# client_printer

Librairie Python pour piloter et surveiller une imprimante 3D **Klipper / Moonraker** (testée pour une Anycubic sous Rinkhals, avec ACE) depuis ton PC, via le réseau local.

```python
from client_printer import Printer

p = Printer("192.168.1.42")
p.update()
print(p)        # Imprimante 192.168.1.42 : état READY, buse 24.8°C, plateau 23.1°C.
```

---

## Sommaire

1. [Installation](#1-installation)
2. [Les 3 règles à connaître](#2-les-3-règles-à-connaître)
3. [Démarrage rapide](#3-démarrage-rapide)
4. [Imprimer un fichier](#4-imprimer-un-fichier)
5. [Référence : `Printer`](#5-référence--printer)
6. [Référence : buse, plateau, températures](#6-référence--buse-plateau-températures)
7. [Référence : ACE (multi-filament)](#7-référence--ace-multi-filament)
8. [Référence : caméra](#8-référence--caméra)
9. [Historiques et fichiers locaux](#9-historiques-et-fichiers-locaux)
10. [Configuration](#10-configuration)
11. [Faire évoluer la librairie](#11-faire-évoluer-la-librairie)
12. [Dépannage](#12-dépannage)

---

## 1. Installation

Dépendance : `requests`. Pour enregistrer des vidéos : `imageio-ffmpeg` (optionnel, fournit ffmpeg).

```bash
pip install -r requirements.txt
```

### Importer la librairie

Le dossier `client_printer` est un **package** : on l'importe depuis le dossier **parent** (`exo/`).

```
exo/
├── mon_script.py          <- from client_printer import Printer
└── client_printer/
    ├── __init__.py
    ├── printer.py
    └── ...
```

Pour un script placé **dans** `client_printer/` (comme `test.py`), ajoute en haut :

```python
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from client_printer import Printer
```

### Lancer en ligne de commande

Depuis `exo/` :

```bash
python -m client_printer 192.168.1.42
```

Rafraîchit l'imprimante toutes les 2 s et remplit les historiques. `Ctrl+C` pour arrêter.

---

## 2. Les 3 règles à connaître

### Règle 1 — Rien n'est lu tant que tu n'appelles pas `update()`

Créer un `Printer` ne fait **aucune** requête réseau. Les valeurs (`p.nozzle.temperature.value`, `p.state_printer.state`...) valent `None` jusqu'au premier `update()`.

```python
p = Printer("192.168.1.42")
p.nozzle.temperature.value   # None
p.update()                   # 1 seule requête : buse, plateau, position, ACE, état, ventilo
p.nozzle.temperature.value   # 24.8
```

`to_dict()`, `to_json()` et `print(p)` montrent les valeurs **du dernier `update()`**, sans requête.

### Règle 2 — Les erreurs sont renvoyées, jamais levées

Toutes les commandes renvoient un **dict**. En cas de problème, il contient une clé `"error"` (et parfois `"detail"`, le message de Klipper). Aucune exception à attraper.

```python
res = p.nozzle.move(x=100)
if res.get("error"):
    print(res["error"], res.get("detail"))   # HTTP 400  Must home axis first
```

Erreurs courantes :

| `error` | Signification |
|---|---|
| `"fail connexion"` | imprimante injoignable, ou délai dépassé |
| `"HTTP 400"`, `"HTTP 404"`... | l'imprimante a refusé la demande (voir `detail`) |
| texte en français | la librairie a refusé avant d'envoyer (valeur hors limites, mauvais état...) |

### Règle 3 — Les températures et vitesses ont des limites de sécurité

| Réglage | Limite | Où la changer |
|---|---|---|
| Buse | 0 à 300 °C | `Nozzle.MAX_TEMP` dans `nozzle.py` |
| Plateau | 0 à 110 °C | `Bed.MAX_TEMP` dans `bed.py` |
| Extrusion | 200 mm max par appel | `Nozzle.MAX_EXTRUDE` |
| Vitesse d'impression | 10 à 300 % | `Printer.set_speed` |
| Débit | 50 à 150 % | `Printer.set_flow` |

---

## 3. Démarrage rapide

```python
from client_printer import Printer

p = Printer("192.168.1.42")

if not p.update():
    print("imprimante injoignable")
    raise SystemExit

# état
print(p.state_printer.state)        # "READY", "PRINTING", "BREAK" (pause) ou "ERROR"
print(p.nozzle)                     # Buse | La température de nozzle est de 24.8 Celsius | Position -> X:0 Y:0 Z:0
print(p.bed)                        # Plateau | La température de bed est de 23.1 Celsius

# chauffer
p.bed.set_target_temp(60)                   # lance la chauffe et rend la main tout de suite
p.nozzle.set_target_temp(200, wait=True)    # bloque jusqu'à 200 °C (10 min max)

# bouger la tête
p.nozzle.home()                     # G28 sur tous les axes
p.nozzle.move(x=100, y=100, z=10)   # position absolue, en mm
p.nozzle.move(z=5, relative=True)   # +5 mm en Z

# tout couper
p.nozzle.stop()
p.bed.stop()

# toutes les infos en JSON
print(p.to_json())
```

---

## 4. Imprimer un fichier

Le parcours complet : **upload → init → start → suivi**.

```python
from time import sleep
from client_printer import Printer

p = Printer("192.168.1.42")

# 1. Enregistrer le gcode (une seule fois par fichier)
#    - copie le fichier dans client_printer/gcode/
#    - l'envoie à l'imprimante pour lire durée et poids estimés
#    - les note dans data/gcode_index.json
infos = p.upload_gcode(r"C:\Users\moi\Downloads\piece.gcode")
print(infos)   # {"temps_estime": 3600, "poids": 12.4, "chemin": "..."}

# 2. Préparer
p.init_print(filename="piece.gcode")
# avec l'ACE :
# p.init_print(filename="piece.gcode", use_ace=True, slot=2, material="PLA")

# 3. Lancer
res = p.start_print()
if res.get("error"):
    print("lancement impossible :", res["error"])
    raise SystemExit

# 4. Suivre
while p.state_printer.state in ("PRINTING", "BREAK"):
    d = p.data_print(with_image=False)
    print(f"{d['progress_percent']} %  couche {d['layer']}/{d['total_layers']}  "
          f"reste {d['remaining_seconds']} s")
    sleep(10)
```

### Ce que fait `start_print()`

1. `check_ready()` : imprimante en ligne, Klipper prêt, aucun print en cours, capteurs lisibles, fichier présent en local, ACE détecté et emplacement non vide si demandé. S'il y a un problème, renvoie `{"error": "problème 1 ; problème 2"}` sans rien lancer.
2. Envoie le gcode **seulement si l'imprimante ne l'a pas déjà** (comparaison de taille). Grâce à `upload_gcode(..., keep_on_printer=True)` (par défaut), le fichier y est déjà : le lancement est quasi immédiat.
3. Avec l'ACE : sélectionne le slot (`T0` à `T3`).
4. Démarre le print, passe l'état en `PRINTING` et remplit `p.current_print`.

> Le temps entre `start_print()` et le premier trait de plastique dépend surtout de la machine : chauffe et nivellement lancés par le début du gcode. Pour gagner du temps, préchauffe le plateau avant (`p.bed.set_target_temp(60)`).

### Pendant le print

```python
p.pause()           # -> état BREAK
p.restart()         # reprend -> état PRINTING
p.cancel()          # annule -> état READY, supprime le gcode de l'imprimante (il reste en local)

p.set_speed(150)    # vitesse x1,5
p.set_flow(105)     # +5 % de plastique
p.set_ventilo(80)   # ventilateur à 80 %
```

`pause()` hors impression ou `restart()` hors pause renvoient une erreur explicative au lieu d'envoyer la commande.

### À la fin

Quand un `update()` voit le print passer à « terminé », la librairie :
- ajoute une ligne à l'historique des prints (`nom`, `poids`, `temps`, `timestamp`) ;
- supprime le gcode de l'imprimante (la copie locale reste dans `gcode/`) ;
- vide `p.current_print`.

Il faut donc qu'un `update()` tourne pendant le print : boucle de suivi, `data_print()` ou `p.run()`.

---

## 5. Référence : `Printer`

```python
p = Printer(ip)
```

### Attributs

| Attribut | Contenu |
|---|---|
| `p.nozzle` | la buse ([section 6](#6-référence--buse-plateau-températures)) |
| `p.bed` | le plateau |
| `p.ace` | l'ACE ([section 7](#7-référence--ace-multi-filament)) |
| `p.camera` | la caméra ([section 8](#8-référence--caméra)) |
| `p.state_printer.state` | `None` (jamais lu), `"READY"`, `"PRINTING"`, `"BREAK"`, `"ERROR"` |
| `p.online` | `True` / `False` selon le dernier `update()`, `None` avant le premier |
| `p.last_status` | dernier état brut lu sur Klipper (dict), pour aller chercher une valeur non prévue |
| `p.print_init` | paramètres préparés par `init_print()` |
| `p.current_print` | infos du print lancé (`name`, `start`, `slot`...) ou `None` |
| `p.light_pin` | nom de la pin de la lumière (`"caselight"` par défaut, à vérifier) |

### Mise à jour

| Méthode | Retour | Description |
|---|---|---|
| `update()` | `bool` | lit tout en 1 requête, met à jour les composants, l'état et les historiques |
| `run(interval=2)` | — | `update()` en boucle jusqu'à `Ctrl+C` |
| `is_online()` | `bool` | teste **en direct** si l'imprimante répond (1 requête) |
| `klipper_state()` | `{"state", "message"}` | état de Klipper : `ready`, `startup`, `shutdown`, `error` |
| `check_ready()` | `{"ready", "problems"}` | tout ce que vérifie `start_print()` |
| `flush()` | — | écrit les historiques sur le disque immédiatement |

### Impression

| Méthode | Description |
|---|---|
| `upload_gcode(path, keep_on_printer=True)` | enregistre un gcode (voir [section 4](#4-imprimer-un-fichier)) |
| `init_print(filename=..., use_ace=False, slot=None, color=None, material=None)` | prépare le prochain print ; avec l'ACE, `slot` (1 à 4) est obligatoire et `color` est lue sur l'ACE si absente |
| `clear_print_init()` | oublie ce que `init_print()` a préparé |
| `start_print()` | lance le print préparé |
| `pause()` / `restart()` / `cancel()` | pause, reprise, annulation |
| `set_speed(percent)` | vitesse d'impression, 10 à 300 % |
| `set_flow(percent)` | débit d'extrusion, 50 à 150 % |

### Filament et moteurs

Ces méthodes sont **refusées pendant un print**.

| Méthode | Description |
|---|---|
| `load_filament(slot=None, temp=220, length=50)` | chauffe (attend), pousse depuis l'ACE si `slot` donné, extrude. La buse reste chaude. |
| `unload_filament(slot=None, temp=220, length=60)` | chauffe (attend), recule, rentre dans l'ACE si `slot` donné, coupe la chauffe |
| `disable_motors()` | coupe les moteurs (M84) : la tête se déplace à la main |

### Infos

| Méthode | Retour |
|---|---|
| `data_print(with_image=True)` | état, fichier, `progress_percent`, `elapsed_seconds`, `remaining_seconds`, `layer`, `total_layers`, `position`, `nozzle`, `bed`, `fan_percent`, `speed_factor`, `filament_used_mm`, `image_base64`. `with_image=False` évite la photo (plus rapide). |
| `filament()` | `{"ace_state", "fils"}` |
| `to_dict()` / `to_json()` | toutes les infos de la machine (sans requête) |

### Commandes diverses

| Méthode | Description |
|---|---|
| `light(on=True)` | allume / éteint la lumière (`SET_PIN`, nom à vérifier) |
| `set_ventilo(percent)` | ventilateur de 0 à 100 %, noté dans l'historique |

### Fichiers sur l'imprimante

| Méthode | Description |
|---|---|
| `list_files()` | `[{"nom", "taille", "modifie"}, ...]` |
| `del_file(nom)` | supprime un gcode de l'imprimante |
| `convert()` | pas encore écrit (TODO : STL → gcode) |

---

## 6. Référence : buse, plateau, températures

`Nozzle` (buse) et `Bed` (plateau) héritent tous les deux de `Heater`.

### Commun (`p.nozzle` et `p.bed`)

| | Description |
|---|---|
| `.temperature.value` | température actuelle (°C) |
| `.temperature.target` | cible, ou `None` si la chauffe est coupée |
| `set_target_temp(temp, wait=False)` | chauffe à `temp` °C ; `wait=True` bloque jusqu'à l'atteindre |
| `stop()` | coupe la chauffe |
| `update()` | relit **seulement** ce composant (préférer `p.update()` qui lit tout d'un coup) |
| `to_dict()` / `to_json()` | |

### Buse uniquement (`p.nozzle`)

| | Description |
|---|---|
| `posX`, `posY`, `posZ` / `position()` | dernière position connue de la tête |
| `home(axes="")` | `home()` tous les axes, `home("XY")` seulement X et Y |
| `move(x=None, y=None, z=None, relative=False, speed=3000)` | déplace la tête ; `speed` en mm/min ; il faut avoir fait `home()` avant |
| `extrude(length=10, speed=5)` | pousse du filament (mm, mm/s) |
| `retract(length=10, speed=5)` | recule du filament |
| `can_extrude()` | `True` si la buse est assez chaude pour extruder |

> `extrude()` et `retract()` ne vérifient pas si un print est en cours. Pour charger ou décharger un filament, utilise plutôt `p.load_filament()` / `p.unload_filament()`.

```python
p.nozzle.set_target_temp(210, wait=True)
p.nozzle.extrude(30)        # purge 30 mm
p.nozzle.retract(5)
p.nozzle.stop()
```

---

## 7. Référence : ACE (multi-filament)

```python
p.update()                    # ou p.ace.update()
print(p.ace.state.state)      # "ON", "OFF" (non détecté) ou "DRY" (séchage)
print(p.ace.fils)             # [{"color": "#ff0000", "emplacement": 1}, {"color": None, "emplacement": 2}, ...]
```

`color` vaut `None` quand l'emplacement est **vide**. Avec l'ACE, `check_ready()` (et donc `start_print()`) refuse de lancer un print sur un emplacement vide.

| Méthode | Description |
|---|---|
| `update()` / `init_fil()` | relit l'ACE seul |
| `start_dry(temp=50, duration=240)` | séchage (°C, minutes) |
| `stop_dry()` | arrête le séchage |
| `feed(slot, length=100, speed=25)` | pousse le filament du slot 1 à 4 vers l'imprimante |
| `retract(slot, length=100, speed=25)` | ramène le filament dans l'ACE |

> ⚠️ Les commandes gcode de l'ACE (`ACE_START_DRYING`, `ACE_FEED`...) et la sélection `T0`–`T3` sont **supposées**. Vérifie-les avec la doc Rinkhals avant de t'en servir.

---

## 8. Référence : caméra

| | Description |
|---|---|
| `instant_pic()` | prend une photo ; renvoie les octets JPEG (ou `{"error": ...}`) et la garde dans `lastPic` |
| `get_stream_url()` | adresse du flux vidéo MJPEG (un navigateur l'affiche directement dans une balise `<img>`) |
| `start_record(name="impression", timelapse=None)` | enregistre une vidéo `.mp4` en arrière-plan dans `image/videos/` ; `timelapse=10` = une photo toutes les 10 s, rejouées à 30 images/s |
| `stop_record()` | arrête et finalise la vidéo ; renvoie `{"fichier", "duree", "taille"}` |
| `is_recording()` / `record_status()` | enregistrement en cours ? `{"recording", "fichier", "timelapse", "duree", "images"}` |
| `rec_video(name, duration=None, interval=0.5)` | ancienne méthode (bloquante) : une photo toutes les `interval` s dans `image/<name>_<date>/`. `duration=None` = jusqu'à `Ctrl+C`. |
| `find_urls()` | redemande à Moonraker les adresses photo / flux (fait automatiquement) |
| `controls()` | réglages de la caméra (luminosité, exposition…) : `{nom: {"id", "value", "min", "max"}}` |
| `set_control(nom, valeur)` | change un réglage, ex. `set_control("Brightness", 40)` ; perdu au redémarrage de l'imprimante |
| `fast_mode()` | empêche la caméra de ralentir dans le noir (`Exposure, Auto Priority` = 0) : **0,2 → 2,8 images/s** sur la Kobra 3. L'app web l'applique à chaque ouverture du flux. |
| `init_directory()` | crée le dossier `image/` (fait automatiquement) |

```python
pic = p.camera.instant_pic()
if isinstance(pic, bytes):
    with open("photo.jpg", "wb") as f:
        f.write(pic)

p.camera.start_record("benchy", timelapse=10)   # rend la main tout de suite
...                                             # l'impression tourne
print(p.camera.stop_record())                   # {"fichier": ".../benchy_20261117_193000.mp4", ...}
```

### Enregistrement vidéo

- Nécessite **ffmpeg**, fourni par le paquet `imageio-ffmpeg` (`pip install imageio-ffmpeg`, rien d'autre à installer).
- **Timelapse** (conseillé pour une impression) : une photo toutes les N secondes, chacune devient une image de la vidéo (30 images/s). 1 h d'impression à `timelapse=10` donne une vidéo d'environ 12 s. Une photo met environ 3,5 s à arriver depuis cette caméra : en dessous de 4 s, l'intervalle n'a pas d'effet.
- **Temps réel** (`timelapse=None`) : ffmpeg lit le flux de la caméra à son vrai rythme. Sur cette machine, le flux ne fournit qu'**environ 1 image par seconde** (limite de la caméra / de `mjpg-streamer`), donc la vidéo est saccadée.
- Le MP4 est « fragmenté » : même si le programme est coupé brutalement, la vidéo déjà enregistrée reste lisible.

L'adresse de la caméra est demandée à Moonraker (`/server/webcams/list`) au premier usage, puis gardée dans `p.camera.snapshot_url` et `p.camera.stream_url`. Pour forcer une autre adresse : `p.camera.snapshot_url = "http://..."`.

> `print(p.camera)` prend une photo à chaque appel : évite-le dans une boucle.

---

## 9. Historiques et fichiers locaux

```python
p.historique_temp()     # [{"temperature", "timestamp", "capteur": "nozzle" | "bed"}, ...]  500 max
p.historique_ventilo()  # [{"timestamp", "percent"}, ...]                                  500 max
p.historique_print()    # [{"nom", "poids", "temps", "timestamp"}, ...]                    50 max
```

- Les températures sont notées à chaque `update()`, le ventilateur seulement quand sa vitesse change.
- Les historiques sont gardés en mémoire et écrits sur le disque **au plus toutes les 30 s** et à la fermeture du programme. Appelle `p.flush()` pour forcer l'écriture.
- L'historique des prints et l'index des gcodes sont écrits **immédiatement**.
- Les tailles maximales se règlent dans `Printer` : `MAX_TEMP`, `MAX_VENTILO`, `MAX_PRINT`.

Organisation sur le disque :

```
client_printer/
├── data/
│   ├── historique_temp.json
│   ├── historique_ventilo.json
│   ├── historique_print.json
│   └── gcode_index.json        <- gcodes connus : temps estimé, poids, chemin
├── gcode/                       <- copies locales des gcodes
└── image/                       <- timelapses
```

---

## 10. Configuration

Tout est dans [`config.py`](config.py) :

| Constante | Défaut | Rôle |
|---|---|---|
| `MOONRAKER_PORT` | `7125` | port de l'API Moonraker |
| `CAMERA_SNAPSHOT_PATH`, `CAMERA_STREAM_PATH` | `/webcam/?action=snapshot`, `/webcam/?action=stream` | adresses de la photo et du flux, utilisées seulement si Moonraker ne les donne pas |
| `VIDEO_DIR` | `image/videos/` | vidéos enregistrées par `start_record()` |
| `GCODE_DIR`, `IMAGE_DIR`, `DATA_DIR` | dans `client_printer/` | dossiers locaux |
| `HISTORY_FLUSH_SECONDS` | `30` | délai entre deux écritures des historiques |

Les limites de sécurité sont dans les classes (`Nozzle.MAX_TEMP`, `Bed.MAX_TEMP`, `Nozzle.MAX_EXTRUDE`, `Heater.WAIT_TIMEOUT`).

---

## 11. Faire évoluer la librairie

### Organisation du code

| Fichier | Classe | Rôle |
|---|---|---|
| `printer.py` | `Printer` | point d'entrée, impression, historiques |
| `heater.py` | `Heater` | base commune buse / plateau |
| `nozzle.py` | `Nozzle` | buse |
| `bed.py` | `Bed` | plateau |
| `temperature.py` | `Temperature` | un capteur de température |
| `ace.py` | `Ace` | ACE |
| `state.py` | `State` | état de l'ACE |
| `state_printer.py` | `State_printer` | état de l'imprimante |
| `camera.py` | `Camera` | caméra |
| `utils.py` | — | fonctions réseau et JSON |
| `config.py` | — | constantes |

### Fonctions de `utils.py`

À utiliser dans tes nouvelles méthodes :

| Fonction | Description |
|---|---|
| `gcode(ip, script, timeout=10)` | envoie un gcode ; augmente `timeout` pour les commandes longues |
| `query_status(ip, {"objet": ["champ", ...]})` | lit des objets Klipper en 1 requête (`None` à la place de la liste = tous les champs) |
| `req(url)` / `req_send(method, url, **kwargs)` | requête HTTP qui renvoie toujours un dict |
| `req_bytes(url)` | requête qui renvoie des octets (images) |
| `load_json(chemin, defaut)` / `save_json(chemin, data)` | lecture / écriture JSON sûre |

### Ajouter une commande

Exemple : une méthode pour faire un bip.

```python
# dans printer.py, classe Printer
def beep(self):
    return gcode(self.url, "M300 S1000 P200")
```

### Lire une nouvelle valeur de Klipper à chaque `update()`

`update()` fait **une seule requête** qui regroupe ce que demande chaque composant. Pour lire une valeur de plus :

- **Côté `Printer`** : ajoute l'objet dans `Printer.QUERY`, puis lis-le dans `p.last_status`.

  ```python
  QUERY = {
      ...
      "temperature_sensor chamber": ["temperature"],
  }
  ```

- **Côté composant** : chaque composant a un attribut `query` (ce qu'il veut lire) et une méthode `apply_status(status)` (ce qu'il en fait). Pour qu'un nouveau composant soit rafraîchi automatiquement, ajoute-le au tuple `self._components` dans `Printer.__init__`.

Pour savoir quels objets et champs existent sur ta machine, voir `README_API_MOONRAKER.md` ou ouvre `http://<ip>:7125/printer/objects/list` dans un navigateur.

---

## 12. Dépannage

| Symptôme | Piste |
|---|---|
| `{"error": "fail connexion"}` partout | mauvaise IP, imprimante éteinte, PC sur un autre réseau. Teste `http://<ip>:7125/server/info` dans un navigateur. |
| `ImportError: attempted relative import` | tu as lancé un fichier de la librairie directement. Lance depuis `exo/` ou ajoute le `sys.path` (voir [Installation](#1-installation)). |
| `"<fichier> inconnu : fais d'abord upload_gcode()"` | `init_print()` ne connaît que les fichiers passés par `upload_gcode()`. |
| `"Klipper n'est pas prêt : shutdown"` | redémarre le firmware depuis l'écran ou l'interface web de l'imprimante. |
| `HTTP 400` + `Must home axis first` | appelle `p.nozzle.home()` avant `move()`. |
| `"buse trop froide pour extruder"` | chauffe d'abord : `p.nozzle.set_target_temp(210, wait=True)`. |
| Les valeurs restent à `None` | tu n'as pas appelé `p.update()`. |
| L'historique des prints reste vide | aucun `update()` ne tournait au moment où le print s'est terminé. |
