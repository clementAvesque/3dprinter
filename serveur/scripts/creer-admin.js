'use strict';
// Crée le premier compte admin (les suivants se créent par l'API).
//   npm run admin:creer -- ton@email.fr "Ton nom"
// Affiche UNE SEULE FOIS : le mot de passe généré, le secret 2FA et les codes de secours.

const { charger } = require('../src/config');
const { ouvrir } = require('../src/db');
const S = require('../src/securite');
const { EMAIL_RE } = require('../src/auth');

(async () => {
  const [email, nom] = process.argv.slice(2);
  if (!email || !EMAIL_RE.test(email) || !nom) {
    console.error('usage : npm run admin:creer -- ton@email.fr "Ton nom"');
    process.exit(1);
  }
  const db = ouvrir(charger().donnees);
  if (db.prepare('SELECT 1 FROM utilisateurs WHERE email = ?').get(email)) {
    console.error('ce compte existe déjà');
    process.exit(1);
  }
  const motdepasse = S.jeton(18);                 // 24 caractères aléatoires
  const secret = S.nouveauSecretTotp();
  const codes = S.codesSecours();
  db.prepare(`INSERT INTO utilisateurs (email, nom, role, hash, totp_secret, codes_secours, cree)
    VALUES (?, ?, 'admin', ?, ?, ?, ?)`).run(email, nom, await S.hacher(motdepasse), secret,
    JSON.stringify(codes.map((c) => S.sha256(c))), Date.now());
  db.prepare('INSERT INTO audit (ts, action, cible, resultat, detail) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), 'users.creer', email, 'ok', 'admin, script local');

  console.log(`Compte admin créé : ${email}`);
  console.log(`Mot de passe (change-le ensuite) : ${motdepasse}`);
  console.log(`Secret 2FA à saisir dans ton application (Aegis, Google Authenticator...) : ${secret}`);
  console.log(`ou ce lien otpauth : ${S.urlTotp(email, secret)}`);
  console.log('Codes de secours (usage unique, à garder hors ligne) :');
  for (const c of codes) console.log(`  ${c}`);
})();
