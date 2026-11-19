"""Petit serveur web pour piloter l'imprimante avec la librairie client_printer.

    python app.py                        # imprimante 192.168.1.42 -> http://127.0.0.1:5000
    python app.py 192.168.1.50           # autre IP d'imprimante
    python app.py 192.168.1.50 --lan     # interface accessible depuis un téléphone du même réseau

Fonctionnement :
  - un thread lit l'imprimante toutes les 2 s et garde la dernière photo de l'état en mémoire ;
    le front lit cette photo (/api/state) : c'est instantané, même avec plusieurs onglets ouverts.
  - les commandes courtes (pause, température, vitesse...) répondent tout de suite.
  - les commandes longues (home, chargement filament, lancement d'un print...) tournent en tâche
    de fond : la requête répond 202 tout de suite, le front suit la tâche via /api/state.
"""

import argparse
import os
import sys
import threading
import time

from flask import Flask, Response, jsonify, render_template, request, send_file, send_from_directory
from werkzeug.utils import secure_filename

# rend le package client_printer importable (il est dans le dossier parent)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from client_printer import Printer, config  # noqa: E402
from client_printer.utils import gcode      # noqa: E402

app = Flask(__name__)

printer = None                  # créé dans main()
verrou = threading.Lock()       # une seule opération courte à la fois sur l'imprimante
etat = {"data": None}           # dernière photo de l'état (remplie par boucle_update)
tache = {"nom": None, "en_cours": False, "resultat": None, "debut": None, "fin": None}
tache_verrou = threading.Lock()
# enregistrement vidéo : auto_stop = arrêter tout seul à la fin de l'impression
# (le résultat du dernier enregistrement est dans printer.dernier_enregistrement)
enregistrement = {"auto_stop": False, "vu_impression": False}


# ---------------------------------------------------------------------------
# Outils
# ---------------------------------------------------------------------------

def boucle_update(interval=2):
    # lit l'imprimante en boucle (1 requête par tour) et garde le résultat en mémoire
    while True:
        with verrou:
            data = printer.data_print(with_image=False)
            photo = {
                **printer.to_dict(),
                "print": None if data.get("error") else data,
                "maj": time.time(),
            }
        etat["data"] = photo
        verifier_enregistrement()
        time.sleep(interval)


def verifier_enregistrement():
    # arrêt automatique de l'enregistrement quand l'impression se termine (si auto_stop)
    if not enregistrement["auto_stop"] or not printer.camera.is_recording():
        return
    if printer.state_printer.state in ("PRINTING", "BREAK"):
        enregistrement["vu_impression"] = True
    elif enregistrement["vu_impression"]:
        # l'impression vient de finir : on arrête (dans un thread, la finalisation prend quelques s)
        enregistrement["auto_stop"] = False
        threading.Thread(target=arreter_enregistrement, daemon=True).start()


def arreter_enregistrement():
    # même case que l'enregistrement automatique de la librairie : le front n'en lit qu'une
    printer.dernier_enregistrement = printer.camera.stop_record()
    return printer.dernier_enregistrement


def repondre(res):
    # les fonctions de la librairie renvoient un dict avec "error" en cas de problème
    if isinstance(res, dict) and res.get("error"):
        return jsonify(res), 400
    return jsonify(res if res is not None else {"result": "ok"})


def court(fonction, *args, **kwargs):
    # commande courte : exécutée tout de suite, réponse directe
    with verrou:
        return repondre(fonction(*args, **kwargs))


def lancer_tache(nom, fonction, *args, **kwargs):
    # commande longue : exécutée en tâche de fond, une seule à la fois
    with tache_verrou:
        if tache["en_cours"]:
            return jsonify({"error": f"une action est déjà en cours : {tache['nom']}"}), 409
        tache.update(nom=nom, en_cours=True, resultat=None, debut=time.time(), fin=None)

    def travail():
        try:
            res = fonction(*args, **kwargs)
        except Exception as e:      # on ne veut jamais bloquer la tâche en "en cours"
            res = {"error": f"erreur interne : {e}"}
        tache.update(en_cours=False, resultat=res, fin=time.time())

    threading.Thread(target=travail, daemon=True).start()
    return jsonify({"tache": nom}), 202


def corps():
    return request.get_json(silent=True) or {}


def nombre(donnees, cle, defaut=None):
    # lit un nombre dans le JSON reçu ; lève ValueError si absent ou invalide
    valeur = donnees.get(cle, defaut)
    if valeur is None or valeur == "":
        raise ValueError(f"'{cle}' manquant")
    return float(valeur)


@app.errorhandler(ValueError)
def valeur_invalide(e):
    return jsonify({"error": f"valeur invalide : {e}"}), 400


# ---------------------------------------------------------------------------
# Lecture
# ---------------------------------------------------------------------------

@app.get("/")
def index():
    return render_template("index.html", ip=printer.url, page="accueil")


@app.get("/suivi")
def page_suivi():
    # suivi 3D de l'impression en cours, couche par couche
    return render_template("suivi.html", ip=printer.url, page="suivi")


@app.get("/galerie")
def page_galerie():
    # tous les gcodes : miniatures, infos, aperçu 3D, historique
    return render_template("galerie.html", ip=printer.url, page="galerie")


@app.get("/api/toolpath/<path:nom>")
def api_toolpath(nom):
    # couches et infos de l'aperçu 3D ; les segments eux-mêmes sont dans /api/toolpath-bin/<nom>
    # (premier appel sur un gros fichier : quelques secondes de lecture, ensuite en cache)
    res = printer.toolpath(nom)
    if isinstance(res, dict):
        return jsonify(res), 404
    return jsonify(res[0])


@app.get("/api/toolpath-bin/<path:nom>")
def api_toolpath_bin(nom):
    res = printer.toolpath(nom)
    if isinstance(res, dict):
        return jsonify(res), 404
    return send_file(res[1], mimetype="application/octet-stream", max_age=3600)


@app.get("/api/state")
def api_state():
    return jsonify({
        "etat": etat["data"],
        "tache": tache,
        "synchro": getattr(printer, "sync_status", None),   # récupération des gcodes de la machine
        "enregistrement": {**printer.camera.record_status(),
                           "auto_stop": enregistrement["auto_stop"],
                           "dernier": printer.dernier_enregistrement,
                           # enregistrement automatique de chaque impression (librairie)
                           "auto": printer.auto_record},
    })


@app.get("/api/camera")
def api_camera():
    # une photo (le flux vidéo, lui, est lu directement sur l'imprimante : voir /api/camera/stream)
    pic = printer.camera.instant_pic()
    if not isinstance(pic, bytes):
        return jsonify(pic), 503
    return Response(pic, mimetype="image/jpeg", headers={"Cache-Control": "no-store"})


@app.get("/api/camera/stream")
def api_camera_stream():
    # adresse du flux vidéo MJPEG ; le navigateur l'affiche directement dans un <img>,
    # sans passer par ce serveur (une seule connexion, pas de charge en plus pour Flask)
    url = printer.camera.get_stream_url()
    # réglage perdu à chaque redémarrage de l'imprimante : on le remet à chaque ouverture du flux
    # (en arrière-plan, pour ne pas retarder l'affichage) ; sans lui la caméra tombe à 0,2 image/s
    threading.Thread(target=printer.camera.fast_mode, daemon=True).start()
    return jsonify({"stream_url": url})


# ---------------------------------------------------------------------------
# Enregistrement vidéo
# ---------------------------------------------------------------------------

@app.post("/api/record/start")
def api_record_start():
    # {"timelapse": 10 ou null (temps réel), "auto_stop": true}
    d = corps()
    timelapse = nombre(d, "timelapse") if d.get("timelapse") else None

    # nom de la vidéo : le fichier en cours d'impression, sinon "enregistrement"
    imprime = (etat["data"] or {}).get("print") or {}
    nom = os.path.splitext(os.path.basename(imprime.get("filename") or ""))[0]
    if printer.state_printer.state not in ("PRINTING", "BREAK") or not nom:
        nom = "enregistrement"

    res = printer.camera.start_record(name=secure_filename(nom) or "enregistrement", timelapse=timelapse)
    if not res.get("error"):
        enregistrement.update(auto_stop=bool(d.get("auto_stop", True)), vu_impression=False)
        printer.dernier_enregistrement = None
    return repondre(res)


@app.put("/api/record/auto")
def api_record_auto():
    # {"actif": true, "timelapse": 10 ou null (temps réel)} : enregistrer chaque impression
    d = corps()
    timelapse = nombre(d, "timelapse") if d.get("timelapse") else None
    return repondre(printer.set_auto_record(bool(d.get("actif", True)), timelapse))


@app.post("/api/record/stop")
def api_record_stop():
    enregistrement["auto_stop"] = False
    return repondre(arreter_enregistrement())


@app.get("/api/recordings")
def api_recordings():
    # vidéos enregistrées, les plus récentes d'abord
    en_cours = printer.camera.record_status().get("fichier")
    videos = []
    if os.path.isdir(config.VIDEO_DIR):
        for nom in os.listdir(config.VIDEO_DIR):
            chemin = os.path.join(config.VIDEO_DIR, nom)
            if nom.endswith(".mp4") and os.path.isfile(chemin):
                videos.append({"nom": nom, "taille": os.path.getsize(chemin),
                               "date": os.path.getmtime(chemin), "en_cours": nom == en_cours})
    # la vidéo en cours n'existe sur le disque qu'après les premières images : on l'affiche quand même
    if en_cours and not any(v["nom"] == en_cours for v in videos):
        videos.append({"nom": en_cours, "taille": 0, "date": time.time(), "en_cours": True})
    return jsonify(sorted(videos, key=lambda v: v["date"], reverse=True))


@app.get("/recordings/<path:nom>")
def recording_file(nom):
    # send_from_directory refuse les chemins qui sortent du dossier, et gère l'avance rapide (Range)
    return send_from_directory(config.VIDEO_DIR, nom)


@app.delete("/api/recordings/<path:nom>")
def api_recording_delete(nom):
    if nom == printer.camera.record_status().get("fichier"):
        return jsonify({"error": "arrête d'abord l'enregistrement"}), 409
    chemin = os.path.join(config.VIDEO_DIR, secure_filename(nom))
    if not nom.endswith(".mp4") or not os.path.isfile(chemin):
        return jsonify({"error": "vidéo introuvable"}), 404
    os.remove(chemin)
    return jsonify({"result": "ok"})


@app.get("/api/history")
def api_history():
    return jsonify({
        "temp": printer.historique_temp()[-240:],   # ~4 min avec un update toutes les 2 s
        "prints": printer.historique_print(),
    })


@app.get("/api/history/machine")
def api_history_machine():
    # historique de l'imprimante (tous les prints, terminés ou annulés)
    res = printer.historique_machine()
    if isinstance(res, dict):
        return jsonify(res), 503
    return jsonify(res)


@app.get("/api/gcodes")
def api_gcodes():
    return jsonify(printer.gcodes())


@app.get("/api/gcodes/files")
def api_gcode_files():
    # [{"nom", "miniature" (data URL), "poids_octets", "poids_grammes", "temps_estime"}]
    # ?images=0 pour ne pas inclure les miniatures
    return jsonify(printer.gcode_files(with_image=request.args.get("images") != "0"))


@app.get("/api/gcodes/thumb/<path:nom>")
def api_gcode_thumb(nom):
    # miniature d'un gcode connu (chemin lu dans l'index, jamais construit depuis l'URL)
    chemin = (printer.gcodes().get(nom) or {}).get("miniature")
    if not chemin or not os.path.isfile(chemin):
        return jsonify({"error": "pas de miniature"}), 404
    return send_file(chemin, max_age=3600)


@app.delete("/api/gcodes/<path:nom>")
def api_gcode_delete(nom):
    # suppression définitive : imprimante + PC (gcode, miniature, aperçu 3D, index)
    # ?local=1 : seulement sur ce PC
    return court(printer.delete_gcode, nom, sur_imprimante=request.args.get("local") != "1")


@app.post("/api/gcodes/sync")
def api_gcode_sync():
    # relance la récupération des gcodes présents sur la machine
    return lancer_tache("récupération des fichiers de la machine", printer.sync_printer_files)


# ---------------------------------------------------------------------------
# Fichiers et impression
# ---------------------------------------------------------------------------

@app.post("/api/gcodes")
def api_upload():
    fichier = request.files.get("file")
    if not fichier or not fichier.filename:
        return jsonify({"error": "aucun fichier reçu"}), 400
    nom = secure_filename(fichier.filename)
    if not nom.lower().endswith(".gcode"):
        return jsonify({"error": "le fichier doit être un .gcode"}), 400

    # enregistré directement dans le dossier gcode/ de la librairie : upload_gcode() n'a rien à copier
    os.makedirs(printer.gcode_dir, exist_ok=True)
    chemin = os.path.join(printer.gcode_dir, nom)
    fichier.save(chemin)
    return lancer_tache(f"envoi de {nom}", printer.upload_gcode, chemin)


def demarrer(filename, slot):
    if slot:
        res = printer.init_print(filename=filename, use_ace=True, slot=slot)
    else:
        res = printer.init_print(filename=filename)
    if res.get("error"):
        return res
    return printer.start_print()


@app.post("/api/print/start")
def api_print_start():
    d = corps()
    if not d.get("filename"):
        return jsonify({"error": "choisis un fichier"}), 400
    slot = int(d["slot"]) if d.get("slot") else None
    return lancer_tache(f"lancement de {d['filename']}", demarrer, d["filename"], slot)


@app.post("/api/print/pause")
def api_pause():
    return court(printer.pause)


@app.post("/api/print/resume")
def api_resume():
    return court(printer.restart)


@app.post("/api/print/cancel")
def api_cancel():
    return court(printer.cancel)


@app.post("/api/speed")
def api_speed():
    return court(printer.set_speed, nombre(corps(), "percent"))


@app.post("/api/flow")
def api_flow():
    return court(printer.set_flow, nombre(corps(), "percent"))


# ---------------------------------------------------------------------------
# Températures, ventilateur, lumière
# ---------------------------------------------------------------------------

@app.post("/api/temperature")
def api_temperature():
    d = corps()
    chauffe = {"nozzle": printer.nozzle, "bed": printer.bed}.get(d.get("cible"))
    if chauffe is None:
        return jsonify({"error": "cible doit valoir 'nozzle' ou 'bed'"}), 400
    return court(chauffe.set_target_temp, nombre(d, "temp"))


@app.post("/api/fan")
def api_fan():
    return court(printer.set_ventilo, nombre(corps(), "percent"))


@app.post("/api/light")
def api_light():
    return court(printer.light, bool(corps().get("on", True)))


# ---------------------------------------------------------------------------
# Mouvements et filament
# ---------------------------------------------------------------------------

@app.post("/api/home")
def api_home():
    axes = str(corps().get("axes", "")).upper()
    if any(a not in "XYZ" for a in axes):
        return jsonify({"error": "axes doit contenir seulement X, Y, Z"}), 400
    return lancer_tache(f"home {axes or 'XYZ'}", printer.nozzle.home, axes)


@app.post("/api/move")
def api_move():
    d = corps()
    axes = {a: float(d[a]) for a in ("x", "y", "z") if d.get(a) not in (None, "")}
    return court(printer.nozzle.move, relative=bool(d.get("relative", True)), **axes)


@app.post("/api/motors/off")
def api_motors_off():
    return court(printer.disable_motors)


@app.post("/api/extrude")
def api_extrude():
    longueur = nombre(corps(), "length")
    if longueur >= 0:
        return lancer_tache(f"extrusion {longueur:g} mm", printer.nozzle.extrude, longueur)
    return lancer_tache(f"rétraction {-longueur:g} mm", printer.nozzle.retract, -longueur)


@app.post("/api/filament/<action>")
def api_filament(action):
    d = corps()
    slot = int(d["slot"]) if d.get("slot") else None
    temp = nombre(d, "temp", 220)
    if action == "load":
        return lancer_tache("chargement du filament", printer.load_filament, slot=slot, temp=temp)
    if action == "unload":
        return lancer_tache("déchargement du filament", printer.unload_filament, slot=slot, temp=temp)
    return jsonify({"error": "action inconnue"}), 404


@app.post("/api/ace/dry")
def api_ace_dry():
    d = corps()
    return court(printer.ace.start_dry, nombre(d, "temp", 50), nombre(d, "duration", 240))


@app.post("/api/ace/dry/stop")
def api_ace_dry_stop():
    return court(printer.ace.stop_dry)


@app.post("/api/gcode")
def api_gcode():
    script = str(corps().get("script", "")).strip()
    if not script:
        return jsonify({"error": "commande vide"}), 400
    return court(gcode, printer.url, script, timeout=30)


# ---------------------------------------------------------------------------

def main():
    global printer
    ap = argparse.ArgumentParser(description="Interface web de l'imprimante")
    ap.add_argument("ip", nargs="?", default="192.168.1.42", help="IP de l'imprimante")
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--lan", action="store_true",
                    help="écoute sur tout le réseau local (sinon seulement ce PC)")
    args = ap.parse_args()

    printer = Printer(args.ip)
    threading.Thread(target=boucle_update, daemon=True).start()

    hote = "0.0.0.0" if args.lan else "127.0.0.1"
    print(f"Imprimante {args.ip} -> interface sur http://{'<ip de ce PC>' if args.lan else '127.0.0.1'}:{args.port}")
    app.run(host=hote, port=args.port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
