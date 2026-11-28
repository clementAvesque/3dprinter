"""Lecture d'un gcode en trajets 3D (pour l'aperçu 3D couche par couche).

    meta, bin_path = load("piece.gcode", cache_dir)

Seules les extrusions sont gardées (pas les déplacements à vide), regroupées par couche.
Le résultat est mis en cache sur le disque : le gcode n'est relu que s'il a changé.

Format du .bin (little endian), N = nombre de segments :
    N x 4 int16   x1, y1, x2, y2 en centièmes de mm (±327 mm)
    N x 1 uint8   type de trajet (indice dans TYPES)
Une couche = segments [debut, debut + nombre[ dans meta["layers"] : [z, debut, nombre].

Gère OrcaSlicer, Anycubic Slicer Next, PrusaSlicer et Cura : extrusion relative (M83) ou
absolue (M82), positions G90/G91, G92, et les arcs G2/G3 (découpés en petits segments).
"""

import array
import hashlib
import json
import math
import os
import sys
import threading

VERSION = 2     # à incrémenter si le format change (invalide le cache)
                # 2 : couches découpées sur ;LAYER_CHANGE

# Une couche commence au marqueur ;LAYER_CHANGE du slicer. Dès qu'un marqueur a été vu, le Z n'est PLUS un
# critère : certains gcode font monter Z en continu pendant l'extrusion (jusqu'à une hauteur de couche entière
# dans une seule couche), ce qui ouvrait une couche par segment — 52988 au lieu de 163 sur la plaque P0013.
# Le seuil ci-dessous ne sert qu'aux gcode sans aucun marqueur (repli).
SEUIL_COUCHE = 0.02

# catégories affichées (l'ordre = l'indice stocké dans le .bin)
TYPES = ["Paroi externe", "Paroi interne", "Remplissage", "Remplissage plein",
         "Surface dessus/dessous", "Support", "Jupe / bordure", "Autre"]

# noms des slicers -> indice dans TYPES (comparaison en minuscules)
_TYPE_NAMES = {
    0: ("outer wall", "wall-outer", "external perimeter", "overhang wall", "overhang perimeter"),
    1: ("inner wall", "wall-inner", "perimeter"),
    2: ("sparse infill", "fill", "internal infill"),
    3: ("internal solid infill", "solid infill", "gap infill", "bridge", "internal bridge",
        "bridge infill"),
    4: ("top surface", "bottom surface", "top solid infill", "skin", "ironing"),
    5: ("support", "support interface", "support transition", "support-interface",
        "support material", "support material interface"),
    6: ("skirt", "brim", "skirt/brim", "prime tower", "wipe tower"),
}
_TYPE_INDEX = {nom: i for i, noms in _TYPE_NAMES.items() for nom in noms}
AUTRE = len(TYPES) - 1

_locks = {}
_locks_guard = threading.Lock()


def _type_of(nom):
    return _TYPE_INDEX.get(nom.strip().lower(), AUTRE)


def _min_len(taille):
    # longueur minimale d'un segment : on fusionne les tout petits segments (invisibles à l'écran)
    # pour garder un aperçu fluide même avec un gcode de 90 Mo
    if taille < 15e6:
        return 0.25
    if taille < 40e6:
        return 0.5
    return 0.9


def parse(path):
    """Lit le gcode et retourne (meta, coords: array('h'), types: bytearray)."""
    min_len = _min_len(os.path.getsize(path))
    min_len2 = min_len * min_len

    coords = array.array("h")
    types = bytearray()
    layers = []                 # [z, debut, nombre]

    x = y = z = e = 0.0
    abs_xyz = True
    abs_e = False
    t = AUTRE
    layer_z = None
    marqueur_couche = False
    marqueur_vu = False

    ax = ay = None              # dernier point émis de la polyligne en cours
    px = py = None              # point en attente (pas encore émis, segment trop court)
    xmin = ymin = 1e9
    xmax = ymax = -1e9

    def emit(x1, y1, x2, y2):
        coords.extend((round(x1 * 100), round(y1 * 100), round(x2 * 100), round(y2 * 100)))
        types.append(t)

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            c0 = line[:1]
            if c0 == ";":
                if line.startswith(";TYPE:"):
                    nouveau = _type_of(line[6:])
                    if nouveau != t:
                        if px is not None:
                            emit(ax, ay, px, py)
                            ax, ay, px, py = px, py, None, None
                        t = nouveau
                elif line.startswith((";LAYER_CHANGE", ";LAYER:", ";CHANGE_LAYER")):
                    marqueur_couche = marqueur_vu = True
                continue
            if c0 not in ("G", "M"):
                continue

            i = line.find(";")
            if i >= 0:
                line = line[:i]
            mots = line.split()
            if not mots:
                continue
            cmd = mots[0]

            if cmd in ("G1", "G0", "G2", "G3"):
                nx, ny, nz, de = x, y, z, 0.0
                ci = cj = None
                for m in mots[1:]:
                    k = m[:1]
                    try:
                        v = float(m[1:])
                    except ValueError:
                        continue
                    if k == "X":
                        nx = v if abs_xyz else x + v
                    elif k == "Y":
                        ny = v if abs_xyz else y + v
                    elif k == "Z":
                        nz = v if abs_xyz else z + v
                    elif k == "E":
                        de = v - e if abs_e else v
                        e = v if abs_e else e + v
                    elif k == "I":
                        ci = v
                    elif k == "J":
                        cj = v

                bouge = nx != x or ny != y
                if de > 0 and bouge:
                    # --- extrusion ---
                    if layer_z is None or marqueur_couche or (not marqueur_vu and abs(nz - layer_z) > SEUIL_COUCHE):
                        if px is not None:
                            emit(ax, ay, px, py)
                        px = py = None
                        if layers:
                            layers[-1][2] = len(types) - layers[-1][1]
                        layers.append([round(nz, 3), len(types), 0])
                        layer_z = nz
                        marqueur_couche = False
                        ax = ay = None

                    # chemin : une ligne, ou un arc découpé en petits morceaux
                    if cmd in ("G2", "G3") and ci is not None and cj is not None:
                        points = _arc(x, y, nx, ny, ci, cj, cmd == "G2")
                    else:
                        points = ((nx, ny),)

                    if ax is None or px is None and (ax != x or ay != y):
                        ax, ay = x, y           # début d'une nouvelle polyligne
                    for qx, qy in points:
                        px, py = qx, qy
                        if (px - ax) ** 2 + (py - ay) ** 2 >= min_len2:
                            emit(ax, ay, px, py)
                            ax, ay, px, py = px, py, None, None
                        if qx < xmin: xmin = qx
                        if qx > xmax: xmax = qx
                        if qy < ymin: ymin = qy
                        if qy > ymax: ymax = qy
                elif bouge or nz != z:
                    # --- déplacement à vide : la polyligne s'arrête ---
                    if px is not None:
                        emit(ax, ay, px, py)
                    ax = ay = px = py = None
                x, y, z = nx, ny, nz

            elif cmd == "G90":
                abs_xyz = True
            elif cmd == "G91":
                abs_xyz = False
            elif cmd == "M82":
                abs_e = True
            elif cmd == "M83":
                abs_e = False
            elif cmd == "G92":
                for m in mots[1:]:
                    try:
                        v = float(m[1:])
                    except ValueError:
                        continue
                    if m[0] == "E":
                        e = v
                    elif m[0] == "X":
                        x = v
                    elif m[0] == "Y":
                        y = v
                    elif m[0] == "Z":
                        z = v

    if px is not None:
        emit(ax, ay, px, py)
    if layers:
        layers[-1][2] = len(types) - layers[-1][1]
    layers = [c for c in layers if c[2] > 0]

    vide = not layers
    meta = {
        "version": VERSION,
        "segments": len(types),
        "layers": layers,
        "types": TYPES,
        "bbox": None if vide else [round(xmin, 2), round(ymin, 2), layers[0][0],
                                   round(xmax, 2), round(ymax, 2), layers[-1][0]],
        "min_len": min_len,
    }
    return meta, coords, types


def _arc(x0, y0, x1, y1, i, j, horaire, pas=1.0):
    # découpe un arc G2 (horaire) / G3 en segments d'environ `pas` mm
    cx, cy = x0 + i, y0 + j
    r = math.hypot(i, j)
    a0 = math.atan2(y0 - cy, x0 - cx)
    a1 = math.atan2(y1 - cy, x1 - cx)
    d = a1 - a0
    if horaire:
        if d >= 0:
            d -= 2 * math.pi
    elif d <= 0:
        d += 2 * math.pi
    n = max(1, min(64, int(abs(d) * r / pas)))
    pts = [(cx + r * math.cos(a0 + d * k / n), cy + r * math.sin(a0 + d * k / n)) for k in range(1, n)]
    pts.append((x1, y1))
    return pts


def _cache_paths(path, cache_dir):
    st = os.stat(path)
    cle = hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime_ns}|{VERSION}"
                       .encode("utf-8")).hexdigest()[:20]
    return cle, os.path.join(cache_dir, cle + ".json"), os.path.join(cache_dir, cle + ".bin")


def forget(path, cache_dir):
    """Supprime l'aperçu en cache d'un gcode (à appeler AVANT de supprimer le gcode lui-même)."""
    try:
        _, meta_path, bin_path = _cache_paths(path, cache_dir)
    except OSError:
        return
    for p in (meta_path, bin_path):
        try:
            os.remove(p)
        except OSError:
            pass


def load(path, cache_dir):
    """Retourne (meta, chemin du .bin), depuis le cache si le gcode n'a pas changé."""
    cle, meta_path, bin_path = _cache_paths(path, cache_dir)

    with _locks_guard:
        verrou = _locks.setdefault(cle, threading.Lock())
    with verrou:            # deux onglets qui demandent le même fichier : une seule lecture
        if os.path.isfile(meta_path) and os.path.isfile(bin_path):
            with open(meta_path, "r", encoding="utf-8") as f:
                return json.load(f), bin_path

        meta, coords, types = parse(path)
        if sys.byteorder != "little":
            coords.byteswap()
        os.makedirs(cache_dir, exist_ok=True)
        tmp = bin_path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(coords.tobytes())
            f.write(bytes(types))
        os.replace(tmp, bin_path)
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f)
        return meta, bin_path
