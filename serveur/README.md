# Serveur en ligne : API + WebSocket agent

Deux portes dans un seul programme Node.js :

| Porte | Adresse | Qui s'y connecte | Protection |
| --- | --- | --- | --- |
| API du site | `http://127.0.0.1:3000/api/v1` (derrière Caddy en HTTPS) | le site, les navigateurs | session + 2FA, rôles, CSRF, limites de débit, audit |
| WebSocket agent | `wss://0.0.0.0:8443/ws` | **uniquement** l'agent local | TLS 1.3 + certificat client, défi signé Ed25519, anti-rejeu, client unique, bannissement |

La liste des commandes autorisées est dans `../protocole/commandes.json`, lue aussi par l'agent.

## Installation (une fois)

```bash
npm install
npm run pki                                   # autorité privée + certificats (localhost)
python ../agent/agent.py --generer-cle        # clé de l'agent, créée sur SA machine
npm run agent:enroler -- ../agent/secrets/agent_ed25519.pub.pem
npm run admin:creer -- ton@email.fr "Ton nom"   # affiche mot de passe, secret 2FA, codes de secours
```

Mets le secret 2FA dans ton application (Aegis, Google Authenticator…) et garde les codes de secours hors ligne.

## Lancer

```bash
npm start      # serveur
npm test       # 26 tests : fonctions + attaques (faux agent, aucune imprimante nécessaire)
```

## Utiliser l'API

1. `POST /api/v1/auth/login` `{"email", "motdepasse"}` → `{"etape": "2fa", "csrf"}`
2. `POST /api/v1/auth/2fa` `{"code": "123456"}` avec l'en-tête `X-CSRF-Token` → session ouverte (cookie)
3. Toute requête qui modifie quelque chose envoie `X-CSRF-Token` (renvoyé aussi par `GET /me`).
4. Actions sensibles (annuler, supprimer, console, comptes, agent) : `POST /auth/2fa/confirmer` `{"code"}` moins de 10 min avant.

Routes : voir le cahier des charges. Les lectures (`GET`) renvoient directement les données ; les commandes renvoient
`{"ok": true, "resultat"}`, ou `202 {"operation"}` pour les longues (suivre `GET /operations/{id}` ou `/events`).

## Mise en ligne sur Fly.io

Tout est déjà configuré : `fly.toml`, `Dockerfile` et `.dockerignore` à la racine du projet, `serveur/docker-entrypoint.sh`.
Les commandes `fly` se lancent depuis la **racine du projet** (là où est `fly.toml`).

**Une seule fois :**

1. Installe `flyctl` ([fly.io/docs/flyctl/install](https://fly.io/docs/flyctl/install/)), puis `fly auth login`.
2. Dans `fly.toml`, remplace `app = "imprimantes-serveur"` par un nom libre (il donne `<nom>.fly.dev`).
3. Crée l'app, son disque et son adresse IPv4 dédiée (nécessaire pour le port 8443 de l'agent, payante) :
   ```bash
   fly apps create <nom>
   fly volumes create donnees --region cdg --size 1 --app <nom>
   fly ips allocate-v4 --app <nom>
   ```
4. Envoie les secrets (dans `serveur/`) :
   ```bash
   npm run fly:secrets
   ```
   Le script refait les certificats pour `<nom>.fly.dev` si besoin, pointe `agent/config.json` vers
   `wss://<nom>.fly.dev:8443/ws` et envoie à Fly les certificats du serveur et la clé publique de l'agent.
   La clé de l'autorité (`pki/ca.key.pem`) ne quitte jamais ton PC.

**Déployer (et à chaque mise à jour) :**

```bash
fly deploy
fly scale count 1
```

Une seule machine : l'état des imprimantes est en mémoire et un seul agent se connecte.

**Premier compte admin**, sur la machine Fly (le script d'entrée le lance avec l'utilisateur `node`) :

```bash
fly ssh console -C "env DONNEES=/data /usr/local/bin/docker-entrypoint.sh node /app/serveur/scripts/creer-admin.js ton@email.fr Ton Nom"
```

**Puis sur ton PC**, relance l'agent : il se connecte au serveur en ligne. Pour revenir au serveur local, remets
l'adresse gardée dans `"serveur_local"` dans `agent/config.json`.

À vérifier ensuite :
- `https://<nom>.fly.dev/sante` répond `{"ok":true}` ; l'API est sur `https://<nom>.fly.dev/api/v1` ;
- `fly logs` montre « WebSocket agent … derrière un proxy TCP avec PROXY protocol » puis la connexion de l'agent ;
- si l'IP de ta box est fixe : `fly secrets set AGENT_IPS_AUTORISEES=x.x.x.x`.

## Mise en ligne sur un serveur à toi (VPS)

1. Un serveur avec ton nom de domaine. Certificats agent pour ce nom :
   `npm run pki -- --domaine agent.ton-domaine.fr --force` (puis recopier `agent/secrets/` sur le PC de l'agent).
2. Caddy pour l'API (HTTPS automatique) :
   ```
   api.ton-domaine.fr {
       reverse_proxy 127.0.0.1:3000
   }
   ```
3. Pare-feu : ouvrir 443 (Caddy) et 8443 (agent). Si l'IP de ta box est fixe, la mettre dans
   `config.json` → `"agent": {"ipsAutorisees": ["x.x.x.x"]}`.
4. `pki/ca.key.pem` (clé de l'autorité) ne doit PAS rester sur le serveur : garde-la hors ligne,
   elle ne sert qu'à refaire des certificats.
5. Sauvegarder `data/serveur.db` chaque nuit (comptes, journal d'audit).

`config.json` (facultatif) remplace les valeurs par défaut de `src/config.js` (ports, id de l'agent, IP autorisées…).
