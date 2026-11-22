'use strict';
// Démarre les deux portes du serveur :
//   - l'API du site      : HTTP sur 127.0.0.1:3000, à placer derrière Caddy (HTTPS) en production
//   - le WebSocket agent : WSS + certificat client sur 0.0.0.0:8443, TLS géré ici même

const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const { charger } = require('./config');
const { ouvrir } = require('./db');
const { Hub } = require('./hub');
const { creerApi } = require('./api');

function creerJournal(db) {
  const inserer = db.prepare('INSERT INTO audit (ts, user_id, ip, action, cible, resultat, detail) VALUES (?, ?, ?, ?, ?, ?, ?)');
  return (action, o = {}) => {
    try {
      inserer.run(Date.now(), o.userId ?? o.req?.user?.id ?? o.req?.session?.user_id ?? null,
        o.ip ?? o.req?.ip ?? null, action, o.cible ? String(o.cible).slice(0, 300) : null,
        o.resultat ?? 'ok', o.detail ? String(o.detail).slice(0, 500) : null);
    } catch (e) {
      console.error('journal :', e.message);
    }
  };
}

// clé publique de l'agent fournie par variable d'environnement (secret Fly) : enrôlée si elle est
// nouvelle. Une clé identique ne touche à rien (un agent révoqué par l'API reste révoqué).
function enrolerDepuisEnv(config, db, journal) {
  if (!config.agentClePublique) return;
  const cle = crypto.createPublicKey(config.agentClePublique);
  if (cle.asymmetricKeyType !== 'ed25519') throw new Error('AGENT_CLE_PUBLIQUE_B64 : clé Ed25519 attendue');
  const pem = cle.export({ type: 'spki', format: 'pem' });
  const actuelle = db.prepare('SELECT cle_publique FROM agent WHERE id = ?').get(config.agent.id);
  if (actuelle?.cle_publique === pem) return;
  db.prepare(`INSERT INTO agent (id, cle_publique, revoque, enrole) VALUES (?, ?, 0, ?)
    ON CONFLICT(id) DO UPDATE SET cle_publique = excluded.cle_publique, revoque = 0, enrole = excluded.enrole`)
    .run(config.agent.id, pem, Date.now());
  journal('agent.enroler', { cible: config.agent.id, resultat: 'ok', detail: 'variable d\'environnement' });
}

async function demarrer(config = charger()) {
  for (const nom of ['ca', 'cert', 'cle']) {
    if (!config.pkiPem?.[nom] && !fs.existsSync(config.pki[nom])) {
      throw new Error(`${config.pki[nom]} introuvable : lance d'abord "npm run pki" (ou fournis PKI_${nom.toUpperCase()}_B64)`);
    }
  }
  const db = ouvrir(config.donnees);
  db.prepare('DELETE FROM audit WHERE ts < ?').run(Date.now() - 365 * 864e5);   // conservé 1 an
  const journal = creerJournal(db);
  enrolerDepuisEnv(config, db, journal);
  const hub = new Hub(config, db, journal);
  try {
    await hub.demarrer();
  } catch (e) {
    db.close();
    throw e;
  }
  const app = creerApi({ config, db, hub, journal });
  const serveurApi = http.createServer(app);
  serveurApi.headersTimeout = 20000;
  serveurApi.requestTimeout = 0;              // envois de gros gcodes et flux longs
  try {
    await new Promise((ok, ko) => {
      serveurApi.once('error', ko);
      serveurApi.listen(config.api.port, config.api.hote, () => { serveurApi.off('error', ko); ok(); });
    });
  } catch (e) {
    await hub.arreter();
    db.close();
    throw e;
  }
  journal('serveur.demarrage', { resultat: 'ok' });
  return {
    config, db, hub, app, serveurApi,
    async arreter() {
      await app.locals.boutique?.decoupeur.arreter();
      await app.locals.boutique?.plaques.arreter();
      await hub.arreter();
      serveurApi.closeAllConnections?.();
      await new Promise((ok) => serveurApi.close(() => ok()));
      db.close();
    },
  };
}

if (require.main === module) {
  process.on('unhandledRejection', (e) => console.error('promesse rejetée non gérée :', e));
  demarrer().then((s) => {
    const { api, agent } = s.config;
    console.log(`API du site      : http://${api.hote}:${api.port}/api/v1`);
    console.log(`WebSocket agent  : wss://${agent.hote}:${agent.port}/ws (certificat client exigé`
      + `${agent.proxyProtocol ? ', derrière un proxy TCP avec PROXY protocol' : ''})`);
    console.log(`Empreinte du certificat serveur (à mettre dans la config de l'agent) :\n  ${s.hub.empreinteServeur}`);
    const fin = () => s.arreter().then(() => process.exit(0));
    process.on('SIGINT', fin);
    process.on('SIGTERM', fin);
  }).catch((e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`Le port ${e.port} est déjà utilisé : le serveur tourne sans doute déjà dans un autre terminal.`
        + '\nArrête-le (Ctrl+C dans ce terminal) avant de le relancer, ou change le port dans serveur/config.json.');
    } else {
      console.error(e.message);
    }
    process.exit(1);
  });
}

module.exports = { demarrer };
