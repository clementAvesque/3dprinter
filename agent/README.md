# Agent local

Relie tes imprimantes au serveur en ligne avec ta librairie `client_printer`. Il ouvre lui-même une connexion
sortante `wss://` : aucun port à ouvrir sur ta box.

## Configuration : `config.json`

Copié de `config.example.json`. Une entrée par imprimante :

```json
"machines": [{"id": "kobra-1", "ip": "192.168.1.42", "nom": "Kobra 3 Combo"}]
```

| Clé | Rôle |
| --- | --- |
| `serveur` | adresse du WebSocket du serveur (`wss://agent.ton-domaine.fr:8443/ws` en ligne) |
| `empreinte_serveur` | vide = lue dans `secrets/empreinte_serveur.txt` (créée par `npm run pki`) |
| `console_gcode` | `false` par défaut : la console gcode du site est refusée ici |
| `enregistrement_auto` | filme chaque impression. Si `web_printer_admin` tourne aussi sur ce PC, ne le laisser actif que d'un côté |
| `limites` | températures max acceptées, en plus des bornes du protocole |

## Lancer

```bash
pip install -r requirements.txt
python agent.py --generer-cle   # une fois : clé de signature (la clé privée ne quitte jamais ce PC)
python agent.py
```

Journal des commandes reçues : `agent.log` (qui, quelle machine, quelle action).

## Sur une Raspberry Pi (démarrage automatique)

L'agent n'a **pas** de session de 12 h à renouveler : il prouve son identité à chaque connexion
(certificat + clé de signature) et se reconnecte tout seul. Il suffit qu'il démarre avec la Raspberry.

1. Sur ton PC (Git Bash), depuis la racine du projet : `bash agent/exporter-raspberry.sh`
   → `agent-raspberry.tar.gz` (environ 50 Ko : agent, config, clés, protocole, code de la librairie).
2. Copie-la : `scp agent-raspberry.tar.gz pi@raspberrypi.local:~`, puis **supprime-la du PC** (elle contient les clés).
3. Sur la Raspberry, une seule fois :
   ```bash
   mkdir -p ~/imprimantes && tar xzf ~/agent-raspberry.tar.gz -C ~/imprimantes && rm ~/agent-raspberry.tar.gz
   bash ~/imprimantes/agent/installer-raspberry.sh
   ```
   Le script installe Python et ffmpeg, crée l'environnement, protège les clés, attend l'heure exacte au démarrage
   et installe le service `imprimantes-agent` : il démarre à chaque allumage et redémarre s'il s'arrête.
4. **Arrête l'agent du PC** : le serveur n'en accepte qu'un.

Ensuite : `journalctl -u imprimantes-agent -f` (journal), `sudo systemctl restart imprimantes-agent` (redémarrer).
Ne lance pas `python agent.py` à la main tant que le service tourne : ce serait un 2e agent, refusé.

Les gcodes de l'imprimante sont re-téléchargés tout seuls au premier démarrage ; les vidéos sont enregistrées
sur la carte SD (`client_printer/image/videos`). Si `web_printer_admin` tourne encore sur le PC, chaque print serait
filmé deux fois : coupe `enregistrement_auto` d'un côté.

## Ce que l'agent refuse, même si le serveur était piraté

- toute commande absente de `../protocole/commandes.json`, tout champ inconnu, toute valeur hors bornes ;
- tout nom de fichier avec chemin (`../`, `C:`, `/`) ;
- un serveur dont le certificat n'a pas exactement l'empreinte attendue ;
- un message rejoué, hors séquence ou daté de plus de 30 s (l'horloge du PC doit être à l'heure).

Il n'exécute jamais de commande système : seules les méthodes de la librairie sont appelées.
