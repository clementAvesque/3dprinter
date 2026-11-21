"""Prépare les profils OrcaSlicer de la Kobra 3 utilisés par le serveur pour découper les devis.

    python serveur/scripts/orca_profils.py

Les profils « système » d'Anycubic Slicer Next (ceux avec lesquels tu imprimes, même format qu'OrcaSlicer)
héritent les uns des autres (« inherits »). Orca en ligne de commande veut des profils complets : ce script
suit la chaîne d'héritage et écrit un fichier autonome par profil dans serveur/orca/<profil>/.
Relance-le après une mise à jour d'Anycubic Slicer Next pour reprendre ses nouveaux réglages.
"""

import json
import os
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SOURCE = Path(os.environ.get("APPDATA", "")) / "AnycubicSlicerNext" / "system" / "Anycubic"
SORTIE = Path(__file__).resolve().parent.parent / "orca"

# profil_orca de la table imprimantes -> profils système choisis
PROFILS = {
    "kobra3": {
        "machine": "Anycubic Kobra 3 0.4 nozzle",
        "process": "0.20mm Standard @Anycubic Kobra 3 0.4 nozzle",
        "filament": "Anycubic PLA @Anycubic Kobra 3 0.4 nozzle",
    },
}


# valeurs d'Anycubic Slicer Next refusées par OrcaSlicer (vérification des plages au lancement).
# Sans effet sur la Kobra 3 : réglages du coupe-filament des imprimantes Bambu, désactivé
# (long_retractions_when_cut = 0) ; on met la valeur par défaut d'Orca pour passer sa vérification.
# bed_exclude_area : bandes de 2,5 mm au bord du plateau de 255 mm. Le serveur refuse déjà toute pièce de plus
# de 250 mm (table imprimantes) et Orca range les pièces au centre ; le profil « Kobra 3 V2 » n'en a pas.
CORRECTIONS = {
    "machine": {"retraction_distances_when_cut": ["18"], "bed_exclude_area": []},
}


def indexer():
    index = {}
    for genre in ("machine", "process", "filament"):
        for f in (SOURCE / genre).glob("*.json"):
            try:
                d = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if d.get("name"):
                index[(genre, d["name"])] = d
    return index


def aplatir(index, genre, nom, vus=()):
    if (genre, nom) not in index:
        sys.exit(f"profil introuvable : {genre} « {nom} » (dans {SOURCE})")
    if nom in vus:
        sys.exit(f"héritage en boucle : {' -> '.join(vus + (nom,))}")
    d = index[(genre, nom)]
    complet = aplatir(index, genre, d["inherits"], vus + (nom,)) if d.get("inherits") else {}
    complet.update(d)
    return complet


def main():
    if not SOURCE.is_dir():
        sys.exit(f"Anycubic Slicer Next introuvable ({SOURCE})")
    index = indexer()
    for profil, noms in PROFILS.items():
        dossier = SORTIE / profil
        dossier.mkdir(parents=True, exist_ok=True)
        for genre, nom in noms.items():
            d = aplatir(index, genre, nom)
            d.update(CORRECTIONS.get(genre, {}))
            d.update({"type": genre, "name": nom, "inherits": "", "from": "User"})
            d.pop("setting_id", None)
            d.pop("instantiation", None)
            (dossier / f"{genre}.json").write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            print(f"[OK] {profil}/{genre}.json  <-  {nom}  ({len(d)} réglages)")


if __name__ == "__main__":
    main()
