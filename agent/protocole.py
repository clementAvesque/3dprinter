"""Liste fermée des commandes (protocole/commandes.json, partagée avec le serveur) et leur validation.

L'agent revalide TOUT ce que le serveur lui envoie : même un serveur compromis ne peut faire exécuter
qu'une commande de cette liste, avec des paramètres dans leurs bornes.
"""

import json
import os
import re

FICHIER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "protocole", "commandes.json")
with open(FICHIER, "r", encoding="utf-8") as f:
    PROTOCOLE = json.load(f)

COMMANDES = PROTOCOLE["commandes"]
TYPES = PROTOCOLE["types"]
LIMITES = PROTOCOLE["limites"]


def definition(d):
    if d["type"] in TYPES:
        return {**TYPES[d["type"]], "optionnel": d.get("optionnel", False)}
    return d


def verifier_valeur(d, v):
    t = d["type"]
    if t == "texte":
        if not isinstance(v, str) or not v or len(v) > d["max"]:
            return f"texte de 1 à {d['max']} caractères attendu"
        if d.get("motif") and not re.search(d["motif"], v):
            return "format refusé"
        return None
    if t == "entier":
        if isinstance(v, bool) or not isinstance(v, int) or not d["min"] <= v <= d["max"]:
            return f"entier entre {d['min']} et {d['max']} attendu"
        return None
    if t == "nombre":
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or not d["min"] <= v <= d["max"]:
            return f"nombre entre {d['min']} et {d['max']} attendu"
        return None
    if t == "booleen":
        return None if isinstance(v, bool) else "true ou false attendu"
    if t == "choix":
        return None if v in d["valeurs"] else "valeur non autorisée"
    return "type inconnu"


def valider(action, params):
    """Retourne (params_propres, None) ou (None, message d'erreur)."""
    cmd = COMMANDES.get(action)
    if cmd is None:
        return None, "commande inconnue"
    if not isinstance(params, dict):
        return None, "paramètres invalides"
    for champ in params:
        if champ not in cmd["params"]:
            return None, f"champ inconnu : {champ}"
    propre = {}
    for champ, brut in cmd["params"].items():
        d = definition(brut)
        v = params.get(champ)
        if v is None:
            if d.get("optionnel"):
                continue
            return None, f"champ manquant : {champ}"
        err = verifier_valeur(d, v)
        if err:
            return None, f"{champ} : {err}"
        propre[champ] = v
    if action == "temperature.set" and propre["cible"] == "plateau" and propre["temp"] > 110:
        return None, "plateau : 110 °C maximum"
    return propre, None
