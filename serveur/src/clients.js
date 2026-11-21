'use strict';
// Comptes clients du site public (/api/client) : inscription, vérification de l'e-mail, connexion,
// mot de passe oublié (lien éphémère à usage unique), sessions.
// Totalement séparé des comptes admin : autre table, autre cookie, autres sessions.

const express = require('express');
const rateLimit = require('express-rate-limit');
const S = require('./securite');
const { EMAIL_RE, asynchrone } = require('./auth');

const JETON_DUREE = { verification: 48 * 3600e3, mot_de_passe: 30 * 60e3 };

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function creerClients({ db, config, journal, courriel }) {
  const C = config.boutique.session;
  const NOM = config.api.cookieSecure ? '__Host-client' : 'client';
  const URL_SITE = config.boutique.urlSite.replace(/\/+$/, '');

  const q = {
    session: db.prepare(`SELECT s.*, c.email, c.nom, c.email_verifie, c.actif FROM sessions_client s
                         JOIN clients c ON c.id = s.client_id WHERE s.id = ?`),
    vu: db.prepare('UPDATE sessions_client SET vu_le = ? WHERE id = ?'),
    supprimer: db.prepare('DELETE FROM sessions_client WHERE id = ?'),
    creer: db.prepare(`INSERT INTO sessions_client (id, client_id, csrf, cree_le, vu_le, ip, agent_nav)
                       VALUES (?, ?, ?, ?, ?, ?, ?)`),
    toutes: db.prepare('DELETE FROM sessions_client WHERE client_id = ?'),
    autres: db.prepare('DELETE FROM sessions_client WHERE client_id = ? AND id != ?'),
    parEmail: db.prepare('SELECT * FROM clients WHERE email = ?'),
    parId: db.prepare('SELECT * FROM clients WHERE id = ?'),
    creerClient: db.prepare('INSERT INTO clients (email, hash, nom, email_verifie, actif, cree_le) VALUES (?, ?, ?, 0, 1, ?)'),
    jeton: db.prepare('SELECT * FROM jetons_email WHERE id = ? AND type = ?'),
    creerJeton: db.prepare('INSERT INTO jetons_email (id, client_id, type, cree_le, expire_le) VALUES (?, ?, ?, ?, ?)'),
    jetonUtilise: db.prepare('UPDATE jetons_email SET utilise_le = ? WHERE id = ?'),
    // un nouveau lien (bien envoyé) annule les précédents du même type
    annulerJetons: db.prepare('UPDATE jetons_email SET utilise_le = ? WHERE client_id = ? AND type = ? AND utilise_le IS NULL AND id != ?'),
    supprimerJeton: db.prepare('DELETE FROM jetons_email WHERE id = ?'),
    recents: db.prepare('SELECT count(*) n FROM jetons_email WHERE client_id = ? AND type = ? AND cree_le > ?'),
  };

  function poserCookie(res, jeton, maxAgeS) {
    res.append('Set-Cookie', `${NOM}=${jeton}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}`
      + (config.api.cookieSecure ? '; Secure' : ''));
  }

  function ouvrirSession(req, res, client) {
    const jeton = S.jeton(32);
    const now = Date.now();
    const s = { id: S.sha256(jeton), csrf: S.jeton(24) };
    q.creer.run(s.id, client.id, s.csrf, now, now, req.ip, String(req.headers['user-agent'] || '').slice(0, 200));
    poserCookie(res, jeton, Math.floor(C.dureeMaxMs / 1000));
    return s;
  }

  const public_ = (c) => ({ id: c.id, email: c.email, nom: c.nom, email_verifie: !!c.email_verifie });

  // envoie un lien à usage unique ; seule l'empreinte du jeton est gardée en base
  async function envoyerLien(client, type) {
    const now = Date.now();
    // pas plus de 3 liens du même type par heure et par compte (évite d'inonder une boîte)
    if (q.recents.get(client.id, type, now - 3600e3).n >= 3) return;
    const jeton = S.jeton(32);
    const id = S.sha256(jeton);
    q.creerJeton.run(id, client.id, type, now, now + JETON_DUREE[type]);
    try {
      if (type === 'verification') {
        await courriel.envoyer({ a: client.email, sujet: 'Confirme ton adresse e-mail',
          texte: `Bonjour ${client.nom},\n\nPour activer ton compte, ouvre ce lien (valable 48 h) :\n`
            + `${URL_SITE}/verifier?jeton=${jeton}\n\nSi tu n'as pas créé de compte, ignore ce message.` });
      } else {
        await courriel.envoyer({ a: client.email, sujet: 'Réinitialiser ton mot de passe',
          texte: `Bonjour ${client.nom},\n\nPour choisir un nouveau mot de passe, ouvre ce lien (valable 30 min, une seule fois) :\n`
            + `${URL_SITE}/reinitialiser?jeton=${jeton}\n\nSi tu n'as rien demandé, ignore ce message : ton mot de passe ne change pas.` });
      }
    } catch (e) {
      // e-mail jamais parti : ce lien n'existe pas pour le client, il ne compte pas dans la limite
      // et les liens déjà reçus restent valables
      q.supprimerJeton.run(id);
      throw e;
    }
    q.annulerJetons.run(now, client.id, type, id);
  }

  // consomme un jeton reçu par e-mail ; retourne le client ou null
  function consommerJeton(brut, type) {
    if (typeof brut !== 'string' || brut.length < 20 || brut.length > 100) return null;
    const j = q.jeton.get(S.sha256(brut), type);
    const now = Date.now();
    if (!j || j.utilise_le || j.expire_le < now) return null;
    q.jetonUtilise.run(now, j.id);
    return q.parId.get(j.client_id);
  }

  // ------------------------------------------------------------ middlewares

  function charger(req, res, next) {
    req.client = null;
    req.sessionClient = null;
    const jeton = cookies(req)[NOM];
    if (jeton && jeton.length <= 64) {
      const s = q.session.get(S.sha256(jeton));
      const now = Date.now();
      if (s) {
        if (!s.actif || now - s.cree_le > C.dureeMaxMs || now - s.vu_le > C.inactiviteMs) {
          q.supprimer.run(s.id);
        } else {
          if (now - s.vu_le > 60e3) q.vu.run(now, s.id);
          req.sessionClient = s;
          req.client = { id: s.client_id, email: s.email, nom: s.nom, email_verifie: !!s.email_verifie };
        }
      }
    }
    next();
  }

  // routes qui ne demandent pas de session (formulaires publics) : origine vérifiée seulement
  const PUBLIQUES = new Set(['/inscription', '/connexion', '/verifier', '/verification/renvoyer',
    '/mot-de-passe/oubli', '/mot-de-passe/reinitialiser']);

  function csrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origine = req.headers.origin;
    if (origine) {
      const hote = `${req.protocol}://${req.headers.host}`;
      if (origine !== hote && origine !== config.api.origineSite) return res.status(403).json({ erreur: 'origine_refusee' });
    }
    if (PUBLIQUES.has(req.path)) return next();
    if (!req.sessionClient) return res.status(401).json({ erreur: 'non_connecte' });
    if (!S.egal(req.headers['x-csrf-token'] || '', req.sessionClient.csrf)) {
      return res.status(403).json({ erreur: 'csrf', detail: 'en-tête X-CSRF-Token manquant ou invalide' });
    }
    next();
  }

  const connecte = (req, res, next) => (req.client ? next() : res.status(401).json({ erreur: 'non_connecte' }));
  const verifie = (req, res, next) => {
    if (!req.client) return res.status(401).json({ erreur: 'non_connecte' });
    if (!req.client.email_verifie) return res.status(403).json({ erreur: 'email_non_verifie' });
    next();
  };

  // ------------------------------------------------------------ routes

  // routes qui répondent pareil qu'un compte existe ou non : un échec d'envoi ne doit pas le trahir
  // (une erreur 503 dirait « ce compte existe ») ; il est seulement écrit dans les logs
  async function sansReveler(envoi, email) {
    try {
      await envoi;
      return true;
    } catch (e) {
      if (e.code !== 'COURRIEL') throw e;
      console.error(`[courriel] ${e.message}`);
      journal('courriel.erreur', { cible: email, resultat: 'erreur', detail: e.message });
      return false;
    }
  }

  const r = express.Router();
  const limite = (n, fenetreMin, cle) => rateLimit({ windowMs: fenetreMin * 60e3, limit: n, keyGenerator: cle,
    standardHeaders: 'draft-7', legacyHeaders: false, message: { erreur: 'trop_de_tentatives', detail: `réessaie dans ${fenetreMin} min` } });
  const parIp = (req) => req.ip;
  const parIpEmail = (req) => `${req.ip}|${String(req.body?.email || '').toLowerCase().slice(0, 200)}`;
  const limiteConnexion = rateLimit({ windowMs: 15 * 60e3, limit: 5, keyGenerator: parIpEmail, skipSuccessfulRequests: true,
    standardHeaders: 'draft-7', legacyHeaders: false, message: { erreur: 'trop_de_tentatives', detail: 'réessaie dans 15 min' } });

  // inscription : la réponse est la même que l'e-mail soit libre ou non (on ne révèle pas qui a un compte) ;
  // le propriétaire d'une adresse déjà inscrite reçoit un e-mail qui le lui dit
  r.post('/inscription', limite(10, 60, parIp), asynchrone(async (req, res) => {
    const { email, motdepasse, nom, ...reste } = req.body || {};
    if (Object.keys(reste).length) return res.status(400).json({ erreur: 'champ_inconnu' });
    if (typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email.trim())) return res.status(400).json({ erreur: 'email_invalide' });
    if (typeof nom !== 'string' || !nom.trim() || nom.length > 80) return res.status(400).json({ erreur: 'nom_invalide' });
    const err = S.politiqueMotDePasse(motdepasse);
    if (err) return res.status(400).json({ erreur: 'mot_de_passe_refuse', detail: err });
    const propre = email.trim();
    const hash = await S.hacher(motdepasse);     // calculé dans tous les cas : même durée de réponse
    const existant = q.parEmail.get(propre);
    if (existant && existant.actif && !existant.email_verifie) {
      // compte jamais confirmé (e-mail perdu, ou envoi en échec la 1re fois) : on renvoie le lien
      await envoyerLien(existant, 'verification');
      journal('client.inscription', { req, cible: propre.slice(0, 100), resultat: 'lien_renvoye' });
    } else if (existant) {
      await courriel.envoyer({ a: existant.email, sujet: 'Tu as déjà un compte',
        texte: `Bonjour ${existant.nom},\n\nQuelqu'un (sans doute toi) a voulu créer un compte avec cette adresse, `
          + `mais tu en as déjà un.\nConnecte-toi, ou choisis un nouveau mot de passe ici : ${URL_SITE}/mot-de-passe-oublie\n` });
      journal('client.inscription', { req, cible: propre.slice(0, 100), resultat: 'deja_inscrit' });
    } else {
      const { lastInsertRowid } = q.creerClient.run(propre, hash, nom.trim(), Date.now());
      await envoyerLien(q.parId.get(lastInsertRowid), 'verification');
      journal('client.inscription', { req, cible: propre.slice(0, 100), resultat: 'ok' });
    }
    res.json({ ok: true, detail: 'un e-mail de confirmation a été envoyé' });
  }));

  r.post('/verification/renvoyer', limite(5, 60, parIp), asynchrone(async (req, res) => {
    const c = typeof req.body?.email === 'string' ? q.parEmail.get(req.body.email.trim()) : null;
    if (c && c.actif && !c.email_verifie) await sansReveler(envoyerLien(c, 'verification'), c.email);
    res.json({ ok: true });
  }));

  // lien de l'e-mail : confirme l'adresse et connecte directement
  r.post('/verifier', limite(20, 15, parIp), (req, res) => {
    const c = consommerJeton(req.body?.jeton, 'verification');
    if (!c || !c.actif) return res.status(400).json({ erreur: 'lien_invalide', detail: 'lien expiré ou déjà utilisé' });
    db.prepare('UPDATE clients SET email_verifie = 1 WHERE id = ?').run(c.id);
    if (req.sessionClient) q.supprimer.run(req.sessionClient.id);
    const s = ouvrirSession(req, res, c);
    journal('client.verification', { req, cible: c.email, resultat: 'ok' });
    res.json({ ok: true, csrf: s.csrf, client: public_({ ...c, email_verifie: 1 }) });
  });

  r.post('/connexion', limite(30, 15, parIp), limiteConnexion, asynchrone(async (req, res) => {
    const { email, motdepasse, ...reste } = req.body || {};
    if (Object.keys(reste).length || typeof email !== 'string' || typeof motdepasse !== 'string'
      || email.length > 254 || motdepasse.length > 256) return res.status(400).json({ erreur: 'requete_invalide' });
    const c = q.parEmail.get(email.trim());
    const ok = c && c.actif ? await S.verifierMdp(c.hash, motdepasse) : await S.verifierFactice(motdepasse);
    if (!ok) {
      journal('client.connexion', { req, cible: email.slice(0, 100), resultat: 'refuse' });
      return res.status(401).json({ erreur: 'identifiants_invalides' });
    }
    if (!c.email_verifie) return res.status(403).json({ erreur: 'email_non_verifie' });
    if (req.sessionClient) q.supprimer.run(req.sessionClient.id);
    const s = ouvrirSession(req, res, c);
    journal('client.connexion', { req, cible: c.email, resultat: 'ok' });
    res.json({ ok: true, csrf: s.csrf, client: public_(c) });
  }));

  r.post('/deconnexion', (req, res) => {
    if (req.sessionClient) q.supprimer.run(req.sessionClient.id);
    poserCookie(res, '', 0);
    res.json({ ok: true });
  });

  // mot de passe oublié : même réponse que l'adresse existe ou non
  r.post('/mot-de-passe/oubli', limite(5, 60, parIp), asynchrone(async (req, res) => {
    const c = typeof req.body?.email === 'string' ? q.parEmail.get(req.body.email.trim()) : null;
    if (c && c.actif) {
      const envoye = await sansReveler(envoyerLien(c, 'mot_de_passe'), c.email);
      journal('client.oubli', { req, cible: c.email, resultat: envoye ? 'ok' : 'erreur_courriel' });
    }
    res.json({ ok: true, detail: 'si un compte existe, un e-mail a été envoyé' });
  }));

  r.post('/mot-de-passe/reinitialiser', limite(10, 15, parIp), asynchrone(async (req, res) => {
    const { jeton, motdepasse } = req.body || {};
    const err = S.politiqueMotDePasse(motdepasse);
    if (err) return res.status(400).json({ erreur: 'mot_de_passe_refuse', detail: err });
    const c = consommerJeton(jeton, 'mot_de_passe');
    if (!c || !c.actif) return res.status(400).json({ erreur: 'lien_invalide', detail: 'lien expiré ou déjà utilisé' });
    // le lien prouve aussi que l'adresse est à lui
    db.prepare('UPDATE clients SET hash = ?, email_verifie = 1 WHERE id = ?').run(await S.hacher(motdepasse), c.id);
    q.toutes.run(c.id);                           // toutes les sessions ouvertes sont fermées
    const s = ouvrirSession(req, res, c);
    journal('client.reinitialisation', { req, cible: c.email, resultat: 'ok' });
    res.json({ ok: true, csrf: s.csrf, client: public_({ ...c, email_verifie: 1 }) });
  }));

  r.get('/moi', connecte, (req, res) => res.json({ client: req.client, csrf: req.sessionClient.csrf }));

  r.patch('/moi/mot-de-passe', connecte, asynchrone(async (req, res) => {
    const { ancien, nouveau } = req.body || {};
    const c = q.parId.get(req.client.id);
    if (typeof ancien !== 'string' || !(await S.verifierMdp(c.hash, ancien))) return res.status(401).json({ erreur: 'ancien_mot_de_passe_invalide' });
    const err = S.politiqueMotDePasse(nouveau);
    if (err) return res.status(400).json({ erreur: 'mot_de_passe_refuse', detail: err });
    db.prepare('UPDATE clients SET hash = ? WHERE id = ?').run(await S.hacher(nouveau), c.id);
    q.autres.run(c.id, req.sessionClient.id);
    journal('client.mot_de_passe', { req, cible: c.email, resultat: 'ok' });
    res.json({ ok: true });
  }));

  const purger = () => {
    const now = Date.now();
    db.prepare('DELETE FROM sessions_client WHERE cree_le < ? OR vu_le < ?').run(now - C.dureeMaxMs, now - C.inactiviteMs);
    db.prepare('DELETE FROM jetons_email WHERE expire_le < ?').run(now - 864e5);
  };

  return { routes: r, charger, csrf, connecte, verifie, purger, NOM };
}

module.exports = { creerClients };
