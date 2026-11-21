// Outils partagés par les pages du site en ligne.
const $ = (id) => document.getElementById(id);
// adresse de l'API : config.js (vide = même adresse que le site)
const BASE = (window.API_BASE || '').replace(/\/+$/, '');
const API = `${BASE}/api/v1`;
const AUTRE_ADRESSE = BASE !== '';                       // site et API à des adresses différentes
const PAGE_CONNEXION = 'connexion.html';
const surConnexion = () => /connexion(\.html)?$/.test(location.pathname);
const Session = { csrf: sessionStorage.getItem('csrf') || '' };

function toast(message, erreur = false) {
  const el = document.createElement('div');
  el.className = `toast${erreur ? ' erreur' : ''}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), erreur ? 7000 : 3500);
}

const MESSAGES = {
  identifiants_invalides: 'E-mail ou mot de passe incorrect.',
  code_invalide: 'Code incorrect ou déjà utilisé : attends le suivant (30 s).',
  trop_de_tentatives: 'Trop d\'essais : réessaie dans 15 minutes.',
  trop_de_requetes: 'Trop de requêtes : patiente une minute.',
  agent_hors_ligne: 'L\'agent n\'est pas connecté : vérifie qu\'il tourne chez toi.',
  machine_inconnue: 'Machine inconnue.',
  non_connecte: 'Session expirée : reconnecte-toi.',
  role_insuffisant: 'Ton compte n\'a pas le droit de faire ça.',
  delai_depasse: 'La machine n\'a pas répondu à temps.',
  csrf: 'Session invalide : recharge la page.',
};
const texteErreur = (r) => (MESSAGES[r?.erreur] || r?.erreur || 'erreur') + (r?.detail && !MESSAGES[r?.erreur] ? ` : ${r.detail}` : '');

function memoriserCsrf(c) {
  Session.csrf = c || '';
  try { sessionStorage.setItem('csrf', Session.csrf); } catch { /* navigation privée */ }
}

// appel à l'API : JSON, jeton anti-CSRF, retour à la connexion si la session est finie,
// et code 2FA redemandé pour les actions sensibles
async function api(methode, chemin, corps, { confirmer = true } = {}) {
  // cookie de session envoyé aussi quand l'API est à une autre adresse
  const options = { method: methode, headers: {}, credentials: AUTRE_ADRESSE ? 'include' : 'same-origin' };
  if (methode !== 'GET') options.headers['X-CSRF-Token'] = Session.csrf;
  if (corps instanceof FormData) options.body = corps;
  else if (corps !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(corps); }
  let rep;
  try {
    rep = await fetch(API + chemin, options);
  } catch {
    return { ok: false, statut: 0, json: { erreur: 'reseau', detail: 'serveur injoignable' } };
  }
  const json = (rep.headers.get('content-type') || '').includes('json') ? await rep.json() : null;
  // seule une session finie renvoie à la connexion (un 401 « ancien mot de passe faux » reste sur la page)
  if (rep.status === 401 && json?.erreur === 'non_connecte' && !chemin.startsWith('/auth/') && !surConnexion()) {
    location.href = PAGE_CONNEXION;
    return { ok: false, statut: 401, json };
  }
  if (rep.status === 403 && json?.erreur === 'confirmation_requise' && confirmer) {
    if (await demanderCode()) return api(methode, chemin, corps, { confirmer: false });
    return { ok: false, statut: 403, json: { erreur: 'annule', detail: 'confirmation annulée' } };
  }
  return { ok: rep.ok, statut: rep.status, json };
}

// fenêtre « confirme avec ton code 2FA » (actions sensibles : annuler, supprimer...)
function demanderCode() {
  const d = $('confirmation');
  if (!d) return Promise.resolve(false);
  $('conf-code').value = '';
  $('conf-erreur').hidden = true;
  d.showModal();
  $('conf-code').focus();
  return new Promise((fin) => {
    const valider = async (ev) => {
      ev.preventDefault();
      const r = await api('POST', '/auth/2fa/confirmer', { code: $('conf-code').value.trim() }, { confirmer: false });
      if (r.ok) { nettoyer(); d.close(); fin(true); return; }
      $('conf-erreur').textContent = texteErreur(r.json);
      $('conf-erreur').hidden = false;
    };
    const annuler = () => { nettoyer(); fin(false); };
    const nettoyer = () => { $('conf-form').removeEventListener('submit', valider); d.removeEventListener('close', annuler); };
    $('conf-form').addEventListener('submit', valider);
    d.addEventListener('close', annuler, { once: true });
  });
}

function duree(s) {
  if (s == null) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}
const arrondi = (v, n = 0) => (v == null ? '—' : Number(v).toFixed(n));
const cheminUrl = (nom) => nom.split('/').map(encodeURIComponent).join('/');
const couleurSure = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : null);

// PWA : installable sur le téléphone et le PC (voir sw.js)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
