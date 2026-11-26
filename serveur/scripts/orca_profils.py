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

# réglages propres à chaque imprimante, par-dessus ceux d'Anycubic.
# Supports arbre (organiques) automatiques : le profil Anycubic les prépare mais les laisse désactivés,
# et les pièces des clients ne sont pas toutes imprimables sans. Angle choisi pour la Kobra 3 (buse 0,4,
# PLA, bonne ventilation) : elle tient proprement les surplombs jusqu'à ~60° de la verticale ; au-delà
# (surface à moins de 30° de l'horizontale, valeur par défaut d'Orca), un support arbre est ajouté. 40° mettait
# des arbres sous des surplombs qui s'impriment très bien sans (+16 % de plastique sur un plateau de roues F1).
# Supports aussi posés sur la pièce
# (pas seulement sur le plateau) : sinon les surplombs au-dessus de la pièce elle-même tombent dans le vide.
REGLAGES = {
    "kobra3": {
        "process": {
            "enable_support": "1",
            "support_type": "tree(auto)",
            "support_style": "default",
            "support_threshold_angle": "30",
            "support_on_build_plate_only": "0",
            "tree_support_auto_brim": "1",
            # plateau monté sur la Kobra 3 : PEI texturé (PLA à 60 °C dans le profil filament). Sans ce réglage,
            # Orca en ligne de commande prend le « Cool Plate » par défaut : plateau à 35 °C, mauvaise adhérence.
            "curr_bed_type": "Textured PEI Plate",
            # ---- pratiques du « HS PLA Speed Benchy » d'Anycubic pour la Kobra 3 (PrusaSlicer 2.7.1, impressions
            # quasi parfaites en PLA Haute Vitesse), vitesses réduites de 36 %. Supports arbre gardés (ci-dessus).
            # vitesses (Benchy x 0,64 : -20 % du Benchy, puis -20 % de plus le 25/11 contre sous-extrusion,
            # fils d'ange et decalages de couche) : paroi externe 380 -> 243, parois internes et remplissage
            # 600 -> 384, remplissage plein 360 -> 230, dessus et petits trous 300 -> 192,
            # 1re couche 200 -> 128, deplacements 600 -> 384 mm/s
            "outer_wall_speed": "243",
            "inner_wall_speed": "384",
            "sparse_infill_speed": "384",
            "internal_solid_infill_speed": "230",
            "top_surface_speed": "192",
            "gap_infill_speed": "192",
            "initial_layer_speed": "128",
            "initial_layer_infill_speed": "128",
            "bridge_speed": "128",
            "support_speed": "96",
            "skirt_speed": "128",
            "travel_speed": "384",
            "small_perimeter_speed": "95%",          # 360 / 380 dans le Benchy
            "internal_bridge_speed": "100%",
            "support_interface_speed": "100%",
            "enable_overhang_speed": "1",            # surplombs ralentis (dynamic overhang speeds du Benchy)
            "slow_down_layers": "0",
            # accélérations du Benchy : 3000 partout, 1000 pour la 1re couche
            **{k: "3000" for k in ("default_acceleration", "outer_wall_acceleration", "inner_wall_acceleration",
                                    "sparse_infill_acceleration", "internal_solid_infill_acceleration",
                                    "top_surface_acceleration", "bridge_acceleration", "travel_acceleration")},
            "initial_layer_acceleration": "1000",
            # parois externes d'abord (meilleur aspect), 2 parois, remplissage en lignes.
            # ESSAI du 25/11 (trous aux angles) : couture au hasard au lieu d'alignée pour voir si les trous
            # se répartissent, et plus d'espace à la fermeture du tour (seam_gap 10 % -> 0). À remettre à
            # "aligned" / "10%" si la couture n'est pas la cause : au hasard, c'est plus laid.
            "wall_sequence": "outer wall/inner wall",
            "seam_position": "random",
            "seam_gap": "0%",
            "seam_slope_type": "none",   # scarf seam laissée désactivée pour isoler le problème
            "wall_loops": "2",
            "sparse_infill_pattern": "zig-zag",
            "infill_wall_overlap": "15%",
            # largeurs de ligne : 0,42 paroi externe, 0,45 le reste, 0,5 première couche (0,23 mm d'épaisseur)
            "outer_wall_line_width": "0.42",
            "inner_wall_line_width": "0.45",
            "sparse_infill_line_width": "0.45",
            "internal_solid_infill_line_width": "0.45",
            "top_surface_line_width": "0.45",
            "initial_layer_line_width": "0.5",
            "initial_layer_print_height": "0.23",
        },
        # PLA Haute Vitesse du Benchy : 225 °C (1re couche comprise), débit max 35 mm³/s -> 22 (-37 %,
        # abaisse avec les vitesses le 25/11 : a 225 °C la buse ne fait plus fondre 28 mm³/s),
        # débit x1,02, ventilateur coupé sur les 2 premières couches puis 100 % dès la 3e.
        # Gardé malgré le Benchy (qui l'a désactivé) : petites couches ralenties pour refroidir (choix du 22/11).
        "filament": {
            "nozzle_temperature": ["225"],
            "nozzle_temperature_initial_layer": ["225"],
            "nozzle_temperature_range_high": ["250"],
            "filament_max_volumetric_speed": ["22"],
            "filament_flow_ratio": ["1.02"],
            "close_fan_the_first_x_layers": ["2"],
            "full_fan_speed_layer": ["3"],
            "fan_min_speed": ["100"],
            "fan_max_speed": ["100"],
        },
        # rétraction du Benchy : 0,4 mm à 160 mm/s, sans levée de buse ni essuyage, pas de rétraction au
        # changement de couche, seulement pour les déplacements de plus de 2 mm.
        # Longueur gardée à 0,4 (déjà très court en direct drive) ; 0,05 mm redonné à la reprise le 25/11
        # pour combler les trous aux angles sans toucher à la rétraction.
        "machine": {
            "retraction_length": ["0.4"],
            "retract_restart_extra": ["0.05"],
            "retraction_speed": ["160"],
            "deretraction_speed": ["160"],
            "z_hop": ["0"],
            "wipe": ["0"],
            "retract_when_changing_layer": ["0"],
            "retraction_minimum_travel": ["2"],
        },
    },
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
            d.update(REGLAGES.get(profil, {}).get(genre, {}))
            d.update({"type": genre, "name": nom, "inherits": "", "from": "User"})
            d.pop("setting_id", None)
            d.pop("instantiation", None)
            (dossier / f"{genre}.json").write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            print(f"[OK] {profil}/{genre}.json  <-  {nom}  ({len(d)} réglages)")


if __name__ == "__main__":
    main()
