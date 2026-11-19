'use strict';
// Sessions (cookie HttpOnly / Secure / SameSite=Strict), protection CSRF, rôles, confirmation 2FA,
// et routes /auth et /me.

const express = require('express');
const rateLimit = require('express-rate-limit');
const S = require('./securite');
const { roleSuffit } = require('./protocole');

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,30}$/;

// Express 4 ne rattrape pas les erreurs des fonctions async : on les passe au gestionnaire d'erreurs
const asynchrone = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function creerAuth({ db, config, journal }) {
  const C = config.session;
  const NOM = config.api.cookieSecure ? '__Host-session' : 'session';

  const q = {
    session: db.prepare(`SELECT s.*, u.email, u.nom, u.role, u.actif FROM sessions s
                         JOIN utilisateurs u ON u.id = s.user_id WHERE s.id = ?`),
    vu: db.prepare('UPDATE sessions SET vu = ? WHERE id = ?'),
    supprimer: db.prepare('DELETE FROM sessions WHERE id = ?'),
    creer: db.prepare(`INSERT INTO sessions (id, pub_id, user_id, etape, csrf, cree, vu, dernier_2fa, ip, agent_nav)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    userParEmail: db.prepare('SELECT * FROM utilisateurs WHERE email = ? AND actif = 1'),
    userParId: db.prepare('SELECT * FROM utilisateurs WHERE id = ?'),
    totpDernier: db.prepare('UPDATE utilisateurs SET totp_dernier = ? WHERE id = ?'),
    codes: db.prepare('UPDATE utilisateurs SET codes_secours = ? WHERE id = ?'),
    confirmer: db.prepare('UPDATE sessions SET dernier_2fa = ? WHERE id = ?'),
    autres: db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?'),
    toutes: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    purger: db.prepare('DELETE FROM sessions WHERE cree < ?'),
  };

  function poserCookie(res, jeton, maxAgeS) {
    res.append('Set-Cookie', `${NOM}=${jeton}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}`
      + (config.api.cookieSecure ? '; Secure' : ''));
  }

  function ouvrirSession(req, res, user, etape) {
    const jeton = S.jeton(32);
    const now = Date.now();
    const s = { id: S.sha256(jeton), pub_id: S.jeton(9), csrf: S.jeton(24) };
    q.creer.run(s.id, s.pub_id, user.id, etape, s.csrf, now, now, etape === 'ok' ? now : 0,
      req.ip, String(req.headers['user-agent'] || '').slice(0, 200));
    poserCookie(res, jeton, Math.floor((etape === 'ok' ? C.dureeMaxMs : C.etape2faMs) / 1000));
    return s;
  }

  // ------------------------------------------------------------ middlewares

  function charger(req, res, next) {
    req.session = null;
    req.user = null;
    const jeton = cookies(req)[NOM];
    if (jeton && jeton.length <= 64) {
      const s = q.session.get(S.sha256(jeton));
      const now = Date.now();
      if (s) {
        const limite = s.etape === '2fa' ? C.etape2faMs : C.dureeMaxMs;
        if (!s.actif || now - s.cree > limite || now - s.vu > C.inactiviteMs) {
          q.supprimer.run(s.id);
        } else {
          if (now - s.vu > 30e3) q.vu.run(now, s.id);
          req.session = s;
          if (s.etape === 'ok') req.user = { id: s.user_id, email: s.email, nom: s.nom, role: s.role };
        }
      }
    }
    next();
  }

  // toute requête qui modifie quelque chose : origine vérifiée + jeton anti-CSRF
  function csrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origine = req.headers.origin;
    if (origine) {
      const hote = `${req.protocol}://${req.headers.host}`;
      if (origine !== hote && origine !== config.api.origineSite) {
        return res.status(403).json({ erreur: 'origine_refusee' });
      }
    }
    if (req.path === '/auth/login') return next();
    if (!req.session || !S.egal(req.headers['x-csrf-token'] || '', req.session.csrf)) {
      return res.status(403).json({ erreur: 'csrf', detail: 'en-tête X-CSRF-Token manquant ou invalide' });
    }
    next();
  }

  const exige = (role) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ erreur: 'non_connecte' });
    if (!roleSuffit(req.user.role, role)) return res.status(403).json({ erreur: 'role_insuffisant', detail: `rôle ${role} requis` });
    next();
  };

  // actions sensibles : un code 2FA de moins de 10 min
  function confirme(req, res, next) {
    if (!req.session || Date.now() - req.session.dernier_2fa > C.confirmationMs) {
      return res.status(403).json({ erreur: 'confirmation_requise', detail: 'confirme avec un code 2FA (POST /auth/2fa/confirmer)' });
    }
    next();
  }

  // code TOTP à 6 chiffres, ou code de secours à usage unique
  function verifierCode(user, code) {
    if (typeof code !== 'string' || code.length > 20) return false;
    const pas = S.verifierTotp(user.totp_secret, code, user.totp_dernier);
    if (pas !== null) { q.totpDernier.run(pas, user.id); return true; }
    const codes = JSON.parse(user.codes_secours || '[]');
    const h = S.sha256(code.trim().toLowerCase());
    const i = codes.indexOf(h);
    if (i >= 0) { codes.splice(i, 1); q.codes.run(JSON.stringify(codes), user.id); return 'secours'; }
    return false;
  }

  // ------------------------------------------------------------ routes /auth et /me

  const r = express.Router();
  const cleIpEmail = (req) => `${req.ip}|${String(req.body?.email || '').toLowerCase().slice(0, 200)}`;
  const limiteLogin = rateLimit({ windowMs: 15 * 60e3, limit: 5, keyGenerator: cleIpEmail, skipSuccessfulRequests: true,
    standardHeaders: 'draft-7', legacyHeaders: false, message: { erreur: 'trop_de_tentatives', detail: 'réessaie dans 15 min' } });
  const limiteLoginIp = rateLimit({ windowMs: 15 * 60e3, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { erreur: 'trop_de_tentatives', detail: 'réessaie dans 15 min' } });
  const limite2fa = rateLimit({ windowMs: 15 * 60e3, limit: 5, skipSuccessfulRequests: true, standardHeaders: 'draft-7',
    legacyHeaders: false, message: { erreur: 'trop_de_tentatives', detail: 'réessaie dans 15 min' } });

  r.post('/auth/login', limiteLoginIp, limiteLogin, asynchrone(async (req, res) => {
    const { email, motdepasse, ...reste } = req.body || {};
    if (Object.keys(reste).length || typeof email !== 'string' || typeof motdepasse !== 'string'
      || email.length > 254 || motdepasse.length > 256) {
      return res.status(400).json({ erreur: 'requete_invalide' });
    }
    const user = q.userParEmail.get(email.trim());
    const ok = user ? await S.verifierMdp(user.hash, motdepasse) : await S.verifierFactice(motdepasse);
    if (!ok) {
      journal('auth.login', { req, cible: email.slice(0, 100), resultat: 'refuse' });
      return res.status(401).json({ erreur: 'identifiants_invalides' });
    }
    if (req.session) q.supprimer.run(req.session.id);
    const s = ouvrirSession(req, res, user, '2fa');
    journal('auth.login', { req, userId: user.id, resultat: 'etape_2fa' });
    res.json({ etape: '2fa', csrf: s.csrf });
  }));

  r.post('/auth/2fa', limite2fa, (req, res) => {
    if (!req.session || req.session.etape !== '2fa') return res.status(401).json({ erreur: 'non_connecte' });
    const user = q.userParId.get(req.session.user_id);
    const ok = user && verifierCode(user, req.body?.code);
    if (!ok) {
      journal('auth.2fa', { req, userId: req.session.user_id, resultat: 'refuse' });
      return res.status(401).json({ erreur: 'code_invalide' });
    }
    q.supprimer.run(req.session.id);             // nouvel identifiant de session après la 2FA
    const s = ouvrirSession(req, res, user, 'ok');
    journal('auth.2fa', { req, userId: user.id, resultat: 'ok', detail: ok === 'secours' ? 'code de secours' : null });
    res.json({ ok: true, csrf: s.csrf, utilisateur: { id: user.id, email: user.email, nom: user.nom, role: user.role } });
  });

  r.post('/auth/2fa/confirmer', limite2fa, exige('lecteur'), (req, res) => {
    const user = q.userParId.get(req.user.id);
    if (!verifierCode(user, req.body?.code)) {
      journal('auth.confirmation', { req, resultat: 'refuse' });
      return res.status(401).json({ erreur: 'code_invalide' });
    }
    const now = Date.now();
    q.confirmer.run(now, req.session.id);
    journal('auth.confirmation', { req, resultat: 'ok' });
    res.json({ ok: true, valide_jusqua: now + C.confirmationMs });
  });

  r.post('/auth/logout', (req, res) => {
    if (req.session) q.supprimer.run(req.session.id);
    poserCookie(res, '', 0);
    journal('auth.logout', { req, resultat: 'ok' });
    res.json({ ok: true });
  });

  r.get('/me', exige('lecteur'), (req, res) => {
    res.json({ utilisateur: req.user, csrf: req.session.csrf,
      confirmation_valide_jusqua: req.session.dernier_2fa ? req.session.dernier_2fa + C.confirmationMs : null });
  });

  r.patch('/me/password', exige('lecteur'), asynchrone(async (req, res) => {
    const { ancien, nouveau } = req.body || {};
    const user = q.userParId.get(req.user.id);
    if (typeof ancien !== 'string' || !(await S.verifierMdp(user.hash, ancien))) {
      journal('me.password', { req, resultat: 'refuse' });
      return res.status(401).json({ erreur: 'ancien_mot_de_passe_invalide' });
    }
    const err = S.politiqueMotDePasse(nouveau);
    if (err) return res.status(400).json({ erreur: 'mot_de_passe_refuse', detail: err });
    db.prepare('UPDATE utilisateurs SET hash = ? WHERE id = ?').run(await S.hacher(nouveau), user.id);
    q.autres.run(user.id, req.session.id);      // les autres sessions sont fermées
    journal('me.password', { req, resultat: 'ok' });
    res.json({ ok: true });
  }));

  r.get('/me/sessions', exige('lecteur'), (req, res) => {
    const lignes = db.prepare('SELECT pub_id, cree, vu, ip, agent_nav FROM sessions WHERE user_id = ? AND etape = ? ORDER BY vu DESC')
      .all(req.user.id, 'ok');
    res.json(lignes.map((s) => ({ ...s, courante: s.pub_id === req.session.pub_id })));
  });

  r.delete('/me/sessions/:pub', exige('lecteur'), (req, res) => {
    const n = db.prepare('DELETE FROM sessions WHERE pub_id = ? AND user_id = ?').run(String(req.params.pub), req.user.id).changes;
    journal('me.session.fermer', { req, resultat: n ? 'ok' : 'absent' });
    res.status(n ? 200 : 404).json(n ? { ok: true } : { erreur: 'session_inconnue' });
  });

  r.get('/me/2fa', exige('lecteur'), (req, res) => {
    const u = q.userParId.get(req.user.id);
    res.json({ actif: true, codes_secours_restants: JSON.parse(u.codes_secours).length });
  });

  r.post('/me/2fa/codes-secours', exige('lecteur'), confirme, (req, res) => {
    const codes = S.codesSecours();
    q.codes.run(JSON.stringify(codes.map((c) => S.sha256(c))), req.user.id);
    journal('me.codes_secours', { req, resultat: 'ok' });
    res.json({ codes_secours: codes });
  });

  // purge régulière des sessions expirées
  setInterval(() => q.purger.run(Date.now() - C.dureeMaxMs), 3600e3).unref();

  return { routes: r, charger, csrf, exige, confirme, NOM, toutesSessions: q.toutes, EMAIL_RE };
}

module.exports = { creerAuth, EMAIL_RE, asynchrone };
