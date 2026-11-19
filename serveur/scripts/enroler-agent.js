'use strict';
// Enregistre la clé publique Ed25519 de l'agent (générée par l'agent lui-même : sa clé privée ne
// quitte jamais sa machine).   npm run agent:enroler -- ../agent/secrets/agent_ed25519.pub.pem

const crypto = require('node:crypto');
const fs = require('node:fs');
const { charger } = require('../src/config');
const { ouvrir } = require('../src/db');

const fichier = process.argv[2];
if (!fichier || !fs.existsSync(fichier)) {
  console.error('usage : npm run agent:enroler -- <fichier de clé publique .pem>');
  process.exit(1);
}
const cle = crypto.createPublicKey(fs.readFileSync(fichier, 'utf8'));
if (cle.asymmetricKeyType !== 'ed25519') {
  console.error('clé publique Ed25519 attendue');
  process.exit(1);
}
const config = charger();
const db = ouvrir(config.donnees);
const pem = cle.export({ type: 'spki', format: 'pem' });
db.prepare(`INSERT INTO agent (id, cle_publique, revoque, enrole) VALUES (?, ?, 0, ?)
  ON CONFLICT(id) DO UPDATE SET cle_publique = excluded.cle_publique, revoque = 0, enrole = excluded.enrole`)
  .run(config.agent.id, pem, Date.now());
db.prepare('INSERT INTO audit (ts, action, cible, resultat, detail) VALUES (?, ?, ?, ?, ?)')
  .run(Date.now(), 'agent.enroler', config.agent.id, 'ok', 'script local');
console.log(`Agent "${config.agent.id}" enrôlé (empreinte de la clé : ${crypto.createHash('sha256').update(pem).digest('hex').slice(0, 16)}).`);
