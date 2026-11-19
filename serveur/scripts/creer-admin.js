'use strict';
// Crée le premier compte admin (les suivants se créent par l'API), ou réinitialise un compte perdu.
//   npm run admin:creer -- ton@email.fr "Ton nom"
//   npm run admin:creer -- ton@email.fr --reinitialiser     (mot de passe ou 2FA perdus)
//   npm run admin:creer -- ton@email.fr --supprimer         (refusé pour le dernier admin)
// Affiche UNE SEULE FOIS : le mot de passe généré, le secret 2FA et les codes de secours.
// --reinitialiser : nouveau mot de passe, nouvelle 2FA, nouveaux codes ; rôle admin ; sessions fermées.

const { charger } = require('../src/config');
const { ouvrir } = require('../src/db');
const S = require('../src/securite');
const { EMAIL_RE } = require('../src/auth');

(async () => {
  const args = process.argv.slice(2);
  const reinitialiser = args.includes('--reinitialiser');
  const supprimer = args.includes('--supprimer');
  const [email, ...mots] = args.filter((a) => a !== '--reinitialiser' && a !== '--supprimer');
  if (supprimer) {
    const db = ouvrir(charger().donnees);
    const u = db.prepare('SELECT id FROM utilisateurs WHERE email = ?').get(email || '');
    if (!u) { console.error('aucun compte avec cet e-mail'); process.exit(1); }
    const admins = db.prepare("SELECT COUNT(*) n FROM utilisateurs WHERE role = 'admin' AND actif = 1 AND id != ?").get(u.id).n;
    if (!admins) { console.error('impossible : c\'est le dernier compte admin'); process.exit(1); }
    db.prepare('DELETE FROM utilisateurs WHERE id = ?').run(u.id);     // ses sessions partent avec (cascade)
    db.prepare('INSERT INTO audit (ts, action, cible, resultat, detail) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), 'users.supprimer', email, 'ok', 'script sur le serveur');
    console.log(`Compte supprimé : ${email}`);
    return;
  }
  const nom = mots.join(' ');               // "Ton nom" en un ou plusieurs mots
  if (!email || !EMAIL_RE.test(email) || (!nom && !reinitialiser)) {
    console.error('usage : npm run admin:creer -- ton@email.fr "Ton nom"   (ou ton@email.fr --reinitialiser)');
    process.exit(1);
  }
  const db = ouvrir(charger().donnees);
  const existant = db.prepare('SELECT id, nom FROM utilisateurs WHERE email = ?').get(email);
  if (existant && !reinitialiser) {
    console.error('ce compte existe déjà. Mot de passe ou 2FA perdus ? Ajoute --reinitialiser');
    process.exit(1);
  }
  if (!existant && reinitialiser && !nom) {
    console.error('aucun compte avec cet e-mail : donne aussi un nom pour le créer');
    process.exit(1);
  }

  const motdepasse = S.jeton(18);                 // 24 caractères aléatoires
  const secret = S.nouveauSecretTotp();
  const codes = S.codesSecours();
  const hash = await S.hacher(motdepasse);
  const empreintes = JSON.stringify(codes.map((c) => S.sha256(c)));
  if (existant) {
    db.prepare(`UPDATE utilisateurs SET hash = ?, totp_secret = ?, totp_dernier = 0, codes_secours = ?,
      role = 'admin', actif = 1, nom = ? WHERE id = ?`).run(hash, secret, empreintes, nom || existant.nom, existant.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existant.id);     // anciennes sessions fermées
  } else {
    db.prepare(`INSERT INTO utilisateurs (email, nom, role, hash, totp_secret, codes_secours, cree)
      VALUES (?, ?, 'admin', ?, ?, ?, ?)`).run(email, nom, hash, secret, empreintes, Date.now());
  }
  db.prepare('INSERT INTO audit (ts, action, cible, resultat, detail) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), existant ? 'users.reinitialiser' : 'users.creer', email, 'ok', 'admin, script sur le serveur');

  console.log(`${existant ? 'Compte admin réinitialisé' : 'Compte admin créé'} : ${email}`);
  console.log(`Mot de passe (change-le ensuite) : ${motdepasse}`);
  console.log(`Secret 2FA à saisir dans ton application (Aegis, Google Authenticator...) : ${secret}`);
  console.log(`ou ce lien otpauth : ${S.urlTotp(email, secret)}`);
  console.log('Codes de secours (usage unique, à garder hors ligne) :');
  for (const c of codes) console.log(`  ${c}`);
  if (existant) console.log('L\'ancien secret 2FA ne marche plus : supprime-le de ton application.');
})();
