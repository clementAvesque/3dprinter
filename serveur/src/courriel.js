'use strict';
// Envoi des e-mails (clients et rappels admin).
// Modes :
//   - "journal" : écrits dans les logs du serveur (tant qu'aucun service d'envoi n'est choisi). Les liens
//                 qu'ils contiennent y sont visibles : à réserver aux essais.
//   - "memoire" : gardés dans `boite` (tests).
//   - "brevo"   : envoyés par l'API de Brevo (https://www.brevo.com, 300 e-mails/jour gratuits).
//                 Clé API dans COURRIEL_CLE_API (fly secrets), expéditeur validé chez Brevo dans
//                 COURRIEL_EXPEDITEUR (ex. "Impression 3D <toi@gmail.com>").
//                 Avec COURRIEL_TEMPLATE_ID (créé par scripts/brevo_template.py) : mise en page HTML du template,
//                 remplie avec versParams() ; sans : e-mail en texte brut.

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const DELAI_MS = 10e3;

// échec d'envoi : l'API répond 503 « courriel_indisponible » (voir api.js) au lieu d'une erreur interne
class ErreurCourriel extends Error {
  constructor(message) { super(message); this.code = 'COURRIEL'; }
}

// libellé du bouton selon la page visée par le lien
const BOUTONS = [
  [/\/verifier\?/, 'Confirmer mon adresse'],
  [/\/(reinitialiser\?|mot-de-passe-oublie)/, 'Choisir un nouveau mot de passe'],
];
const URL_SURE = /^https?:\/\/[^\s"'<>`\\]+$/;

// texte brut d'un e-mail -> variables du template Brevo (voir scripts/brevo-template.html).
// On ne sait pas si Brevo échappe le HTML des variables : < et > sont donc retirés ici (un nom de client
// comme "<b>Bob</b>" ne peut rien injecter), et le lien du bouton n'est gardé que s'il est une adresse sûre.
// Une ligne qui ne contient qu'une adresse devient le bouton ; une adresse au milieu d'une phrase reste dans le texte.
function versParams(sujet, texte) {
  const propre = (t) => String(t).replace(/</g, '‹').replace(/>/g, '›');
  const adresses = String(texte).match(/https?:\/\/[^\s<>"]+/g) || [];
  const lien = adresses.find((u) => URL_SURE.test(u)) || '';
  const paragraphes = String(texte).split(/\n\s*\n/)
    .map((p) => p.split('\n').filter((l) => !lien || l.trim() !== lien).join('\n').trim())
    .filter(Boolean)
    .map(propre);
  const bouton = lien ? (BOUTONS.find(([re]) => re.test(lien))?.[1] || 'Ouvrir le site') : '';
  return { sujet: propre(sujet), paragraphes, lien, bouton };
}

// "Nom <adresse@x.fr>" ou "adresse@x.fr" -> { name, email }
function lireAdresse(texte) {
  const m = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(texte || '');
  if (m) return m[1] ? { name: m[1].replace(/^"|"$/g, ''), email: m[2] } : { email: m[2] };
  return { email: String(texte || '').trim() };
}

function creerCourriel(config, { fetch: fetchFn = globalThis.fetch } = {}) {
  const C = config.boutique.courriel;
  const boite = [];

  if (!['journal', 'memoire', 'brevo'].includes(C.mode)) throw new Error(`mode d'e-mail inconnu : ${C.mode}`);
  if (C.mode === 'brevo') {
    // vérifié au démarrage : mieux vaut un serveur qui refuse de démarrer que des comptes jamais confirmés
    if (!C.cleApi) throw new Error('COURRIEL_MODE=brevo : la clé API (COURRIEL_CLE_API) manque');
    if (!lireAdresse(C.expediteur).email.includes('@') || /@example\.com$/i.test(lireAdresse(C.expediteur).email)) {
      throw new Error('COURRIEL_MODE=brevo : COURRIEL_EXPEDITEUR doit être une adresse validée chez Brevo');
    }
    if (C.templateId && !/^\d+$/.test(String(C.templateId))) {
      throw new Error(`COURRIEL_TEMPLATE_ID doit être le numéro du template Brevo (reçu : ${C.templateId})`);
    }
  }

  async function envoyerBrevo({ a, sujet, texte }) {
    let rep;
    try {
      rep = await fetchFn(BREVO_URL, {
        method: 'POST',
        headers: { 'api-key': C.cleApi, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(C.templateId
          // le sujet et l'expéditeur sont passés aussi : ceux du serveur priment sur ceux du template
          ? { templateId: Number(C.templateId), sender: lireAdresse(C.expediteur), to: [{ email: a }], subject: sujet,
            params: versParams(sujet, texte) }
          : { sender: lireAdresse(C.expediteur), to: [{ email: a }], subject: sujet, textContent: texte }),
        signal: AbortSignal.timeout(DELAI_MS),
      });
    } catch (e) {
      throw new ErreurCourriel(`Brevo injoignable : ${e.name === 'TimeoutError' ? 'délai dépassé' : e.message}`);
    }
    if (!rep.ok) {
      // ex. 401 clé invalide, 400 expéditeur non validé : le message de Brevo dit lequel
      const detail = await rep.json().then((j) => j.message || j.code).catch(() => '');
      throw new ErreurCourriel(`Brevo a refusé l'e-mail (HTTP ${rep.status})${detail ? ` : ${detail}` : ''}`);
    }
    return { ok: true };
  }

  async function envoyer({ a, sujet, texte }) {
    const message = { de: C.expediteur, a, sujet, texte, le: Date.now() };
    if (C.mode === 'memoire') {
      boite.push(message);
      return { ok: true };
    }
    if (C.mode === 'journal') {
      console.log(`[courriel] à ${a} : ${sujet}\n${texte.split('\n').map((l) => `  | ${l}`).join('\n')}`);
      return { ok: true };
    }
    return envoyerBrevo(message);
  }

  return { envoyer, boite, mode: C.mode };
}

module.exports = { creerCourriel, lireAdresse, versParams, ErreurCourriel };
