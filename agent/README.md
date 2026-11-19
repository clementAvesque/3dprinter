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
| `enregistrement_auto` | filme chaque impression. Si `web_printer` tourne aussi sur ce PC, ne le laisser actif que d'un côté |
| `limites` | températures max acceptées, en plus des bornes du protocole |

## Lancer

```bash
pip install -r requirements.txt
python agent.py --generer-cle   # une fois : clé de signature (la clé privée ne quitte jamais ce PC)
python agent.py
```

Journal des commandes reçues : `agent.log` (qui, quelle machine, quelle action).

## Ce que l'agent refuse, même si le serveur était piraté

- toute commande absente de `../protocole/commandes.json`, tout champ inconnu, toute valeur hors bornes ;
- tout nom de fichier avec chemin (`../`, `C:`, `/`) ;
- un serveur dont le certificat n'a pas exactement l'empreinte attendue ;
- un message rejoué, hors séquence ou daté de plus de 30 s (l'horloge du PC doit être à l'heure).

Il n'exécute jamais de commande système : seules les méthodes de la librairie sont appelées.
