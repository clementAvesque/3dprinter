import atexit
import base64
import json
import mimetypes
import os
import posixpath
import threading
from time import sleep, time
from urllib.parse import quote

from . import config
from .ace import Ace
from .bed import Bed
from .camera import Camera
from .nozzle import Nozzle
from .state_printer import State_printer
from .utils import (gcode, load_json, merge_queries, query_status, req, req_download, req_send,
                    save_json)


class Printer:
    # ce que Printer lit lui-même sur Klipper (les composants ajoutent le leur via leur attribut `query`)
    QUERY = {
        "webhooks": ["state", "state_message"],     # état de Klipper (ready, shutdown...)
        "print_stats": ["state", "filename", "print_duration", "info", "filament_used"],
        "virtual_sdcard": ["progress"],
        "toolhead": ["position", "homed_axes"],
        "gcode_move": ["speed_factor", "extrude_factor"],
        "fan": ["speed"],
        # pas d'objet "mmu" de Rinkhals ici : il peut ne plus répondre du tout et bloquerait toute
        # la requête. Le fil chargé dans la tête est lu dans "filament_hub" (voir Ace).
    }
    # tailles des historiques (MAX_TEMP n'a rien à voir avec Heater.MAX_TEMP)
    MAX_TEMP = 500
    MAX_VENTILO = 500
    MAX_PRINT = 50
    HISTORY_SIZE = {"temp": MAX_TEMP, "ventilo": MAX_VENTILO, "print": MAX_PRINT}

    def __init__(self, ip, sync_files=True):
        # aucune requête réseau bloquante ni lecture de fichier ici : le démarrage est instantané.
        # sync_files=True : récupère en tâche de fond les gcodes déjà présents sur la machine
        # (voir sync_printer_files) ; avancement dans self.sync_status.
        self.url = ip
        self.base = f"http://{ip}:{config.MOONRAKER_PORT}"
        self.nozzle = Nozzle(ip)
        self.bed = Bed(ip)
        self.ace = Ace(ip)
        self.state_printer = State_printer()
        self.camera = Camera(ip)
        self.print_init = {}        # paramètres du prochain print (rempli par init_print)
        self.current_print = None   # infos du print en cours
        self.light_pin = "caselight"  # /!\ nom supposé de la pin de la lumière, à vérifier
        self.online = None          # résultat du dernier update() (None = jamais mis à jour)
        self.last_status = {}       # dernier status brut lu sur Klipper
        self._last_fan = None
        self._fil_cache = {}        # fil prévu des gcodes absents de l'index (voir fil_prevu)
        # enregistrement vidéo automatique de chaque impression (voir set_auto_record)
        self.auto_record = {"actif": config.AUTO_RECORD, "timelapse": config.AUTO_RECORD_TIMELAPSE}
        self.dernier_enregistrement = None  # résultat du dernier enregistrement auto arrêté
        self._record_auto = False   # True si l'enregistrement en cours a été lancé automatiquement
        self._record_thread = None
        self._etat_print = None     # dernier print_stats.state vu (pour détecter début et fin)

        # composants rafraîchis par update() : chacun a un attribut `query`
        # et une méthode apply_status(status). Pour en ajouter un, ajoute-le à ce tuple.
        self._components = (self.nozzle, self.bed, self.ace)
        self._query = merge_queries(self.QUERY, *(c.query for c in self._components))

        # fichiers locaux : lus sur le disque au premier accès, gardés en mémoire,
        # écrits par flush() (voir _changed). Ce qui reste est écrit à la fermeture du programme.
        self.gcode_dir = config.GCODE_DIR
        self.files = {
            "temp": config.TEMP_HISTORY_FILE,
            "ventilo": config.FAN_HISTORY_FILE,
            "print": config.PRINT_HISTORY_FILE,
            "index": config.GCODE_INDEX_FILE,
        }
        self._data = {}             # nom ("temp", "index"...) -> contenu en mémoire
        self._dirty = set()         # noms modifiés mais pas encore écrits sur le disque
        self._last_flush = time()
        # la synchro des gcodes tourne dans un thread : ce verrou protège _data / _dirty
        self._lock = threading.RLock()
        atexit.register(self.flush)

        self.sync_status = {"en_cours": False, "fin": None, "resultat": None}
        if sync_files:
            self.sync_in_background()

    def __str__(self):
        # phrase lisible pour print(printer) ; le JSON complet est dans to_json()
        return (f"Imprimante {self.url} : état {self.state_printer.state}, "
                f"buse {self.nozzle.temperature.value}°C, "
                f"plateau {self.bed.temperature.value}°C.")

    def to_dict(self):
        # aucune requête réseau : ce sont les valeurs du dernier update()
        return {
            "ip": self.url,
            "online": self.online,
            "state": self.state_printer.state,
            "nozzle": self.nozzle.to_dict(),
            "bed": self.bed.to_dict(),
            "ace": self.ace.to_dict(),
            "print_init": self.print_init,
            "current_print": self.current_print,
            "auto_record": self.auto_record,
        }

    def to_json(self):
        # json qui renvoie toutes les infos sur la machine et ses composants
        return json.dumps(self.to_dict(), indent=2, ensure_ascii=False)

    # ----- fichiers locaux (historiques + index des gcodes) ---------------

    def _data_of(self, nom):
        # contenu d'un fichier local ; lu sur le disque une seule fois
        with self._lock:
            if nom not in self._data:
                defaut = {} if nom == "index" else []
                self._data[nom] = load_json(self.files[nom], defaut)
            return self._data[nom]

    def _changed(self, nom, now=False):
        # signale qu'un fichier a été modifié en mémoire.
        # Écrit sur le disque tout de suite si now=True, sinon au plus toutes les HISTORY_FLUSH_SECONDS.
        with self._lock:
            self._dirty.add(nom)
            if now or time() - self._last_flush >= config.HISTORY_FLUSH_SECONDS:
                self.flush()

    def _add_history(self, nom, *entrees, now=False):
        with self._lock:
            historique = self._data_of(nom)
            historique.extend(entrees)
            del historique[:-self.HISTORY_SIZE[nom]]    # garde seulement les N dernières entrées
            self._changed(nom, now)

    def flush(self):
        # écrit sur le disque tout ce qui a été modifié (fait aussi automatiquement à la fermeture)
        with self._lock:
            for nom in list(self._dirty):
                try:
                    save_json(self.files[nom], self._data[nom])
                    self._dirty.discard(nom)
                except OSError as e:
                    print(f"Erreur : impossible d'écrire {self.files[nom]} ({e})")
            self._last_flush = time()

    def _set_index(self, nom, entree):
        # ajoute / remplace un gcode dans gcode_index.json (écrit tout de suite)
        with self._lock:
            self._data_of("index")[nom] = entree
            self._changed("index", now=True)

    def _local_path(self, nom):
        # chemin local d'un gcode : "pieces/a.gcode" -> <gcode_dir>/pieces/a.gcode
        # None si le nom sortirait du dossier gcode (ex. "../../x"), par sécurité
        racine = os.path.abspath(self.gcode_dir)
        chemin = os.path.abspath(os.path.join(racine, *nom.split("/")))
        if chemin == racine or os.path.commonpath([racine, chemin]) != racine:
            return None
        return chemin

    # ----- outils internes -------------------------------------------------

    def _sync_state(self, status):
        # aligne State_printer sur l'état réel de Klipper
        etat = status.get("print_stats", {}).get("state")
        ancien = self.state_printer.state
        correspondance = {
            "standby": "READY",
            "printing": "PRINTING",
            "paused": "BREAK",
            "complete": "READY",
            "cancelled": "READY",
            "error": "ERROR",
        }
        nouveau = correspondance.get(etat)
        if nouveau:
            self.state_printer.state = nouveau

        # fin d'impression détectée : on enregistre dans l'historique
        if ancien == "PRINTING" and etat == "complete":
            self._end_print(status)

        # enregistrement vidéo automatique : début et fin d'impression, d'après l'état réel de la
        # machine (et pas State_printer, que start_print() passe en PRINTING avant la 1re lecture).
        # Marche aussi pour un print lancé depuis l'écran ou le slicer.
        precedent, self._etat_print = self._etat_print, etat
        en_cours = ("printing", "paused")
        if etat == "printing" and precedent not in en_cours:
            self._record_debut(status.get("print_stats", {}).get("filename"))
        elif etat and etat not in en_cours and precedent in en_cours:
            self._record_fin()

    # ----- enregistrement automatique --------------------------------------

    def set_auto_record(self, actif=True, timelapse=10):
        # active / coupe l'enregistrement de chaque impression.
        # timelapse=10 : une photo toutes les 10 s (1 h de print ≈ 12 s de vidéo) ; None = temps réel
        if timelapse is not None and float(timelapse) <= 0:
            return {"error": "timelapse doit être un nombre de secondes positif, ou None"}
        self.auto_record = {"actif": bool(actif), "timelapse": timelapse}
        return self.auto_record

    def _record_debut(self, fichier):
        if not self.auto_record["actif"] or self.camera.is_recording():
            return      # coupé, ou un enregistrement (manuel) tourne déjà : on n'y touche pas
        # nom de la vidéo = nom du gcode, sans dossier ni caractères spéciaux
        nom = os.path.splitext(os.path.basename(fichier or ""))[0]
        nom = "".join(c if c.isalnum() or c in "-_" else "_" for c in nom).strip("_") or "impression"
        self._record_auto = True

        def demarrer():
            # start_record() attend ~1,5 s que ffmpeg démarre : dans un thread, pour ne pas
            # ralentir update()
            res = self.camera.start_record(name=nom, timelapse=self.auto_record["timelapse"])
            if res.get("error"):
                self._record_auto = False
                self.dernier_enregistrement = res
            elif not self._record_auto:
                # le print s'est arrêté pendant le démarrage de la vidéo : on la finalise tout de suite
                self.dernier_enregistrement = self.camera.stop_record()
        self._record_thread = threading.Thread(target=demarrer, daemon=True, name="record-auto")
        self._record_thread.start()

    def _record_fin(self):
        # n'arrête que l'enregistrement lancé automatiquement (un manuel reste sous ton contrôle)
        if not self._record_auto:
            return
        self._record_auto = False
        if self._record_thread and self._record_thread.is_alive():
            return      # demarrer() verra _record_auto à False et arrêtera la vidéo lui-même

        def arreter():
            res = self.camera.stop_record()     # finalisation : quelques secondes
            if res.get("error") != "aucun enregistrement en cours":
                self.dernier_enregistrement = res
        threading.Thread(target=arreter, daemon=True, name="record-auto-fin").start()

    def _end_print(self, status):
        stats = status.get("print_stats", {})
        nom = self.current_print["name"] if self.current_print else stats.get("filename")
        infos = self._data_of("index").get(nom, {})

        self._add_history("print", {
            "nom": nom,
            "poids": infos.get("poids"),
            "temps": round(stats.get("print_duration") or 0),
            "timestamp": time(),
        }, now=True)

        # le gcode reste stocké en local, on le supprime de l'imprimante
        # (seulement si la copie locale existe : sinon on perdrait le fichier)
        local = self._local_path(nom) if nom else None
        if local and os.path.isfile(local):
            self.del_file(nom)
        self.current_print = None

    def _log_temp(self):
        maintenant = time()
        entrees = [
            {"temperature": objet.temperature.value, "timestamp": maintenant, "capteur": capteur}
            for capteur, objet in (("nozzle", self.nozzle), ("bed", self.bed))
            if objet.temperature.value is not None
        ]
        if entrees:
            self._add_history("temp", *entrees)

    def _log_ventilo(self, percent):
        self._add_history("ventilo", {"timestamp": time(), "percent": percent})
        self._last_fan = percent

    def _upload(self, nom):
        # envoie le gcode stocké en local vers l'imprimante (dans le même sous-dossier)
        local = self._local_path(nom)
        dossier, fichier = posixpath.split(nom)
        data = {"root": "gcodes", **({"path": dossier} if dossier else {})}
        try:
            with open(local, "rb") as f:
                return req_send("POST", f"{self.base}/server/files/upload",
                                files={"file": (fichier, f)}, data=data, timeout=120)
        except (OSError, TypeError):
            return {"error": "fichier local illisible"}

    def _metadata(self, nom, timeout=5):
        # métadonnées d'un gcode lues par l'imprimante (taille, poids, temps, miniatures...), ou None
        res = req_send("GET", f"{self.base}/server/files/metadata", params={"filename": nom},
                       timeout=timeout)
        return None if res.get("error") else res.get("result", {})

    def _on_printer(self, nom):
        # True si l'imprimante a déjà ce fichier, de la même taille que la copie locale
        meta = self._metadata(nom)
        if meta is None:
            return False
        try:
            taille_locale = os.path.getsize(self._local_path(nom))
        except (OSError, TypeError):
            return False
        return meta.get("size") == taille_locale

    def _download_thumbnail(self, nom, miniatures):
        # télécharge la plus grande miniature du gcode dans image/miniatures/ ; retourne son chemin ou None
        miniatures = [m for m in (miniatures or []) if m.get("relative_path")]
        if not miniatures:
            return None
        grande = max(miniatures, key=lambda m: (m.get("width") or 0) * (m.get("height") or 0))

        # relative_path est relatif au dossier du gcode : "pieces/a.gcode" -> "pieces/.thumbs/a-300x300.png"
        distant = posixpath.join(posixpath.dirname(nom), grande["relative_path"])
        extension = os.path.splitext(grande["relative_path"])[1] or ".png"
        local = os.path.join(config.THUMB_DIR, os.path.splitext(nom)[0].replace("/", "__") + extension)

        # déjà téléchargée (même taille) : rien à refaire
        if os.path.isfile(local) and os.path.getsize(local) == grande.get("size"):
            return local
        res = req_download(f"{self.base}/server/files/gcodes/{quote(distant)}", local, timeout=10)
        return None if res.get("error") else local

    def _index_entry(self, nom, meta):
        # ligne de gcode_index.json à partir des métadonnées de l'imprimante
        local = self._local_path(nom)
        taille = meta.get("size")
        if taille is None and os.path.isfile(local):
            taille = os.path.getsize(local)
        return {
            "temps_estime": meta.get("estimated_time"),     # secondes
            "poids": meta.get("filament_weight_total"),     # grammes de filament
            "taille_octets": taille,                        # poids du fichier
            "miniature": self._download_thumbnail(nom, meta.get("thumbnails")),
            "chemin": local,
            "filament": self._filament_of(meta) if meta else None,
        }

    @staticmethod
    def _filament_of(meta):
        # fil prévu par le slicer, lu dans les métadonnées du gcode.
        # "outils" : outils T0..T3 que le fichier sélectionne ; vide = le fichier ne choisit pas
        # d'emplacement, l'imprimante prend celui associé à T0 (voir MMU_TTG_MAP dans start_print)
        def liste(valeur):
            if isinstance(valeur, str):
                valeur = valeur.split(";")
            return [str(v).strip().strip('"') for v in (valeur or []) if str(v).strip().strip('"')]

        couleurs = liste(meta.get("filament_colors")) or liste(meta.get("extruder_colors"))
        if not (couleurs or meta.get("filament_type") or meta.get("filament_name")):
            return None             # ex. Cura : aucun réglage de fil dans le fichier
        return {
            "types": liste(meta.get("filament_type")),
            # "Anycubic PLA High Speed @Anycubic Kobra 3 V2 0.4 nozzle" -> "Anycubic PLA High Speed"
            "noms": [n.split(" @")[0].strip() for n in liste(meta.get("filament_name"))],
            "couleurs": couleurs,
            # None = inconnu (fil lu dans le fichier local, sans l'analyse de l'imprimante)
            "outils": (meta.get("referenced_tools") or []) if "referenced_tools" in meta else None,
            "poids": meta.get("filament_weight_total"),
        }

    @classmethod
    def _filament_local(cls, chemin, poids=None):
        # fil prévu lu directement dans le gcode local : OrcaSlicer, Anycubic Slicer Next et
        # PrusaSlicer écrivent leurs réglages en fin de fichier ("; filament_type = PLA"...).
        # Cura ne les écrit pas -> None
        cles = dict.fromkeys(("filament_type", "filament_colour", "extruder_colour", "filament_settings_id"))
        try:
            with open(chemin, "rb") as f:
                f.seek(0, os.SEEK_END)
                f.seek(max(0, f.tell() - 400_000))
                fin = f.read().decode("utf-8", "replace")
        except (OSError, TypeError):
            return None
        for ligne in fin.splitlines():
            if ligne.startswith("; ") and " = " in ligne:
                cle, _, valeur = ligne[2:].partition(" = ")
                if cle in cles:
                    cles[cle] = valeur
        if not any(cles.values()):
            return None
        return cls._filament_of({
            "filament_type": cles["filament_type"], "filament_name": cles["filament_settings_id"],
            "filament_colors": cles["filament_colour"], "extruder_colors": cles["extruder_colour"],
            "filament_weight_total": poids,
        })

    def fil_prevu(self, nom):
        # fil prévu par le gcode `nom` : {"types", "noms", "couleurs", "outils", "poids"} ou None.
        # ordre : index local, puis le gcode local lui-même, puis les métadonnées de l'imprimante ;
        # le résultat est gardé (dans l'index si le fichier y est)
        if not nom:
            return None
        entree = self.gcodes().get(nom) or {}
        if entree.get("filament") is not None:
            return entree["filament"]
        cache = self._fil_cache
        if nom not in cache:
            fil = self._filament_local(entree.get("chemin") or self._local_path(nom), entree.get("poids"))
            if fil is None:
                meta = self._metadata(nom)
                fil = self._filament_of(meta) if meta else None
            cache[nom] = fil
            if fil and entree:
                self._set_index(nom, {**entree, "filament": fil})
        return cache[nom]

    def fil_utilise(self):
        # emplacement de l'ACE réellement utilisé (valeurs du dernier update(), aucune requête) :
        # {"emplacement": 1..4 ou None, "couleur", "matiere", "source"}
        #   source "machine"   : l'ACE indique que le fil de cet emplacement est chargé dans la tête
        #   source "lancement" : emplacement fixé par start_print() (rien n'est encore chargé)
        #   source None        : inconnu (print lancé depuis l'écran ou le slicer, rien de chargé)
        slot, source = None, None
        if self.ace.slot_actif:
            slot, source = self.ace.slot_actif, "machine"
        elif self.current_print and self.ace.state.state in ("ON", "DRY"):
            # start_print() a fixé l'emplacement : celui demandé, ou le 1 par défaut
            slot = self.current_print["slot"] if self.current_print.get("use_ace") else 1
            source = "lancement"
        fil = next((f for f in (self.ace.fils or []) if f["emplacement"] == slot), {})
        return {"emplacement": slot, "couleur": fil.get("color"), "matiere": fil.get("matiere"),
                "source": source}

    def _file_json(self, nom, entree, with_image=True):
        # format renvoyé par gcode_files() / sync_printer_files()
        taille = entree.get("taille_octets")
        if taille is None and entree.get("chemin") and os.path.isfile(entree["chemin"]):
            taille = os.path.getsize(entree["chemin"])   # anciennes entrées de l'index
        image = None
        if with_image and entree.get("miniature"):
            try:
                with open(entree["miniature"], "rb") as f:
                    mime = mimetypes.guess_type(entree["miniature"])[0] or "image/png"
                    image = f"data:{mime};base64,{base64.b64encode(f.read()).decode()}"
            except OSError:
                pass
        return {
            "nom": nom,
            "miniature": image,             # data URL utilisable directement dans <img src="...">
            "poids_octets": taille,
            "poids_grammes": entree.get("poids"),
            "temps_estime": entree.get("temps_estime"),
        }

    # ----- boucle de mise à jour ------------------------------------------

    def update(self):
        # rafraîchit tous les composants et le status avec UNE seule requête
        # retourne False si l'imprimante n'a pas répondu
        status = query_status(self.url, self._query)
        self.online = not status.get("error")
        if not self.online:
            return False
        self.last_status = status

        for composant in self._components:
            composant.apply_status(status)

        self._sync_state(status)
        self._log_temp()

        fan = status.get("fan", {}).get("speed")
        if fan is not None:
            percent = round(fan * 100)
            if percent != self._last_fan:
                self._log_ventilo(percent)
        return True

    def run(self, interval=2):
        # rafraîchit tout en boucle ; Ctrl+C pour arrêter
        try:
            while True:
                self.update()
                sleep(interval)
        except KeyboardInterrupt:
            pass
        finally:
            self.flush()

    def is_online(self):
        # vérifie EN DIRECT si l'imprimante répond (une requête) ; sinon voir self.online
        return not req(f"{self.base}/server/info", timeout=3).get("error")

    # ----- impression ------------------------------------------------------

    def init_print(self, **kwargs):
        # prépare les paramètres du prochain print (avec ou sans ACE)
        #
        # sans ACE : init_print(filename="piece.gcode")
        # avec ACE : init_print(filename="piece.gcode", use_ace=True, slot=2, color="#ff0000", material="PLA")
        nom = kwargs.get("filename")
        if not nom:
            return {"error": "filename est obligatoire"}

        if nom not in self._data_of("index"):
            return {"error": f"{nom} inconnu : fais d'abord upload_gcode()"}

        if kwargs.get("use_ace", False):
            slot = kwargs.get("slot")
            if slot not in (1, 2, 3, 4):
                return {"error": "avec l'ACE, slot doit valoir 1, 2, 3 ou 4"}

            # si la couleur n'est pas donnée, on prend celle lue sur l'ACE
            fil = next((f for f in (self.ace.fils or []) if f["emplacement"] == slot), None)
            self.print_init = {
                "filename": nom,
                "use_ace": True,
                "slot": slot,
                "color": kwargs.get("color") or (fil["color"] if fil else None),
                "material": kwargs.get("material"),
            }
        else:
            self.print_init = {"filename": nom, "use_ace": False}

        return self.print_init

    def clear_print_init(self):
        # vide les paramètres préparés par init_print() (sans toucher au print en cours)
        self.print_init = {}
        return self.print_init

    def start_print(self):
        # lance une impression avec les valeurs de print_init et passe l'état en PRINTING
        if not self.print_init:
            return {"error": "appelle init_print() avant start_print()"}

        # vérifications avant impression (en ligne, Klipper prêt, capteurs, fichier, ACE...)
        verif = self.check_ready()
        if not verif["ready"]:
            return {"error": " ; ".join(verif["problems"])}

        nom = self.print_init["filename"]

        # l'envoi du gcode est de loin l'étape la plus longue (transfert + analyse par l'imprimante) :
        # on ne le fait que si l'imprimante n'a pas déjà le fichier
        if not self._on_printer(nom):
            res = self._upload(nom)
            if res.get("error"):
                return res

        # avec l'ACE on choisit l'emplacement : sous Rinkhals ce n'est PAS un "T0..T3" (qui ne fait
        # qu'un changement d'outil) mais la table outil -> emplacement MMU_TTG_MAP. Rinkhals la lit au
        # lancement et l'envoie au firmware Anycubic (en mode LAN). MAP=2 : l'outil T0 du fichier
        # (impression mono-couleur) prend l'emplacement 3 ; les autres outils gardent leur emplacement.
        # Cette table RESTE en mémoire après le print : sans choix d'emplacement on la remet donc à
        # zéro (T0 -> emplacement 1), sinon le print suivant reprendrait l'emplacement d'un ancien
        # lancement sans que personne ne le sache.
        avertissements = []
        ace = self.ace.state.state in ("ON", "DRY")
        if self.print_init.get("use_ace"):
            res = gcode(self.url, f"MMU_TTG_MAP MAP={self.print_init['slot'] - 1}")
            if res.get("error"):
                return res
        elif ace:
            gcode(self.url, "MMU_TTG_MAP RESET=1")     # échec sans gravité : on lance quand même

        # Chargement du fil : quand le gcode ne choisit aucun outil (cas de tes fichiers), Rinkhals
        # ne pousse le fil jusqu'à la buse que si un emplacement a été « sélectionné » avant le
        # lancement, comme le fait l'écran avec Color Match. MMU_SELECT fait cette sélection :
        # Rinkhals envoie alors le fil (FEED_FILAMENT) au début du print, une fois la buse chaude.
        # Sans effet si un fil est déjà chargé dans la tête ou si le fichier choisit ses outils.
        if ace:
            gate = self.print_init["slot"] - 1 if self.print_init.get("use_ace") else 0
            res = gcode(self.url, f"MMU_SELECT GATE={gate}")
            if res.get("error"):
                avertissements.append(f"emplacement {gate + 1} non sélectionné ({res['error']}) : "
                                      "le fil ne sera peut-être pas chargé automatiquement")

        # timeout long : le firmware analyse le fichier avant de répondre (9 s mesurées pour 1 Mo)
        res = req_send("POST", f"{self.base}/printer/print/start", params={"filename": nom}, timeout=60)
        if res.get("error"):
            return self._explain_print_error(res)

        self.state_printer.PRINTING()
        self.current_print = {"name": nom, "start": time(), **self.print_init}
        if avertissements:
            res["avertissements"] = avertissements
        return res

    def pause(self):
        # met en pause (état BREAK, accessible uniquement depuis PRINTING)
        if self.state_printer.state != "PRINTING":
            return {"error": self.state_printer.BREAK()}
        res = req_send("POST", f"{self.base}/printer/print/pause")
        if not res.get("error"):
            self.state_printer.BREAK()
        return res

    def restart(self):
        # reprend l'impression qui est en pause
        if self.state_printer.state != "BREAK":
            return {"error": self.state_printer.RESTART()}
        res = req_send("POST", f"{self.base}/printer/print/resume")
        if not res.get("error"):
            self.state_printer.RESTART()
        return res

    def cancel(self):
        # annule l'impression en cours, remet l'état en READY
        # et supprime le gcode de l'imprimante (il reste en local)
        res = req_send("POST", f"{self.base}/printer/print/cancel")
        if not res.get("error"):
            self.state_printer.READY()
            if self.current_print:
                self.del_file(self.current_print["name"])
                self.current_print = None
        return res

    # ----- vérifications ---------------------------------------------------

    def remote_mode(self):
        # mode réseau de la Kobra : "lan", "cloud", ou None si l'imprimante ne répond pas.
        # Rinkhals ajoute un avertissement dans /server/info quand elle n'est PAS en mode LAN.
        # /!\ Rinkhals ne relit le mode qu'à son démarrage et à chaque lancement d'impression :
        # juste après un changement sur l'écran, la valeur peut être périmée.
        res = req(f"{self.base}/server/info", timeout=5)
        if res.get("error"):
            return None
        warnings = res.get("result", {}).get("warnings") or []
        return "cloud" if any("not in LAN mode" in w for w in warnings) else "lan"

    def _explain_print_error(self, res):
        # ajoute la cause probable à l'erreur de lancement (le firmware Anycubic ne donne qu'un code)
        texte = f"{res.get('error', '')} {res.get('detail', '')}".lower()
        if "parse" in texte or "10115" in texte:
            res["conseil"] = (
                "erreur 10115 (le firmware ne peut pas lire le fichier) : " + (
                    self.CLOUD_MODE_HELP if self.remote_mode() == "cloud" else
                    "vérifie que l'emplacement choisi contient du filament et que le gcode a été "
                    "tranché pour la Kobra 3 (sinon retranche-le et renvoie-le)."))
        return res

    CLOUD_MODE_HELP = (
        "l'imprimante est en mode cloud : Rinkhals ne peut pas dire au firmware quel emplacement "
        "de l'ACE utiliser, et comme aucun filament n'est chargé dans la tête le fichier est refusé. "
        "Passe l'imprimante en mode LAN sur son écran (Réglages > Réseau > mode LAN) ; "
        "l'appli Anycubic cloud ne marchera plus tant que le mode LAN est actif.")

    def klipper_state(self):
        # état de Klipper : "ready", "startup", "shutdown" ou "error"
        res = req(f"{self.base}/printer/info")
        if res.get("error"):
            return {"state": None, "message": res["error"]}
        info = res["result"]
        return {"state": info.get("state"), "message": info.get("state_message")}

    def check_ready(self):
        # vérifie que tout est OK avant une impression
        # retourne {"ready": bool, "problems": [str, ...]} ; utilisable seul, avant start_print()
        #
        # cas normal : UNE seule requête, car update() lit aussi l'état de Klipper ("webhooks")
        if not self.update():
            # 2e requête seulement en cas d'échec, pour donner la vraie raison
            klipper = self.klipper_state()
            if klipper["state"] is None:
                return {"ready": False, "problems": ["imprimante hors ligne"]}
            return {"ready": False,
                    "problems": [f"état illisible, Klipper : {klipper['state']} ({klipper['message']})"]}

        webhooks = self.last_status.get("webhooks", {})
        if webhooks.get("state") != "ready":
            return {"ready": False,
                    "problems": [f"Klipper n'est pas prêt : {webhooks.get('state')} "
                                 f"({webhooks.get('state_message')})"]}

        problems = []
        if self.state_printer.state not in (None, "READY"):
            problems.append(f"état actuel : {self.state_printer.state}")
        if self.nozzle.temperature.value is None or self.bed.temperature.value is None:
            problems.append("capteur de température illisible")

        if self.print_init:
            nom = self.print_init["filename"]
            if not os.path.isfile(self._local_path(nom) or ""):
                problems.append(f"{nom} introuvable en local")
            if self.print_init.get("use_ace"):
                slot = self.print_init.get("slot")
                fil = next((f for f in (self.ace.fils or []) if f["emplacement"] == slot), None)
                if self.ace.state.state == "OFF":
                    problems.append("ACE demandé mais non détecté")
                elif fil is not None and fil["color"] is None:
                    problems.append(f"l'emplacement {slot} de l'ACE est vide")

        # pas de test du mode LAN ici : Rinkhals ne relit ce mode qu'à son démarrage et au lancement
        # d'une impression, remote_mode() peut donc dire "cloud" alors que la machine vient de passer
        # en LAN. Le refus éventuel est expliqué après coup par _explain_print_error().
        return {"ready": not problems, "problems": problems}

    def _idle_error(self):
        # retourne une erreur si la machine est hors ligne ou en impression, sinon None
        if not self.update():
            return {"error": "imprimante hors ligne"}
        if self.state_printer.state in ("PRINTING", "BREAK"):
            return {"error": "impossible pendant une impression"}
        return None

    # ----- réglages pendant l'impression -----------------------------------

    def set_speed(self, percent):
        # vitesse d'impression (M220) : 100 = vitesse du slicer, 150 = 1,5x plus rapide.
        # l'extrusion suit automatiquement. Utilisable en cours d'impression.
        if not 10 <= percent <= 300:
            return {"error": "percent doit être entre 10 et 300"}
        return gcode(self.url, f"M220 S{int(percent)}")

    def set_flow(self, percent):
        # débit d'extrusion (M221) : 100 = normal. Utilisable en cours d'impression.
        if not 50 <= percent <= 150:
            return {"error": "percent doit être entre 50 et 150"}
        return gcode(self.url, f"M221 S{int(percent)}")

    # ----- moteurs et filament ---------------------------------------------

    def disable_motors(self):
        # coupe les moteurs (M84) : on peut déplacer la tête à la main. Refusé pendant un print.
        erreur = self._idle_error()
        if erreur:
            return erreur
        return gcode(self.url, "M84")

    def load_filament(self, slot=None, temp=220, length=50):
        # charge un filament : chauffe la buse, avance depuis l'ACE (si slot donné), puis extrude.
        # la buse reste chaude à la fin (un print va probablement suivre).
        erreur = self._idle_error()
        if erreur:
            return erreur

        res = self.nozzle.set_target_temp(temp, wait=True)
        if res.get("error"):
            return res

        if slot is not None:
            res = self.ace.feed(slot)
            if res.get("error"):
                return res

        return self.nozzle.extrude(length)

    def unload_filament(self, slot=None, temp=220, length=60):
        # décharge un filament : chauffe, recule dans l'extrudeur, rentre dans l'ACE (si slot donné),
        # puis coupe la chauffe.
        erreur = self._idle_error()
        if erreur:
            return erreur

        res = self.nozzle.set_target_temp(temp, wait=True)
        if res.get("error"):
            return res

        res = self.nozzle.retract(length)
        if res.get("error"):
            return res

        if slot is not None:
            res = self.ace.retract(slot)
            if res.get("error"):
                return res

        return self.nozzle.stop()

    # ----- infos -----------------------------------------------------------

    def filament(self):
        # retourne les infos des filaments
        if self.ace.fils is None:
            self.ace.update()
        return {"ace_state": self.ace.state.state, "fils": self.ace.fils}

    def data_print(self, with_image=True):
        # toutes les infos utiles pour l'impression : dernière image, position de la buse,
        # nom du fichier, températures buse et lit, couche, avancement, temps, ventilo...
        # with_image=False saute la photo (beaucoup plus rapide : pas de requête caméra)
        if not self.update():       # 1 requête, qui met aussi à jour les composants et l'état
            return {"error": "fail connexion"}
        status = self.last_status

        stats = status.get("print_stats", {})
        sd = status.get("virtual_sdcard", {})
        tool = status.get("toolhead", {})
        ext = status.get("extruder", {})
        lit = status.get("heater_bed", {})
        info = stats.get("info") or {}

        progression = round((sd.get("progress") or 0) * 100, 1)
        ecoule = round(stats.get("print_duration") or 0)
        # temps restant estimé à partir de l'avancement
        restant = round(ecoule * (100 - progression) / progression) if progression > 0 else None

        pos = tool.get("position") or [None, None, None]
        image = None
        if with_image:
            pic = self.camera.instant_pic()
            if isinstance(pic, bytes):
                import base64
                image = base64.b64encode(pic).decode()

        return {
            "state": self.state_printer.state,
            # état exact de Klipper : "printing", "paused", "complete", "cancelled", "error", "standby"
            # (le serveur s'en sert pour savoir si une plaque est finie ou a été annulée)
            "etat_klipper": stats.get("state"),
            "filename": stats.get("filename"),
            "progress_percent": progression,
            "elapsed_seconds": ecoule,
            "remaining_seconds": restant,
            "layer": info.get("current_layer"),
            "total_layers": info.get("total_layer"),
            "position": {"x": pos[0], "y": pos[1], "z": pos[2]},
            "nozzle": {"temperature": ext.get("temperature"), "target": ext.get("target")},
            "bed": {"temperature": lit.get("temperature"), "target": lit.get("target")},
            "fan_percent": round((status.get("fan", {}).get("speed") or 0) * 100),
            "speed_factor": status.get("gcode_move", {}).get("speed_factor"),
            "filament_used_mm": stats.get("filament_used"),
            # fil prévu par le fichier (slicer) et emplacement de l'ACE réellement utilisé
            "filament": {"prevu": self.fil_prevu(stats.get("filename")), "utilise": self.fil_utilise()},
            "image_base64": image,
        }

    # ----- commandes directes ---------------------------------------------
    # (home / move / température : voir printer.nozzle et printer.bed)

    def light(self, on=True):
        # /!\ SET_PIN avec self.light_pin supposé, à vérifier avec ta doc
        return gcode(self.url, f"SET_PIN PIN={self.light_pin} VALUE={1 if on else 0}")

    def set_ventilo(self, percent):
        # règle le ventilateur de 0 à 100 % et l'enregistre dans le json de suivi
        percent = max(0, min(100, int(percent)))
        res = gcode(self.url, f"M106 S{round(percent * 255 / 100)}")
        if not res.get("error"):
            self._log_ventilo(percent)
        return res

    # ----- fichiers --------------------------------------------------------

    def upload_gcode(self, path, keep_on_printer=True, nom=None):
        # stocke le gcode en local, l'envoie sur la machine pour lire le temps d'impression
        # et le poids estimés, et enregistre ces infos dans gcode_index.json.
        #
        # keep_on_printer=True  : le fichier reste sur l'imprimante -> start_print() démarre
        #                         sans le renvoyer (il est supprimé à la fin du print / à l'annulation)
        # keep_on_printer=False : supprimé tout de suite -> start_print() devra le renvoyer (lent)
        # nom : nom à donner au fichier, avec un dossier éventuel ("a_faire/P0007.gcode") ; par défaut
        #       le nom du fichier, à la racine
        if not os.path.isfile(path):
            return {"error": "fichier introuvable"}

        nom = nom or os.path.basename(path)
        local = self._local_path(nom)
        if local is None:
            return {"error": f"nom de fichier refusé : {nom}"}
        os.makedirs(os.path.dirname(local), exist_ok=True)
        if os.path.abspath(path) != os.path.abspath(local):
            import shutil
            shutil.copy2(path, local)

        res = self._upload(nom)
        if res.get("error"):
            return res

        # l'imprimante met un petit moment à analyser le fichier : on redemande toutes les 0,5 s (10 s max)
        meta = None
        limite = time() + 10
        while time() < limite:
            meta = self._metadata(nom, timeout=10)
            if meta is not None:
                break
            sleep(0.5)

        entree = self._index_entry(nom, meta or {})
        self._set_index(nom, entree)

        if not keep_on_printer:
            self.del_file(nom)
        return entree

    def move_gcode(self, source, destination):
        # déplace / renomme un gcode connu (ex. "a_faire/P0007.gcode" -> "imprimees/P0007_..._Client.gcode") :
        # copie locale, entrée de gcode_index.json, et le fichier sur l'imprimante s'il y est encore
        # (après un print il n'y est plus : il est renvoyé depuis la copie locale au prochain lancement).
        # retourne {"result": "ok", "nom": destination} ou {"error": ...}
        from . import toolpath

        if source == destination:
            return {"result": "ok", "nom": destination}
        entree = self.gcodes().get(source)
        ancien = (entree or {}).get("chemin") or self._local_path(source)
        nouveau = self._local_path(destination)
        if not entree or not ancien or not os.path.isfile(ancien):
            return {"error": f"{source} inconnu"}
        if nouveau is None or not destination.lower().endswith(config.GCODE_EXTENSIONS):
            return {"error": f"destination refusée : {destination}"}
        if os.path.exists(nouveau) or destination in self.gcodes():
            return {"error": f"{destination} existe déjà"}
        en_cours = self.last_status.get("print_stats", {}).get("filename")
        if source == en_cours and self.state_printer.state in ("PRINTING", "BREAK"):
            return {"error": f"{source} est en cours d'impression"}

        # 1) imprimante d'abord (si elle a encore le fichier) : en cas d'échec, rien n'est déplacé
        if self._metadata(source) is not None:
            res = req_send("POST", f"{self.base}/server/files/move",
                           json={"source": f"gcodes/{source}", "dest": f"gcodes/{destination}"}, timeout=20)
            if res.get("error"):
                return {"error": f"déplacement sur l'imprimante impossible ({res['error']}) : rien n'a été déplacé"}

        # 2) copie locale et index (l'aperçu 3D en cache est lié au chemin : il sera refait)
        toolpath.forget(ancien, config.TOOLPATH_DIR)
        os.makedirs(os.path.dirname(nouveau), exist_ok=True)
        os.replace(ancien, nouveau)
        with self._lock:
            index = self._data_of("index")
            index.pop(source, None)
            index[destination] = {**entree, "chemin": nouveau}
            self._changed("index", now=True)
        return {"result": "ok", "nom": destination}

    def gcodes(self):
        # gcodes connus en local (envoyés avec upload_gcode() ou récupérés sur la machine) :
        # {nom: {"temps_estime", "poids", "taille_octets", "miniature", "chemin"}}
        with self._lock:
            return {nom: dict(entree) for nom, entree in self._data_of("index").items()}

    def gcode_files(self, with_image=True):
        # liste prête à envoyer en JSON (json.dumps / jsonify) de tous les gcodes imprimables :
        # [{"nom", "miniature" (data URL base64 ou None), "poids_octets", "poids_grammes", "temps_estime"}]
        # with_image=False : miniature à None (réponse beaucoup plus légère)
        return [self._file_json(nom, entree, with_image)
                for nom, entree in sorted(self.gcodes().items())]

    def toolpath(self, nom):
        # trajets 3D d'un gcode connu, couche par couche (pour l'aperçu 3D) : (meta, chemin du .bin)
        # ou {"error": ...}. Format décrit dans toolpath.py ; lu une fois puis gardé en cache.
        from . import toolpath
        chemin = (self.gcodes().get(nom) or {}).get("chemin") or self._local_path(nom)
        if not chemin or not os.path.isfile(chemin):
            return {"error": f"{nom} introuvable en local"}
        try:
            return toolpath.load(chemin, config.TOOLPATH_DIR)
        except OSError as e:
            return {"error": f"lecture impossible ({e})"}

    def sync_printer_files(self, download=True):
        # récupère les gcodes DÉJÀ présents sur l'imprimante (envoyés par le slicer, une clé USB, l'app
        # Anycubic...) et les range comme ceux de upload_gcode() : copie dans gcode/, miniature dans
        # image/miniatures/, infos dans gcode_index.json. Ils deviennent imprimables avec init_print().
        #
        # un fichier déjà copié en local avec la même taille n'est pas retéléchargé.
        # download=False : n'enregistre que les infos (mais init_print() refusera un fichier sans copie
        # locale, voir check_ready()).
        # retourne la liste au format gcode_files(with_image=False), ou {"error": ...}
        fichiers = self.list_files()
        if isinstance(fichiers, dict):          # erreur réseau
            return fichiers

        resultat = []
        for f in fichiers:
            nom = f["nom"]
            local = self._local_path(nom)
            if local is None or not nom.lower().endswith(config.GCODE_EXTENSIONS):
                continue

            if download and not (os.path.isfile(local) and os.path.getsize(local) == f["taille"]):
                res = req_download(f"{self.base}/server/files/gcodes/{quote(nom)}", local)
                if res.get("error"):
                    resultat.append({"nom": nom, "error": f"téléchargement impossible ({res['error']})"})
                    continue

            meta = self._metadata(nom) or {}
            meta.setdefault("size", f["taille"])
            entree = self._index_entry(nom, meta)
            self._set_index(nom, entree)
            resultat.append(self._file_json(nom, entree, with_image=False))

        # gcodes connus en local mais plus sur l'imprimante (ou indexés avant) : fil lu dans le fichier
        for nom, entree in self.gcodes().items():
            if entree.get("filament") is None:
                fil = self._filament_local(entree.get("chemin"), entree.get("poids"))
                if fil:
                    self._set_index(nom, {**entree, "filament": fil})
        return resultat

    def sync_in_background(self, retry=10):
        # lance sync_printer_files() dans un thread (appelé par __init__).
        # si l'imprimante est éteinte, réessaie toutes les `retry` secondes jusqu'à ce qu'elle réponde.
        # avancement : self.sync_status = {"en_cours", "fin", "resultat"}
        if self.sync_status["en_cours"]:
            return self.sync_status
        self.sync_status = {"en_cours": True, "fin": None, "resultat": None}

        def travail():
            while True:
                try:
                    res = self.sync_printer_files()
                except Exception as e:      # le thread ne doit jamais mourir en "en_cours"
                    res = {"error": f"erreur interne : {e}"}
                if not (isinstance(res, dict) and res.get("error") == "fail connexion"):
                    break
                sleep(retry)
            self.sync_status = {"en_cours": False, "fin": time(), "resultat": res}

        threading.Thread(target=travail, daemon=True, name="sync-gcodes").start()
        return self.sync_status

    def list_files(self):
        # liste les fichiers gcode présents sur l'imprimante
        res = req_send("GET", f"{self.base}/server/files/list", params={"root": "gcodes"})
        if res.get("error"):
            return res
        return [
            {"nom": f["path"], "taille": f.get("size"), "modifie": f.get("modified")}
            for f in res["result"]
        ]

    def del_file(self, nom):
        # supprime un fichier gcode de l'imprimante
        return req_send("DELETE", f"{self.base}/server/files/gcodes/{quote(nom)}")

    def delete_gcode(self, nom, sur_imprimante=True):
        # supprime DÉFINITIVEMENT un gcode : sur l'imprimante (sinon la synchro au démarrage le
        # re-téléchargerait), puis sa copie locale, sa miniature, son aperçu 3D en cache et son entrée
        # dans gcode_index.json. Refusé pour le fichier en cours d'impression.
        # sur_imprimante=False : ne touche qu'au PC.
        # retourne {"result": "ok", "supprime": [...]} ou {"error": ...}
        from . import toolpath

        en_cours = self.last_status.get("print_stats", {}).get("filename")
        if self.current_print:
            en_cours = self.current_print.get("name") or en_cours
        if nom == en_cours and self.state_printer.state in ("PRINTING", "BREAK"):
            return {"error": f"{nom} est en cours d'impression"}

        entree = self.gcodes().get(nom) or {}
        local = entree.get("chemin") or self._local_path(nom)
        if not entree and not (local and os.path.isfile(local)):
            return {"error": f"{nom} inconnu"}

        supprime = []
        # 1) imprimante d'abord : si elle ne répond pas, on ne supprime rien du tout
        if sur_imprimante:
            res = self.del_file(nom)
            if res.get("error") and res.get("error") != "HTTP 404":    # 404 = déjà absent
                return {"error": f"suppression sur l'imprimante impossible ({res['error']}) : "
                                 "rien n'a été supprimé"}
            if not res.get("error"):
                supprime.append("imprimante")

        # 2) fichiers du PC (le cache 3D est retrouvé à partir du gcode : avant de l'effacer)
        if local and os.path.isfile(local):
            toolpath.forget(local, config.TOOLPATH_DIR)
            os.remove(local)
            supprime.append("gcode local")
        miniature = entree.get("miniature")
        if miniature and os.path.isfile(miniature):
            os.remove(miniature)
            supprime.append("miniature")

        # 3) index
        with self._lock:
            if self._data_of("index").pop(nom, None) is not None:
                self._changed("index", now=True)
                supprime.append("index")
        self._fil_cache.pop(nom, None)
        return {"result": "ok", "supprime": supprime}

    def convert(self):
        # TODO : convertir un fichier stl en gcode avec un .ini prédéfini selon la machine,
        # placé à la racine du projet (nom de l'imprimante normalisé et comparé au nom du .ini),
        # puis enregistrer le résultat dans le dossier "gcode".
        pass

    # ----- historiques -----------------------------------------------------

    def historique_temp(self):
        # les 500 dernières valeurs : [{"temperature", "timestamp", "capteur": "nozzle"/"bed"}]
        return list(self._data_of("temp"))

    def historique_ventilo(self):
        # suivi du ventilateur : [{"timestamp", "percent"}]
        return list(self._data_of("ventilo"))

    def historique_print(self):
        # les 50 derniers prints : [{"nom", "poids", "temps", "timestamp"}]
        return list(self._data_of("print"))

    # filament 1,75 mm en PLA (1,24 g/cm³) : grammes par mm de fil
    GRAMMES_PAR_MM = 3.14159 * 0.0875 ** 2 * 1.24 / 10

    def historique_machine(self, limit=100):
        # historique gardé par l'imprimante elle-même (Moonraker) : tous les prints, y compris ceux
        # lancés depuis l'écran ou le slicer, terminés ou non. Le plus récent en premier :
        # [{"nom", "statut" ("completed", "cancelled", "error"...), "debut", "fin", "temps" (s), "poids" (g)}]
        res = req_send("GET", f"{self.base}/server/history/list",
                       params={"limit": limit, "order": "desc"})
        if res.get("error"):
            return res
        historique = []
        for job in res.get("result", {}).get("jobs", []):
            meta = job.get("metadata") or {}
            # print terminé : poids calculé par le slicer ; sinon (annulé, en cours...) le filament
            # réellement consommé, converti en grammes (estimation PLA 1,75 mm)
            poids = meta.get("filament_weight_total") if job.get("status") == "completed" else None
            if not poids and job.get("filament_used"):
                poids = job["filament_used"] * self.GRAMMES_PAR_MM
            historique.append({
                "nom": job.get("filename"),
                "statut": job.get("status"),
                "debut": job.get("start_time"),
                "fin": job.get("end_time"),
                "temps": round(job.get("print_duration") or 0),
                "poids": round(poids, 1) if poids else None,
            })
        return historique
