'use strict';
// Tests du serveur avec un FAUX agent (aucune imprimante nécessaire) :
// fonctions de l'API, relais des commandes, transferts, et chaque couche de sécurité attaquée.
//   npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const tls = require('node:tls');
const path = require('node:path');
const WebSocket = require('ws');
const { genererPki, certificatClient } = require('../scripts/pki');
const { charger } = require('../src/config');
const { demarrer } = require('../src/index');
const S = require('../src/securite');

const AGENT_ID = 'agent-test';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serveur-test-'));
let srv, pki, cleAgent, urlApi, urlWs, totpAdmin;

// ------------------------------------------------------------------ faux agent

class FauxAgent {
  constructor(opts = {}) {
    this.opts = opts;
    this.seqOut = 0;
    this.seqIn = 0;
    this.commandes = [];
    this.recus = new Map();     // transfert -> Buffer[] (gcodes reçus)
    this.videoTimer = null;
  }

  connecter() {
    const o = this.opts;
    this.ws = new WebSocket(o.url || urlWs, {
      ca: pki.caPem, servername: 'localhost', perMessageDeflate: false,
      // derrière un proxy : en-tête PROXY protocol envoyé en clair avant la poignée TLS
      ...(o.entete ? { createConnection: (opts) => {
        const brut = net.connect(o.relais, '127.0.0.1');
        if (o.entete !== 'aucun') brut.write(o.entete);
        return tls.connect({ ...opts, socket: brut });
      } } : {}),
      ...(o.sansCertificat ? {} : {
        cert: o.cert ?? fs.readFileSync(path.join(dir, 'agent', 'agent.crt.pem')),
        key: o.key ?? fs.readFileSync(path.join(dir, 'agent', 'agent.key.pem')),
      }),
    });
    return new Promise((ok, ko) => {
      this.ws.on('message', (data, binaire) => this.recevoir(data, binaire, ok));
      this.ws.on('close', (code, raison) => { clearInterval(this.videoTimer); this.ferme = { code, raison: String(raison) }; ko(Object.assign(new Error(`fermé ${code} ${raison}`), { code })); });
      this.ws.on('unexpected-response', (req, res) => ko(Object.assign(new Error(`HTTP ${res.statusCode}`), { statut: res.statusCode })));
      this.ws.on('error', (e) => ko(e));
    });
  }

  env(msg) { return { v: 1, id: crypto.randomBytes(12).toString('base64url'), seq: ++this.seqOut, ts: Date.now(), ...msg }; }
  envoyer(msg) { this.ws.send(JSON.stringify(this.env(msg))); }
  envoyerBinaire(entete, octets) {
    const e = Buffer.from(JSON.stringify(this.env(entete)));
    const lg = Buffer.alloc(4); lg.writeUInt32BE(e.length);
    this.ws.send(Buffer.concat([lg, e, octets]));
  }

  transferer(re, resultat, octets, mime) {
    const id = crypto.randomBytes(12).toString('base64url');
    this.envoyer({ type: 'reponse', re, ok: true, resultat, transfert: { id, taille: octets.length,
      sha256: crypto.createHash('sha256').update(octets).digest('hex'), mime } });
    const M = 1024 * 1024;
    for (let i = 0, n = 0; i < octets.length || (i === 0 && !octets.length); i += M, n++) {
      this.envoyerBinaire({ type: 'morceau', transfert: id, index: n, fin: i + M >= octets.length }, octets.subarray(i, i + M));
      if (!octets.length) break;
    }
  }

  recevoir(data, binaire, pret) {
    let env, octets;
    if (binaire) {
      const lg = data.readUInt32BE(0);
      env = JSON.parse(data.subarray(4, 4 + lg));
      octets = data.subarray(4 + lg);
    } else {
      env = JSON.parse(data);
    }
    assert.equal(env.seq, ++this.seqIn, 'séquence du serveur');
    if (env.type === 'defi') {
      const msg = `printer-agent-v1|${env.nonce}|${env.defi_ts}|${AGENT_ID}|${pki.empreinte}`;
      const sig = this.opts.signatureFausse ? crypto.randomBytes(64) : crypto.sign(null, Buffer.from(msg), cleAgent.privateKey);
      return this.envoyer({ type: 'preuve', agent: AGENT_ID, protocole: 1, signature: sig.toString('base64'),
        machines: [{ id: 'kobra-1', nom: 'Kobra test' }] });
    }
    if (env.type === 'bienvenue') {
      this.envoyer({ type: 'evenement', machine: 'kobra-1', nom: 'etat',
        donnees: { state: 'READY', online: true, nozzle: { temperature: { value: 25, target: 0 } }, bed: { temperature: { value: 22, target: 0 } } } });
      return pret(this);
    }
    if (env.type === 'morceau') {
      const l = this.recus.get(env.transfert) || [];
      l.push(Buffer.from(octets));
      this.recus.set(env.transfert, l);
      if (env.fin) {
        const cmd = this.commandes.find((c) => c.params.transfert === env.transfert);
        this.envoyer({ type: 'reponse', re: cmd.id, ok: true, resultat: { recu: Buffer.concat(l).length } });
      }
      return;
    }
    if (env.type !== 'commande') return;
    this.commandes.push(env);
    const { action, params, id } = env;
    if (action === 'file.upload') return;                          // réponse quand le dernier morceau arrive
    if (action === 'file.thumbnail') return this.transferer(id, null, Buffer.from('PNG-miniature'), 'image/png');
    if (action === 'record.download') return this.transferer(id, null, Buffer.alloc(2.5 * 1024 * 1024, 7), 'video/mp4');
    if (action === 'file.toolpath') {
      // petit aperçu : description dans la réponse ; gros plateau (nouvel agent) : description jointe au transfert
      const meta = { layers: params.fichier === 'gros.gcode' ? Array.from({ length: 20000 }, (_, i) => [i, i * 9]) : [[0, 0]], segments: 2 };
      const seg = Buffer.from('SEGMENTS');
      if (params.fichier !== 'gros.gcode') return this.transferer(id, meta, seg, 'application/octet-stream');
      const m = Buffer.from(JSON.stringify(meta));
      return this.transferer(id, { meta_jointe: m.length }, Buffer.concat([m, seg]), 'application/octet-stream');
    }
    if (action === 'files.list') return this.envoyer({ type: 'reponse', re: id, ok: true, resultat: [{ nom: 'piece.gcode', taille_octets: 10 }] });
    if (action === 'camera.stream') {
      clearInterval(this.videoTimer);
      if (params.actif) this.videoTimer = setInterval(() => this.envoyerBinaire({ type: 'video', machine: 'kobra-1' }, Buffer.from('JPEG')), 100);
    }
    if (action === 'print.pause') return this.envoyer({ type: 'reponse', re: id, ok: false, erreur: 'machine', detail: 'pas d\'impression' });
    this.envoyer({ type: 'reponse', re: id, ok: true, resultat: { action, params } });
  }

  fermer() { clearInterval(this.videoTimer); this.ws?.terminate(); }
}

// ------------------------------------------------------------------ client HTTP avec cookie

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async req(methode, chemin, corps, entetes = {}) {
    const h = { ...entetes };
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf) h['x-csrf-token'] = this.csrf;
    if (corps !== undefined && !(corps instanceof FormData)) h['content-type'] = 'application/json';
    const res = await fetch(urlApi + chemin, { method: methode, headers: h,
      body: corps === undefined ? undefined : corps instanceof FormData ? corps : JSON.stringify(corps) });
    for (const c of res.headers.getSetCookie()) this.cookie = c.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const json = type.includes('json') ? await res.json() : null;
    return { statut: res.status, json, res };
  }
  async connexion(email, mdp, secret) {
    const a = await this.req('POST', '/auth/login', { email, motdepasse: mdp });
    assert.equal(a.statut, 200, JSON.stringify(a.json));
    this.csrf = a.json.csrf;
    const b = await this.req('POST', '/auth/2fa', { code: S.codeTotp(secret, Math.floor(Date.now() / 30000)) });
    assert.equal(b.statut, 200, JSON.stringify(b.json));
    this.csrf = b.json.csrf;
  }
}

async function creerCompte(email, role) {
  const secret = S.nouveauSecretTotp();
  srv.db.prepare(`INSERT INTO utilisateurs (email, nom, role, hash, totp_secret, cree) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(email, role, role, await S.hacher('mot-de-passe-de-test!'), secret, Date.now());
  return secret;
}

const attendre = (cond, ms = 5000) => new Promise((ok, ko) => {
  const t0 = Date.now();
  const f = () => (cond() ? ok() : Date.now() - t0 > ms ? ko(new Error('délai dépassé')) : setTimeout(f, 20));
  f();
});

// ------------------------------------------------------------------ préparation

let agent;
before(async () => {
  pki = genererPki({ fichiersServeur: { ca: path.join(dir, 'pki', 'ca.crt.pem'), cert: path.join(dir, 'pki', 'serveur.crt.pem'),
    cle: path.join(dir, 'pki', 'serveur.key.pem') }, dossierAgent: path.join(dir, 'agent'), agentId: AGENT_ID, bits: 2048 });
  const fichierConfig = path.join(dir, 'config.json');
  fs.writeFileSync(fichierConfig, JSON.stringify({
    api: { port: 0, cookieSecure: false, enteteIpClient: 'fly-client-ip' },
    agent: { port: 0, hote: '127.0.0.1', id: AGENT_ID, bannissement: { echecs: 1000, dureeMs: 3600e3 } },
    pki: { ca: path.join(dir, 'pki', 'ca.crt.pem'), cert: path.join(dir, 'pki', 'serveur.crt.pem'), cle: path.join(dir, 'pki', 'serveur.key.pem') },
    donnees: path.join(dir, 'data'),
  }));
  srv = await demarrer(charger(fichierConfig));
  urlApi = `http://127.0.0.1:${srv.serveurApi.address().port}/api/v1`;
  urlWs = `wss://localhost:${srv.hub.serveur.address().port}/ws`;
  cleAgent = crypto.generateKeyPairSync('ed25519');
  srv.db.prepare('INSERT INTO agent (id, cle_publique, revoque, enrole) VALUES (?, ?, 0, ?)')
    .run(AGENT_ID, cleAgent.publicKey.export({ type: 'spki', format: 'pem' }), Date.now());
  totpAdmin = await creerCompte('admin@test.local', 'admin');
});

after(async () => {
  agent?.fermer();
  await srv.arreter();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ sécurité du lien agent

test('sans certificat client : la poignée TLS échoue', async () => {
  await assert.rejects(new FauxAgent({ sansCertificat: true }).connecter());
  assert.equal(srv.hub.lien, null);
  assert.equal(srv.hub.candidat, null);
});

test('certificat d\'une autre autorité : refusé', async () => {
  const autre = genererPki({ fichiersServeur: { ca: path.join(dir, 'x', 'ca.pem'), cert: path.join(dir, 'x', 'c.pem'), cle: path.join(dir, 'x', 'k.pem') },
    dossierAgent: path.join(dir, 'x', 'agent'), agentId: AGENT_ID, bits: 2048 });
  assert.ok(autre.empreinte);
  await assert.rejects(new FauxAgent({ cert: fs.readFileSync(path.join(dir, 'x', 'agent', 'agent.crt.pem')),
    key: fs.readFileSync(path.join(dir, 'x', 'agent', 'agent.key.pem')) }).connecter());
});

test('bon certificat mais mauvais CN : refusé (403)', async () => {
  const c = certificatClient({ caCertPem: pki.caPem, caClePem: pki.caCle, cn: 'intrus' });
  await assert.rejects(new FauxAgent({ cert: c.cert, key: c.cle }).connecter(), (e) => e.statut === 403);
});

test('signature du défi fausse : coupé (4003)', async () => {
  await assert.rejects(new FauxAgent({ signatureFausse: true }).connecter(), (e) => e.code === 4003);
  assert.equal(srv.hub.lien, null);
});

test('agent légitime : authentifié ; un 2e agent est refusé (409)', async () => {
  agent = new FauxAgent();
  await agent.connecter();
  assert.equal(srv.hub.statut().connecte, true);
  await assert.rejects(new FauxAgent().connecter(), (e) => e.statut === 409);
  assert.equal(srv.hub.lien !== null, true);
});

// ------------------------------------------------------------------ API : comptes et protections

const admin = new Client();

test('connexion : mot de passe puis code 2FA obligatoire', async () => {
  const anonyme = new Client();
  assert.equal((await anonyme.req('GET', '/machines')).statut, 401);
  assert.equal((await anonyme.req('POST', '/auth/login', { email: 'admin@test.local', motdepasse: 'faux-mot-de-passe' })).statut, 401);
  const etape = await anonyme.req('POST', '/auth/login', { email: 'admin@test.local', motdepasse: 'mot-de-passe-de-test!' });
  assert.equal(etape.json.etape, '2fa');
  anonyme.csrf = etape.json.csrf;
  assert.equal((await anonyme.req('GET', '/machines')).statut, 401, 'pas d\'accès avant la 2FA');
  assert.equal((await anonyme.req('POST', '/auth/2fa', { code: '000000' })).statut, 401);
  await admin.connexion('admin@test.local', 'mot-de-passe-de-test!', totpAdmin);
  const me = await admin.req('GET', '/me');
  assert.equal(me.json.utilisateur.role, 'admin');
});

test('un code 2FA déjà utilisé est refusé', async () => {
  const c = new Client();
  const a = await c.req('POST', '/auth/login', { email: 'admin@test.local', motdepasse: 'mot-de-passe-de-test!' });
  c.csrf = a.json.csrf;
  // même pas de temps que la connexion précédente : déjà consommé
  const code = S.codeTotp(totpAdmin, Math.floor(Date.now() / 30000));
  assert.equal((await c.req('POST', '/auth/2fa', { code })).statut, 401);
});

test('sans jeton CSRF ou depuis une autre origine : 403', async () => {
  const sans = Object.assign(new Client(), { cookie: admin.cookie });
  assert.equal((await sans.req('PUT', '/machines/kobra-1/speed', { percent: 120 })).statut, 403);
  const r = await admin.req('PUT', '/machines/kobra-1/speed', { percent: 120 }, { origin: 'https://site-pirate.example' });
  assert.equal(r.statut, 403);
});

test('connexion : 5 échecs puis blocage (429)', async () => {
  const c = new Client();
  for (let i = 0; i < 5; i++) await c.req('POST', '/auth/login', { email: 'cible@test.local', motdepasse: 'mauvais-mot-de-passe' });
  assert.equal((await c.req('POST', '/auth/login', { email: 'cible@test.local', motdepasse: 'mauvais-mot-de-passe' })).statut, 429);
});

test('derrière Fly : vraie IP du visiteur (Fly-Client-IP) ; un inconnu ne bloque pas ta connexion', async () => {
  const c = new Client();
  const essai = (ip) => c.req('POST', '/auth/login', { email: 'admin@test.local', motdepasse: 'mauvais-mot-de-passe' }, { 'fly-client-ip': ip });
  for (let i = 0; i < 5; i++) await essai('198.51.100.20');          // un attaquant épuise SES essais
  assert.equal((await essai('198.51.100.20')).statut, 429);
  assert.equal((await essai('203.0.113.50')).statut, 401, 'une autre IP n\'est pas bloquée');
  const ips = srv.db.prepare("SELECT DISTINCT ip FROM audit WHERE action = 'auth.login'").all().map((r) => r.ip);
  assert.ok(ips.includes('198.51.100.20') && ips.includes('203.0.113.50'), JSON.stringify(ips));
  // le vrai admin, depuis chez lui, passe toujours l'étape du mot de passe
  const bonne = await new Client().req('POST', '/auth/login', { email: 'admin@test.local', motdepasse: 'mot-de-passe-de-test!' },
    { 'fly-client-ip': '192.0.2.10' });
  assert.equal(bonne.statut, 200);
  assert.equal(bonne.json.etape, '2fa');
});

// ------------------------------------------------------------------ API : machines et commandes

test('état des machines lu depuis le cache', async () => {
  const l = await admin.req('GET', '/machines');
  assert.equal(l.json.machines[0].id, 'kobra-1');
  assert.equal(l.json.machines[0].enLigne, true);
  const m = await admin.req('GET', '/machines/kobra-1');
  assert.equal(m.json.etat.state, 'READY');
  const t = await admin.req('GET', '/machines/kobra-1/temperatures');
  assert.equal(t.json[0].buse, 25);
});

test('commande relayée à l\'agent ; erreurs de la machine remontées', async () => {
  const r = await admin.req('PUT', '/machines/kobra-1/speed', { percent: 120 });
  assert.equal(r.statut, 200);
  assert.deepEqual(r.json.resultat.params, { percent: 120 });
  const e = await admin.req('POST', '/machines/kobra-1/print/pause', {});
  assert.equal(e.statut, 409);
  assert.equal(e.json.detail, 'pas d\'impression');
});

test('paramètres hors bornes ou inconnus : refusés AVANT d\'atteindre l\'agent', async () => {
  const avant = agent.commandes.length;
  assert.equal((await admin.req('PUT', '/machines/kobra-1/speed', { percent: 500 })).statut, 400);
  assert.equal((await admin.req('PUT', '/machines/kobra-1/speed', { percent: 120, script: 'M112' })).statut, 400);
  assert.equal((await admin.req('PUT', '/machines/kobra-1/temperature', { cible: 'plateau', temp: 150 })).statut, 400);
  assert.equal((await admin.req('POST', '/machines/kobra-1/print', { fichier: '../../secret.gcode' })).statut, 400);
  assert.equal((await admin.req('POST', '/machines/kobra-1/print', { fichier: 'C:\\x.gcode' })).statut, 400);
  assert.equal((await admin.req('GET', '/machines/inconnue')).statut, 404);
  assert.equal(agent.commandes.length, avant);
});

test('commande longue : 202 puis opération suivie', async () => {
  const r = await admin.req('POST', '/machines/kobra-1/print', { fichier: 'piece.gcode', emplacement: 2 });
  assert.equal(r.statut, 202);
  await attendre(() => srv.hub.operations.get(r.json.operation)?.statut === 'ok');
  const op = await admin.req('GET', `/operations/${r.json.operation}`);
  assert.equal(op.json.statut, 'ok');
  assert.deepEqual(op.json.resultat.params, { fichier: 'piece.gcode', emplacement: 2 });
});

test('filament : extruder / rétracter quelques mm (longueur signée, bornée)', async () => {
  for (const longueur of [10, -50]) {
    const r = await admin.req('POST', '/machines/kobra-1/filament/extrude', { longueur, temp: 215 });
    assert.equal(r.statut, 202, JSON.stringify(r.json));
    await attendre(() => srv.hub.operations.get(r.json.operation)?.fin);
    const cmd = agent.commandes.at(-1);
    assert.equal(cmd.action, 'filament.extrude');
    assert.deepEqual(cmd.params, { longueur, temp: 215 });
  }
  const avant = agent.commandes.length;
  for (const corps of [{ longueur: 500 }, { longueur: -201 }, { longueur: '10' }, {}, { longueur: 10, temp: 400 }]) {
    assert.equal((await admin.req('POST', '/machines/kobra-1/filament/extrude', corps)).statut, 400, JSON.stringify(corps));
  }
  assert.equal(agent.commandes.length, avant, 'rien envoyé à l\'agent');
});

test('rôle insuffisant : un lecteur ne peut pas agir', async () => {
  const secret = await creerCompte('lecteur@test.local', 'lecteur');
  const l = new Client();
  await l.connexion('lecteur@test.local', 'mot-de-passe-de-test!', secret);
  assert.equal((await l.req('GET', '/machines')).statut, 200);
  assert.equal((await l.req('PUT', '/machines/kobra-1/speed', { percent: 120 })).statut, 403);
  assert.equal((await l.req('GET', '/users')).statut, 403);
});

test('action sensible : code 2FA récent exigé', async () => {
  srv.db.prepare('UPDATE sessions SET dernier_2fa = 0').run();
  const r = await admin.req('POST', '/machines/kobra-1/print/cancel', {});
  assert.equal(r.statut, 403);
  assert.equal(r.json.erreur, 'confirmation_requise');
  await new Promise((ok) => setTimeout(ok, 31000 - (Date.now() % 30000)));   // pas de temps suivant
  const c = await admin.req('POST', '/auth/2fa/confirmer', { code: S.codeTotp(totpAdmin, Math.floor(Date.now() / 30000)) });
  assert.equal(c.statut, 200);
  assert.equal((await admin.req('POST', '/machines/kobra-1/print/cancel', {})).statut, 200);
});

test('gcode envoyé du site jusqu\'à l\'agent, intact (SHA-256)', async () => {
  const contenu = Buffer.alloc(2.3 * 1024 * 1024, 'G1 X1\n');
  const form = new FormData();
  form.append('file', new Blob([contenu]), 'piece envoyee.gcode');
  const r = await admin.req('POST', '/machines/kobra-1/files', form);
  assert.equal(r.statut, 202, JSON.stringify(r.json));
  await attendre(() => srv.hub.operations.get(r.json.operation)?.fin);
  assert.equal(srv.hub.operations.get(r.json.operation).statut, 'ok');
  const cmd = agent.commandes.find((c) => c.action === 'file.upload');
  assert.equal(cmd.params.fichier, 'piece envoyee.gcode');
  const recu = Buffer.concat(agent.recus.get(cmd.params.transfert));
  assert.ok(recu.equals(contenu));
  const mauvais = new FormData();
  mauvais.append('file', new Blob(['x']), 'virus.exe');
  assert.equal((await admin.req('POST', '/machines/kobra-1/files', mauvais)).statut, 400);
});

test('miniature transférée puis gardée en cache', async () => {
  const a = await admin.req('GET', '/machines/kobra-1/files/piece.gcode/thumbnail');
  assert.equal(a.statut, 200);
  assert.equal(Buffer.from(await a.res.arrayBuffer()).toString(), 'PNG-miniature');
  const n = agent.commandes.length;
  await admin.req('GET', '/machines/kobra-1/files/piece.gcode/thumbnail');
  assert.equal(agent.commandes.length, n, 'pas de 2e demande à l\'agent');
});

test('aperçu 3D : description dans la réponse, ou jointe au transfert pour un gros plateau', async () => {
  for (const [fichier, couches] of [['petit.gcode', 1], ['gros.gcode', 20000]]) {
    const meta = await admin.req('GET', `/machines/kobra-1/files/${fichier}/toolpath`);
    assert.equal(meta.statut, 200, JSON.stringify(meta.json));
    assert.equal(meta.json.layers.length, couches);
    assert.equal(meta.json.segments, 2);
    const bin = await admin.req('GET', `/machines/kobra-1/files/${fichier}/toolpath-bin`);
    assert.equal(Buffer.from(await bin.res.arrayBuffer()).toString(), 'SEGMENTS', 'segments seuls, sans la description');
  }
  assert.equal(srv.hub.lien !== null, true, 'agent toujours connecté');
});

test("aperçu 3D d'une plaque : trajets du serveur, l'agent n'est pas sollicité", async () => {
  const zlib = require('node:zlib');
  const dossier = path.join(srv.config.donnees, 'gcode');
  fs.mkdirSync(dossier, { recursive: true });
  fs.writeFileSync(path.join(dossier, 'devis-777.trajets.json'), JSON.stringify({ version: 1, segments: 1, layers: [[0.2, 0, 1]] }));
  fs.writeFileSync(path.join(dossier, 'devis-777.trajets.bin.gz'), zlib.gzipSync(Buffer.from('SEGPLAQUE')));
  srv.db.prepare(`INSERT INTO lots (id, imprimante_id, proprete_mm, statut, gcode_chemin, fichier_machine, cree_le)
    VALUES (777, 'kobra-1', 0.2, 'a_faire', 'gcode/devis-777.gcode.gz', 'a_faire/P0777_2026-11-28.gcode', ?)`).run(Date.now());
  const n = agent.commandes.length;
  const meta = await admin.req('GET', '/machines/kobra-1/files/a_faire/P0777_2026-11-28.gcode/toolpath');
  assert.equal(meta.statut, 200, JSON.stringify(meta.json));
  assert.deepEqual(meta.json.layers, [[0.2, 0, 1]]);
  const bin = await admin.req('GET', '/machines/kobra-1/files/a_faire/P0777_2026-11-28.gcode/toolpath-bin');
  assert.equal(Buffer.from(await bin.res.arrayBuffer()).toString(), 'SEGPLAQUE', 'décompressé par le client HTTP');
  assert.equal(agent.commandes.length, n, "rien demandé à l'agent");
  srv.db.prepare('DELETE FROM lots WHERE id = 777').run();
});

test('vidéo enregistrée téléchargée en flux (2,5 Mo)', async () => {
  const r = await admin.req('GET', '/machines/kobra-1/recordings/impression_20261117_120000.mp4');
  assert.equal(r.statut, 200);
  assert.equal(r.res.headers.get('content-type'), 'video/mp4');
  assert.equal((await r.res.arrayBuffer()).byteLength, 2.5 * 1024 * 1024);
});

test('caméra en direct relayée seulement pendant qu\'on regarde', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${urlApi}/machines/kobra-1/camera/stream`, { headers: { cookie: admin.cookie }, signal: ctrl.signal });
  const lecteur = res.body.getReader();
  let texte = '';
  while (!texte.includes('JPEG')) texte += Buffer.from((await lecteur.read()).value).toString();
  assert.ok(texte.includes('--image'));
  ctrl.abort();
  await attendre(() => agent.commandes.filter((c) => c.action === 'camera.stream').at(-1)?.params.actif === false);
});

test('flux temps réel (SSE) : état poussé au navigateur', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${urlApi}/events`, { headers: { cookie: admin.cookie }, signal: ctrl.signal });
  const lecteur = res.body.getReader();
  let texte = '';
  while (!texte.includes('event: etat')) texte += Buffer.from((await lecteur.read()).value).toString();
  ctrl.abort();
});

test('création d\'un compte : 2FA et codes de secours fournis une fois', async () => {
  const r = await admin.req('POST', '/users', { email: 'nouveau@test.local', nom: 'Nouveau', role: 'operateur', motdepasse: 'un-mot-de-passe-solide' });
  assert.equal(r.statut, 201, JSON.stringify(r.json));
  assert.match(r.json.totp.url, /^otpauth:\/\/totp\//);
  assert.equal(r.json.codes_secours.length, 10);
  assert.equal((await admin.req('POST', '/users', { email: 'x@test.local', nom: 'X', role: 'admin', motdepasse: 'court' })).statut, 400);
  const audit = await admin.req('GET', '/audit');
  assert.ok(audit.json.some((a) => a.action === 'users.creer'));
});

// ------------------------------------------------------------------ attaques sur le lien établi

test('message rejoué (séquence répétée) : connexion coupée', async () => {
  const env = agent.env({ type: 'evenement', machine: 'kobra-1', nom: 'etat', donnees: { state: 'READY' } });
  agent.ws.send(JSON.stringify(env));
  agent.ws.send(JSON.stringify(env));
  await attendre(() => agent.ferme);
  assert.equal(agent.ferme.code, 4002);
  await attendre(() => srv.hub.lien === null);
});

test('agent hors ligne : l\'API répond 503', async () => {
  const r = await admin.req('PUT', '/machines/kobra-1/speed', { percent: 100 });
  assert.equal(r.statut, 503);
  assert.equal(r.json.erreur, 'agent_hors_ligne');
});

test('message trop gros, champ inconnu, type inconnu : coupé', async () => {
  for (const attaque of [
    (a) => a.ws.send(JSON.stringify(a.env({ type: 'evenement', machine: 'kobra-1', nom: 'etat', donnees: { x: 'a'.repeat(70000) } }))),
    (a) => a.envoyer({ type: 'evenement', machine: 'kobra-1', nom: 'etat', donnees: {}, executer: 'rm -rf /' }),
    (a) => a.envoyer({ type: 'commande', machine: 'kobra-1', action: 'shell', params: {} }),
    (a) => a.ws.send(JSON.stringify({ ...a.env({ type: 'evenement', machine: 'kobra-1', nom: 'etat', donnees: {} }), ts: Date.now() - 3600e3 })),
  ]) {
    const a = new FauxAgent();
    await a.connecter();
    attaque(a);
    await attendre(() => a.ferme);
    assert.ok([1009, 4002].includes(a.ferme.code), `code ${a.ferme.code}`);
    await attendre(() => srv.hub.lien === null);
  }
  // message trop gros : le journal dit lequel (type, événement, champ lourd), sans son contenu
  const coupure = srv.db.prepare("SELECT detail FROM audit WHERE action = 'agent.coupure' AND detail LIKE 'message trop gros%' ORDER BY id DESC LIMIT 1").get();
  assert.match(coupure.detail, /octets · type=evenement · nom=etat · champs lourds : donnees\.x=70002/);
  assert.doesNotMatch(coupure.detail, /aaaa/);
});

test('agent révoqué : refusé', async () => {
  srv.db.prepare('UPDATE agent SET revoque = 1').run();
  await assert.rejects(new FauxAgent().connecter(), (e) => e.code === 4003);
  srv.db.prepare('UPDATE agent SET revoque = 0').run();
});

test('bannissement : 5 échecs depuis une IP -> coupée dès la connexion', async () => {
  srv.hub.echecs.clear();
  srv.hub.config.agent.bannissement.echecs = 5;
  srv.hub.config.agent.bannissement.exempterLocal = false;   // les tests viennent de 127.0.0.1
  for (let i = 0; i < 5; i++) await new FauxAgent({ signatureFausse: true }).connecter().catch(() => {});
  await assert.rejects(new FauxAgent().connecter());
  const j = srv.db.prepare("SELECT COUNT(*) n FROM audit WHERE action = 'agent.echec'").get();
  assert.ok(j.n >= 5);
});

test('derrière un proxy (Fly.io) : vraie IP lue dans le PROXY protocol, bannissement par vraie IP', async () => {
  const cfg = path.join(dir, 'config-proxy.json');
  fs.writeFileSync(cfg, JSON.stringify({
    api: { port: 0, cookieSecure: false },
    agent: { port: 0, hote: '127.0.0.1', id: AGENT_ID, proxyProtocol: true, bannissement: { echecs: 2, dureeMs: 3600e3 } },
    pki: { ca: path.join(dir, 'pki', 'ca.crt.pem'), cert: path.join(dir, 'pki', 'serveur.crt.pem'), cle: path.join(dir, 'pki', 'serveur.key.pem') },
    donnees: path.join(dir, 'data-proxy'),
  }));
  const s2 = await demarrer(charger(cfg, {}));
  try {
    s2.db.prepare('INSERT INTO agent (id, cle_publique, revoque, enrole) VALUES (?, ?, 0, ?)')
      .run(AGENT_ID, cleAgent.publicKey.export({ type: 'spki', format: 'pem' }), Date.now());
    const relais = s2.hub.relais.address().port;
    const url = `wss://localhost:${relais}/ws`;
    const entete = (ip) => `PROXY TCP4 ${ip} 10.0.0.1 40000 8443\r\n`;

    // sans en-tête : la connexion ne vient pas du proxy, refusée avant toute poignée TLS
    await assert.rejects(new FauxAgent({ url, relais, entete: 'aucun' }).connecter());
    // un attaquant (198.51.100.7) se fait bannir...
    for (let i = 0; i < 2; i++) await new FauxAgent({ url, relais, entete: entete('198.51.100.7'), signatureFausse: true }).connecter().catch(() => {});
    await assert.rejects(new FauxAgent({ url, relais, entete: entete('198.51.100.7') }).connecter());
    // ...sans bannir l'agent légitime, qui passe pourtant par le même proxy
    const a = new FauxAgent({ url, relais, entete: entete('203.0.113.9') });
    await a.connecter();
    assert.equal(s2.hub.statut().ip, '203.0.113.9');
    const echecs = s2.db.prepare("SELECT ip FROM audit WHERE action = 'agent.echec'").all().map((r) => r.ip);
    assert.ok(echecs.includes('198.51.100.7') && !echecs.includes('127.0.0.1'), JSON.stringify(echecs));
    a.fermer();
  } finally {
    await s2.arreter();
  }
});

test('connexion fantôme : coupée sous 5 s si un nouvel agent attend ; les refus 409 ne bannissent pas', async () => {
  srv.hub.echecs.clear();
  srv.hub.config.agent.bannissement.exempterLocal = false;
  srv.hub.config.agent.bannissement.echecs = 2;
  const fantome = new FauxAgent();
  await fantome.connecter();
  fantome.ws._socket.pause();                       // ne lit plus rien : ne répond plus aux pings
  for (let i = 0; i < 4; i++) {                     // 4 refus 409 : plus que le seuil de bannissement
    await assert.rejects(new FauxAgent().connecter(), (e) => e.statut === 409);
  }
  await attendre(() => srv.hub.lien === null, 8000);
  const nouveau = new FauxAgent();
  await nouveau.connecter();                       // pas banni, et la place est libre
  assert.equal(srv.hub.statut().connecte, true);
  nouveau.fermer();
  fantome.fermer();
  await attendre(() => srv.hub.lien === null);
  srv.hub.config.agent.bannissement.exempterLocal = true;
});

test('le PC lui-même (127.0.0.1) n\'est jamais banni par défaut', async () => {
  srv.hub.config.agent.bannissement.exempterLocal = true;
  const a = new FauxAgent();
  await a.connecter();                  // malgré les 5 échecs du test précédent
  assert.equal(srv.hub.statut().connecte, true);
  a.fermer();
  await attendre(() => srv.hub.lien === null);
});
