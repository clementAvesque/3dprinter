import atexit
import os
import subprocess
import threading
from time import sleep, strftime, time
from urllib.parse import urlsplit

from . import config
from .utils import req, req_bytes, req_send


class Camera:
    def __init__(self, url):
        self.url = url
        self.lastPic = ""
        self.directory = ""         # rempli par init_directory(), au premier usage seulement
        self.snapshot_url = None    # adresse d'une photo     } demandées à Moonraker au premier
        self.stream_url = None      # adresse du flux vidéo   } usage (voir find_urls)
        self._record = None         # enregistrement en cours (voir start_record)

    def __str__(self):
        # /!\ fait une requête réseau (prend une photo) à chaque print(camera)
        pic = self.instant_pic()
        if not isinstance(pic, bytes):
            return "il y a un problème de la connexion"
        return f"Dernière image : {len(pic)} octets"

    # ----- adresses de la caméra ------------------------------------------

    def _adresse_complete(self, adresse):
        # "/webcam/?action=stream" -> "http://<ip>/webcam/?action=stream"
        # "http://localhost:8080/..." (vu depuis l'imprimante) -> "http://<ip>:8080/..."
        if not adresse.startswith("http"):
            return f"http://{self.url}/{adresse.lstrip('/')}"
        morceaux = urlsplit(adresse)
        if morceaux.hostname in ("localhost", "127.0.0.1"):
            port = f":{morceaux.port}" if morceaux.port else ""
            adresse = morceaux._replace(netloc=f"{self.url}{port}").geturl()
        return adresse

    def find_urls(self):
        # demande à Moonraker les adresses de la caméra telles qu'elles sont configurées sur la machine
        # et remplit self.snapshot_url / self.stream_url.
        # retourne False si Moonraker ne répond pas (on réessaiera au prochain usage)
        res = req(f"http://{self.url}:{config.MOONRAKER_PORT}/server/webcams/list", timeout=3)
        if res.get("error"):
            return False

        cam = next((c for c in res.get("result", {}).get("webcams", []) if c.get("enabled", True)), {})
        # si Moonraker ne déclare aucune caméra : adresses par défaut (voir config.py)
        self.snapshot_url = self._adresse_complete(cam.get("snapshot_url") or config.CAMERA_SNAPSHOT_PATH)
        self.stream_url = self._adresse_complete(cam.get("stream_url") or config.CAMERA_STREAM_PATH)
        return True

    def get_stream_url(self):
        # adresse du flux vidéo (MJPEG) : un navigateur l'affiche directement dans une balise <img>
        if self.stream_url is None:
            self.find_urls()
        return self.stream_url or self._adresse_complete(config.CAMERA_STREAM_PATH)

    # ----- réglages de la caméra (mjpg-streamer) ---------------------------

    def _webcam_base(self):
        # "http://<ip>/webcam/?action=stream" -> "http://<ip>/webcam/"
        return self.get_stream_url().split("?")[0]

    def controls(self):
        # réglages de la caméra : {"Brightness": {"id", "group", "value", "min", "max"}, ...}
        # ou {"error": ...}. (la valeur affichée par mjpg-streamer n'est pas toujours à jour)
        res = req(self._webcam_base() + "input.json", timeout=5)
        if res.get("error"):
            return res
        return {c["name"]: c for c in res.get("controls", [])}

    def set_control(self, nom, valeur):
        """Change un réglage de la caméra, ex. set_control("Brightness", 40).
        Perdu au redémarrage de l'imprimante : à réappliquer (voir fast_mode)."""
        reglages = self.controls()
        if reglages.get("error"):
            return reglages
        c = reglages.get(nom)
        if not c:
            return {"error": f"réglage inconnu : {nom}", "detail": ", ".join(reglages)}
        url = (f"{self._webcam_base()}?action=command&dest=0&plugin=0"
               f"&id={c['id']}&group={c['group']}&value={int(valeur)}")
        return req_send("GET", url, timeout=5)

    def fast_mode(self):
        # empêche la caméra de ralentir quand la scène est sombre.
        # "Exposure, Auto Priority" = 1 l'autorise à allonger l'exposition en baissant la cadence :
        # mesuré sur la Kobra 3 : 0,2 image/s avec, 2,5 images/s sans.
        return self.set_control("Exposure, Auto Priority", 0)

    # ----- photos ---------------------------------------------------------

    def instant_pic(self):
        # récupère la dernière image de la caméra, la stocke dans lastPic
        # (sans l'enregistrer sur disque) et la retourne (bytes, ou {"error": ...})
        if self.snapshot_url is None:
            self.find_urls()
        url = self.snapshot_url or self._adresse_complete(config.CAMERA_SNAPSHOT_PATH)

        pic = req_bytes(url, timeout=5)
        if isinstance(pic, bytes):
            self.lastPic = pic
        return pic

    def init_directory(self):
        # crée le dossier "image" de la librairie et l'enregistre dans self.directory
        os.makedirs(config.IMAGE_DIR, exist_ok=True)
        self.directory = config.IMAGE_DIR
        return self.directory

    def rec_video(self, name, duration=None, interval=0.5):
        # crée un dossier "nom_timestamp" dans image/ avec une photo toutes les `interval` secondes
        # (bloquant ; pour une vraie vidéo .mp4 en arrière-plan, voir start_record)
        if not self.directory:
            self.init_directory()

        dossier = os.path.join(self.directory, f"{name}_{strftime('%Y%m%d_%H%M%S')}")
        os.makedirs(dossier, exist_ok=True)

        debut = time()
        prochaine = debut
        i = 0
        try:
            while duration is None or time() - debut < duration:
                pic = self.instant_pic()
                if isinstance(pic, bytes):
                    with open(os.path.join(dossier, f"{i:06d}.jpg"), "wb") as f:
                        f.write(pic)
                    i += 1
                # on retire le temps déjà pris par la photo : le rythme reste régulier
                prochaine += interval
                sleep(max(0, prochaine - time()))
        except KeyboardInterrupt:
            pass  # Ctrl+C pour arrêter l'enregistrement

        return dossier

    # ----- enregistrement vidéo (.mp4) ------------------------------------
    # ffmpeg encode les images en MP4 (H.264), lisible dans un navigateur. Il tourne dans un
    # processus à part : start_record() rend la main tout de suite.
    #   - vidéo temps réel : ffmpeg lit lui-même le flux de la caméra, à son vrai rythme
    #   - timelapse        : un thread prend une photo toutes les N s et l'envoie à ffmpeg ;
    #                        chaque photo devient une image de la vidéo finale (30 images/s)
    # Le MP4 est "fragmenté" : même si le programme est coupé brutalement, la vidéo reste lisible.
    # Nécessite :  pip install imageio-ffmpeg   (fournit ffmpeg, rien d'autre à installer)

    TIMELAPSE_FPS = 30      # images par seconde de la vidéo timelapse finale

    def start_record(self, name="impression", timelapse=None):
        """Démarre l'enregistrement dans image/videos/<name>_<date>.mp4.
        timelapse=None -> vidéo en temps réel
        timelapse=10   -> une photo toutes les 10 s, rejouées à 30 images/s (1 h d'impression ≈ 12 s)
        """
        if self.is_recording():
            return {"error": "un enregistrement est déjà en cours"}
        if self._record:
            self._fin_record()      # le précédent s'est arrêté tout seul (flux coupé...) : on le range
        try:
            import imageio_ffmpeg
            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            return {"error": "ffmpeg introuvable : pip install imageio-ffmpeg"}
        if timelapse is not None and float(timelapse) <= 0:
            return {"error": "timelapse doit être un nombre de secondes positif"}

        os.makedirs(config.VIDEO_DIR, exist_ok=True)
        fichier = os.path.join(config.VIDEO_DIR, f"{name}_{strftime('%Y%m%d_%H%M%S')}.mp4")

        if timelapse:
            # entrée : les photos envoyées par _boucle_timelapse, une image chacune
            entree = ["-f", "image2pipe", "-framerate", str(self.TIMELAPSE_FPS), "-i", "-"]
        else:
            # entrée : flux MJPEG de la caméra, horodaté à l'heure réelle de réception,
            # avec reconnexion automatique si le WiFi coupe pendant une longue impression
            entree = ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "30",
                      "-use_wallclock_as_timestamps", "1", "-f", "mpjpeg", "-i", self.get_stream_url()]
        commande = [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *entree,
            # sortie : H.264 léger, dans un format lu par tous les navigateurs
            "-vf", "scale=out_range=tv,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast",
            "-crf", "28", "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
            fichier,
        ]
        journal = open(fichier + ".log", "wb")      # messages d'erreur de ffmpeg
        process = subprocess.Popen(
            commande, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=journal,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),   # pas de fenêtre sous Windows
        )
        self._record = {"process": process, "journal": journal, "fichier": fichier,
                        "timelapse": timelapse, "debut": time(), "images": 0,
                        "arret": threading.Event(), "thread": None}
        atexit.register(self.stop_record)      # la vidéo est finalisée même si le programme s'arrête

        if timelapse:
            thread = threading.Thread(target=self._boucle_timelapse, args=(self._record,), daemon=True)
            self._record["thread"] = thread
            thread.start()

        # ffmpeg s'arrête tout de suite si le flux est inaccessible : on le vérifie
        sleep(1.5)
        if process.poll() is not None:
            return {"error": "ffmpeg s'est arrêté", "detail": self._fin_record().get("detail")}
        return self.record_status()

    def _boucle_timelapse(self, rec):
        # prend une photo toutes les `timelapse` secondes et l'envoie à ffmpeg, jusqu'à l'arrêt
        intervalle = float(rec["timelapse"])
        prochaine = time()
        while not rec["arret"].is_set():
            pic = self.instant_pic()
            if isinstance(pic, bytes):
                try:
                    rec["process"].stdin.write(pic)
                    rec["images"] += 1
                except OSError:
                    return      # ffmpeg s'est arrêté
            # rythme régulier : on retire le temps déjà pris par la photo (≈ 3 s sur cette caméra) ;
            # wait() se réveille tout de suite si on demande l'arrêt
            prochaine += intervalle
            rec["arret"].wait(max(0, prochaine - time()))

    def stop_record(self):
        """Arrête l'enregistrement et finalise la vidéo. Retourne {"fichier", "duree", "taille"}."""
        if not self._record:
            return {"error": "aucun enregistrement en cours"}
        rec = self._record
        rec["arret"].set()
        if rec["thread"]:
            rec["thread"].join(timeout=15)      # laisse finir la photo en cours
        process = rec["process"]
        if process.poll() is None:
            try:
                if rec["timelapse"]:
                    process.stdin.close()       # plus de photos : ffmpeg termine la vidéo
                else:
                    process.stdin.write(b"q")   # "q" = arrêt propre de ffmpeg
                    process.stdin.flush()
                process.wait(timeout=30)
            except Exception:
                process.terminate()             # le MP4 fragmenté reste lisible
                process.wait(timeout=10)
        return self._fin_record()

    def _fin_record(self):
        # range l'enregistrement terminé : ferme le journal, supprime les fichiers vides
        rec = self._record
        self._record = None
        rec["arret"].set()          # stoppe le thread timelapse s'il tourne encore
        atexit.unregister(self.stop_record)
        rec["journal"].close()
        log = rec["fichier"] + ".log"
        with open(log, "rb") as f:
            erreurs = f.read().decode(errors="replace").strip()
        os.remove(log)

        taille = os.path.getsize(rec["fichier"]) if os.path.isfile(rec["fichier"]) else 0
        resultat = {"fichier": rec["fichier"], "duree": round(time() - rec["debut"]), "taille": taille}
        if not taille:
            if os.path.isfile(rec["fichier"]):
                os.remove(rec["fichier"])       # vidéo vide : inutile de la garder
            resultat = {"error": "aucune image enregistrée", "detail": erreurs[-300:] or None}
        return resultat

    def is_recording(self):
        return bool(self._record) and self._record["process"].poll() is None

    def record_status(self):
        # {"recording": bool, "fichier", "timelapse", "duree" (s), "images" (timelapse)}
        if not self.is_recording():
            return {"recording": False}
        rec = self._record
        return {"recording": True, "fichier": os.path.basename(rec["fichier"]),
                "timelapse": rec["timelapse"], "duree": round(time() - rec["debut"]),
                "images": rec["images"] if rec["timelapse"] else None}
