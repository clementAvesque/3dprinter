'use strict';
// Démarre les deux portes du serveur :
//   - l'API du site      : HTTP sur 127.0.0.1:3000, à placer derrière Caddy (HTTPS) en production
//   - le WebSocket agent : WSS + certificat client sur 0.0.0.0:8443, TLS géré ici même

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

async function demarrer(config = charger()) {
  for (const f of [config.pki.ca, config.pki.cert, config.pki.cle]) {
    if (!fs.existsSync(f)) throw new Error(`${f} introuvable : lance d'abord "npm run pki"`);
  }
  const db = ouvrir(config.donnees);
  db.prepare('DELETE FROM audit WHERE ts < ?').run(Date.now() - 365 * 864e5);   // conservé 1 an
  const journal = creerJournal(db);
  const hub = new Hub(config, db, journal);
  await hub.demarrer();
  const app = creerApi({ config, db, hub, journal });
  const serveurApi = http.createServer(app);
  serveurApi.headersTimeout = 20000;
  serveurApi.requestTimeout = 0;              // envois de gros gcodes et flux longs
  await new Promise((ok) => serveurApi.listen(config.api.port, config.api.hote, ok));
  journal('serveur.demarrage', { resultat: 'ok' });
  return {
    config, db, hub, app, serveurApi,
    async arreter() {
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
    console.log(`WebSocket agent  : wss://${agent.hote}:${agent.port}/ws (certificat client exigé)`);
    console.log(`Empreinte du certificat serveur (à mettre dans la config de l'agent) :\n  ${s.hub.empreinteServeur}`);
    const fin = () => s.arreter().then(() => process.exit(0));
    process.on('SIGINT', fin);
    process.on('SIGTERM', fin);
  }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { demarrer };
