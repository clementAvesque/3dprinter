'use strict';
// Tests du module d'e-mails (mode Brevo avec un faux fetch : aucun e-mail réel n'est envoyé).
//   npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { creerCourriel, lireAdresse } = require('../src/courriel');

const conf = (courriel) => ({ boutique: { courriel: { mode: 'brevo', expediteur: 'Impression 3D <moi@exemple.fr>', cleApi: 'cle-test', ...courriel } } });
const reponse = (statut, json) => ({ ok: statut >= 200 && statut < 300, status: statut, json: async () => json });

test('adresse expéditeur : avec ou sans nom', () => {
  assert.deepEqual(lireAdresse('Impression 3D <moi@exemple.fr>'), { name: 'Impression 3D', email: 'moi@exemple.fr' });
  assert.deepEqual(lireAdresse('"Atelier" <moi@exemple.fr>'), { name: 'Atelier', email: 'moi@exemple.fr' });
  assert.deepEqual(lireAdresse('moi@exemple.fr'), { email: 'moi@exemple.fr' });
});

test('brevo : refuse de démarrer sans clé ou avec l\'expéditeur par défaut', () => {
  assert.throws(() => creerCourriel(conf({ cleApi: '' })), /COURRIEL_CLE_API/);
  assert.throws(() => creerCourriel(conf({ expediteur: 'Impression 3D <no-reply@example.com>' })), /COURRIEL_EXPEDITEUR/);
  assert.throws(() => creerCourriel(conf({ mode: 'pigeon' })), /mode d'e-mail inconnu/);
});

test('brevo : requête envoyée à l\'API', async () => {
  let appel;
  const c = creerCourriel(conf(), { fetch: async (url, o) => { appel = { url, ...o }; return reponse(201, { messageId: 'x' }); } });
  assert.deepEqual(await c.envoyer({ a: 'client@exemple.fr', sujet: 'Bonjour', texte: 'Lien : https://x' }), { ok: true });
  assert.equal(appel.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(appel.method, 'POST');
  assert.equal(appel.headers['api-key'], 'cle-test');
  assert.deepEqual(JSON.parse(appel.body), { sender: { name: 'Impression 3D', email: 'moi@exemple.fr' },
    to: [{ email: 'client@exemple.fr' }], subject: 'Bonjour', textContent: 'Lien : https://x' });
});

test('brevo : refus ou panne -> ErreurCourriel avec la raison', async () => {
  const refus = creerCourriel(conf(), { fetch: async () => reponse(401, { code: 'unauthorized', message: 'Key not found' }) });
  await assert.rejects(refus.envoyer({ a: 'a@b.fr', sujet: 's', texte: 't' }), (e) => e.code === 'COURRIEL' && /HTTP 401\) : Key not found/.test(e.message));
  const panne = creerCourriel(conf(), { fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(panne.envoyer({ a: 'a@b.fr', sujet: 's', texte: 't' }), (e) => e.code === 'COURRIEL' && /injoignable/.test(e.message));
});

test('template : le texte devient paragraphes + bouton, sans HTML injectable', () => {
  const { versParams } = require('../src/courriel');
  const p = versParams('Confirme <ton> adresse', 'Bonjour <b>Bob</b>,\n\nOuvre ce lien :\nhttps://site.test/verifier?jeton=abc\n\nÀ bientôt.');
  assert.deepEqual(p, { sujet: 'Confirme ‹ton› adresse', paragraphes: ['Bonjour ‹b›Bob‹/b›,', 'Ouvre ce lien :', 'À bientôt.'],
    lien: 'https://site.test/verifier?jeton=abc', bouton: 'Confirmer mon adresse' });
  assert.equal(versParams('s', 'Sans lien.\n\nCommande n° 4.').lien, '');
  assert.equal(versParams('s', 'voir https://x.test/\'onmouseover=alert(1) fin').lien, '', 'adresse douteuse : pas de bouton');
});

test('brevo avec template : templateId + params, refuse un numéro invalide', async () => {
  assert.throws(() => creerCourriel(conf({ templateId: 'abc' })), /COURRIEL_TEMPLATE_ID/);
  let corps;
  const c = creerCourriel(conf({ templateId: '7' }), { fetch: async (url, o) => { corps = JSON.parse(o.body); return reponse(201, {}); } });
  await c.envoyer({ a: 'client@exemple.fr', sujet: 'Réinitialiser', texte: 'Bonjour,\n\nLien :\nhttps://site.test/reinitialiser?jeton=x' });
  assert.equal(corps.templateId, 7);
  assert.equal(corps.subject, 'Réinitialiser');
  assert.equal(corps.textContent, undefined);
  assert.deepEqual(corps.params.paragraphes, ['Bonjour,', 'Lien :']);
  assert.equal(corps.params.bouton, 'Choisir un nouveau mot de passe');
});
