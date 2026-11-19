"""Fonctions utilitaires partagées par toutes les classes (pas de classe ici).

Réseau : toutes les fonctions retournent un dict -> la réponse de l'imprimante, ou {"error": ...}.
Elles ne lèvent jamais d'exception : on teste simplement `if res.get("error")`.
"""

import json
import os
import time

from .config import MOONRAKER_PORT

_session = None


def _get_session():
    # UNE seule session HTTP pour toute la librairie : la connexion TCP vers l'imprimante
    # est réutilisée (keep-alive) au lieu d'être rouverte à chaque requête.
    # `requests` est importé ici, au premier appel, et pas au démarrage du programme.
    global _session
    if _session is None:
        import requests
        _session = requests.Session()
        # ignore les proxys / .netrc du système : inutiles sur le réseau local,
        # et leur détection peut être lente sous Windows
        _session.trust_env = False
    return _session


# ---------------------------------------------------------------------------
# Réseau
# ---------------------------------------------------------------------------

def req_send(method, url, timeout=10, **kwargs):
    # requête GET / POST / DELETE ; retourne le JSON de la réponse ou {"error": ...}
    try:
        reponse = _get_session().request(method, url, timeout=timeout, **kwargs)
    except Exception:
        return {"error": "fail connexion"}

    if 200 <= reponse.status_code < 300:
        try:
            return reponse.json()
        except ValueError:
            return {"result": "ok"}

    erreur = {"error": f"HTTP {reponse.status_code}"}
    try:
        erreur["detail"] = reponse.json()["error"]["message"]   # ex. "Must home axis first"
    except Exception:
        pass
    return erreur


def req(url, timeout=5):
    # GET simple
    return req_send("GET", url, timeout=timeout)


def req_bytes(url, timeout=5):
    # GET qui retourne le contenu brut (ex. une image), ou {"error": ...}
    try:
        reponse = _get_session().get(url, timeout=timeout)
    except Exception:
        return {"error": "fail connexion"}
    if reponse.status_code == 200:
        return reponse.content
    return {"error": f"HTTP {reponse.status_code}"}


def req_download(url, chemin, timeout=30):
    # télécharge un fichier directement sur le disque, par morceaux (un gcode peut peser
    # plusieurs dizaines de Mo : on ne le charge jamais entier en mémoire).
    # écrit dans un .part puis renomme : un téléchargement coupé ne laisse pas de fichier tronqué.
    # retourne {"result": chemin} ou {"error": ...}
    os.makedirs(os.path.dirname(chemin), exist_ok=True)
    tmp = chemin + ".part"
    try:
        with _get_session().get(url, timeout=timeout, stream=True) as reponse:
            if reponse.status_code != 200:
                return {"error": f"HTTP {reponse.status_code}"}
            with open(tmp, "wb") as f:
                for bloc in reponse.iter_content(64 * 1024):
                    f.write(bloc)
        os.replace(tmp, chemin)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return {"error": "fail connexion"}
    return {"result": chemin}


def gcode(ip, script, timeout=10):
    # envoie un script gcode à l'imprimante
    # timeout à augmenter pour les commandes bloquantes (M109, M190, G28...)
    return req_send("POST", f"http://{ip}:{MOONRAKER_PORT}/printer/gcode/script",
                    params={"script": script}, timeout=timeout)


def query_status(ip, objets):
    # lit l'état de plusieurs objets Klipper en UNE requête.
    # objets : {"extruder": ["temperature", "target"], "filament_hub": None}  (None = tous les champs)
    # retourne le dict "status" de Klipper, ou {"error": ...}
    query = "&".join(
        nom if champs is None else f"{nom}={','.join(champs)}"
        for nom, champs in objets.items()
    )
    data = req(f"http://{ip}:{MOONRAKER_PORT}/printer/objects/query?{query}")
    if data.get("error"):
        return data
    return data.get("result", {}).get("status", {})


def merge_queries(*requetes):
    # fusionne plusieurs dicts de query_status() en un seul (sans doublons)
    # merge_queries({"toolhead": ["position"]}, {"toolhead": ["homed_axes"]})
    #   -> {"toolhead": ["position", "homed_axes"]}
    resultat = {}
    for requete in requetes:
        for nom, champs in requete.items():
            if nom not in resultat:
                resultat[nom] = None if champs is None else list(champs)
            elif resultat[nom] is None or champs is None:
                resultat[nom] = None        # None = tous les champs, ça englobe le reste
            else:
                resultat[nom] += [c for c in champs if c not in resultat[nom]]
    return resultat


# ---------------------------------------------------------------------------
# Fichiers JSON
# ---------------------------------------------------------------------------

def load_json(chemin, defaut):
    try:
        with open(chemin, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return defaut


def save_json(chemin, data):
    # écrit dans un fichier temporaire puis le renomme :
    # un arrêt brutal pendant l'écriture ne corrompt jamais le fichier
    os.makedirs(os.path.dirname(chemin), exist_ok=True)
    tmp = chemin + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    # sous Windows, l'antivirus ou l'indexeur relit souvent le fichier juste après son écriture et
    # le verrouille un instant : le remplacement échoue alors avec "Accès refusé". On réessaie.
    for essai in range(10):
        try:
            os.replace(tmp, chemin)
            return
        except PermissionError:
            if essai == 9:
                raise
            time.sleep(0.05 * (essai + 1))
