'use strict';
// Données d'essai pour le serveur de DÉVELOPPEMENT (base data-dev/, jamais celle de Fly) :
//   node --env-file=dev.env scripts/dev-donnees.js
// - crée un compte admin d'essai (identifiants et secret 2FA écrits dans data-dev/ACCES-TEST.txt) ;
// - transforme le dernier devis en commande « payée », pour voir la page Boutique de l'admin.
// Le code 2FA du moment : node --env-file=dev.env scripts/dev-donnees.js code

const fs = require('node:fs');
const path = require('node:path');
const { charger } = require('../src/config');
const { ouvrir } = require('../src/db');
const S = require('../src/securite');

const config = charger();
if (!/data-dev$/.test(config.donnees)) {
  console.error('Refusé : ce script ne s\'utilise qu\'avec la base de développement (DONNEES=data-dev, voir dev.env).');
  process.exit(1);
}
const db = ouvrir(config.donnees);
const fichierAcces = path.join(config.donnees, 'ACCES-TEST.txt');
const EMAIL = 'admin-essai@exemple.test';

(async () => {
  let admin = db.prepare('SELECT * FROM utilisateurs WHERE email = ?').get(EMAIL);
  if (process.argv[2] === 'code') {
    if (!admin) throw new Error('compte d\'essai absent : lance d\'abord le script sans argument');
    console.log(S.codeTotp(admin.totp_secret, Math.floor(Date.now() / 30000)));
    return;
  }
  if (!admin) {
    const motdepasse = S.jeton(18);
    const secret = S.nouveauSecretTotp();
    db.prepare('INSERT INTO utilisateurs (email, nom, role, hash, totp_secret, cree) VALUES (?, ?, ?, ?, ?, ?)')
      .run(EMAIL, 'Admin essai', 'admin', await S.hacher(motdepasse), secret, Date.now());
    fs.writeFileSync(fichierAcces, `Compte admin d'essai (serveur de développement uniquement)\ne-mail : ${EMAIL}\n`
      + `mot de passe : ${motdepasse}\nsecret 2FA : ${secret}\ncode du moment : node --env-file=dev.env scripts/dev-donnees.js code\n`);
    admin = db.prepare('SELECT * FROM utilisateurs WHERE email = ?').get(EMAIL);
    console.log(`Compte admin d'essai créé : identifiants dans ${fichierAcces}`);
  }

  const devis = db.prepare('SELECT * FROM devis WHERE id NOT IN (SELECT devis_id FROM commandes) ORDER BY id DESC LIMIT 1').get();
  if (!devis) { console.log('Aucun devis libre : dépose des STL dans le site client et clique sur « Découper ».'); return; }
  const now = Date.now();
  const { lastInsertRowid: id } = db.prepare(`INSERT INTO commandes (client_id, devis_id, statut, livraison_nom, livraison_adresse,
    sous_total_cts, livraison_cts, total_cts, cree_le, paye_le, validation_limite_le, stripe_paiement_id)
    VALUES (?, ?, 'payee', 'Client Essai', ?, 1240, 500, 1740, ?, ?, ?, 'pi_essai')`)
    .run(devis.client_id, devis.id, JSON.stringify({ ligne1: '1 rue de l\'Essai', code_postal: '75001', ville: 'Paris', pays: 'FR' }),
      now, now, now + config.boutique.validationJours * 864e5);
  console.log(`Commande d'essai n° ${id} créée (payée, à valider) à partir du devis ${devis.id}.`);
})().finally(() => db.close());
