# Moonraker – Documentation API complète

*Anycubic Kobra 3 V2 Combo sous firmware Klipper/Moonraker – routes HTTP, WebSocket JSON-RPC, exemples de réponses*

## Sommaire

1. [Bases : URL, port, formats, erreurs](#1-bases)
2. [Informations serveur Moonraker](#2-informations-serveur-moonraker)
3. État de l'imprimante (Klipper)
4. Objets Klipper : lire l'état en détail
5. Températures
6. [Progression de l'impression](#6-progression-de-limpression)
7. Contrôle d'impression (start / pause / resume / cancel)
8. [G-code et macros](#8-g-code-et-macros)
9. [Fichiers (liste, métadonnées, upload, download, miniatures)](#9-fichiers)
10. [File d'attente (job queue)](#10-file-dattente-job-queue)
11. [Historique des impressions](#11-historique-des-impressions)
12. Système, services, reboot
13. Mises à jour
14. [Webcam, capteurs, prises (power devices)](#14-webcam-capteurs-power-devices)
15. Authentification et clé API
16. Base de données Moonraker
17. WebSocket : temps réel
18. [Exemples complets (curl, Python)](#18-exemples-complets)
19. Problèmes fréquents (Kobra 3 V2 / Rinkhals)
20. Aide-mémoire : toutes les routes en un coup d'œil

---

## 1. Bases

**URL de base** : `http://IP_IMPRIMANTE:7125`

Remplace `IP_IMPRIMANTE` par l'adresse IP de ta Kobra (visible sur ton routeur ou sur l'écran). Sur certains firmwares (ex. Rinkhals), Mainsail/Fluidd sont sur d'autres ports (souvent 4409 / 4408), mais **Moonraker reste en général sur 7125**. Teste dans ton navigateur : `http://IP:7125/server/info`.

**Format des réponses** : toutes les réponses HTTP sont en JSON et enveloppées dans une clé `result` :

```json
{ "result": { ... } }
```

**Passage de paramètres** :

- `GET` : paramètres dans l'URL (`?cle=valeur&cle2=valeur2`).
- `POST` : soit dans l'URL (query string), soit en corps JSON (`Content-Type: application/json`). Les deux marchent pour la plupart des routes.
- Les caractères spéciaux dans l'URL doivent être encodés (espace → `%20`, saut de ligne → `%0A`).

**Codes HTTP** :

| Code | Signification |
| --- | --- |
| 200 | OK |
| 400 | Requête invalide (paramètre manquant ou erroné) |
| 401 | Authentification requise |
| 403 | Interdit (IP non autorisée) |
| 404 | Route ou fichier introuvable |
| 405 | Méthode HTTP incorrecte (GET au lieu de POST…) |
| 500 | Erreur interne (souvent Klipper pas prêt) |
| 503 | Klipper non connecté / en cours de démarrage |

**Format d'une erreur** :

```json
{
  "error": {
    "code": 400,
    "message": "Unknown gcode command..."
  }
}
```

**Deux façons de parler à Moonraker** :

- **HTTP** : simple, une requête = une réponse (idéal pour scripts, Home Assistant, cron).
- **WebSocket** : connexion permanente, tu reçois les changements en direct sans interroger sans cesse (voir section 17).

---

## 2. Informations serveur Moonraker

### `GET /server/info`

Première route à tester : indique si Moonraker tourne et si Klipper est connecté.

```json
{
  "result": {
    "klippy_connected": true,
    "klippy_state": "ready",
    "components": ["database", "file_manager", "klippy_apis", "machine", "history", "job_queue", "webcam"],
    "failed_components": [],
    "registered_directories": ["config", "gcodes", "logs"],
    "warnings": [],
    "websocket_count": 1,
    "moonraker_version": "v0.9.3-12-gabcdef",
    "api_version": [1, 5, 0],
    "api_version_string": "1.5.0"
  }
}
```

`klippy_state` peut valoir : `ready`, `startup`, `shutdown`, `error`, `disconnected`.

### `GET /server/config`

Retourne la configuration de Moonraker (contenu de `moonraker.conf` interprété).

### `GET /server/temperature_store`

Historique des températures (≈ 20 minutes, 1 point par seconde). Voir section 5.

### `GET /server/gcode_store?count=100`

Dernières lignes de la console G-code.

```json
{
  "result": {
    "gcode_store": [
      { "message": "G28", "time": 1731000000.12, "type": "command" },
      { "message": "ok", "time": 1731000001.40, "type": "response" }
    ]
  }
}
```

### `POST /server/restart`

Redémarre le service Moonraker (pas Klipper). Réponse : `{"result": "ok"}`.

### Autres

- `POST /server/logs/rollover` : force la rotation des logs (`?application=klipper` ou `moonraker`).
- `GET /server/announcements/list` : annonces officielles.

---

## 3. État de l'imprimante (Klipper)

### `GET /printer/info`

État du logiciel Klipper.

```json
{
  "result": {
    "state": "ready",
    "state_message": "Printer is ready",
    "hostname": "kobra3v2",
    "klipper_path": "/home/user/klipper",
    "python_path": "/home/user/klippy-env/bin/python",
    "log_file": "/tmp/klippy.log",
    "config_file": "/userdata/app/gk/printer.cfg",
    "software_version": "v0.12.0-xxx",
    "cpu_info": "4 core ARM"
  }
}
```

`state` : `ready`, `startup`, `shutdown`, `error`.

### `POST /printer/emergency_stop`

**Arrêt d'urgence** : coupe tout immédiatement (équivalent M112). Il faudra ensuite un `firmware_restart`.

### `POST /printer/restart`

Redémarrage logiciel de Klipper (recharge la config, équivalent `RESTART`).

### `POST /printer/firmware_restart`

Redémarrage complet du firmware et des MCU (équivalent `FIRMWARE_RESTART`). À utiliser après une erreur ou un emergency stop.

Toutes trois répondent `{"result": "ok"}`.

### `GET /printer/query_endstops/status`

État des fins de course.

```json
{ "result": { "x": "open", "y": "open", "z": "TRIGGERED" } }
```

---

## 4. Objets Klipper : lire l'état en détail

C'est **la route la plus importante** : elle donne accès à tout l'état de la machine.

### `GET /printer/objects/list`

Liste tous les objets disponibles sur ta machine (la liste dépend de ton `printer.cfg`).

```json
{
  "result": {
    "objects": ["webhooks", "configfile", "mcu", "gcode_move", "print_stats", "virtual_sdcard",
      "display_status", "pause_resume", "toolhead", "extruder", "heater_bed", "fan",
      "idle_timeout", "motion_report", "system_stats", "gcode_macro START_PRINT"]
  }
}
```

### `GET /printer/objects/query?objet1&objet2=champ1,champ2`

Interroge un ou plusieurs objets. Sans champ → tous les champs de l'objet.

Exemple : `GET /printer/objects/query?print_stats&extruder=temperature,target&heater_bed=temperature,target`

```json
{
  "result": {
    "eventtime": 345678.91,
    "status": {
      "print_stats": { "filename": "benchy.gcode", "state": "printing", "...": "..." },
      "extruder": { "temperature": 219.8, "target": 220.0 },
      "heater_bed": { "temperature": 60.1, "target": 60.0 }
    }
  }
}
```

### Objets utiles et leurs champs

| Objet | Champs principaux |
| --- | --- |
| `print_stats` | `filename`, `state`, `total_duration`, `print_duration`, `filament_used`, `message`, `info.total_layer`, `info.current_layer` |
| `virtual_sdcard` | `file_path`, `progress` (0 à 1), `is_active`, `file_position`, `file_size` |
| `display_status` | `progress`, `message` (progression pilotée par M73) |
| `extruder` | `temperature`, `target`, `power`, `pressure_advance`, `smooth_time`, `can_extrude` |
| `heater_bed` | `temperature`, `target`, `power` |
| `toolhead` | `position` \[x,y,z,e\], `homed_axes` ("xyz"), `print_time`, `estimated_print_time`, `max_velocity`, `max_accel`, `extruder`, `axis_minimum`, `axis_maximum` |
| `gcode_move` | `speed_factor`, `extrude_factor`, `speed`, `homing_origin`, `position`, `gcode_position`, `absolute_coordinates` |
| `motion_report` | `live_position`, `live_velocity`, `live_extruder_velocity` |
| `fan` | `speed` (0 à 1), `rpm` |
| `heater_fan xxx` / `controller_fan xxx` | `speed`, `rpm` |
| `idle_timeout` | `state` (`Idle`, `Ready`, `Printing`), `printing_time` |
| `pause_resume` | `is_paused` |
| `webhooks` | `state`, `state_message` |
| `system_stats` | `sysload`, `cputime`, `memavail` |
| `mcu` | `mcu_version`, `mcu_build_versions`, `last_stats` |
| `filament_switch_sensor xxx` | `filament_detected`, `enabled` |
| `bed_mesh` | `profile_name`, `mesh_min`, `mesh_max`, `probed_matrix`, `mesh_matrix` |
| `exclude_object` | `objects`, `excluded_objects`, `current_object` |
| `temperature_sensor xxx` | `temperature`, `measured_min_temp`, `measured_max_temp` |
| `gcode_macro NOM` | variables de la macro |
| `configfile` | `config`, `settings`, `save_config_pending` |

**Valeurs possibles de `print_stats.state`** : `standby` (rien en cours), `printing`, `paused`, `complete`, `error`, `cancelled`.

Exemple complet de `print_stats` pendant une impression :

```json
"print_stats": {
  "filename": "benchy.gcode",
  "total_duration": 1523.4,
  "print_duration": 1498.2,
  "filament_used": 3250.7,
  "state": "printing",
  "message": "",
  "info": { "total_layer": 240, "current_layer": 87 }
}
```

`filament_used` est en **millimètres**. `info` peut être `null` si le slicer n'envoie pas `SET_PRINT_STATS_INFO`.

---

## 5. Températures

**État instantané** :

`GET /printer/objects/query?extruder=temperature,target,power&heater_bed=temperature,target,power`

```json
{
  "result": {
    "eventtime": 345678.91,
    "status": {
      "extruder": { "temperature": 24.3, "target": 0.0, "power": 0.0 },
      "heater_bed": { "temperature": 23.1, "target": 0.0, "power": 0.0 }
    }
  }
}
```

**Historique (≈ 20 min)** : `GET /server/temperature_store`

```json
{
  "result": {
    "extruder": {
      "temperatures": [24.1, 24.2, 24.3],
      "targets": [0, 0, 0],
      "powers": [0, 0, 0]
    },
    "heater_bed": {
      "temperatures": [23.0, 23.1, 23.1],
      "targets": [0, 0, 0],
      "powers": [0, 0, 0]
    }
  }
}
```

Paramètre optionnel : `?include_monitors=true` pour inclure les capteurs de température supplémentaires.

**Régler une température** (via G-code, voir section 8) :

- Buse : `POST /printer/gcode/script?script=M104 S220`
- Plateau : `POST /printer/gcode/script?script=M140 S60`
- Éteindre : `M104 S0` et `M140 S0`
- Attendre la température : `M109 S220` / `M190 S60` (la requête reste bloquée jusqu'à l'atteinte).

**Tous les capteurs de température** : `GET /server/sensors/list`.

---

## 6. Progression de l'impression

Une seule requête suffit :

`GET /printer/objects/query?print_stats&virtual_sdcard&display_status&toolhead&gcode_move`

```json
{
  "result": {
    "eventtime": 345900.5,
    "status": {
      "print_stats": {
        "filename": "benchy.gcode",
        "total_duration": 1523.4,
        "print_duration": 1498.2,
        "filament_used": 3250.7,
        "state": "printing",
        "message": "",
        "info": { "total_layer": 240, "current_layer": 87 }
      },
      "virtual_sdcard": {
        "file_path": "/userdata/app/gk/gcodes/benchy.gcode",
        "progress": 0.362,
        "is_active": true,
        "file_position": 1250340,
        "file_size": 3452000
      },
      "display_status": { "progress": 0.36, "message": null },
      "toolhead": { "position": [120.5, 98.2, 8.7, 4521.3], "homed_axes": "xyz" },
      "gcode_move": { "speed_factor": 1.0, "extrude_factor": 1.0 }
    }
  }
}
```

### Calculs utiles

- **Pourcentage** : `virtual_sdcard.progress × 100` (ici 36,2 %).
- **Temps écoulé** : `print_duration` (secondes, hors pauses) ou `total_duration` (avec préparation et pauses).
- **Temps restant estimé** : `print_duration / progress − print_duration` (plus fiable en milieu d'impression qu'au début).
- **Couche actuelle** : `print_stats.info.current_layer / total_layer`.
- **Vitesse réelle** : `gcode_move.speed_factor × 100` en %.

Les métadonnées du fichier en cours (`estimated_time`, `layer_count`, `filament_total`…) s'obtiennent via `GET /server/files/metadata?filename=benchy.gcode` (section 9).

---

## 7. Contrôle d'impression

### `POST /printer/print/start?filename=benchy.gcode`

Lance l'impression d'un fichier **déjà présent** sur l'imprimante. Pour un fichier dans un sous-dossier : `filename=dossier/benchy.gcode`.

```json
{ "result": "ok" }
```

### `POST /printer/print/pause`

Met en pause (équivalent macro `PAUSE`). Réponse : `{"result": "ok"}`.

### `POST /printer/print/resume`

Reprend après une pause.

### `POST /printer/print/cancel`

Annule l'impression en cours (exécute la macro `CANCEL_PRINT` si elle existe).

**Erreur typique** si Klipper n'est pas prêt ou si une impression est déjà en cours :

```json
{ "error": { "code": 400, "message": "Klipper reports not ready" } }
```

**Envoyer ET lancer** un fichier en une requête : voir `print=true` dans l'upload (section 9).

**Ajuster en cours d'impression** (via G-code) :

- Vitesse à 120 % : `M220 S120`
- Débit à 95 % : `M221 S95`
- Décalage Z (babystep) : `SET_GCODE_OFFSET Z_ADJUST=0.02 MOVE=1`
- Ventilateur à 50 % : `M106 S128` (0 à 255) ; couper : `M107`
- Exclure un objet : `EXCLUDE_OBJECT NAME=nom_objet`

---

## 8. G-code et macros

### `POST /printer/gcode/script?script=G28`

Exécute n'importe quelle commande G-code. Plusieurs commandes : sépare par `%0A` (saut de ligne).

```
POST /printer/gcode/script?script=G28%0AG1%20Z10%20F600
```

Ou en JSON :

```json
{ "script": "G28\nG1 Z10 F600" }
```

Réponse : `{"result": "ok"}` (une fois la commande terminée ; les commandes longues comme `G28` ou `M109` bloquent la requête – prévois un timeout élevé).

### `GET /printer/gcode/help`

Liste de toutes les commandes et macros disponibles avec leur description.

```json
{
  "result": {
    "G28": "Home axes",
    "PAUSE": "Pause the print",
    "SET_GCODE_OFFSET": "Set a virtual offset to g-code positions"
  }
}
```

**Utilise cette route pour découvrir les macros spécifiques à ta Kobra** (macros du firmware custom, commandes pour l'ACE Pro du Combo, etc.).

### Commandes G-code courantes

| Action | Commande |
| --- | --- |
| Home tous axes | `G28` |
| Home X Y seulement | `G28 X Y` |
| Mouvement absolu | `G90` puis `G1 X100 Y100 F3000` |
| Mouvement relatif | `G91` puis `G1 Z5 F600` |
| Moteurs off | `M84` |
| Extruder 10 mm | `G91` + `G1 E10 F300` (buse chaude !) |
| Arrêt d'urgence | `M112` |
| Sauvegarder la config | `SAVE_CONFIG` |
| Maillage du plateau | `BED_MESH_CALIBRATE` |
| Charger un profil de maillage | `BED_MESH_PROFILE LOAD=default` |
| Redémarrer Klipper | `RESTART` |

Les réponses de la console arrivent via `GET /server/gcode_store` ou en temps réel via la notification WebSocket `notify_gcode_response`.

---

## 9. Fichiers

Racines (`root`) courantes : `gcodes` (fichiers à imprimer), `config` (fichiers de configuration), `logs`.

### `GET /server/files/roots`

Liste les racines accessibles et leurs droits.

### `GET /server/files/list?root=gcodes`

Liste tous les fichiers de la racine (récursif).

```json
{
  "result": [
    { "path": "benchy.gcode", "modified": 1731000000.5, "size": 3452000, "permissions": "rw" },
    { "path": "pieces/support.gcode", "modified": 1730900000.1, "size": 812000, "permissions": "rw" }
  ]
}
```

### `GET /server/files/directory?path=gcodes&extended=true`

Contenu d'un seul dossier (non récursif). `extended=true` ajoute les métadonnées.

```json
{
  "result": {
    "dirs": [{ "dirname": "pieces", "modified": 1730900000.1, "size": 4096, "permissions": "rw" }],
    "files": [{ "filename": "benchy.gcode", "modified": 1731000000.5, "size": 3452000, "permissions": "rw" }],
    "disk_usage": { "total": 7516192768, "used": 2147483648, "free": 5368709120 },
    "root_info": { "name": "gcodes", "permissions": "rw" }
  }
}
```

### `GET /server/files/metadata?filename=benchy.gcode`

Métadonnées extraites du G-code : très utile pour afficher durée estimée, couches, filament, miniatures.

```json
{
  "result": {
    "filename": "benchy.gcode",
    "size": 3452000,
    "modified": 1731000000.5,
    "slicer": "OrcaSlicer",
    "slicer_version": "2.2.0",
    "layer_count": 240,
    "layer_height": 0.2,
    "first_layer_height": 0.2,
    "object_height": 48.0,
    "estimated_time": 4120,
    "nozzle_diameter": 0.4,
    "filament_total": 5120.3,
    "filament_weight_total": 15.4,
    "filament_type": "PLA",
    "first_layer_extr_temp": 220,
    "first_layer_bed_temp": 60,
    "thumbnails": [
      { "width": 32, "height": 32, "size": 1520, "relative_path": ".thumbs/benchy-32x32.png" },
      { "width": 300, "height": 300, "size": 24310, "relative_path": ".thumbs/benchy-300x300.png" }
    ]
  }
}
```

Les champs présents dépendent du slicer. `estimated_time` est en secondes.

### Autres routes de lecture

- `POST /server/files/metascan?filename=benchy.gcode` : force l'extraction des métadonnées.
- `GET /server/files/thumbnails?filename=benchy.gcode` : liste des miniatures.
- **Télécharger une miniature** : `GET /server/files/gcodes/.thumbs/benchy-300x300.png`
- **Télécharger un fichier** : `GET /server/files/gcodes/benchy.gcode` (config : `GET /server/files/config/printer.cfg`).

### Upload : `POST /server/files/upload`

Envoi d'un fichier en `multipart/form-data` :

| Champ | Description |
| --- | --- |
| `file` | Le fichier (obligatoire) |
| `root` | `gcodes` par défaut |
| `path` | Sous-dossier de destination (optionnel) |
| `checksum` | SHA256 pour vérifier l'intégrité (optionnel) |
| `print` | `true` pour lancer l'impression juste après (optionnel) |

```bash
curl -F "file=@benchy.gcode" -F "root=gcodes" -F "print=true" http://IP:7125/server/files/upload
```

```json
{
  "item": { "path": "benchy.gcode", "root": "gcodes", "modified": 1731000000.5, "size": 3452000, "permissions": "rw" },
  "print_started": true,
  "print_queued": false,
  "action": "create_file"
}
```

(Cette réponse n'est pas enveloppée dans `result`.)

### Supprimer, dossiers, déplacer

- Supprimer un fichier : `DELETE /server/files/gcodes/benchy.gcode`
- Créer un dossier : `POST /server/files/directory?path=gcodes/nouveau_dossier`
- Supprimer un dossier : `DELETE /server/files/directory?path=gcodes/nouveau_dossier&force=true`
- Déplacer : `POST /server/files/move?source=gcodes/a.gcode&dest=gcodes/pieces/a.gcode`
- Copier : `POST /server/files/copy?source=gcodes/a.gcode&dest=gcodes/b.gcode`

```json
{ "result": { "item": { "path": "benchy.gcode", "root": "gcodes" }, "action": "delete_file" } }
```

---

## 10. File d'attente (job queue)

### `GET /server/job_queue/status`

```json
{
  "result": {
    "queued_jobs": [
      { "filename": "piece1.gcode", "job_id": "0000000000A1B2C3", "time_added": 1731000100.2, "time_in_queue": 35.4 }
    ],
    "queue_state": "ready"
  }
}
```

`queue_state` : `ready`, `loading`, `starting`, `paused`.

### Actions

- `POST /server/job_queue/job` avec `{"filenames": ["piece1.gcode", "piece2.gcode"], "reset": false}` : ajoute des fichiers.
- `DELETE /server/job_queue/job?job_ids=ID1,ID2` : retire des jobs (`?all=true` vide la file).
- `POST /server/job_queue/pause` / `POST /server/job_queue/start` : pause / démarre la file.
- `POST /server/job_queue/jump?job_id=ID` : passe un job en tête de file.

---

## 11. Historique des impressions

### `GET /server/history/list?limit=50&start=0&order=desc`

Paramètres : `limit`, `start`, `since` (timestamp), `before` (timestamp), `order` (`asc` / `desc`).

```json
{
  "result": {
    "count": 1,
    "jobs": [
      {
        "job_id": "000001",
        "user": "_TRUSTED_USER_",
        "filename": "benchy.gcode",
        "status": "completed",
        "start_time": 1731000000.0,
        "end_time": 1731004200.0,
        "print_duration": 4120.5,
        "total_duration": 4200.0,
        "filament_used": 5120.3,
        "exists": true,
        "metadata": { "estimated_time": 4120, "layer_count": 240 }
      }
    ]
  }
}
```

`status` : `completed`, `cancelled`, `error`, `klippy_shutdown`, `klippy_disconnect`, `server_exit`, `in_progress`, `interrupted`.

### `GET /server/history/totals`

Statistiques cumulées.

```json
{
  "result": {
    "job_totals": {
      "total_jobs": 42,
      "total_time": 512340.5,
      "total_print_time": 498000.2,
      "total_filament_used": 215000.0,
      "longest_job": 36000.0,
      "longest_print": 35500.0
    }
  }
}
```

### Autres routes

- `GET /server/history/job?uid=ID` : détail d'un job.
- `DELETE /server/history/job?uid=ID` ou `?all=true` : supprime.
- `POST /server/history/reset_totals` : remet les totaux à zéro.

---

## 12. Système, services, reboot

### `GET /machine/system_info`

Infos sur la carte (CPU, mémoire, distribution, services).

```json
{
  "result": {
    "system_info": {
      "cpu_info": { "cpu_count": 4, "processor": "aarch64", "total_memory": 1007000 },
      "distribution": { "name": "Linux" },
      "available_services": ["klipper", "moonraker"],
      "service_state": { "klipper": { "active_state": "active", "sub_state": "running" } }
    }
  }
}
```

### Autres routes

- `GET /machine/proc_stats` : utilisation CPU/mémoire, température CPU, réseau.
- `POST /machine/reboot` : redémarre la carte.
- `POST /machine/shutdown` : éteint la carte.
- `POST /machine/services/restart?service=klipper` (idem `stop` et `start`).
- `GET /machine/peripherals/usb`, `/serial`, `/video`.

Selon le firmware de la Kobra, les routes de services peuvent être limitées ou indisponibles.

---

## 13. Mises à jour

- `GET /machine/update/status?refresh=false` : état des composants (Klipper, Moonraker, clients web).
- `POST /machine/update/refresh` : recherche de mises à jour.
- `POST /machine/update/full` : tout mettre à jour.
- `POST /machine/update/klipper` / `moonraker` / `system`
- `POST /machine/update/client?name=mainsail`
- `POST /machine/update/recover?name=klipper` : réparer un dépôt corrompu.

**Attention sur Kobra** : le firmware est custom ; ne lance pas de mise à jour automatique sans vérifier la procédure de ton firmware, au risque de casser l'installation.

---

## 14. Webcam, capteurs, prises (power devices)

### Webcams : `GET /server/webcams/list`

```json
{
  "result": {
    "webcams": [
      {
        "name": "cam1",
        "enabled": true,
        "service": "mjpegstreamer",
        "stream_url": "/webcam/?action=stream",
        "snapshot_url": "/webcam/?action=snapshot",
        "flip_horizontal": false,
        "flip_vertical": false,
        "rotation": 0,
        "target_fps": 15
      }
    ]
  }
}
```

URL complète du flux : `http://IP` + `stream_url` (le port dépend de ta config). Autres routes : `GET /server/webcams/item?name=cam1`, `POST /server/webcams/item`, `DELETE /server/webcams/item?name=cam1`, `POST /server/webcams/test?name=cam1`.

### Capteurs

`GET /server/sensors/list` (capteurs configurés dans Moonraker), `GET /server/sensors/measurements` (valeurs).

### Prises / relais

- `GET /machine/device_power/devices` : liste.
- `GET /machine/device_power/status?nom_du_device` : état.
- `POST /machine/device_power/on?nom_du_device` / `off` / `toggle`.

```json
{ "result": { "nom_du_device": "on" } }
```

### Spoolman (gestion des bobines, si activé)

- `GET /server/spoolman/status`
- `POST /server/spoolman/spool_id` avec `{"spool_id": 3}`

---

## 15. Authentification et clé API

Par défaut, les adresses du réseau local listées dans `trusted_clients` n'ont **pas besoin** de s'authentifier. Si tu reçois une 401 :

- **Clé API** : récupère-la depuis un client de confiance avec `GET /access/api_key`, puis ajoute l'en-tête `X-Api-Key: TA_CLE` à tes requêtes.
- **Token JWT** : `POST /access/login` avec `{"username": "...", "password": "..."}` → renvoie `token` et `refresh_token`. Utilise `Authorization: Bearer TOKEN`.
- **Token à usage unique** (pour WebSocket depuis un navigateur) : `GET /access/oneshot_token` puis `ws://IP:7125/websocket?token=XXX`.

Autres routes : `POST /access/api_key` (régénère la clé), `GET /access/user`, `GET /access/users/list`, `POST /access/refresh_jwt`, `POST /access/logout`.

```bash
curl -H "X-Api-Key: TA_CLE" http://IP:7125/printer/info
```

---

## 16. Base de données Moonraker

Stockage clé/valeur interne (utile pour stocker des réglages de ton automatisation).

- `GET /server/database/list` : namespaces.
- `GET /server/database/item?namespace=monapp&key=reglage1`
- `POST /server/database/item` avec `{"namespace": "monapp", "key": "reglage1", "value": 42}`
- `DELETE /server/database/item?namespace=monapp&key=reglage1`

```json
{ "result": { "namespace": "monapp", "key": "reglage1", "value": 42 } }
```

---

## 17. WebSocket : temps réel

**Adresse** : `ws://IP_IMPRIMANTE:7125/websocket`

Protocole : **JSON-RPC 2.0**. Chaque requête a un `method`, des `params` et un `id`.

```json
{ "jsonrpc": "2.0", "method": "printer.info", "id": 1 }
```

Réponse :

```json
{ "jsonrpc": "2.0", "result": { "state": "ready", "hostname": "kobra3v2" }, "id": 1 }
```

### Méthodes équivalentes aux routes HTTP

| Route HTTP | Méthode WebSocket |
| --- | --- |
| `GET /server/info` | `server.info` |
| `GET /printer/info` | `printer.info` |
| `POST /printer/emergency_stop` | `printer.emergency_stop` |
| `POST /printer/restart` | `printer.restart` |
| `POST /printer/firmware_restart` | `printer.firmware_restart` |
| `GET /printer/objects/list` | `printer.objects.list` |
| `GET /printer/objects/query` | `printer.objects.query` |
| `POST /printer/objects/subscribe` | `printer.objects.subscribe` |
| `POST /printer/gcode/script` | `printer.gcode.script` |
| `GET /printer/gcode/help` | `printer.gcode.help` |
| `POST /printer/print/start` | `printer.print.start` |
| `POST /printer/print/pause` | `printer.print.pause` |
| `POST /printer/print/resume` | `printer.print.resume` |
| `POST /printer/print/cancel` | `printer.print.cancel` |
| `GET /server/files/list` | `server.files.list` |
| `GET /server/files/metadata` | `server.files.metadata` |
| `GET /server/history/list` | `server.history.list` |
| `GET /server/temperature_store` | `server.temperature_store` |
| `GET /server/job_queue/status` | `server.job_queue.status` |
| `POST /machine/reboot` | `machine.reboot` |

Règle générale : remplace les `/` par des `.` et enlève le préfixe HTTP. Les paramètres passent dans `params` (objet JSON).

### S'abonner aux changements : `printer.objects.subscribe`

```json
{
  "jsonrpc": "2.0",
  "method": "printer.objects.subscribe",
  "params": {
    "objects": {
      "print_stats": null,
      "virtual_sdcard": ["progress", "is_active"],
      "extruder": ["temperature", "target"],
      "heater_bed": ["temperature", "target"]
    }
  },
  "id": 5
}
```

`null` = tous les champs de l'objet. La réponse contient l'état initial complet :

```json
{
  "jsonrpc": "2.0",
  "result": {
    "eventtime": 345678.9,
    "status": {
      "print_stats": { "state": "standby", "filename": "" },
      "virtual_sdcard": { "progress": 0, "is_active": false },
      "extruder": { "temperature": 24.3, "target": 0 },
      "heater_bed": { "temperature": 23.1, "target": 0 }
    }
  },
  "id": 5
}
```

Ensuite, **à chaque changement** (environ 1 fois par seconde max), tu reçois une notification **sans `id`** et **uniquement avec les champs modifiés** :

```json
{
  "jsonrpc": "2.0",
  "method": "notify_status_update",
  "params": [
    { "extruder": { "temperature": 25.1 }, "heater_bed": { "temperature": 23.2 } },
    345679.9
  ]
}
```

À toi de conserver un état local et de le fusionner avec chaque mise à jour.

### Notifications (envoyées automatiquement)

| Notification | Quand |
| --- | --- |
| `notify_status_update` | Changement d'un objet abonné |
| `notify_klippy_ready` | Klipper est prêt |
| `notify_klippy_shutdown` | Klipper en arrêt d'urgence / erreur |
| `notify_klippy_disconnected` | Moonraker a perdu Klipper |
| `notify_gcode_response` | Ligne de console G-code reçue |
| `notify_filelist_changed` | Fichier ajouté / supprimé / modifié |
| `notify_metadata_update` | Métadonnées d'un fichier mises à jour |
| `notify_job_queue_changed` | File d'attente modifiée |
| `notify_history_changed` | Nouveau job ou job terminé |
| `notify_proc_stat_update` | Stats CPU/mémoire (1 fois par seconde) |
| `notify_service_state_changed` | Un service change d'état |
| `notify_update_response` | Progression d'une mise à jour |
| `notify_power_changed` | Une prise change d'état |
| `notify_cpu_throttled` | Limitation CPU détectée |

Exemples :

```json
{ "jsonrpc": "2.0", "method": "notify_gcode_response", "params": ["// Probe at 120.0,120.0 is z=1.235"] }
```

```json
{ "jsonrpc": "2.0", "method": "notify_history_changed",
  "params": [{ "action": "finished", "job": { "filename": "benchy.gcode", "status": "completed" } }] }
```

### Détecter la fin d'une impression

Abonne-toi à `print_stats` et surveille `state` : passage de `printing` à `complete` (terminé), `cancelled` (annulé) ou `error`. Alternative : écouter `notify_history_changed` avec `action: "finished"`.

### Autres méthodes utiles

- `server.connection.identify` : s'identifier (nom du client, version, type `web` / `bot` / `other`).
- `server.websocket.id` : récupère ton `connection_id` (utile pour `POST /printer/objects/subscribe?connection_id=...&print_stats` en HTTP).
- `server.files.get_directory`, `server.files.delete_file`, `server.files.move`, `server.files.copy`, `server.database.get_item`, `server.database.post_item`, `machine.device_power.on`…

---

## 18. Exemples complets

### curl

```bash
# Moonraker + Klipper prêts ?
curl http://IP:7125/server/info

# Températures
curl "http://IP:7125/printer/objects/query?extruder=temperature,target&heater_bed=temperature,target"

# Progression
curl "http://IP:7125/printer/objects/query?print_stats&virtual_sdcard"

# Envoyer et lancer un fichier
curl -F "file=@benchy.gcode" -F "print=true" http://IP:7125/server/files/upload

# Lancer un fichier déjà présent
curl -X POST "http://IP:7125/printer/print/start?filename=benchy.gcode"

# Pause / reprise / annulation
curl -X POST http://IP:7125/printer/print/pause
curl -X POST http://IP:7125/printer/print/resume
curl -X POST http://IP:7125/printer/print/cancel

# G-code libre
curl -X POST "http://IP:7125/printer/gcode/script?script=G28"
```

### Python (HTTP)

```python
import requests

BASE = "http://IP:7125"

def status():
    r = requests.get(f"{BASE}/printer/objects/query", params={
        "print_stats": "", "virtual_sdcard": "progress",
        "extruder": "temperature,target", "heater_bed": "temperature,target",
    }, timeout=10)
    r.raise_for_status()
    s = r.json()["result"]["status"]
    return {
        "etat": s["print_stats"]["state"],
        "fichier": s["print_stats"]["filename"],
        "progression_pct": round(s["virtual_sdcard"]["progress"] * 100, 1),
        "buse": s["extruder"]["temperature"],
        "plateau": s["heater_bed"]["temperature"],
    }

def upload_and_print(path):
    with open(path, "rb") as f:
        r = requests.post(f"{BASE}/server/files/upload",
                          files={"file": f}, data={"print": "true"}, timeout=300)
    r.raise_for_status()
    return r.json()

print(status())
```

### Python (WebSocket temps réel)

```python
import asyncio, json, websockets   # pip install websockets

async def main():
    async with websockets.connect("ws://IP:7125/websocket") as ws:
        await ws.send(json.dumps({
            "jsonrpc": "2.0", "method": "printer.objects.subscribe", "id": 1,
            "params": {"objects": {
                "print_stats": None,
                "virtual_sdcard": ["progress"],
                "extruder": ["temperature", "target"],
                "heater_bed": ["temperature", "target"],
            }}
        }))
        etat = {}
        async for raw in ws:
            msg = json.loads(raw)
            if msg.get("id") == 1:
                etat = msg["result"]["status"]
            elif msg.get("method") == "notify_status_update":
                for obj, champs in msg["params"][0].items():
                    etat.setdefault(obj, {}).update(champs)
                print(etat.get("print_stats", {}).get("state"),
                      etat.get("virtual_sdcard", {}).get("progress"))

asyncio.run(main())
```

---

## 19. Problèmes fréquents

| Symptôme | Cause probable | Solution |
| --- | --- | --- |
| Connexion refusée sur 7125 | Moonraker non lancé ou autre port | Vérifie le firmware, teste `:7125/server/info`, scanne les ports |
| 401 Unauthorized | IP non autorisée | Ajoute ton IP dans `trusted_clients` ou utilise `X-Api-Key` |
| `klippy_state: "disconnected"` | Klipper pas démarré | Attends, ou `POST /printer/firmware_restart` |
| `klippy_state: "shutdown"` | Erreur MCU / arrêt d'urgence | Lis `state_message`, puis `firmware_restart` |
| 400 « Unknown command » | Macro ou commande inexistante sur ton firmware | Vérifie `GET /printer/gcode/help` |
| `print/start` refusé | Impression déjà en cours ou Klipper non prêt | Contrôle `print_stats.state` avant |
| Upload qui échoue | Disque plein ou fichier trop gros | Vérifie `disk_usage` dans `/server/files/directory` |
| Progression à 0 % ou fausse | Impression lancée hors `virtual_sdcard` (écran / app Anycubic) | Utilise `print/start` de Moonraker |
| `info.total_layer` à `null` | Slicer sans `SET_PRINT_STATS_INFO` | Ajoute-le dans le G-code de début ou utilise `metadata.layer_count` |

**Spécificités Kobra 3 V2 Combo** : les noms d'objets et macros peuvent différer d'un firmware custom à l'autre, et l'ACE Pro (multicouleur du Combo) dispose souvent de commandes dédiées. Fais toujours `GET /printer/objects/list` et `GET /printer/gcode/help` pour voir ce qui existe réellement sur ta machine.

---

## 20. Aide-mémoire

### Lecture (GET)

| Route | Rôle |
| --- | --- |
| `/server/info` | Moonraker + état Klipper |
| `/server/config` | Config Moonraker |
| `/server/temperature_store` | Historique températures |
| `/server/gcode_store?count=N` | Historique console |
| `/printer/info` | Infos Klipper |
| `/printer/objects/list` | Objets disponibles |
| `/printer/objects/query?obj=champ` | État des objets |
| `/printer/gcode/help` | Commandes et macros |
| `/printer/query_endstops/status` | Fins de course |
| `/server/files/roots` | Racines de fichiers |
| `/server/files/list?root=gcodes` | Liste des fichiers |
| `/server/files/directory?path=gcodes` | Contenu d'un dossier |
| `/server/files/metadata?filename=X` | Métadonnées G-code |
| `/server/files/thumbnails?filename=X` | Miniatures |
| `/server/files/gcodes/X` | Télécharger un fichier |
| `/server/job_queue/status` | File d'attente |
| `/server/history/list` | Historique |
| `/server/history/totals` | Totaux |
| `/server/webcams/list` | Webcams |
| `/server/sensors/list` | Capteurs |
| `/machine/system_info` | Infos système |
| `/machine/proc_stats` | Stats CPU/RAM |
| `/machine/update/status` | État des mises à jour |
| `/machine/device_power/devices` | Prises |
| `/access/api_key` | Clé API |
| `/server/database/list` | Namespaces BDD |

### Action (POST / DELETE)

| Route | Rôle |
| --- | --- |
| `POST /printer/print/start?filename=X` | Lancer |
| `POST /printer/print/pause` | Pause |
| `POST /printer/print/resume` | Reprendre |
| `POST /printer/print/cancel` | Annuler |
| `POST /printer/gcode/script?script=X` | G-code |
| `POST /printer/emergency_stop` | Arrêt d'urgence |
| `POST /printer/restart` | Restart Klipper |
| `POST /printer/firmware_restart` | Restart firmware |
| `POST /server/restart` | Restart Moonraker |
| `POST /server/files/upload` | Envoyer un fichier |
| `POST /server/files/directory?path=X` | Créer un dossier |
| `POST /server/files/move` / `copy` | Déplacer / copier |
| `DELETE /server/files/gcodes/X` | Supprimer un fichier |
| `POST /server/job_queue/job` | Ajouter à la file |
| `POST /server/job_queue/start` / `pause` | Lancer / pauser la file |
| `POST /server/history/reset_totals` | Reset totaux |
| `POST /machine/reboot` / `shutdown` | Reboot / extinction |
| `POST /machine/services/restart?service=X` | Restart service |
| `POST /machine/update/refresh` | Chercher des MAJ |
| `POST /machine/device_power/on?X` | Allumer une prise |
| `POST /server/database/item` | Écrire en BDD |

---

*Cette documentation est basée sur l'API Moonraker standard. Certaines routes peuvent être absentes ou différentes selon le firmware installé sur ta Kobra 3 V2 Combo : vérifie toujours avec `/server/info`, `/printer/objects/list` et `/printer/gcode/help`.*
