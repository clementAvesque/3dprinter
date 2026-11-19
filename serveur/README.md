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

## Mise en ligne

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
