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

  // ---- plateau cliquable : chaque exemplaire posé sur le plateau, coché quand il est bien imprimé
  const SVG = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

  // plateau vu de dessus (Y de l'imprimante vers le haut) ; couleurs dans style.css (pas de style en ligne : CSP)
  function dessinerPlateau(o, coches, basculer) {
    const [L, H] = o.plateau_mm;
    const svg = svgEl('svg', { viewBox: `0 0 ${L} ${H}`, class: 'plateau-svg', role: 'img', 'aria-label': `Plateau ${L} × ${H} mm` });
    svg.append(svgEl('rect', { x: 0, y: 0, width: L, height: H, rx: 4, class: 'plateau-fond' }));
    for (let g = 50; g < Math.max(L, H); g += 50) {
      if (g < L) svg.append(svgEl('line', { x1: g, y1: 0, x2: g, y2: H, class: 'plateau-grille' }));
      if (g < H) svg.append(svgEl('line', { x1: 0, y1: g, x2: L, y2: g, class: 'plateau-grille' }));
    }
    const formes = new Map();
    o.objets.forEach((ob, i) => {
      if (!ob.centre) return;
      const groupe = svgEl('g', { class: 'objet', 'data-nom': ob.nom });
      const forme = ob.polygone?.length > 2
        ? svgEl('polygon', { points: ob.polygone.map(([x, y]) => `${x},${H - y}`).join(' ') })
        : svgEl('circle', { cx: ob.centre[0], cy: H - ob.centre[1], r: 8 });
      const titre = svgEl('title');
      titre.textContent = `${ob.piece_nom} n° ${ob.exemplaire}${ob.client_nom ? ` · ${ob.client_nom}` : ''}`;
      const num = svgEl('text', { x: ob.centre[0], y: H - ob.centre[1], class: 'objet-num' });
      num.textContent = i + 1;
      groupe.append(forme, titre, num);
      groupe.addEventListener('click', () => basculer(ob.nom));
      svg.append(groupe);
      formes.set(ob.nom, groupe);
    });
    const maj = () => { for (const [nom, g] of formes) g.classList.toggle('ok', coches.has(nom)); };
    maj();
    return { svg, maj, vide: !formes.size };
  }

  // liste à cocher, par commande (client) : la fiche de tri des pièces réussies
  // apercu(ligne, objet) : branche l'aperçu 3D du STL sur la ligne (facultatif, voir montrer())
  function listeObjets(o, coches, basculer, apercu) {
    const liste = el('div', 'tri');
    const cases = new Map();
    const groupes = new Map();
    o.objets.forEach((ob, i) => {
      const cle = ob.commande_ref || '—';
      if (!groupes.has(cle)) {
        const bloc = el('div', 'tri-bloc');
        bloc.append(el('b', null, ob.commande_ref ? `Commande ${ob.commande_ref} · ${ob.client_nom}` : 'Pièces'));
        groupes.set(cle, bloc);
        liste.append(bloc);
      }
      const label = el('label', 'objet-ligne');
      const caseO = el('input');
      caseO.type = 'checkbox';
      caseO.onchange = () => basculer(ob.nom, caseO.checked);
      label.append(caseO, el('span', 'objet-pastille', String(i + 1)), el('span', null, `${ob.piece_nom} · n° ${ob.exemplaire}`));
      apercu?.(label, ob);
      groupes.get(cle).append(label);
      cases.set(ob.nom, caseO);
    });
    const maj = () => { for (const [nom, c] of cases) c.checked = coches.has(nom); };
    return { liste, maj };
  }

  async function montrer(p, autres = 0) {
    const d = preparer();
    occupe = true;
    d.replaceChildren();
    const titre = el('h2', null, `Plaque ${p.numero} terminée`);
    titre.id = 'plaque-titre';
    const chargement = el('p', 'muted', 'Lecture des pièces du plateau…');
    d.append(titre, chargement);
    if (!d.open) d.showModal();

    const r = await api('GET', `/boutique/plaques/${p.id}/objets`);
    if (!r.ok) { chargement.textContent = `Pièces illisibles : ${texteErreur(r.json)}`; chargement.className = 'erreur'; return; }
    const o = r.json;
    const total = o.objets.length;
    const coches = new Set();            // exemplaires bien imprimés (cliqués)
    const basculer = (nom, force) => {
      const oui = force ?? !coches.has(nom);
      if (oui) coches.add(nom); else coches.delete(nom);
      maj();
    };
    const plateau = dessinerPlateau(o, coches, basculer);
    // aperçu 3D du STL au survol d'une ligne : le nom du fichier vient du client et ne dit souvent rien.
    // Chargé à la demande (commun.js est un script classique, apercu-stl.js un module) ; sans lui la liste
    // marche comme avant.
    const brancher = await import('./apercu-stl.js').then((m) => m.brancherApercuStl).catch(() => null);
    const liste = listeObjets(o, coches, basculer, (ligne, ob) => brancher?.(ligne,
      `${API}/boutique/plaques/${p.id}/pieces/${ob.piece_id}/stl`, ob.dims_mm, ob.piece_nom));

    const corps = el('div', 'plaque-corps plaque-pieces');
    if (!plateau.vide) corps.append(plateau.svg);
    const droite = el('div', 'plaque-liste');
    const raccourcis = el('div', 'row');
    raccourcis.append(bouton('Tout est bon', 'fantome', () => { o.objets.forEach((x) => coches.add(x.nom)); maj(); }),
      bouton('Tout décocher', 'fantome', () => { coches.clear(); maj(); }));
    droite.append(el('p', 'small', plateau.vide ? 'Coche les pièces bien imprimées.'
      : 'Clique sur le plateau (ou coche dans la liste) les pièces bien imprimées.'), raccourcis, liste.liste);
    corps.append(droite);
    const bilan = el('p', 'plaque-bilan');
    const pied = el('p', 'muted small', `${p.fichier || ''}${autres ? ` · encore ${autres} autre(s) plaque(s) à valider ensuite` : ''}`);

    const actions = el('div', 'row plaque-actions');
    const non = bouton('Rien n\'est bon : à refaire', 'danger', async () => {
      oui.disabled = non.disabled = true;
      const rr = await api('POST', `/boutique/plaques/${p.id}/ratee`, {});
      if (!rr.ok) { oui.disabled = non.disabled = false; return toast(texteErreur(rr.json), true); }
      changee();
      apresRatee(rr.json);
    });
    const oui = bouton('Valider', 'primaire', async () => {
      oui.disabled = non.disabled = true;
      const rr = await api('POST', `/boutique/plaques/${p.id}/valider`, { bonnes: [...coches] });
      if (!rr.ok) { oui.disabled = non.disabled = false; return toast(texteErreur(rr.json), true); }
      const range = rr.json.range ? `rangée : ${rr.json.fichier}` : 'rangée dans « imprimees » dès que l\'agent répond';
      toast(rr.json.reprise
        ? `Plaque ${p.numero} validée (${range}). ${total - coches.size} pièce(s) à refaire : nouvelle plaque ${rr.json.reprise}, découpe en cours.`
        : `Plaque ${p.numero} validée, ${range}`);
      d.close();
      changee();
      setTimeout(verifier, 300);
    });
    actions.append(non, oui);

    function maj() {
      plateau.maj();
      liste.maj();
      const n = coches.size;
      oui.disabled = n === 0;
      oui.textContent = n === total ? 'Tout est bon : valider' : `Valider ${n} / ${total}`;
      bilan.className = `plaque-bilan${n && n < total ? ' alerte' : ''}`;
      bilan.textContent = n === 0 ? 'Aucune pièce cochée : clique celles qui sont bien imprimées.'
        : n === total ? `Les ${total} pièces sont bonnes.`
          : `${n} pièce(s) bonne(s), ${total - n} à refaire : elles repartiront sur une nouvelle plaque (redécoupée par Orca).`;
    }
    maj();
    chargement.replaceWith(corps, bilan, pied, actions);
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
