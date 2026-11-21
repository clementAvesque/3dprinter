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
- le site client (`web_printer_user/front`) est compilé dans l'image et servi à la racine `https://<nom>.fly.dev/`
  (c'est là que mènent les liens des e-mails) : un `fly deploy` suffit pour publier une modification du site ;
- `fly logs` montre « WebSocket agent … derrière un proxy TCP avec PROXY protocol » puis la connexion de l'agent ;
- si l'IP de ta box est fixe : `fly secrets set AGENT_IPS_AUTORISEES=x.x.x.x`.

### Découpe des devis (OrcaSlicer)

Le serveur découpe lui-même chaque devis avec OrcaSlicer (installé dans l'image Docker, version épinglée et
vérifiée dans le `Dockerfile`), un devis à la fois (`src/orca.js`) : poids, durée, prix, et un aperçu 3D couche
par couche sur la page du devis. Le client ne voit que l'aperçu ; **l'admin reçoit le gcode** (aperçu +
téléchargement dans la fiche d'une commande payée) et n'a plus accès aux STL des clients.

- Profils : `orca/kobra3/` (machine, découpe, filament), tirés des profils Kobra 3 d'Anycubic Slicer Next par
  `python scripts/orca_profils.py` (à relancer après une mise à jour du slicer, puis `fly deploy`).
- « Rapide » découpe en 0,28 mm : la Kobra 3 avec une buse de 0,4 mm n'accepte pas plus.
- Chaque construction de l'image lance `scripts/essai-orca.js` (deux cubes, fine et rapide, avec le vrai Orca) :
  si la découpe échoue, l'image n'est pas construite et le serveur en ligne ne change pas.
- Orca a besoin de mémoire : machine Fly de 1 Go au moins (`fly scale memory 1024`).
- En local, sans Orca : les devis restent « en file ». `ORCA_CMD` indique la commande à lancer.

### Paiement (Stripe)

Le client commande un devis découpé : adresse de livraison, puis paiement sur la page sécurisée de Stripe
(Checkout). Le montant vient toujours du devis calculé par le serveur. Stripe confirme le paiement par un webhook
signé (`/api/stripe/webhook`) : la commande passe « payée », une facture numérotée est créée (`2026-000001`...),
le client et l'admin reçoivent un e-mail, et l'admin peut voir et télécharger le gcode. Refuser une commande la
rembourse intégralement par Stripe.

1. Compte Stripe (stripe.com), en **mode test** d'abord.
2. Depuis la racine du projet : `python serveur/scripts/stripe_configurer.py`. Il demande la clé secrète
   (Developers > API keys > Secret key, `sk_test_...`, masquée), crée le webhook chez Stripe et envoie
   `STRIPE_CLE_SECRETE` et `STRIPE_SECRET_WEBHOOK` à Fly (le serveur redémarre).
3. Essai : commande un devis et paie avec la carte `4242 4242 4242 4242`, une date future, CVC `123`.
4. Passage en réel (après les pages légales) : relancer le script avec la clé `sk_live_...` du mode réel.

Sans ces secrets, « Commander » répond que le paiement n'est pas encore ouvert. Le reçu de paiement est envoyé
par Stripe ; une facture PDF à ton nom viendra avec les mentions légales.

### E-mails des clients (Brevo)

Sans réglage, les e-mails (confirmation d'inscription, mot de passe oublié, suivi des commandes) sont seulement
écrits dans `fly logs` : les clients ne reçoivent rien. Pour de vrais envois, avec [Brevo](https://www.brevo.com)
(gratuit jusqu'à 300 e-mails/jour, pas besoin de nom de domaine) :

1. Crée un compte Brevo, puis **Senders, Domains & Dedicated IPs > Senders > Add a sender** : ajoute l'adresse
   qui enverra les e-mails (ta Gmail par ex.) et valide-la avec le lien que Brevo t'envoie.
2. **SMTP & API > API Keys > Generate a new API key** : copie la clé (`xkeysib-…`).
3. Depuis la racine du projet : `python serveur/scripts/brevo_template.py`. Le script demande la clé (masquée)
   et l'adresse expéditeur, crée la mise en page HTML chez Brevo (ou la met à jour), t'envoie un e-mail d'essai,
   puis envoie à Fly la clé, l'expéditeur et le numéro du template (le serveur redémarre tout seul).
   La mise en page est dans `scripts/brevo-template.html` : après une retouche, relance le script.
4. `URL_SITE` doit être l'adresse publique du site client : c'est elle qui est mise dans les liens des e-mails
   (par défaut `https://<nom>.fly.dev`, voir `src/config.js`).

Si la clé ou l'expéditeur manque, le serveur refuse de démarrer (message dans `fly logs`). Si Brevo refuse un envoi
(clé révoquée, expéditeur non validé), l'inscription répond « Impossible d'envoyer l'e-mail » et la raison exacte
est écrite dans `fly logs` (`[courriel] …`). Pour essayer en local : mêmes variables en `$env:...` dans le terminal
avant de lancer le serveur. **Pas dans `dev.env`** : ce fichier est suivi par git, la clé finirait dans un commit.
Brevo ajoute un petit pied de page à ses e-mails gratuits, et ils peuvent arriver dans les indésirables tant que
l'expéditeur est une Gmail (un nom de domaine à toi, authentifié chez Brevo, règle ça).

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
