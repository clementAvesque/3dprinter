'use strict';
// API publique /api/v1 (Express) : le site en ligne lit l'état gardé par le serveur et agit sur les
// machines à travers l'agent (hub). Routes décrites dans le cahier des charges.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Busboy = require('busboy');
const S = require('./securite');
const { COMMANDES, valider, definition, verifierValeur, TYPES } = require('./protocole');
const { creerAuth, EMAIL_RE, asynchrone } = require('./auth');
const { ErreurHub } = require('./hub');
const { creerClients } = require('./clients');
const { creerBoutique } = require('./boutique');
const { creerCourriel } = require('./courriel');
const { creerPaiements } = require('./paiements');

const ROLES = ['lecteur', 'operateur', 'admin'];

function creerApi({ config, db, hub, journal, courriel = creerCourriel(config), paiements = creerPaiements(config) }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.api.trustProxy);
  // vraie IP du visiteur fournie par l'hébergeur : sert aux limites de débit et au journal d'audit.
  // Sans elle, derrière Fly, tout le monde aurait la même IP (celle du proxy) et partagerait les limites.
  if (config.api.enteteIpClient) {
    app.use((req, res, next) => {
      const ip = String(req.headers[config.api.enteteIpClient] || '').trim();
      if (/^[0-9a-fA-F.:]{3,45}$/.test(ip)) Object.defineProperty(req, 'ip', { value: ip, configurable: true });
      next();
    });
  }
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      // le site (dossier site/) ne charge que ses propres fichiers : aucun script ni style venu d'ailleurs
      directives: {
        'img-src': ["'self'", 'data:', 'blob:'], 'frame-ancestors': ["'none'"], 'connect-src': ["'self'"],
        'script-src': ["'self'"], 'style-src': ["'self'"], 'font-src': ["'self'"], 'form-action': ["'self'"],
        // en local (http://localhost) : ne pas forcer https sur les fichiers du site
        ...(config.api.cookieSecure ? {} : { 'upgrade-insecure-requests': null }),
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  }));

  // site sur un autre domaine : seul celui-là, avec cookies
  if (config.api.origineSite) {
    app.use((req, res, next) => {
      if (req.headers.origin === config.api.origineSite) {
        res.set({ 'Access-Control-Allow-Origin': config.api.origineSite, 'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE',
          Vary: 'Origin' });
        if (req.method === 'OPTIONS') return res.sendStatus(204);
      }
      next();
    });
  }

  const auth = creerAuth({ db, config, journal });
  const { exige, confirme } = auth;
  const clients = creerClients({ db, config, journal, courriel });
  const boutique = creerBoutique({ config, db, hub, journal, courriel, paiements, clients, exige, confirme });
  app.locals.boutique = boutique;
  app.locals.courriel = courriel;
  // vérification de santé de l'hébergeur : ne révèle rien (ni état de l'agent, ni version)
  app.get('/sante', (req, res) => res.json({ ok: true }));
  const api = express.Router();
  api.use(express.json({ limit: '64kb', strict: true }));
  api.use(auth.charger);
  api.use(auth.csrf);
  api.use(rateLimit({
    windowMs: 60e3, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (req) => (req.user ? `u${req.user.id}` : req.ip),
    // flux longs (temps réel, vidéo, téléchargement) : ne comptent qu'à l'ouverture
    message: { erreur: 'trop_de_requetes', detail: '120 requêtes par minute maximum' },
  }));
  api.use(auth.routes);

  const cache = path.join(config.donnees, 'cache');
  const uploads = path.join(config.donnees, 'uploads');
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(uploads, { recursive: true });

  // ------------------------------------------------------------ outils

  const erreur = (res, e) => {
    if (res.headersSent) return res.destroy();
    if (e instanceof ErreurHub) return res.status(e.statut).json({ erreur: e.code, detail: e.detail || undefined });
    console.error(e);
    return res.status(500).json({ erreur: 'erreur_interne' });
  };

  const repondre = (res, r) => (r.ok ? res.json({ ok: true, resultat: r.resultat })
    : res.status(409).json({ erreur: r.erreur || 'refuse_par_la_machine', detail: r.detail || undefined }));

  function machineConnue(req, res, next) {
    if (!hub.machine(req.params.m)) {
      return hub.lien ? res.status(404).json({ erreur: 'machine_inconnue' })
        : res.status(503).json({ erreur: 'agent_hors_ligne', detail: 'l\'agent n\'est pas connecté' });
    }
    next();
  }

  const qui = (req) => req.user?.email || null;

  // commande de la liste fermée : rôle et confirmation lus dans le protocole commun
  function commande(methode, chemin, action, extraire = (req) => req.body || {}) {
    const def = COMMANDES[action];
    const chaine = [exige(def.role), machineConnue];
    if (def.confirmation) chaine.push(confirme);
    api[methode](chemin, ...chaine, asynchrone(async (req, res) => {
      const params = extraire(req);
      const cible = `${req.params.m} ${action}`;
      if (def.longue) {
        const v = valider(action, params);
        if (v.erreur) return res.status(400).json({ erreur: 'parametres', detail: v.champ ? `${v.champ} : ${v.erreur}` : v.erreur });
        const op = hub.operation(req.params.m, action, params, {
          user: qui(req),
          apres: (o) => journal('commande', { req, cible, resultat: o.statut, detail: o.detail || o.erreur }),
        });
        return res.status(202).json({ operation: op.id });
      }
      try {
        const r = await hub.commande(req.params.m, action, params, { user: qui(req) });
        journal('commande', { req, cible, resultat: r.ok ? 'ok' : 'refuse', detail: r.detail || r.erreur });
        repondre(res, r);
      } catch (e) {
        journal('commande', { req, cible, resultat: 'erreur', detail: e.code || e.message });
        erreur(res, e);
      }
    }));
  }

  // ------------------------------------------------------------ machines et temps réel

  api.get('/machines', exige('lecteur'), (req, res) => {
    res.json({ agent: hub.statut(), machines: [...hub.machines.values()].map((m) => ({
      id: m.id, nom: m.nom, enLigne: m.enLigne && !!hub.lien, etat: m.etat?.state ?? null, maj: m.recu || null,
    })) });
  });

  api.get('/machines/:m', exige('lecteur'), machineConnue, (req, res) => {
    const m = hub.machine(req.params.m);
    res.json({ id: m.id, nom: m.nom, enLigne: m.enLigne && !!hub.lien, maj: m.recu || null, etat: m.etat });
  });

  api.get('/operations/:id', exige('lecteur'), (req, res) => {
    const op = hub.operations.get(String(req.params.id));
    if (!op) return res.status(404).json({ erreur: 'operation_inconnue' });
    res.json(op);
  });

  // flux temps réel (Server-Sent Events) : état des machines, agent, opérations, fichiers
  api.get('/events', exige('lecteur'), (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no' });
    const envoyer = (nom, donnees) => res.write(`event: ${nom}\ndata: ${JSON.stringify(donnees)}\n\n`);
    envoyer('agent', hub.statut());
    for (const m of hub.machines.values()) if (m.etat) envoyer('etat', { machine: m.id, donnees: m.etat });
    const surEvenement = (e) => envoyer(e.nom, { machine: e.machine, donnees: e.donnees });
    const surAgent = (s) => envoyer('agent', s);
    const surOperation = (op) => envoyer('operation', op);
    hub.on('evenement', surEvenement);
    hub.on('agent', surAgent);
    hub.on('operation', surOperation);
    const session = req.session.id;
    const battement = setInterval(() => {
      // la session expire (inactivité, déconnexion) : le flux s'arrête aussi
      if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(session)) return res.end();
      res.write(': battement\n\n');
    }, 20e3);
    req.on('close', () => {
      clearInterval(battement);
      hub.off('evenement', surEvenement);
      hub.off('agent', surAgent);
      hub.off('operation', surOperation);
    });
  });

  api.get('/machines/:m/temperatures', exige('lecteur'), machineConnue, (req, res) => {
    res.json(hub.machine(req.params.m).temperatures);
  });

  // ------------------------------------------------------------ commandes

  commande('post', '/machines/:m/print', 'print.start');
  commande('post', '/machines/:m/print/pause', 'print.pause');
  commande('post', '/machines/:m/print/resume', 'print.resume');
  commande('post', '/machines/:m/print/cancel', 'print.cancel');
  commande('put', '/machines/:m/speed', 'print.speed');
  commande('put', '/machines/:m/flow', 'print.flow');
  commande('put', '/machines/:m/temperature', 'temperature.set');
  commande('post', '/machines/:m/home', 'move.home');
  commande('post', '/machines/:m/move', 'move.jog');
  commande('post', '/machines/:m/motors/off', 'motors.off');
  commande('put', '/machines/:m/fan', 'fan.set');
  commande('put', '/machines/:m/light', 'light.set');
  commande('post', '/machines/:m/filament/load', 'filament.load');
  commande('post', '/machines/:m/filament/unload', 'filament.unload');
  commande('post', '/machines/:m/ace/dry', 'ace.dry.start');
  commande('delete', '/machines/:m/ace/dry', 'ace.dry.stop');
  commande('post', '/machines/:m/gcode', 'gcode.raw');
  commande('post', '/machines/:m/files/sync', 'files.sync');
  commande('post', '/machines/:m/recordings/start', 'record.start');
  commande('post', '/machines/:m/recordings/stop', 'record.stop');
  commande('put', '/machines/:m/recordings/auto', 'record.auto');

  api.get('/machines/:m/recordings', exige('lecteur'), machineConnue, asynchrone(async (req, res) => {
    try {
      const r = await hub.commande(req.params.m, 'record.list', {}, { user: qui(req) });
      if (!r.ok) return repondre(res, r);
      res.json(r.resultat);
    } catch (e) { erreur(res, e); }
  }));

  api.get('/machines/:m/recordings/auto', exige('lecteur'), machineConnue, (req, res) => {
    res.json(hub.machine(req.params.m).etat?.auto_record ?? null);
  });

  api.get('/machines/:m/history', exige('lecteur'), machineConnue, asynchrone(async (req, res) => {
    const m = hub.machine(req.params.m);
    if (m.historique && Date.now() - m.historique.t < 30e3) return res.json(m.historique.liste);
    try {
      const r = await hub.commande(m.id, 'history.machine', {}, { user: qui(req) });
      if (!r.ok) return repondre(res, r);
      m.historique = { t: Date.now(), liste: r.resultat };
      res.json(r.resultat);
    } catch (e) { erreur(res, e); }
  }));

  // ------------------------------------------------------------ fichiers

  const nomValide = (nom) => !verifierValeur(definition({ type: 'fichier' }), nom);

  api.get('/machines/:m/files', exige('lecteur'), machineConnue, asynchrone(async (req, res) => {
    const m = hub.machine(req.params.m);
    if (m.fichiers && req.query.rafraichir !== '1') return res.json(m.fichiers);
    try {
      const r = await hub.rafraichirFichiers(m.id);
      if (r.ok) return res.json(r.resultat);
      repondre(res, r);
    } catch (e) { erreur(res, e); }
  }));

  // envoi d'un gcode : reçu ici (200 Mo max), vérifié, puis transmis à l'agent par morceaux
  api.post('/machines/:m/files', exige('operateur'), machineConnue, (req, res) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 1, fields: 0, fileSize: config.uploadMaxOctets, parts: 1 } });
    } catch {
      return res.status(400).json({ erreur: 'multipart_attendu' });
    }
    let recu = false;
    bb.on('file', (champ, flux, info) => {
      recu = true;
      const nom = String(info.filename || '').split(/[\\/]/).pop();
      if (champ !== 'file' || !nomValide(nom)) {
        flux.resume();
        return res.status(400).json({ erreur: 'nom_de_fichier_refuse', detail: '.gcode, .g ou .gco, sans chemin' });
      }
      const transfert = crypto.randomBytes(12).toString('base64url');
      const chemin = path.join(uploads, `${transfert}.part`);
      const hash = crypto.createHash('sha256');
      let taille = 0;
      const sortie = fs.createWriteStream(chemin, { flags: 'wx' });
      flux.on('data', (d) => { hash.update(d); taille += d.length; });
      flux.pipe(sortie);
      const nettoyer = () => fs.promises.unlink(chemin).catch(() => {});
      flux.on('limit', () => {
        flux.unpipe(sortie); sortie.destroy(); nettoyer();
        if (!res.headersSent) res.status(413).json({ erreur: 'fichier_trop_gros', detail: `${config.uploadMaxOctets / 1048576} Mo max` });
      });
      sortie.on('finish', () => {
        if (res.headersSent) return nettoyer();
        if (!taille) { nettoyer(); return res.status(400).json({ erreur: 'fichier_vide' }); }
        const params = { fichier: nom, taille, sha256: hash.digest('hex'), transfert };
        const v = valider('file.upload', params);
        if (v.erreur) { nettoyer(); return res.status(400).json({ erreur: 'parametres', detail: v.erreur }); }
        const op = hub.operation(req.params.m, 'file.upload', params, {
          user: qui(req),
          envoi: (c) => hub.envoyerFichier(c, chemin, transfert),
          apres: (o) => {
            nettoyer();
            journal('fichier.envoi', { req, cible: `${req.params.m} ${nom}`, resultat: o.statut, detail: o.detail || `${taille} octets` });
            if (o.statut === 'ok') hub.rafraichirFichiers(req.params.m).catch(() => {});
          },
        });
        res.status(202).json({ operation: op.id });
      });
      sortie.on('error', () => { nettoyer(); if (!res.headersSent) res.status(500).json({ erreur: 'ecriture_impossible' }); });
    });
    bb.on('close', () => { if (!recu && !res.headersSent) res.status(400).json({ erreur: 'aucun_fichier' }); });
    bb.on('error', () => { if (!res.headersSent) res.status(400).json({ erreur: 'multipart_invalide' }); });
    req.pipe(bb);
  });

  // cache local des miniatures et aperçus 3D : clé = machine + nom + taille du fichier
  function cleCache(m, nom, suffixe) {
    const f = (m.fichiers || []).find((x) => x.nom === nom);
    return path.join(cache, crypto.createHash('sha1').update(`${m.id}|${nom}|${f?.taille_octets ?? '?'}`).digest('hex') + suffixe);
  }

  async function obtenir(req, m, nom, action, suffixeBin, suffixeMeta) {
    const bin = cleCache(m, nom, suffixeBin);
    const meta = suffixeMeta && cleCache(m, nom, suffixeMeta);
    if (fs.existsSync(bin) && (!meta || fs.existsSync(meta))) return { bin, meta };
    const r = await hub.commande(m.id, action, { fichier: nom }, { user: qui(req) });
    if (!r.ok) return { r };
    let octets = r.octets || Buffer.alloc(0), resultat = r.resultat;
    // aperçu 3D d'un gros plateau : l'agent joint la description des couches au transfert, devant les segments
    // (trop grosse pour sa réponse JSON). resultat.meta_jointe = sa taille en octets.
    const jointe = resultat?.meta_jointe;
    if (meta && jointe !== undefined) {
      if (!Number.isInteger(jointe) || jointe < 2 || jointe > octets.length) {
        throw new ErreurHub(502, 'apercu_invalide', 'description de l\'aperçu jointe invalide');
      }
      try { resultat = JSON.parse(octets.subarray(0, jointe).toString('utf8')); } catch {
        throw new ErreurHub(502, 'apercu_invalide', 'description de l\'aperçu illisible');
      }
      octets = octets.subarray(jointe);
    }
    await fs.promises.writeFile(bin, octets);
    if (meta) await fs.promises.writeFile(meta, JSON.stringify(resultat));
    else await fs.promises.writeFile(`${bin}.mime`, r.mime || 'image/png');
    return { bin, meta };
  }

  // /machines/:m/files/<nom avec sous-dossiers>[/thumbnail | /toolpath | /toolpath-bin]
  api.get('/machines/:m/files/*', exige('lecteur'), machineConnue, asynchrone(async (req, res) => {
    const m = hub.machine(req.params.m);
    const suite = String(req.params[0]);
    const quoi = ['thumbnail', 'toolpath', 'toolpath-bin'].find((s) => suite.endsWith(`/${s}`));
    const nom = quoi ? suite.slice(0, -(quoi.length + 1)) : null;
    if (!quoi || !nomValide(nom)) return res.status(404).json({ erreur: 'route_inconnue' });
    try {
      if (quoi === 'thumbnail') {
        const o = await obtenir(req, m, nom, 'file.thumbnail', '.img');
        if (o.r) return repondre(res, o.r);
        // no-cache : le navigateur garde une copie mais la revalide (ETag) à chaque fois. Un même nom de fichier
        // peut désigner un autre gcode (fichier remplacé) : une copie gardée 1 h sans vérifier était fausse.
        res.set({ 'Content-Type': fs.readFileSync(`${o.bin}.mime`, 'utf8'), 'Cache-Control': 'private, no-cache' });
        return res.sendFile(o.bin);
      }
      const o = await obtenir(req, m, nom, 'file.toolpath', '.bin', '.json');
      if (o.r) return repondre(res, o.r);
      res.set('Cache-Control', 'private, no-cache');
      if (quoi === 'toolpath') return res.type('application/json').sendFile(o.meta);
      res.set('Content-Type', 'application/octet-stream');
      return res.sendFile(o.bin);
    } catch (e) { erreur(res, e); }
  }));

  api.delete('/machines/:m/files/*', exige(COMMANDES['file.delete'].role), machineConnue, confirme, asynchrone(async (req, res) => {
    const nom = String(req.params[0]);
    if (!nomValide(nom)) return res.status(400).json({ erreur: 'nom_de_fichier_refuse' });
    try {
      const r = await hub.commande(req.params.m, 'file.delete', { fichier: nom }, { user: qui(req) });
      journal('commande', { req, cible: `${req.params.m} file.delete ${nom}`, resultat: r.ok ? 'ok' : 'refuse', detail: r.detail || r.erreur });
      if (r.ok) hub.rafraichirFichiers(req.params.m).catch(() => {});
      repondre(res, r);
    } catch (e) { erreur(res, e); }
  }));

  // ------------------------------------------------------------ caméra et vidéos

  api.get('/machines/:m/camera/snapshot', exige('lecteur'), machineConnue, asynchrone(async (req, res) => {
    try {
      const r = await hub.commande(req.params.m, 'camera.snapshot', {}, { user: qui(req) });
      if (!r.ok) return repondre(res, r);
      res.set({ 'Content-Type': r.mime || 'image/jpeg', 'Cache-Control': 'no-store' }).send(r.octets);
    } catch (e) { erreur(res, e); }
  }));

  // flux vidéo en direct (MJPEG) : l'agent n'envoie des images que tant qu'au moins une page regarde
  api.get('/machines/:m/camera/stream', exige('lecteur'), machineConnue, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=image', 'Cache-Control': 'no-store',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const retirer = hub.ajouterSpectateur(req.params.m, (jpeg) => {
      if (res.writableLength > 2 * 1024 * 1024) return;   // spectateur trop lent : on saute des images
      res.write(`--image\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      res.write(jpeg);
      res.write('\r\n');
    });
    const session = req.session.id;
    const controle = setInterval(() => {
      if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(session)) res.end();
    }, 60e3);
    req.on('close', () => { clearInterval(controle); retirer(); });
  });

  const nomVideo = (nom) => !verifierValeur(TYPES.video, nom);

  api.get('/machines/:m/recordings/:nom', exige('lecteur'), machineConnue, asynchrone(async (req, res) => {
    const nom = String(req.params.nom);
    if (!nomVideo(nom)) return res.status(400).json({ erreur: 'nom_refuse' });
    try {
      const r = await hub.commande(req.params.m, 'record.download', { nom }, {
        user: qui(req),
        sink: res,
        debut: (rep, t) => res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': t.taille,
          'Content-Disposition': `${req.query.telecharger === '1' ? 'attachment' : 'inline'}; filename="${nom}"`,
          'Cache-Control': 'private, no-store' }),
      });
      if (!r.ok && !res.headersSent) repondre(res, r);
    } catch (e) { erreur(res, e); }
  }));

  api.delete('/machines/:m/recordings/:nom', exige(COMMANDES['record.delete'].role), machineConnue, confirme, asynchrone(async (req, res) => {
    const nom = String(req.params.nom);
    if (!nomVideo(nom)) return res.status(400).json({ erreur: 'nom_refuse' });
    try {
      const r = await hub.commande(req.params.m, 'record.delete', { nom }, { user: qui(req) });
      journal('commande', { req, cible: `${req.params.m} record.delete ${nom}`, resultat: r.ok ? 'ok' : 'refuse' });
      repondre(res, r);
    } catch (e) { erreur(res, e); }
  }));

  // ------------------------------------------------------------ comptes (admin)

  const sansSecret = (u) => ({ id: u.id, email: u.email, nom: u.nom, role: u.role, actif: !!u.actif, cree: u.cree });

  api.get('/users', exige('admin'), (req, res) => {
    res.json(db.prepare('SELECT * FROM utilisateurs ORDER BY id').all().map(sansSecret));
  });

  api.post('/users', exige('admin'), confirme, asynchrone(async (req, res) => {
    const { email, nom, role, motdepasse, ...reste } = req.body || {};
    if (Object.keys(reste).length) return res.status(400).json({ erreur: 'champ_inconnu' });
    if (typeof email !== 'string' || !EMAIL_RE.test(email)) return res.status(400).json({ erreur: 'email_invalide' });
    if (typeof nom !== 'string' || !nom.trim() || nom.length > 80) return res.status(400).json({ erreur: 'nom_invalide' });
    if (!ROLES.includes(role)) return res.status(400).json({ erreur: 'role_invalide' });
    const err = S.politiqueMotDePasse(motdepasse);
    if (err) return res.status(400).json({ erreur: 'mot_de_passe_refuse', detail: err });
    if (db.prepare('SELECT 1 FROM utilisateurs WHERE email = ?').get(email)) return res.status(409).json({ erreur: 'email_deja_utilise' });
    const secret = S.nouveauSecretTotp();
    const codes = S.codesSecours();
    const { lastInsertRowid } = db.prepare(`INSERT INTO utilisateurs (email, nom, role, hash, totp_secret, codes_secours, cree)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(email, nom.trim(), role, await S.hacher(motdepasse), secret,
      JSON.stringify(codes.map((c) => S.sha256(c))), Date.now());
    journal('users.creer', { req, cible: email, resultat: 'ok', detail: role });
    res.status(201).json({ utilisateur: sansSecret(db.prepare('SELECT * FROM utilisateurs WHERE id = ?').get(lastInsertRowid)),
      totp: { secret, url: S.urlTotp(email, secret) }, codes_secours: codes });
  }));

  api.patch('/users/:id', exige('admin'), confirme, (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM utilisateurs WHERE id = ?').get(id);
    if (!u) return res.status(404).json({ erreur: 'utilisateur_inconnu' });
    const { nom, role, actif, ...reste } = req.body || {};
    if (Object.keys(reste).length) return res.status(400).json({ erreur: 'champ_inconnu' });
    if (id === req.user.id && (role !== undefined || actif !== undefined)) {
      return res.status(400).json({ erreur: 'impossible_sur_soi', detail: 'un admin ne change ni son rôle ni son activation' });
    }
    if (nom !== undefined && (typeof nom !== 'string' || !nom.trim() || nom.length > 80)) return res.status(400).json({ erreur: 'nom_invalide' });
    if (role !== undefined && !ROLES.includes(role)) return res.status(400).json({ erreur: 'role_invalide' });
    if (actif !== undefined && typeof actif !== 'boolean') return res.status(400).json({ erreur: 'actif_invalide' });
    db.prepare('UPDATE utilisateurs SET nom = ?, role = ?, actif = ? WHERE id = ?')
      .run(nom?.trim() ?? u.nom, role ?? u.role, actif === undefined ? u.actif : Number(actif), id);
    if (actif === false || (role && role !== u.role)) auth.toutesSessions.run(id);   // reconnexion obligatoire
    journal('users.modifier', { req, cible: u.email, resultat: 'ok', detail: JSON.stringify({ role, actif }) });
    res.json(sansSecret(db.prepare('SELECT * FROM utilisateurs WHERE id = ?').get(id)));
  });

  api.delete('/users/:id', exige('admin'), confirme, (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ erreur: 'impossible_sur_soi' });
    const u = db.prepare('SELECT email FROM utilisateurs WHERE id = ?').get(id);
    if (!u) return res.status(404).json({ erreur: 'utilisateur_inconnu' });
    db.prepare('DELETE FROM utilisateurs WHERE id = ?').run(id);
    journal('users.supprimer', { req, cible: u.email, resultat: 'ok' });
    res.json({ ok: true });
  });

  api.post('/users/:id/reinitialiser-2fa', exige('admin'), confirme, (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT email FROM utilisateurs WHERE id = ?').get(id);
    if (!u) return res.status(404).json({ erreur: 'utilisateur_inconnu' });
    const secret = S.nouveauSecretTotp();
    const codes = S.codesSecours();
    db.prepare('UPDATE utilisateurs SET totp_secret = ?, totp_dernier = 0, codes_secours = ? WHERE id = ?')
      .run(secret, JSON.stringify(codes.map((c) => S.sha256(c))), id);
    auth.toutesSessions.run(id);
    journal('users.reinitialiser_2fa', { req, cible: u.email, resultat: 'ok' });
    res.json({ totp: { secret, url: S.urlTotp(u.email, secret) }, codes_secours: codes });
  });

  api.get('/audit', exige('admin'), (req, res) => {
    const limite = Math.min(500, Math.max(1, Number(req.query.limite) || 100));
    const avant = Number(req.query.avant) || Number.MAX_SAFE_INTEGER;
    res.json(db.prepare(`SELECT a.*, u.email FROM audit a LEFT JOIN utilisateurs u ON u.id = a.user_id
      WHERE a.id < ? ORDER BY a.id DESC LIMIT ?`).all(avant, limite));
  });

  // ------------------------------------------------------------ agent (admin)

  api.get('/agent', exige('admin'), (req, res) => {
    const a = db.prepare('SELECT id, revoque, enrole, cle_publique FROM agent WHERE id = ?').get(config.agent.id);
    res.json({ ...hub.statut(), id: config.agent.id, enrole: a ? a.enrole : null, revoque: a ? !!a.revoque : null,
      empreinte_cle: a ? S.sha256(a.cle_publique).slice(0, 16) : null });
  });

  api.post('/agent/revoke', exige('admin'), confirme, (req, res) => {
    db.prepare('UPDATE agent SET revoque = 1 WHERE id = ?').run(config.agent.id);
    hub.revoquer();
    journal('agent.revoquer', { req, cible: config.agent.id, resultat: 'ok' });
    res.json({ ok: true });
  });

  api.post('/agent/enroll', exige('admin'), confirme, (req, res) => {
    const pem = req.body?.cle_publique;
    let cle;
    try { cle = typeof pem === 'string' && pem.length < 1000 && crypto.createPublicKey(pem); } catch { cle = null; }
    if (!cle || cle.asymmetricKeyType !== 'ed25519') return res.status(400).json({ erreur: 'cle_invalide', detail: 'clé publique Ed25519 (PEM) attendue' });
    const propre = cle.export({ type: 'spki', format: 'pem' });
    db.prepare(`INSERT INTO agent (id, cle_publique, revoque, enrole) VALUES (?, ?, 0, ?)
      ON CONFLICT(id) DO UPDATE SET cle_publique = excluded.cle_publique, revoque = 0, enrole = excluded.enrole`)
      .run(config.agent.id, propre, Date.now());
    hub.revoquer();      // l'agent connecté avec l'ancienne clé doit se réauthentifier
    journal('agent.enroler', { req, cible: config.agent.id, resultat: 'ok', detail: S.sha256(propre).slice(0, 16) });
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ boutique (admin)

  api.use('/boutique', boutique.routesAdmin);

  // ------------------------------------------------------------ fin

  api.use((req, res) => res.status(404).json({ erreur: 'route_inconnue' }));
  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ erreur: 'json_invalide' });
    if (err.type === 'entity.too.large') return res.status(413).json({ erreur: 'requete_trop_grosse' });
    console.error(err);
    if (!res.headersSent) res.status(500).json({ erreur: 'erreur_interne' });
  });

  app.use('/api/v1', api);

  // ------------------------------------------------------------ API du site client (/api/client)
  // comptes clients séparés des comptes admin : autre cookie, autres sessions, aucune route admin ici

  const cl = express.Router();
  cl.use(express.json({ limit: '64kb', strict: true }));
  cl.use(clients.charger);
  cl.use(clients.csrf);
  cl.use(rateLimit({
    windowMs: 60e3, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (req) => (req.client ? `c${req.client.id}` : req.ip),
    message: { erreur: 'trop_de_requetes', detail: '120 requêtes par minute maximum' },
  }));
  cl.use(clients.routes);
  cl.use(boutique.routesClient);
  cl.use((req, res) => res.status(404).json({ erreur: 'route_inconnue' }));
  // eslint-disable-next-line no-unused-vars
  cl.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ erreur: 'json_invalide' });
    if (err.type === 'entity.too.large') return res.status(413).json({ erreur: 'requete_trop_grosse' });
    if (err.code === 'COURRIEL') {
      // service d'e-mails en panne ou mal réglé (clé, expéditeur) : le détail reste dans les logs
      console.error(`[courriel] ${err.message}`);
      return res.headersSent ? undefined : res.status(503).json({ erreur: 'courriel_indisponible' });
    }
    console.error(err);
    if (!res.headersSent) res.status(500).json({ erreur: 'erreur_interne' });
  });
  app.use('/api/client', cl);

  // webhooks Stripe : corps brut (la signature porte sur les octets exacts), aucune session ni CSRF :
  // seule la signature HMAC (secret partagé avec Stripe) fait foi
  app.post('/api/stripe/webhook', express.raw({ type: '*/*', limit: '512kb' }), asynchrone(boutique.webhookStripe));

  // tâches de la boutique toutes les heures (purges, rappels, remboursements automatiques)
  const tache = () => boutique.tacheHoraire().catch((e) => console.error('tâche boutique :', e));
  setTimeout(tache, 60e3).unref();
  setInterval(tache, 3600e3).unref();

  // ------------------------------------------------------------ site client (web_printer_user/front/dist)
  // servi à la même adresse que l'API : les liens des e-mails (/verifier, /reinitialiser) y mènent

  const site = config.siteClient;
  if (site && fs.existsSync(path.join(site, 'index.html'))) {
    // fichiers de build au nom unique (hash) : gardés en cache un an ; le reste revalidé à chaque fois
    app.use('/assets', express.static(path.join(site, 'assets'), { immutable: true, maxAge: '365d' }));
    app.use(express.static(site, { index: false, maxAge: 0 }));
    // pages de l'application (/verifier, /compte, /devis/12...) : index.html, le routeur Vue fait le reste.
    // Pas pour l'API, ni pour un fichier absent (extension) : ceux-là restent des 404.
    app.get(/^(?!\/api\/|\/sante$)[^.]*$/, (req, res) => {
      res.set('Cache-Control', 'no-cache').sendFile(path.join(site, 'index.html'));
    });
  } else if (site) {
    console.warn(`site client absent (${site}) : seule l'API est servie`);
  }

  app.use((req, res) => res.status(404).json({ erreur: 'route_inconnue' }));
  return app;
}

module.exports = { creerApi };
