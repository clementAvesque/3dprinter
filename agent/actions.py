"""Exécution des commandes de la liste fermée sur une machine, avec la librairie client_printer.

Chaque action retourne un dict :
  {"ok": True, "resultat": ...}                         réponse simple
  {"ok": True, "resultat": ..., "octets": b"...", "mime"}   + un fichier à transférer (miniature, aperçu 3D...)
  {"ok": True, "chemin": "...", "mime"}                  + un fichier du disque à transférer (vidéo)
  {"ok": False, "erreur": "...", "detail": "..."}
Aucune action ne lance de commande système : seules les méthodes de la librairie sont appelées.
"""

import mimetypes
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from client_printer import Printer, config as lib_config   # noqa: E402
from client_printer.utils import gcode                     # noqa: E402


def _res(r, defaut=None):
    # les méthodes de la librairie renvoient {"error": ...} en cas de problème
    if isinstance(r, dict) and r.get("error"):
        detail = r.get("detail")
        return {"ok": False, "erreur": "machine",
                "detail": f"{r['error']} : {detail}" if detail else str(r["error"])}
    return {"ok": True, "resultat": r if r is not None else defaut}


class Machine:
    """Une imprimante pilotée par l'agent."""

    def __init__(self, id, ip, nom, options):
        self.id = id
        self.ip = ip
        self.nom = nom
        self.options = options
        self.printer = Printer(ip)               # synchronise aussi les gcodes de la machine au démarrage
        self.printer.set_auto_record(options.get("enregistrement_auto", True),
                                     options.get("enregistrement_timelapse", 10))
        self.verrou = threading.Lock()           # une seule opération courte à la fois sur la machine
        self.flux_video = False                  # le serveur demande les images de la caméra

    # ------------------------------------------------------------ état (toutes les 2 s)

    def etat(self):
        with self.verrou:
            data = self.printer.data_print(with_image=False)
            return {
                **self.printer.to_dict(),
                "print": None if data.get("error") else data,
                "enregistrement": self.printer.camera.record_status(),
                "dernier_enregistrement": self.printer.dernier_enregistrement,
            }

    def fichiers(self):
        # liste compacte (pas de chemins du PC)
        return [{
            "nom": nom,
            "taille_octets": e.get("taille_octets"),
            "temps_estime": e.get("temps_estime"),
            "poids": e.get("poids"),
            "filament": e.get("filament"),
            "miniature": bool(e.get("miniature")),
        } for nom, e in sorted(self.printer.gcodes().items())]

    # ------------------------------------------------------------ commandes

    def executer(self, action, p):
        """Exécute une action DÉJÀ validée (protocole.valider). Bloquant : appelé dans un thread."""
        pr = self.printer
        limites = self.options.get("limites", {})
        longues = {"print.start", "move.home", "filament.load", "filament.unload", "files.sync"}
        if action in longues:
            return self._executer(action, p, pr, limites)
        with self.verrou:
            return self._executer(action, p, pr, limites)

    def _executer(self, action, p, pr, limites):
        if action == "print.start":
            if p.get("emplacement"):
                r = pr.init_print(filename=p["fichier"], use_ace=True, slot=p["emplacement"])
            else:
                r = pr.init_print(filename=p["fichier"])
            if r.get("error"):
                return _res(r)
            return _res(pr.start_print())
        if action == "print.pause":
            return _res(pr.pause())
        if action == "print.resume":
            return _res(pr.restart())
        if action == "print.cancel":
            return _res(pr.cancel())
        if action == "print.speed":
            return _res(pr.set_speed(p["percent"]))
        if action == "print.flow":
            return _res(pr.set_flow(p["percent"]))
        if action == "temperature.set":
            maxi = limites.get("buse_max", 300) if p["cible"] == "buse" else limites.get("plateau_max", 110)
            if p["temp"] > maxi:
                return {"ok": False, "erreur": "limite_agent", "detail": f"{maxi} °C maximum sur cet agent"}
            chauffe = pr.nozzle if p["cible"] == "buse" else pr.bed
            return _res(chauffe.set_target_temp(p["temp"]))
        if action == "move.home":
            return _res(pr.nozzle.home(p.get("axes", "")))
        if action == "move.jog":
            axes = {a: p[a] for a in ("x", "y", "z") if a in p}
            return _res(pr.nozzle.move(relative=p.get("relatif", True), **axes))
        if action == "motors.off":
            return _res(pr.disable_motors())
        if action == "fan.set":
            return _res(pr.set_ventilo(p["percent"]))
        if action == "light.set":
            return _res(pr.light(p["on"]))
        if action == "filament.load":
            return _res(pr.load_filament(slot=p.get("emplacement"), temp=p.get("temp", 220)))
        if action == "filament.unload":
            return _res(pr.unload_filament(slot=p.get("emplacement"), temp=p.get("temp", 220)))
        if action == "ace.dry.start":
            return _res(pr.ace.start_dry(p["temp"], p["duree"]))
        if action == "ace.dry.stop":
            return _res(pr.ace.stop_dry())
        if action == "gcode.raw":
            if not self.options.get("console_gcode", False):
                return {"ok": False, "erreur": "console_desactivee",
                        "detail": "console gcode désactivée dans la configuration de l'agent"}
            return _res(gcode(self.ip, p["script"], timeout=30))

        if action == "files.list":
            return {"ok": True, "resultat": self.fichiers()}
        if action == "files.sync":
            r = pr.sync_printer_files()
            return _res(r) if isinstance(r, dict) else {"ok": True, "resultat": {"fichiers": len(r)}}
        if action == "file.delete":
            return _res(pr.delete_gcode(p["fichier"]))
        if action == "file.thumbnail":
            chemin = (pr.gcodes().get(p["fichier"]) or {}).get("miniature")
            if not chemin or not os.path.isfile(chemin):
                return {"ok": False, "erreur": "pas_de_miniature"}
            with open(chemin, "rb") as f:
                return {"ok": True, "resultat": None, "octets": f.read(),
                        "mime": mimetypes.guess_type(chemin)[0] or "image/png"}
        if action == "file.toolpath":
            r = pr.toolpath(p["fichier"])
            if isinstance(r, dict):
                return _res(r)
            meta, chemin_bin = r
            with open(chemin_bin, "rb") as f:
                return {"ok": True, "resultat": meta, "octets": f.read(), "mime": "application/octet-stream"}

        if action == "camera.snapshot":
            pic = pr.camera.instant_pic()
            if not isinstance(pic, bytes):
                return _res(pic)
            return {"ok": True, "resultat": None, "octets": pic, "mime": "image/jpeg"}
        if action == "camera.stream":
            self.flux_video = p["actif"]
            return {"ok": True, "resultat": {"actif": self.flux_video}}
        if action == "record.start":
            r = pr.camera.start_record(name="enregistrement", timelapse=p.get("timelapse"))
            if not r.get("error"):
                pr.dernier_enregistrement = None
            return _res(r)
        if action == "record.stop":
            r = pr.camera.stop_record()
            pr.dernier_enregistrement = r
            return _res(r)
        if action == "record.auto":
            return _res(pr.set_auto_record(p["actif"], p.get("timelapse")))
        if action == "record.list":
            return {"ok": True, "resultat": self._videos()}
        if action == "record.download":
            chemin = self._video(p["nom"])
            if not chemin:
                return {"ok": False, "erreur": "video_introuvable"}
            return {"ok": True, "resultat": None, "chemin": chemin, "mime": "video/mp4"}
        if action == "record.delete":
            if p["nom"] == pr.camera.record_status().get("fichier"):
                return {"ok": False, "erreur": "enregistrement_en_cours", "detail": "arrête d'abord l'enregistrement"}
            chemin = self._video(p["nom"])
            if not chemin:
                return {"ok": False, "erreur": "video_introuvable"}
            os.remove(chemin)
            return {"ok": True, "resultat": None}

        if action == "history.machine":
            return _res(pr.historique_machine())
        return {"ok": False, "erreur": "commande_non_geree"}

    # ------------------------------------------------------------ vidéos enregistrées

    def _video(self, nom):
        # chemin d'une vidéo DANS le dossier des vidéos (le nom est déjà validé : pas de / ni de ..)
        dossier = os.path.realpath(lib_config.VIDEO_DIR)
        chemin = os.path.realpath(os.path.join(dossier, nom))
        if os.path.dirname(chemin) != dossier or not os.path.isfile(chemin):
            return None
        return chemin

    def _videos(self):
        en_cours = self.printer.camera.record_status().get("fichier")
        videos = []
        if os.path.isdir(lib_config.VIDEO_DIR):
            for nom in os.listdir(lib_config.VIDEO_DIR):
                chemin = os.path.join(lib_config.VIDEO_DIR, nom)
                if nom.endswith(".mp4") and os.path.isfile(chemin):
                    videos.append({"nom": nom, "taille": os.path.getsize(chemin),
                                   "date": os.path.getmtime(chemin), "en_cours": nom == en_cours})
        return sorted(videos, key=lambda v: v["date"], reverse=True)

    def recevoir_gcode(self, chemin_tmp):
        """Range un gcode reçu du serveur (déjà vérifié : taille et SHA-256) comme upload_gcode().
        Sans le verrou : l'envoi vers l'imprimante est long et ne doit pas bloquer l'état."""
        return _res(self.printer.upload_gcode(chemin_tmp))
