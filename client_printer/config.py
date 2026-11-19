"""Constantes et chemins du projet (aucune logique ici)."""

import os

# dossier de la librairie (celui qui contient ce fichier)
ROOT = os.path.dirname(os.path.abspath(__file__))

GCODE_DIR = os.path.join(ROOT, "gcode")
IMAGE_DIR = os.path.join(ROOT, "image")
DATA_DIR = os.path.join(ROOT, "data")
THUMB_DIR = os.path.join(IMAGE_DIR, "miniatures")     # miniatures des gcodes
VIDEO_DIR = os.path.join(IMAGE_DIR, "videos")         # enregistrements .mp4 (Camera.start_record)
TOOLPATH_DIR = os.path.join(DATA_DIR, "trajets")       # cache des aperçus 3D (voir toolpath.py)

# extensions reconnues comme gcode sur l'imprimante
GCODE_EXTENSIONS = (".gcode", ".g", ".gco")

TEMP_HISTORY_FILE = os.path.join(DATA_DIR, "historique_temp.json")
FAN_HISTORY_FILE = os.path.join(DATA_DIR, "historique_ventilo.json")
PRINT_HISTORY_FILE = os.path.join(DATA_DIR, "historique_print.json")
GCODE_INDEX_FILE = os.path.join(DATA_DIR, "gcode_index.json")

MOONRAKER_PORT = 7125
# adresses de la caméra (photo / flux vidéo), utilisées seulement si Moonraker ne les donne pas
# (normalement elles sont lues dans /server/webcams/list, voir Camera.find_urls)
CAMERA_SNAPSHOT_PATH = "/webcam/?action=snapshot"
CAMERA_STREAM_PATH = "/webcam/?action=stream"

# enregistrement vidéo automatique de chaque impression (voir Printer.set_auto_record)
# timelapse : une photo toutes les N secondes ; None = vidéo en temps réel (fichiers bien plus gros)
AUTO_RECORD = True
AUTO_RECORD_TIMELAPSE = 10

# historiques fréquents (températures, ventilateur) : écriture disque groupée
# toutes les N secondes au lieu d'une écriture à chaque update()
HISTORY_FLUSH_SECONDS = 30
