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
  machine_occupee: 'L\'imprimante est déjà en train d\'imprimer.',
  plaque_inconnue: 'Plaque inconnue.',
  statut_incompatible: 'Action impossible dans l\'état actuel.',
  envoi_impossible: 'Le fichier de la plaque n\'a pas pu être renvoyé à l\'imprimante.',
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

// ---------------------------------------------------------------- plaques imprimées à valider (toutes les pages)
// Une plaque finie attend ta validation : la fenêtre revient à chaque page ouverte et toutes les 30 s tant
// qu'elle n'est pas validée. Oui : la plaque est rangée dans « imprimees/ ». Non : elle repart dans
// « a_faire » et la relance est proposée si la machine ne travaille pas déjà.

const Plaques = (() => {
  let boite = null, occupe = false;
  const el = (tag, classe, texte) => { const e = document.createElement(tag); if (classe) e.className = classe; if (texte != null) e.textContent = texte; return e; };

  function preparer() {
    if (boite) return boite;
    boite = el('dialog', 'plaque-valider');
    boite.setAttribute('aria-labelledby', 'plaque-titre');
    boite.addEventListener('close', () => { occupe = false; });
    document.body.appendChild(boite);
    return boite;
  }
  const bouton = (texte, classe, action) => { const b = el('button', classe, texte); b.type = 'button'; b.onclick = action; return b; };
  // prévient la page (onglet Plaques de la boutique) qu'une plaque a changé
  const changee = () => document.dispatchEvent(new CustomEvent('plaques-changees'));

  // fiche de tri : un bloc par commande (client), avec ses pièces
  function fiche(p) {
    const liste = el('div', 'tri');
    for (const c of p.contenu) {
      const bloc = el('div', 'tri-bloc');
      bloc.append(el('b', null, `Commande ${c.ref} · ${c.client_nom}`));
      const ul = el('ul');
      for (const pc of c.pieces) ul.append(el('li', null, `${pc.nom} × ${pc.quantite} · ${pc.dims_mm.join(' × ')} mm`));
      bloc.append(ul);
      liste.append(bloc);
    }
    return liste;
  }

  function montrer(p, autres = 0) {
    const d = preparer();
    occupe = true;
    d.replaceChildren();
    const titre = el('h2', null, `Plaque ${p.numero} terminée`);
    titre.id = 'plaque-titre';
    const corps = el('div', 'plaque-corps');
    corps.append(el('p', null, 'L\'impression est-elle bonne ?'), fiche(p),
      el('p', 'muted small', `${p.fichier || ''}${autres ? ` · encore ${autres} autre(s) plaque(s) à valider ensuite` : ''}`));
    const actions = el('div', 'row plaque-actions');
    const oui = bouton('Oui, valider', 'primaire', async () => {
      oui.disabled = non.disabled = true;
      const r = await api('POST', `/boutique/plaques/${p.id}/valider`, {});
      if (!r.ok) { oui.disabled = non.disabled = false; return toast(texteErreur(r.json), true); }
      toast(r.json.range ? `Plaque ${p.numero} validée, rangée : ${r.json.fichier}`
        : `Plaque ${p.numero} validée (rangée dans « imprimees » dès que l'agent répond)`);
      d.close();
      changee();
      setTimeout(verifier, 300);
    });
    const non = bouton('Non, ratée', 'danger', async () => {
      oui.disabled = non.disabled = true;
      const r = await api('POST', `/boutique/plaques/${p.id}/ratee`, {});
      if (!r.ok) { oui.disabled = non.disabled = false; return toast(texteErreur(r.json), true); }
      changee();
      apresRatee(r.json);
    });
    actions.append(non, oui);
    d.append(titre, corps, actions);
    if (!d.open) d.showModal();
  }

  function apresRatee(p) {
    const d = preparer();
    d.replaceChildren();
    const titre = el('h2', null, `Plaque ${p.numero} à refaire`);
    titre.id = 'plaque-titre';
    const actions = el('div', 'row plaque-actions');
    let texte;
    if (p.relancable) {
      texte = 'Elle est de retour dans « a_faire ». La relancer maintenant ?';
      const lancer = bouton('Relancer maintenant', 'primaire', async () => {
        lancer.disabled = true;
        const r = await api('POST', `/boutique/plaques/${p.id}/lancer`, {});
        if (!r.ok) { lancer.disabled = false; return toast(texteErreur(r.json), true); }
        toast(`Plaque ${p.numero} relancée`);
        d.close();
        changee();
      });
      actions.append(bouton('Plus tard', 'fantome', () => d.close()), lancer);
    } else {
      texte = 'Elle est de retour dans « a_faire ». La machine imprime déjà : relance-la quand elle aura fini.';
      actions.append(bouton('Compris', 'primaire', () => d.close()));
    }
    d.append(titre, el('p', null, texte), actions);
  }

  async function verifier() {
    if (occupe || surConnexion() || document.hidden) return;
    const r = await api('GET', '/boutique/plaques/a-valider');
    if (!r.ok || !Array.isArray(r.json) || !r.json.length || occupe) return;      // pas admin, rien à valider
    montrer(r.json[0], r.json.length - 1);
  }

  if (!surConnexion()) {
    window.addEventListener('load', () => { verifier(); setInterval(verifier, 30000); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) verifier(); });
  }
  return { verifier, montrer };
})();

// PWA : installable sur le téléphone et le PC (voir sw.js)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
