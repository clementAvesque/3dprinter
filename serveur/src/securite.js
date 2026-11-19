'use strict';
// Outils de sécurité : mots de passe (Argon2id), double authentification (TOTP, RFC 6238), jetons.

const crypto = require('node:crypto');
const argon2 = require('@node-rs/argon2');

// --- mots de passe -----------------------------------------------------------

const ARGON2 = { algorithm: 2 /* Argon2id */, memoryCost: 65536, timeCost: 3, parallelism: 1 };

// quelques mots de passe parmi les plus répandus dans les fuites (vérification locale :
// aucun mot de passe n'est envoyé à un service extérieur)
const COURANTS = new Set([
  '123456789012', 'motdepasse123', 'password1234', 'azertyuiop12', 'qwertyuiop12', '000000000000',
  '111111111111', 'aaaaaaaaaaaa', 'iloveyou1234', 'administrator', 'imprimante3d', 'motdepasse!!',
]);

function politiqueMotDePasse(mdp) {
  if (typeof mdp !== 'string' || mdp.length < 12) return '12 caractères minimum';
  if (mdp.length > 256) return '256 caractères maximum';
  if (COURANTS.has(mdp.toLowerCase())) return 'mot de passe trop courant';
  if (new Set(mdp).size < 5) return 'mot de passe trop répétitif';
  return null;
}

const hacher = (mdp) => argon2.hash(mdp, ARGON2);
const verifierMdp = (hash, mdp) => argon2.verify(hash, mdp).catch(() => false);
// hash factice : un e-mail inconnu prend le même temps qu'un mauvais mot de passe
let hashFactice = null;
async function verifierFactice(mdp) {
  hashFactice ||= await hacher(crypto.randomBytes(16).toString('hex'));
  await verifierMdp(hashFactice, mdp);
  return false;
}

// --- TOTP ----------------------------------------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buf) {
  let bits = 0, val = 0, out = '';
  for (const o of buf) {
    val = (val << 8) | o; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

function debase32(txt) {
  let bits = 0, val = 0; const out = [];
  for (const c of txt.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('base32 invalide');
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const nouveauSecretTotp = () => base32(crypto.randomBytes(20));

function codeTotp(secret, pas) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(pas));
  const h = crypto.createHmac('sha1', debase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

// retourne le pas de temps accepté (pour interdire sa réutilisation), ou null.
// Tolère ±1 pas (30 s) de décalage d'horloge.
function verifierTotp(secret, code, dernierPas = 0, maintenant = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const pas = Math.floor(maintenant / 30000);
  for (const p of [pas - 1, pas, pas + 1]) {
    if (p <= dernierPas) continue;
    const attendu = Buffer.from(codeTotp(secret, p));
    if (crypto.timingSafeEqual(attendu, Buffer.from(code))) return p;
  }
  return null;
}

const urlTotp = (email, secret) =>
  `otpauth://totp/Imprimantes:${encodeURIComponent(email)}?secret=${secret}&issuer=Imprimantes&digits=6&period=30`;

// --- jetons et divers -------------------------------------------------------------

const jeton = (octets = 32) => crypto.randomBytes(octets).toString('base64url');
const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');

function egal(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function codesSecours(n = 10) {
  // format "abcd-efgh-ijkl" lisible ; seules leurs empreintes sont stockées
  return Array.from({ length: n }, () => jeton(9).toLowerCase().replace(/[^a-z0-9]/g, 'x').match(/.{4}/g).slice(0, 3).join('-'));
}

module.exports = {
  politiqueMotDePasse, hacher, verifierMdp, verifierFactice,
  nouveauSecretTotp, verifierTotp, codeTotp, urlTotp,
  jeton, sha256, egal, codesSecours,
};
