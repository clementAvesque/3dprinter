'use strict';
// Serveur WebSocket de l'agent (une seule connexion autorisée) : TLS 1.3 + certificat client (mTLS),
// défi signé Ed25519, anti-rejeu (séquence + horodatage + identifiants uniques), validation stricte
// de chaque message, relais des commandes, transferts de fichiers, cache de l'état des machines.

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { WebSocketServer } = require('ws');
const { COMMANDES, LIMITES, valider } = require('./protocole');
const { lirePki } = require('./config');

// PROXY protocol v1 : "PROXY TCP4 <ip source> <ip dest> <port source> <port dest>\r\n" (107 octets max)
const PROXY_RE = /^PROXY (TCP4|TCP6) ([0-9a-fA-F.:]+) ([0-9a-fA-F.:]+) (\d{1,5}) (\d{1,5})$/;

const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const MACHINE_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const BUFFER_MAX = 64 * 1024 * 1024;            // transfert gardé en mémoire (aperçu 3D, miniature...)
const TEMPERATURES_MAX = 240;                    // 8 min à un point toutes les 2 s
const EVENEMENTS = new Set(['etat', 'fichiers', 'enregistrement']);

// champs autorisés pour chaque type de message reçu de l'agent (en plus de v, id, seq, ts, type)
const CHAMPS = {
  preuve: ['agent', 'signature', 'protocole', 'machines'],
  reponse: ['re', 'ok', 'resultat', 'erreur', 'detail', 'transfert'],
  evenement: ['machine', 'nom', 'donnees'],
  morceau: ['transfert', 'index', 'fin'],
  video: ['machine'],
};

const nouvelId = () => crypto.randomBytes(12).toString('base64url');
const ipPropre = (ip) => String(ip || '').replace(/^::ffff:/, '');

class ErreurHub extends Error {
  constructor(statut, code, detail) {
    super(detail || code);
    this.statut = statut; this.code = code; this.detail = detail;
  }
}

class Hub extends EventEmitter {
  constructor(config, db, journal) {
    super();
    this.setMaxListeners(200);
    this.config = config;
    this.db = db;
    this.journal = journal;          // journal(action, {ip, cible, resultat, detail})
    this.lien = null;                // l'agent authentifié
    this.candidat = null;            // connexion en cours d'authentification (une seule à la fois)
    this.machines = new Map();       // id -> {id, nom, enLigne, etat, recu, temperatures, fichiers}
    this.attente = new Map();        // id de commande -> {resolve, reject, timer, sink, delai}
    this.transferts = new Map();     // id de transfert reçu -> état du transfert
    this.operations = new Map();     // opérations longues (202)
    this.spectateurs = new Map();    // machine -> Set de fonctions(image) (flux vidéo)
    this.echecs = new Map();         // ip -> [horodatages d'échec] (bannissement)
    this.connecteDepuis = null;
    this.ipAgent = null;
    this.ipsReelles = new Map();     // derrière un proxy : port local du relais interne -> vraie IP
  }

  // adresse réelle d'une connexion : celle annoncée par le proxy (PROXY protocol), sinon celle du socket
  _ip(socket) {
    if (this.config.agent.proxyProtocol) return this.ipsReelles.get(socket.remotePort) || 'inconnue';
    return ipPropre(socket.remoteAddress);
  }

  // ---------------------------------------------------------------- démarrage

  demarrer() {
    const cert = lirePki(this.config, 'cert');
    this.empreinteServeur = crypto.createHash('sha256').update(new crypto.X509Certificate(cert).raw).digest('hex');
    this.serveur = https.createServer({
      key: lirePki(this.config, 'cle'),
      cert,
      ca: lirePki(this.config, 'ca'),
      requestCert: true,               // certificat client exigé...
      rejectUnauthorized: true,        // ...et signé par NOTRE autorité, sinon la poignée TLS échoue
      minVersion: 'TLSv1.3',
    }, (req, res) => { res.writeHead(404); res.end(); });
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: LIMITES.morceau_octets + 8192,
      perMessageDeflate: false,        // pas de compression : évite les attaques par décompression
    });
    this.serveur.on('upgrade', (req, socket, head) => this._upgrade(req, socket, head));
    // une IP bannie est coupée dès la connexion TCP, avant même la poignée TLS
    // (derrière un proxy, c'est le relais qui s'en charge : voir _entreeProxy)
    this.serveur.on('connection', (socket) => {
      if (!this.config.agent.proxyProtocol && this._banni(this._ip(socket))) { socket.coupeCarBanni = true; socket.destroy(); }
    });
    this.serveur.on('tlsClientError', (err, socket) => {
      // socket déjà coupée car bannie (comptée), ou disparue : pas d'échec en double dans le journal
      if (socket.coupeCarBanni || socket._parent?.coupeCarBanni || !socket.remotePort) return;
      const conseil = err.code === 'ERR_SSL_HTTP_REQUEST' ? ' (requête http:// en clair : ce port est réservé à l\'agent)' : '';
      this._echec(this._ip(socket), `TLS : ${err.code || err.message}${conseil}`);
    });
    this.serveur.headersTimeout = 10000;
    this.serveur.requestTimeout = 10000;
    const ecouter = (serveur, port, hote) => new Promise((ok, ko) => {
      serveur.once('error', ko);                 // ex. port déjà utilisé : erreur remontée, pas de plantage brut
      serveur.listen(port, hote, () => { serveur.off('error', ko); ok(); });
    });
    const demarrage = this.config.agent.proxyProtocol
      // derrière un proxy TCP : le relais écoute le port public, le serveur TLS n'écoute que la machine
      ? ecouter(this.serveur, 0, '127.0.0.1').then(() => {
        this.relais = net.createServer((socket) => this._entreeProxy(socket));
        return ecouter(this.relais, this.config.agent.port, this.config.agent.hote);
      })
      : ecouter(this.serveur, this.config.agent.port, this.config.agent.hote);
    return demarrage.then(() => { this._pingTimer = setInterval(() => this._ping(), LIMITES.ping_ms); });
  }

  // derrière un proxy (Fly.io) : lit l'en-tête PROXY protocol (vraie IP de l'agent), applique le
  // bannissement et la liste d'IP autorisées, puis relaie le flux TLS intact vers le serveur interne
  _entreeProxy(socket) {
    let tampon = Buffer.alloc(0);
    socket.on('error', () => {});
    const delai = setTimeout(() => socket.destroy(), 5000);
    const lire = (morceau) => {
      tampon = Buffer.concat([tampon, morceau]);
      const fin = tampon.indexOf('\r\n');
      if (fin < 0) { if (tampon.length > 107) socket.destroy(); return; }
      socket.off('data', lire);
      socket.pause();
      clearTimeout(delai);
      const m = PROXY_RE.exec(tampon.subarray(0, fin).toString('latin1'));
      if (!m) return socket.destroy();          // connexion qui ne vient pas du proxy : refusée
      const ip = ipPropre(m[2]);
      if (this._banni(ip)) return socket.destroy();
      const ips = this.config.agent.ipsAutorisees;
      if (ips.length && !ips.includes(ip)) { this._echec(ip, 'ip non autorisée'); return socket.destroy(); }
      const interne = net.connect(this.serveur.address().port, '127.0.0.1');
      interne.on('error', () => socket.destroy());
      interne.on('connect', () => {
        const cle = interne.localPort;
        this.ipsReelles.set(cle, ip);
        interne.on('close', () => { this.ipsReelles.delete(cle); socket.destroy(); });
        socket.on('close', () => interne.destroy());
        interne.write(tampon.subarray(fin + 2));
        socket.pipe(interne);
        interne.pipe(socket);
        socket.resume();
      });
    };
    socket.on('data', lire);
  }

  arreter() {
    clearInterval(this._pingTimer);
    if (this.lien) this.lien.ws.terminate();
    if (this.candidat) this.candidat.ws.terminate();
    const fermer = (s) => (s ? new Promise((ok) => s.close(() => ok())) : Promise.resolve());
    return Promise.all([fermer(this.serveur), fermer(this.relais)]);
  }

  _banni(ip) {
    const { echecs, dureeMs, exempterLocal } = this.config.agent.bannissement;
    // le PC lui-même (127.0.0.1) n'est jamais banni : un navigateur ouvert par erreur sur ce port
    // bannirait sinon l'agent qui tourne sur la même machine. Ses échecs restent journalisés.
    if (exempterLocal && ['127.0.0.1', '::1'].includes(ip)) return false;
    const t = (this.echecs.get(ip) || []).filter((x) => Date.now() - x < dureeMs);
    this.echecs.set(ip, t);
    return t.length >= echecs;
  }

  _echec(ip, detail) {
    ip = ipPropre(ip);
    const t = this.echecs.get(ip) || [];
    t.push(Date.now());
    this.echecs.set(ip, t);
    this.journal('agent.echec', { ip, resultat: 'refuse', detail });
  }

  _upgrade(req, socket, head) {
    const ip = this._ip(socket);
    const refuser = (code, raison) => {
      this._echec(ip, raison);
      socket.end(`HTTP/1.1 ${code} Refuse\r\nConnection: close\r\n\r\n`);
    };
    if (this._banni(ip)) return refuser(429, 'ip bannie (trop d\'échecs)');
    if (req.url !== '/ws') return refuser(404, `chemin ${String(req.url).slice(0, 50)}`);
    const ips = this.config.agent.ipsAutorisees;
    if (ips.length && !ips.includes(ip)) return refuser(403, 'ip non autorisée');
    const cert = socket.getPeerCertificate();
    if (!socket.authorized || !cert || cert.subject?.CN !== this.config.agent.id) {
      return refuser(403, `certificat client refusé (${cert?.subject?.CN || 'aucun'})`);
    }
    // place prise : ce n'est PAS un échec (bon certificat), sinon l'agent légitime qui réessaie pendant
    // qu'une ancienne connexion traîne finirait banni. On vérifie aussitôt si l'agent en place répond.
    const occupe = (raison) => {
      this.journal('agent.refus', { ip, resultat: 'refuse', detail: raison });
      socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
    };
    if (this.lien) { this._sonder(this.lien); return occupe('un agent est déjà connecté'); }
    if (this.candidat) return occupe('authentification déjà en cours');
    this.wss.handleUpgrade(req, socket, head, (ws) => this._accueillir(ws, ip, cert.subject.CN));
  }

  // ---------------------------------------------------------------- connexion et authentification

  _accueillir(ws, ip, cn) {
    const c = {
      ws, ip, cn, seqIn: 0, seqOut: 0, authentifie: false,
      vus: new Map(), dernierPong: Date.now(), debit: { t: Date.now(), n: 0 },
    };
    this.candidat = c;
    c.defi = { nonce: crypto.randomBytes(32).toString('base64'), ts: Date.now() };
    this._envoyer(c, { type: 'defi', nonce: c.defi.nonce, defi_ts: c.defi.ts });
    c.timerDefi = setTimeout(() => this._fermer(c, 4001, 'délai d\'authentification dépassé'), LIMITES.defi_validite_ms);
    ws.on('message', (data, binaire) => {
      try { this._recevoir(c, data, binaire); } catch (e) { this._fermer(c, 4000, `erreur interne : ${e.message}`); }
    });
    ws.on('pong', () => { c.dernierPong = Date.now(); });
    ws.on('close', () => this._perdu(c));
    ws.on('error', () => {});
  }

  _fermer(c, code, raison) {
    if (!c.authentifie) this._echec(c.ip, raison);
    else this.journal('agent.coupure', { ip: c.ip, resultat: 'erreur', detail: raison });
    clearTimeout(c.timerDefi);
    try { c.ws.close(code, raison.slice(0, 100)); } catch { /* déjà fermé */ }
    setTimeout(() => c.ws.terminate(), 2000).unref();
  }

  _perdu(c) {
    clearTimeout(c.timerDefi);
    if (this.candidat === c) this.candidat = null;
    if (this.lien !== c) return;
    this.lien = null;
    this.connecteDepuis = null;
    for (const [id, p] of this.attente) {
      clearTimeout(p.timer);
      p.reject(new ErreurHub(503, 'agent_hors_ligne', 'l\'agent s\'est déconnecté'));
      this.attente.delete(id);
    }
    for (const [id, t] of this.transferts) { t.echouer(new ErreurHub(503, 'agent_hors_ligne')); this.transferts.delete(id); }
    for (const m of this.machines.values()) m.enLigne = false;
    this.journal('agent.deconnexion', { ip: c.ip, resultat: 'ok' });
    this.emit('agent', this.statut());
  }

  // l'agent en place répond-il encore ? (connexion fantôme : agent arrêté net, derrière un proxy qui
  // n'a pas encore fermé) -> sans « pong » sous 5 s, il est coupé et la place se libère
  _sonder(c) {
    if (c.sondage) return;
    c.sondage = true;
    const avant = c.dernierPong;
    try { c.ws.ping(); } catch { /* déjà fermé */ }
    setTimeout(() => {
      c.sondage = false;
      if (this.lien === c && c.dernierPong === avant) {
        this.journal('agent.coupure', { ip: c.ip, resultat: 'erreur', detail: 'ne répond plus (un autre agent attend)' });
        c.ws.terminate();
      }
    }, 5000).unref();
  }

  _ping() {
    for (const c of [this.lien, this.candidat]) {
      if (!c) continue;
      if (Date.now() - c.dernierPong > LIMITES.coupure_ms) { c.ws.terminate(); continue; }
      try { c.ws.ping(); } catch { /* fermé */ }
    }
  }

  _preuve(c, env) {
    const { agent, signature, protocole, machines } = env;
    if (agent !== this.config.agent.id || agent !== c.cn) return this._fermer(c, 4003, 'identifiant d\'agent refusé');
    if (protocole !== 1) return this._fermer(c, 4003, 'version de protocole refusée');
    if (Date.now() - c.defi.ts > LIMITES.defi_validite_ms) return this._fermer(c, 4001, 'défi expiré');
    const ligne = this.db.prepare('SELECT cle_publique, revoque FROM agent WHERE id = ?').get(agent);
    if (!ligne) return this._fermer(c, 4003, 'agent non enrôlé');
    if (ligne.revoque) return this._fermer(c, 4003, 'agent révoqué');
    // la signature couvre le défi ET l'empreinte du certificat du serveur : une preuve obtenue
    // par un faux serveur intermédiaire ne vaut rien ici
    const message = Buffer.from(`printer-agent-v1|${c.defi.nonce}|${c.defi.ts}|${agent}|${this.empreinteServeur}`);
    let bonne = false;
    try {
      bonne = typeof signature === 'string' && signature.length <= 200
        && crypto.verify(null, message, crypto.createPublicKey(ligne.cle_publique), Buffer.from(signature, 'base64'));
    } catch { bonne = false; }
    if (!bonne) return this._fermer(c, 4003, 'signature invalide');
    if (!Array.isArray(machines) || machines.length < 1 || machines.length > 20
      || !machines.every((m) => m && MACHINE_RE.test(m.id) && typeof m.nom === 'string' && m.nom.length <= 80)) {
      return this._fermer(c, 4002, 'liste de machines invalide');
    }
    if (this.lien) return this._fermer(c, 4009, 'un agent est déjà connecté');

    clearTimeout(c.timerDefi);
    c.authentifie = true;
    this.candidat = null;
    this.lien = c;
    this.connecteDepuis = Date.now();
    this.ipAgent = c.ip;
    const ids = new Set(machines.map((m) => m.id));
    for (const id of [...this.machines.keys()]) if (!ids.has(id)) this.machines.delete(id);
    for (const m of machines) {
      const ex = this.machines.get(m.id);
      this.machines.set(m.id, ex ? { ...ex, nom: m.nom, enLigne: true }
        : { id: m.id, nom: m.nom, enLigne: true, etat: null, recu: 0, temperatures: [], fichiers: null });
    }
    this._envoyer(c, { type: 'bienvenue' });
    this.journal('agent.connexion', { ip: c.ip, resultat: 'ok', detail: `${machines.length} machine(s)` });
    this.emit('agent', this.statut());
    // remet en route ce que le serveur attend de l'agent
    for (const m of this.machines.values()) {
      if (this.spectateurs.get(m.id)?.size) this.commande(m.id, 'camera.stream', { actif: true }).catch(() => {});
      this.rafraichirFichiers(m.id).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- réception

  _verifierEnveloppe(c, env, type) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) return 'message invalide';
    if (env.v !== 1) return 'version invalide';
    if (typeof env.id !== 'string' || !ID_RE.test(env.id)) return 'identifiant invalide';
    if (!Number.isInteger(env.seq) || env.seq !== c.seqIn + 1) return `séquence ${env.seq} au lieu de ${c.seqIn + 1}`;
    if (typeof env.ts !== 'number' || Math.abs(Date.now() - env.ts) > LIMITES.horloge_tolerance_ms) return 'horodatage hors tolérance';
    if (c.vus.has(env.id)) return 'message rejoué';
    const autorises = CHAMPS[type];
    if (!autorises) return `type ${String(type).slice(0, 20)} refusé`;
    for (const k of Object.keys(env)) {
      if (!['v', 'id', 'seq', 'ts', 'type'].includes(k) && !autorises.includes(k)) return `champ inconnu ${k.slice(0, 20)}`;
    }
    if (!c.authentifie && type !== 'preuve') return 'non authentifié';
    if (c.authentifie && type === 'preuve') return 'déjà authentifié';
    c.seqIn = env.seq;
    c.vus.set(env.id, Date.now());
    if (c.vus.size > 5000) for (const [id, t] of c.vus) if (Date.now() - t > 120e3) c.vus.delete(id);
    return null;
  }

  _recevoir(c, data, binaire) {
    // débit : 300 messages / s maximum (images vidéo et morceaux de fichiers compris)
    const now = Date.now();
    if (now - c.debit.t > 1000) c.debit = { t: now, n: 0 };
    if (++c.debit.n > 300) return this._fermer(c, 4008, 'trop de messages');

    let env, octets = null;
    if (!binaire) {
      if (data.length > LIMITES.message_json_octets) return this._fermer(c, 1009, 'message trop gros');
      try { env = JSON.parse(data.toString('utf8')); } catch { return this._fermer(c, 4002, 'JSON invalide'); }
    } else {
      if (data.length < 4) return this._fermer(c, 4002, 'trame binaire invalide');
      const lg = data.readUInt32BE(0);
      if (lg > 4096 || 4 + lg > data.length) return this._fermer(c, 4002, 'entête binaire invalide');
      try { env = JSON.parse(data.subarray(4, 4 + lg).toString('utf8')); } catch { return this._fermer(c, 4002, 'entête JSON invalide'); }
      octets = data.subarray(4 + lg);
      if (!['morceau', 'video'].includes(env?.type)) return this._fermer(c, 4002, 'type binaire refusé');
    }
    if (!binaire && ['morceau', 'video'].includes(env?.type)) return this._fermer(c, 4002, 'type texte refusé');
    const erreur = this._verifierEnveloppe(c, env, env?.type);
    if (erreur) return this._fermer(c, 4002, erreur);

    switch (env.type) {
      case 'preuve': return this._preuve(c, env);
      case 'reponse': return this._reponse(c, env);
      case 'evenement': return this._evenement(c, env);
      case 'morceau': return this._morceau(c, env, octets);
      case 'video': return this._video(c, env, octets);
      default: return this._fermer(c, 4002, 'type refusé');
    }
  }

  _reponse(c, env) {
    if (typeof env.re !== 'string' || !ID_RE.test(env.re) || typeof env.ok !== 'boolean') return this._fermer(c, 4002, 'réponse invalide');
    const p = this.attente.get(env.re);
    if (!p) return;                                  // réponse tardive (délai dépassé) : ignorée
    const res = { ok: env.ok, resultat: env.resultat ?? null, erreur: env.erreur ?? null, detail: env.detail ?? null };
    if (!env.transfert) {
      this.attente.delete(env.re);
      clearTimeout(p.timer);
      return p.resolve(res);
    }
    const t = env.transfert;
    if (!t || typeof t !== 'object' || !ID_RE.test(t.id || '') || !Number.isInteger(t.taille) || t.taille < 0
      || t.taille > 4 * 1024 ** 3 || !SHA_RE.test(t.sha256 || '') || typeof t.mime !== 'string' || t.mime.length > 80
      || this.transferts.has(t.id)) {
      return this._fermer(c, 4002, 'transfert invalide');
    }
    if (!p.sink && t.taille > BUFFER_MAX) {
      this.attente.delete(env.re); clearTimeout(p.timer);
      return p.reject(new ErreurHub(502, 'transfert_trop_gros'));
    }
    const hash = crypto.createHash('sha256');
    const morceaux = [];
    const fin = (erreur) => {
      this.transferts.delete(t.id);
      this.attente.delete(env.re);
      clearTimeout(p.timer);
      c.ws._socket.resume();          // jamais laisser l'agent en pause après un transfert
      if (erreur) return p.reject(erreur);
      if (p.sink && !p.sink.writableEnded) p.sink.end();
      const octets = p.sink ? null : Buffer.concat(morceaux);
      if (t.mime === 'application/json' && octets) {
        try { res.resultat = JSON.parse(octets.toString('utf8')); } catch { return p.reject(new ErreurHub(502, 'json_invalide')); }
      } else {
        res.octets = octets;
      }
      res.mime = t.mime;
      res.taille = t.taille;
      p.resolve(res);
    };
    this.transferts.set(t.id, {
      ...t, recu: 0, index: 0, hash, morceaux, sink: p.sink, c,
      terminer: () => {
        if (hash.digest('hex') !== t.sha256) return fin(new ErreurHub(502, 'empreinte_invalide', 'fichier corrompu en route'));
        fin(null);
      },
      echouer: (e) => { if (p.sink) p.sink.destroy(e); fin(e); },
    });
    if (p.sink && p.debut) p.debut(res, t);        // ex. en-têtes HTTP du téléchargement
    if (t.taille === 0) this.transferts.get(t.id).terminer();
  }

  _morceau(c, env, octets) {
    const t = this.transferts.get(env.transfert);
    if (!t) return;                                  // transfert abandonné : morceau ignoré
    if (env.index !== t.index || typeof env.fin !== 'boolean') return this._fermer(c, 4002, 'morceau hors ordre');
    t.index += 1;
    t.recu += octets.length;
    if (t.recu > t.taille) { t.echouer(new ErreurHub(502, 'transfert_trop_long')); return; }
    t.hash.update(octets);
    if (t.sink) {
      // visiteur parti en cours de route : on laisse l'agent finir, sans rien écrire
      if (!t.sink.destroyed && !t.sink.writableEnded && !t.sink.write(octets)) {
        // le visiteur télécharge lentement : on freine l'agent jusqu'à ce que son tampon se vide
        // (ou qu'il parte) ; reprendre est sans effet si la connexion n'était pas en pause
        c.ws._socket.pause();
        const reprendre = () => c.ws._socket.resume();
        t.sink.once('drain', reprendre);
        t.sink.once('close', reprendre);
      }
    } else {
      t.morceaux.push(Buffer.from(octets));
    }
    if (env.fin) {
      if (t.recu !== t.taille) return t.echouer(new ErreurHub(502, 'transfert_incomplet'));
      t.terminer();
    }
  }

  _video(c, env, octets) {
    if (!this.machines.has(env.machine)) return;
    for (const f of this.spectateurs.get(env.machine) || []) f(octets);
  }

  _evenement(c, env) {
    const m = this.machines.get(env.machine);
    if (!m || !EVENEMENTS.has(env.nom) || !env.donnees || typeof env.donnees !== 'object') {
      return this._fermer(c, 4002, 'événement invalide');
    }
    if (env.nom === 'etat') {
      m.etat = env.donnees;
      m.recu = Date.now();
      const buse = env.donnees.nozzle?.temperature, lit = env.donnees.bed?.temperature;
      m.temperatures.push({
        ts: m.recu,
        buse: buse?.value ?? null, buse_cible: buse?.target ?? null,
        plateau: lit?.value ?? null, plateau_cible: lit?.target ?? null,
      });
      if (m.temperatures.length > TEMPERATURES_MAX) m.temperatures.splice(0, m.temperatures.length - TEMPERATURES_MAX);
    } else if (env.nom === 'fichiers') {
      if (!Array.isArray(env.donnees.liste)) return this._fermer(c, 4002, 'liste de fichiers invalide');
      m.fichiers = env.donnees.liste;
    }
    this.emit('evenement', { machine: m.id, nom: env.nom, donnees: env.donnees });
  }

  // ---------------------------------------------------------------- envoi

  _envoyer(c, msg) {
    const env = { v: 1, id: nouvelId(), seq: ++c.seqOut, ts: Date.now(), ...msg };
    c.ws.send(JSON.stringify(env));
    return env.id;
  }

  _envoyerBinaire(c, entete, octets) {
    const env = Buffer.from(JSON.stringify({ v: 1, id: nouvelId(), seq: ++c.seqOut, ts: Date.now(), ...entete }));
    const lg = Buffer.alloc(4);
    lg.writeUInt32BE(env.length);
    return new Promise((ok, ko) => c.ws.send(Buffer.concat([lg, env, octets]), { binary: true }, (e) => (e ? ko(e) : ok())));
  }

  // envoie un fichier local à l'agent, morceau par morceau (après la commande file.upload)
  async envoyerFichier(c, chemin, transfert) {
    const fd = await fs.promises.open(chemin, 'r');
    try {
      const taille = (await fd.stat()).size;
      const buf = Buffer.alloc(LIMITES.morceau_octets);
      let pos = 0, index = 0;
      do {
        const { bytesRead } = await fd.read(buf, 0, buf.length, pos);
        pos += bytesRead;
        if (this.lien !== c) throw new ErreurHub(503, 'agent_hors_ligne');
        await this._envoyerBinaire(c, { type: 'morceau', transfert, index: index++, fin: pos >= taille }, buf.subarray(0, bytesRead));
      } while (pos < taille);
    } finally {
      await fd.close();
    }
  }

  // ---------------------------------------------------------------- API utilisée par Express

  statut() {
    return {
      connecte: !!this.lien,
      depuis: this.connecteDepuis,
      ip: this.ipAgent,
      machines: [...this.machines.values()].map((m) => ({ id: m.id, nom: m.nom, enLigne: m.enLigne })),
    };
  }

  machine(id) {
    return typeof id === 'string' && MACHINE_RE.test(id) ? this.machines.get(id) : undefined;
  }

  // envoie une commande de la liste fermée et attend la réponse de l'agent.
  // opts.user : qui l'a demandée (journal de l'agent) ; opts.sink : flux où écrire un fichier reçu ;
  // opts.envoi : fonction async(c) qui envoie des morceaux juste après la commande
  commande(machine, action, params = {}, opts = {}) {
    if (!this.lien) return Promise.reject(new ErreurHub(503, 'agent_hors_ligne', 'l\'agent n\'est pas connecté'));
    if (!this.machines.has(machine)) return Promise.reject(new ErreurHub(404, 'machine_inconnue'));
    const v = valider(action, params);
    if (v.erreur) return Promise.reject(new ErreurHub(400, 'parametres', v.champ ? `${v.champ} : ${v.erreur}` : v.erreur));
    const def = COMMANDES[action];
    const delai = def.delai_ms || (def.longue ? LIMITES.reponse_longue_ms : LIMITES.reponse_ms);
    const c = this.lien;
    return new Promise((resolve, reject) => {
      const id = this._envoyer(c, { type: 'commande', machine, action, params: v.params, user: opts.user ?? null });
      const timer = setTimeout(() => {
        this.attente.delete(id);
        reject(new ErreurHub(504, 'delai_depasse', `pas de réponse de l'agent en ${delai / 1000} s`));
      }, delai);
      this.attente.set(id, { resolve, reject, timer, sink: opts.sink, debut: opts.debut, delai });
      if (opts.envoi) {
        opts.envoi(c).catch((e) => {
          if (!this.attente.has(id)) return;
          clearTimeout(timer);
          this.attente.delete(id);
          reject(e instanceof ErreurHub ? e : new ErreurHub(502, 'envoi_impossible', e.message));
        });
      }
    });
  }

  // lance une commande longue en arrière-plan : retourne tout de suite l'opération à suivre
  operation(machine, action, params, opts = {}) {
    const op = { id: nouvelId(), machine, action, statut: 'en_cours', resultat: null, erreur: null, cree: Date.now(), fin: null, user: opts.user ?? null };
    this.operations.set(op.id, op);
    for (const [id, o] of this.operations) if (o.fin && Date.now() - o.fin > 3600e3) this.operations.delete(id);
    this.emit('operation', op);
    this.commande(machine, action, params, opts).then((r) => {
      Object.assign(op, r.ok ? { statut: 'ok', resultat: r.resultat } : { statut: 'erreur', erreur: r.erreur, detail: r.detail });
    }, (e) => {
      Object.assign(op, { statut: 'erreur', erreur: e.code || 'erreur', detail: e.detail || e.message });
    }).finally(() => {
      op.fin = Date.now();
      if (opts.apres) opts.apres(op);
      this.emit('operation', op);
    });
    return op;
  }

  async rafraichirFichiers(machine) {
    const r = await this.commande(machine, 'files.list', {});
    if (r.ok && Array.isArray(r.resultat)) {
      this.machines.get(machine).fichiers = r.resultat;
      this.emit('evenement', { machine, nom: 'fichiers', donnees: { liste: r.resultat } });
    }
    return r;
  }

  // flux vidéo : la caméra n'est relayée que tant qu'au moins une page la regarde
  ajouterSpectateur(machine, f) {
    let s = this.spectateurs.get(machine);
    if (!s) this.spectateurs.set(machine, (s = new Set()));
    s.add(f);
    if (s.size === 1) this.commande(machine, 'camera.stream', { actif: true }).catch(() => {});
    return () => {
      s.delete(f);
      if (s.size === 0) this.commande(machine, 'camera.stream', { actif: false }).catch(() => {});
    };
  }

  revoquer() {
    if (this.lien) this._fermer(this.lien, 4003, 'agent révoqué');
  }
}

module.exports = { Hub, ErreurHub };
