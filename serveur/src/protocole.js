'use strict';
// Liste fermée des commandes (protocole/commandes.json, partagée avec l'agent) et leur validation.

const fs = require('node:fs');
const path = require('node:path');

const FICHIER = path.resolve(__dirname, '..', '..', 'protocole', 'commandes.json');
const PROTOCOLE = JSON.parse(fs.readFileSync(FICHIER, 'utf8'));
const { commandes: COMMANDES, types: TYPES, limites: LIMITES } = PROTOCOLE;
const RANGS = { lecteur: 1, operateur: 2, admin: 3 };

function definition(def) {
  // "fichier" / "video" : types nommés, définis une fois dans commandes.json
  return TYPES[def.type] ? { ...TYPES[def.type], optionnel: def.optionnel } : def;
}

function verifierValeur(def, v) {
  switch (def.type) {
    case 'texte':
      if (typeof v !== 'string' || !v.length || v.length > def.max) return `texte de 1 à ${def.max} caractères attendu`;
      if (def.motif && !new RegExp(def.motif).test(v)) return 'format refusé';
      return null;
    case 'entier':
      if (!Number.isInteger(v) || v < def.min || v > def.max) return `entier entre ${def.min} et ${def.max} attendu`;
      return null;
    case 'nombre':
      if (typeof v !== 'number' || !Number.isFinite(v) || v < def.min || v > def.max) return `nombre entre ${def.min} et ${def.max} attendu`;
      return null;
    case 'booleen':
      return typeof v === 'boolean' ? null : 'true ou false attendu';
    case 'choix':
      return def.valeurs.includes(v) ? null : `une valeur parmi ${def.valeurs.join(', ')} attendue`;
    default:
      return 'type inconnu';
  }
}

// retourne { params } (copie propre) ou { erreur, champ }
function valider(action, params) {
  const cmd = COMMANDES[action];
  if (!cmd) return { erreur: 'commande inconnue' };
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return { erreur: 'paramètres invalides' };
  for (const champ of Object.keys(params)) {
    if (!Object.prototype.hasOwnProperty.call(cmd.params, champ)) return { erreur: 'champ inconnu', champ };
  }
  const propre = {};
  for (const [champ, brut] of Object.entries(cmd.params)) {
    const def = definition(brut);
    const v = params[champ];
    if (v === undefined || v === null) {
      if (def.optionnel) continue;
      return { erreur: 'champ manquant', champ };
    }
    const err = verifierValeur(def, v);
    if (err) return { erreur: err, champ };
    propre[champ] = v;
  }
  // limite propre au plateau : 110 °C (la buse va jusqu'à 300)
  if (action === 'temperature.set' && propre.cible === 'plateau' && propre.temp > 110) {
    return { erreur: 'plateau : 110 °C maximum', champ: 'temp' };
  }
  return { params: propre };
}

const roleSuffit = (role, minimum) => (RANGS[role] || 0) >= (RANGS[minimum] || 99);

module.exports = { COMMANDES, LIMITES, RANGS, valider, roleSuffit, definition, verifierValeur, TYPES };
