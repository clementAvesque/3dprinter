// Démarrage commun aux pages Suivi 3D et Galerie (script classique) : session, en-tête, machine affichée,
// état en direct (flux /events). La page Imprimer (app.js) garde son propre code.
//
//   Page.demarrer({ etat: (e, enLigne) => ..., fichiers: (liste) => ..., operation: (op) => ... })
//   Page.machine        identifiant de la machine affichée
//   Page.url(chemin)    adresse de l'API pour cette machine, ex. Page.url('/files')

const ETATS = { READY: 'Prête', PRINTING: 'Impression', BREAK: 'En pause', ERROR: 'Erreur' };

const Page = {
  machine: null,
  rappels: {},
  url: (chemin = '') => `${API}/machines/${encodeURIComponent(Page.machine)}${chemin}`,

  async demarrer(rappels) {
    Page.rappels = rappels;
    const me = await api('GET', '/me');
    if (!me.ok) return false;                         // api() a déjà renvoyé vers la connexion
    memoriserCsrf(me.json.csrf);
    $('utilisateur').textContent = me.json.utilisateur.nom;

    const l = await api('GET', '/machines');
    Page.afficherAgent(l.json?.agent);
    const liste = l.json?.machines || [];
    const select = $('machine');
    for (const m of liste) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.nom;
      select.appendChild(o);
    }
    select.hidden = liste.length < 2;
    if (!liste.length) { toast('Aucune machine : l\'agent ne s\'est jamais connecté.', true); return false; }
    // même machine que sur les autres pages
    let choix = null;
    try { choix = sessionStorage.getItem('machine'); } catch { /* navigation privée */ }
    await Page.choisir(liste.some((m) => m.id === choix) ? choix : liste[0].id);
    select.addEventListener('change', (ev) => Page.choisir(ev.target.value));
    Page.ecouter();
    return true;
  },

  async choisir(id) {
    Page.machine = id;
    $('machine').value = id;
    try { sessionStorage.setItem('machine', id); } catch { /* navigation privée */ }
    const m = await api('GET', `/machines/${encodeURIComponent(id)}`);
    if (m.ok) Page.etat(m.json.etat, m.json.enLigne);
    await Page.rappels.machine?.(id);
  },

  ecouter() {
    const flux = new EventSource(`${API}/events`, { withCredentials: AUTRE_ADRESSE });
    flux.addEventListener('agent', (ev) => Page.afficherAgent(JSON.parse(ev.data)));
    flux.addEventListener('etat', (ev) => {
      const d = JSON.parse(ev.data);
      if (d.machine === Page.machine) Page.etat(d.donnees, true);
    });
    flux.addEventListener('fichiers', (ev) => {
      const d = JSON.parse(ev.data);
      if (d.machine === Page.machine) Page.rappels.fichiers?.(d.donnees.liste || []);
    });
    flux.addEventListener('operation', (ev) => Page.rappels.operation?.(JSON.parse(ev.data)));
    flux.onerror = () => setTimeout(async () => { if (flux.readyState === EventSource.CLOSED) await api('GET', '/me'); }, 3000);
  },

  etat(e, enLigne) {
    if (!e || !enLigne) {
      $('badge').className = 'badge HORS';
      $('badge').textContent = 'Hors ligne';
    } else {
      $('badge').className = `badge ${e.online === false ? 'HORS' : e.state || ''}`;
      $('badge').textContent = e.online === false ? 'Machine injoignable' : ETATS[e.state] || 'Inconnu';
    }
    Page.rappels.etat?.(e, enLigne);
  },

  afficherAgent(a) {
    const ok = !!a?.connecte;
    $('point').className = `point ${ok ? 'on' : 'off'}`;
    $('agent-etat').textContent = ok ? 'agent connecté' : 'agent hors ligne';
    if (!ok) { $('badge').className = 'badge HORS'; $('badge').textContent = 'Hors ligne'; }
  },
};

// lance une impression (opération longue : son résultat arrive par le flux /events)
const operationsEnCours = new Map();
async function lancerImpression(fichier, emplacement) {
  const corps = { fichier };
  if (emplacement) corps.emplacement = Number(emplacement);
  const r = await api('POST', `/machines/${encodeURIComponent(Page.machine)}/print`, corps);
  if (!r.ok) { toast(texteErreur(r.json), true); return false; }
  if (r.statut === 202 && r.json?.operation) operationsEnCours.set(r.json.operation, `Lancement de ${fichier}`);
  toast(`Lancement de ${fichier}…`);
  return true;
}

function annoncerOperation(op) {
  if (!operationsEnCours.has(op.id) || op.statut === 'en_cours') return;
  const libelle = operationsEnCours.get(op.id);
  operationsEnCours.delete(op.id);
  if (op.statut === 'ok') toast(`${libelle} : terminé`);
  else toast(`${libelle} : ${texteErreur({ erreur: op.erreur, detail: op.detail })}`, true);
}

function dateCourte(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function octets(n) {
  if (n == null) return '—';
  const unites = ['o', 'Ko', 'Mo', 'Go'];
  let i = 0;
  while (n >= 1024 && i < unites.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(1).replace('.', ',') : n} ${unites[i]}`;
}

$('deconnexion').addEventListener('click', async () => {
  await api('POST', '/auth/logout', {});
  memoriserCsrf('');
  location.href = PAGE_CONNEXION;
});
$('conf-annuler')?.addEventListener('click', () => $('confirmation').close());
