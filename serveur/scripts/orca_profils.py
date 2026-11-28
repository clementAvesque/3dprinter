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
        "filament": "Anycubic PLA High Speed @Anycubic Kobra 3 0.4 nozzle",
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
# Profil « FERME – ISO 2768-m » (27/11) : vise les tolérances générales ISO 2768-m (±0,1 mm jusqu'à 6 mm,
# ±0,2 de 6 à 30, ±0,3 de 30 à 120) à vitesse sûre, environ 2 fois plus long que le profil Benchy d'avant.
# Le client ne règle plus que le remplissage (src/orca.js) : hauteur de couche, parois et faces sont fixées ici.
# Écarts volontaires au profil d'origine :
#  - supports arbre automatiques gardés (le profil les coupe) : les pièces des clients ne sont pas toutes
#    imprimables sans. Angle 30° : la Kobra 3 tient proprement les surplombs jusqu'à ~60° de la verticale.
#    Supports aussi posés sur la pièce, sinon les surplombs au-dessus d'elle tombent dans le vide.
#  - « seam_slope_type: contour » n'existe pas dans Orca 2.5 (none / external / all) : « external », la couture
#    en biseau sur la paroi extérieure seulement, ce que « contour » désigne.
#  - plateau PEI texturé : sans « curr_bed_type », Orca en ligne de commande chauffe un « Cool Plate » à 35 °C.
REGLAGES = {
    "kobra3": {
        "process": {
            "enable_support": "1",
            "support_type": "tree(auto)",
            "support_style": "default",
            "support_threshold_angle": "30",
            "support_on_build_plate_only": "0",
            "tree_support_auto_brim": "1",
            "curr_bed_type": "Textured PEI Plate",
            # couches : 0,2 mm partout, 1re couche comprise ; Z précis (dernière couche ajustée à la hauteur exacte)
            "layer_height": "0.20",
            "initial_layer_print_height": "0.20",
            "precise_z_height": "1",
            "ironing_type": "no ironing",
            # largeurs de ligne
            "line_width": "0.42",
            "outer_wall_line_width": "0.42",
            "inner_wall_line_width": "0.45",
            "initial_layer_line_width": "0.5",
            "sparse_infill_line_width": "0.50",
            "internal_solid_infill_line_width": "0.42",
            "top_surface_line_width": "0.40",
            "support_line_width": "0.42",
            # parois : 3 tours, ordre intérieur-extérieur-intérieur (paroi externe tenue des deux côtés : cotes
            # plus justes sans bourrelet), paroi externe précise
            "wall_generator": "arachne",
            "wall_loops": "3",
            "wall_sequence": "inner-outer-inner wall",
            "precise_outer_wall": "1",
            "only_one_wall_top": "1",
            "detect_overhang_wall": "1",
            "ensure_vertical_shell_thickness": "ensure_all",
            # faces : 5 couches dessus (1 mm), 4 dessous
            "top_shell_layers": "5",
            "top_shell_thickness": "1.0",
            "bottom_shell_layers": "4",
            "bottom_shell_thickness": "0",
            "top_surface_pattern": "monotonicline",
            "bottom_surface_pattern": "monotonic",
            "internal_solid_infill_pattern": "monotonic",
            # remplissage : gyroïde ; la densité vient du devis (choix du client), 15 % par défaut
            "sparse_infill_pattern": "gyroid",
            "sparse_infill_density": "15%",
            "infill_wall_overlap": "15%",
            "reduce_crossing_wall": "1",
            # couture alignée, 10 % d'espace à la fermeture, coutures internes décalées, biseau (scarf) extérieur
            "seam_position": "aligned",
            "seam_gap": "10%",
            "staggered_inner_seams": "1",
            "wipe_on_loops": "1",
            "seam_slope_type": "external",
            # compensations : seulement la patte d'éléphant (1re couche écrasée) ; résolution fine, pas d'arcs
            "xy_hole_compensation": "0",
            "xy_contour_compensation": "0",
            "elefant_foot_compensation": "0.15",
            "resolution": "0.008",
            "enable_arc_fitting": "0",
            # vitesses (mm/s)
            "initial_layer_speed": "50",
            "initial_layer_infill_speed": "100",
            "outer_wall_speed": "120",
            "inner_wall_speed": "260",
            "small_perimeter_speed": "50%",
            "small_perimeter_threshold": "6.5",
            "sparse_infill_speed": "280",
            "internal_solid_infill_speed": "260",
            "top_surface_speed": "150",
            "gap_infill_speed": "150",
            "bridge_speed": "45",
            "internal_bridge_speed": "90",
            "support_speed": "150",
            "support_interface_speed": "80",
            "skirt_speed": "50",
            "enable_overhang_speed": "1",
            "overhang_1_4_speed": "80",
            "overhang_2_4_speed": "50",
            "overhang_3_4_speed": "25",
            "overhang_4_4_speed": "10",
            "travel_speed": "500",
            "slow_down_layers": "2",
            # accélérations (mm/s²)
            "default_acceleration": "7500",
            "outer_wall_acceleration": "3100",
            "inner_wall_acceleration": "7000",
            "sparse_infill_acceleration": "9000",
            "internal_solid_infill_acceleration": "8000",
            "top_surface_acceleration": "3500",
            "bridge_acceleration": "2500",
            "initial_layer_acceleration": "1200",
            "travel_acceleration": "9000",
            "accel_to_decel_enable": "1",
            "accel_to_decel_factor": "50%",
            "default_jerk": "0",
            "brim_type": "auto_brim",
            "enable_prime_tower": "0",
            "max_travel_detour_distance": "0",
            "exclude_object": "1",
        },
        # PLA Haute Vitesse : 210 °C la 1re couche puis 205, débit x0,98, 19 mm³/s au plus, avance de pression 0,03.
        # Ventilateur coupé sur la 1re couche, 85-100 % dès la 3e. Rétraction (prioritaire sur celle de la
        # machine) : 1,2 mm à 50 mm/s, levée en spirale de 0,2 mm, essuyage de 1,5 mm, à chaque changement de couche.
        # (210 °C et 0,8 mm à 40 mm/s au départ : fils d'ange entre les pièces, d'où 205 °C et 1,2 mm à 50 mm/s.)
        "filament": {
            "filament_type": ["PLA"],
            "filament_diameter": ["1.75"],
            "filament_density": ["1.24"],
            "filament_flow_ratio": ["0.98"],
            "filament_max_volumetric_speed": ["19"],
            "filament_shrink": ["100%"],
            "temperature_vitrification": ["55"],
            "nozzle_temperature": ["205"],
            "nozzle_temperature_initial_layer": ["210"],
            "nozzle_temperature_range_low": ["190"],
            "nozzle_temperature_range_high": ["240"],
            "hot_plate_temp": ["60"],
            "hot_plate_temp_initial_layer": ["60"],
            "textured_plate_temp": ["60"],
            "textured_plate_temp_initial_layer": ["60"],
            "enable_pressure_advance": ["1"],
            "pressure_advance": ["0.030"],
            "fan_min_speed": ["85"],
            "fan_max_speed": ["100"],
            "fan_cooling_layer_time": ["30"],
            "close_fan_the_first_x_layers": ["1"],
            "full_fan_speed_layer": ["3"],
            "overhang_fan_speed": ["100"],
            "overhang_fan_threshold": ["25%"],
            "reduce_fan_stop_start_freq": ["1"],
            "slow_down_for_layer_cooling": ["1"],
            "slow_down_layer_time": ["5"],
            "slow_down_min_speed": ["20"],
            "filament_retraction_length": ["1.2"],
            "filament_retraction_speed": ["50"],
            "filament_deretraction_speed": ["30"],
            "filament_retract_before_wipe": ["70%"],
            "filament_wipe": ["1"],
            "filament_z_hop": ["0.2"],
            "filament_z_hop_types": ["Spiral Lift"],
            "filament_retract_when_changing_layer": ["1"],
            "filament_retraction_minimum_travel": ["1"],
            "filament_wipe_distance": ["1.5"],
        },
        # machine : celle d'Anycubic, sans retouche (la rétraction est réglée dans le filament ci-dessus)
        "machine": {},
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
