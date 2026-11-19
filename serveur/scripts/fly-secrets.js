'use strict';
// Prépare la mise en ligne sur Fly.io, en une commande :   npm run fly:secrets
//   1. lit le nom de l'app dans ../fly.toml  ->  <app>.fly.dev
//   2. refait les certificats si celui du serveur ne couvre pas encore <app>.fly.dev
//   3. pointe l'agent (agent/config.json) vers wss://<app>.fly.dev:8443/ws
//   4. envoie à Fly les secrets : certificats du serveur et clé publique de l'agent
// La clé privée de l'autorité (pki/ca.key.pem) n'est JAMAIS envoyée.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { charger, RACINE } = require('../src/config');
const { genererPki } = require('./pki');

const PROJET = path.resolve(RACINE, '..');
const toml = fs.readFileSync(path.join(PROJET, 'fly.toml'), 'utf8');
const app = /^app\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
if (!app) { console.error('nom de l\'app introuvable dans fly.toml (ligne app = "...")'); process.exit(1); }
const domaine = `${app}.fly.dev`;
const config = charger();
const dossierAgent = path.join(PROJET, 'agent', 'secrets');

// 1-2. certificats couvrant <app>.fly.dev (et localhost, pour continuer à tester chez toi)
const couvre = fs.existsSync(config.pki.cert)
  && (new crypto.X509Certificate(fs.readFileSync(config.pki.cert)).subjectAltName || '').includes(`DNS:${domaine}`);
if (!couvre) {
  console.log(`Certificats refaits pour ${domaine} (l'agent de ce PC reçoit les siens dans agent/secrets/).`);
  genererPki({ fichiersServeur: config.pki, dossierAgent, agentId: config.agent.id,
    domaines: ['localhost', domaine], ips: ['127.0.0.1'] });
}

// 3. l'agent se connecte désormais au serveur en ligne
const fichierAgent = path.join(PROJET, 'agent', 'config.json');
if (fs.existsSync(fichierAgent)) {
  const ca = JSON.parse(fs.readFileSync(fichierAgent, 'utf8'));
  const url = `wss://${domaine}:8443/ws`;
  if (ca.serveur !== url) {
    ca.serveur_local = ca.serveur_local || ca.serveur;
    ca.serveur = url;
    ca.empreinte_serveur = '';                      // relue dans agent/secrets/empreinte_serveur.txt
    fs.writeFileSync(fichierAgent, `${JSON.stringify(ca, null, 2)}\n`);
    console.log(`agent/config.json : serveur = ${url} (l'ancienne adresse est gardée dans "serveur_local")`);
  }
}

// 4. secrets Fly (base64 : une seule ligne, aucun souci de guillemets ou de retours à la ligne)
const b64 = (f) => fs.readFileSync(f).toString('base64');
const clePublique = path.join(dossierAgent, 'agent_ed25519.pub.pem');
if (!fs.existsSync(clePublique)) {
  console.error('Clé de l\'agent absente : lance d\'abord  python agent/agent.py --generer-cle');
  process.exit(1);
}
const secrets = [
  `PKI_CA_B64=${b64(config.pki.ca)}`,
  `PKI_CERT_B64=${b64(config.pki.cert)}`,
  `PKI_CLE_B64=${b64(config.pki.cle)}`,
  `AGENT_CLE_PUBLIQUE_B64=${b64(clePublique)}`,
];
console.log(`Envoi des secrets à Fly (app ${app})...`);
const r = spawnSync('fly', ['secrets', 'set', '--app', app, ...secrets], { cwd: PROJET, stdio: 'inherit' });
if (r.error) {
  console.error(`commande "fly" introuvable (${r.error.code}) : installe flyctl puis "fly auth login"`);
  process.exit(1);
}
process.exit(r.status ?? 1);
