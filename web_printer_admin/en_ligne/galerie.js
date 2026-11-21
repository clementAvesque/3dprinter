// Page Galerie (en ligne) : toutes les pièces (gcodes) de la machine, leurs stats d'impression,
// une fiche avec l'aperçu 3D, le lancement et la suppression.

import { Apercu3D } from './apercu3d.js';

let pieces = [];          // [{nom, temps_estime, poids, taille_octets, miniature, filament, nb, derniere}]
let fichiers = [];
let historique = [];
let dernierEtat = null;
let vue = null;           // aperçu 3D de la fiche (créé à la première ouverture)
let ouverte = null;
let modeSelection = false;
const selection = new Set();   // noms des pièces cochées
const urlMachine = () => `/machines/${encodeURIComponent(Page.machine)}`;

// ---------------------------------------------------------------- données

const STATUTS = {
  completed: ['Terminée', 'ok'], cancelled: ['Annulée', 'warn'], error: ['Erreur', 'danger'],
  in_progress: ['En cours', 'accent'], klippy_shutdown: ['Arrêt machine', 'danger'],
  klippy_disconnect: ['Coupure', 'danger'], server_exit: ['Coupure', 'danger'], interrupted: ['Interrompue', 'warn'],
};

async function charger({ rafraichir = false } = {}) {
  const [f, h] = await Promise.all([
    api('GET', `${urlMachine()}/files${rafraichir ? '?rafraichir=1' : ''}`),
    api('GET', `${urlMachine()}/history`),
  ]);
  if (!f.ok) toast(`Fichiers : ${texteErreur(f.json)}`, true);
  if (!h.ok) toast(`Historique : ${texteErreur(h.json)}`, true);
  fichiers = f.ok ? f.json || [] : fichiers;
  historique = (h.ok && Array.isArray(h.json) ? h.json : historique).slice().sort((a, b) => (b.debut || 0) - (a.debut || 0));
  calculer();
}

function calculer() {
  const terminees = historique.filter((h) => h.statut === 'completed');
  // nombre d'impressions terminées et dernière date par pièce
  const stats = {};
  for (const h of terminees) {
    const s = (stats[h.nom] ||= { nb: 0, derniere: 0 });
    s.nb++;
    s.derniere = Math.max(s.derniere, h.fin || h.debut || 0);
  }
  pieces = fichiers.map((g) => ({ ...g, ...(stats[g.nom] || { nb: 0, derniere: 0 }) }));

  $('r-pieces').textContent = pieces.length;
  $('r-prints').textContent = terminees.length;
  const grammes = historique.reduce((t, h) => t + (h.poids || 0), 0);
  $('r-filament').textContent = grammes >= 1000 ? `${(grammes / 1000).toFixed(2).replace('.', ',')} kg` : `${Math.round(grammes)} g`;
  $('r-temps').textContent = duree(historique.reduce((t, h) => t + (h.temps || 0), 0));

  afficherCartes();
  afficherHistorique();
}

// ---------------------------------------------------------------- cartes

const TRIS = {
  nom: (a, b) => a.nom.localeCompare(b.nom, 'fr'),
  imprimes: (a, b) => b.nb - a.nb || a.nom.localeCompare(b.nom, 'fr'),
  recent: (a, b) => b.derniere - a.derniere || a.nom.localeCompare(b.nom, 'fr'),
  poids: (a, b) => (b.poids || 0) - (a.poids || 0),
  temps: (a, b) => (b.temps_estime || 0) - (a.temps_estime || 0),
};

function piecesVisibles() {
  const filtre = $('recherche').value.trim().toLowerCase();
  return pieces.filter((p) => p.nom.toLowerCase().includes(filtre));
}

function afficherCartes() {
  const liste = piecesVisibles().sort(TRIS[$('tri').value]);
  const zone = $('cartes');
  zone.innerHTML = '';
  if (!liste.length) {
    zone.innerHTML = `<p class="muted">${pieces.length ? 'Aucune pièce ne correspond.' : 'Aucun gcode sur la machine pour l\'instant.'}</p>`;
    return;
  }
  for (const p of liste) {
    const carte = document.createElement('button');
    carte.className = `carte${modeSelection ? ' selectionnable' : ''}${selection.has(p.nom) ? ' cochee' : ''}`;
    carte.setAttribute('aria-pressed', modeSelection ? String(selection.has(p.nom)) : 'false');
    const infos = [p.temps_estime ? duree(p.temps_estime) : null, p.poids ? `${arrondi(p.poids)} g` : null].filter(Boolean).join(' · ');
    carte.innerHTML = `
      <span class="coche" aria-hidden="true"></span>
      <div class="vignette"><span class="muted small">pas d'aperçu</span></div>
      <div class="corps">
        <span class="nom"></span>
        ${p.filament ? `<span class="fil-liste small">${Filament.prevu(p.filament, { court: true })}</span>` : ''}
        <span class="muted small">${infos || '&nbsp;'}</span>
        <span class="small ${p.nb ? '' : 'muted'}">${p.nb ? `Imprimée ${p.nb}× · ${dateCourte(p.derniere)}` : 'Jamais imprimée'}</span>
      </div>`;
    carte.querySelector('.nom').textContent = p.nom;     // nom de fichier : jamais interprété en HTML
    carte.title = p.nom;
    if (p.miniature) {
      const vignette = carte.querySelector('.vignette');
      const repli = vignette.innerHTML;
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => { vignette.innerHTML = repli; };
      img.src = Page.url(`/files/${cheminUrl(p.nom)}/thumbnail`);
      vignette.replaceChildren(img);
    }
    carte.onclick = () => {
      if (!modeSelection) return ouvrirFiche(p);
      if (selection.has(p.nom)) selection.delete(p.nom);
      else selection.add(p.nom);
      carte.classList.toggle('cochee', selection.has(p.nom));
      carte.setAttribute('aria-pressed', String(selection.has(p.nom)));
      majBarreSelection();
    };
    zone.appendChild(carte);
  }
}

function afficherHistorique() {
  const tb = $('historique');
  tb.innerHTML = '';
  if (!historique.length) {
    tb.innerHTML = '<tr><td colspan="5" class="muted">Aucune impression pour l\'instant.</td></tr>';
    return;
  }
  for (const h of historique) {
    const [statut, ton] = STATUTS[h.statut] || [h.statut || '—', ''];
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="nom"></td><td>${dateCourte(h.debut)}</td><td>${duree(h.temps)}</td>`
      + `<td>${h.poids != null ? `${arrondi(h.poids)} g` : '—'}</td>`
      + `<td><span class="statut ${ton}"></span></td>`;
    tr.querySelector('.nom').textContent = h.nom || '—';
    tr.querySelector('.statut').textContent = statut;
    tb.appendChild(tr);
  }
}

// ---------------------------------------------------------------- suppression

function majBarreSelection() {
  const n = selection.size;
  $('sel-nb').textContent = `${n} sélectionnée${n > 1 ? 's' : ''}`;
  $('sel-supprimer').disabled = n === 0;
  $('sel-supprimer').textContent = n ? `Supprimer (${n})` : 'Supprimer';
  const visibles = piecesVisibles();
  $('sel-tout').textContent = visibles.length && visibles.every((p) => selection.has(p.nom))
    ? 'Tout désélectionner' : 'Tout sélectionner';
}

function basculerSelection(actif) {
  modeSelection = actif;
  selection.clear();
  $('barre-selection').hidden = !actif;
  $('btn-selection').hidden = actif;
  majBarreSelection();
  afficherCartes();
}

// demande confirmation ; résout true si l'utilisateur confirme
function confirmerSuppression(noms) {
  const d = $('suppression');
  $('c-titre').textContent = noms.length > 1 ? `Supprimer ${noms.length} pièces ?` : 'Supprimer cette pièce ?';
  const ul = $('c-liste');
  ul.innerHTML = '';
  const max = 8;
  for (const nom of noms.slice(0, max)) {
    const li = document.createElement('li');
    li.textContent = nom;
    ul.appendChild(li);
  }
  if (noms.length > max) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = `… et ${noms.length - max} autre${noms.length - max > 1 ? 's' : ''}`;
    ul.appendChild(li);
  }
  d.returnValue = '';
  d.showModal();
  $('c-ok').focus();
  return new Promise((ok) => d.addEventListener('close', () => ok(d.returnValue === 'oui'), { once: true }));
}

let suppressionEnCours = false;
async function supprimer(noms) {
  // une seule suppression à la fois (valider avec Entrée peut sinon relancer le bouton qui reprend le focus)
  if (!noms.length || suppressionEnCours) return false;
  suppressionEnCours = true;
  try {
    if (!(await confirmerSuppression(noms))) return false;
    const erreurs = [];
    let faits = 0;
    for (const nom of noms) {           // une par une : l'imprimante n'aime pas les rafales
      // le serveur redemande le code 2FA (action sensible) : api() ouvre la fenêtre si besoin
      const r = await api('DELETE', `${urlMachine()}/files/${cheminUrl(nom)}`);
      if (r.ok) faits++;
      else if (r.json?.erreur === 'annule') break;
      else erreurs.push(`${nom} : ${texteErreur(r.json)}`);
    }
    if (faits) toast(faits > 1 ? `${faits} pièces supprimées` : `${noms.length === 1 ? noms[0] : '1 pièce'} supprimée`);
    for (const e of erreurs) toast(e, true);
    await charger({ rafraichir: true });
    return faits > 0;
  } finally {
    suppressionEnCours = false;
  }
}

$('btn-selection').onclick = () => basculerSelection(true);
$('sel-annuler').onclick = () => basculerSelection(false);
$('sel-tout').onclick = () => {
  const visibles = piecesVisibles();
  const tout = visibles.every((p) => selection.has(p.nom));
  for (const p of visibles) tout ? selection.delete(p.nom) : selection.add(p.nom);
  majBarreSelection();
  afficherCartes();
};
$('sel-supprimer').onclick = async () => { if (await supprimer([...selection])) basculerSelection(false); };
$('f-supprimer').onclick = async () => {
  if (!ouverte) return;
  const nom = ouverte.nom;
  if (!(await supprimer([nom]))) return;
  $('fiche').close();
  if (vue && vue.nom === nom) vue.vider();
};

// ---------------------------------------------------------------- fiche d'une pièce

async function ouvrirFiche(p) {
  ouverte = p;
  $('f-nom').textContent = p.nom;
  $('f-nom').title = p.nom;
  $('f-temps').textContent = p.temps_estime ? duree(p.temps_estime) : '—';
  $('f-poids').textContent = p.poids ? `${arrondi(p.poids)} g` : '—';
  $('f-taille').textContent = octets(p.taille_octets);
  $('f-nb').textContent = p.nb ? `${p.nb}×` : 'jamais';
  $('f-derniere').textContent = p.nb ? dateCourte(p.derniere) : '—';
  $('f-couches').textContent = '…';
  $('f-suivi').href = `suivi.html?f=${encodeURIComponent(p.nom)}`;
  $('f-fil').innerHTML = Filament.prevu(p.filament ?? null);
  $('f-slot').value = '';
  conseillerEmplacement(p);
  $('fiche').showModal();

  vue ||= new Apercu3D($('f-vue'), (nom) => Page.url(`/files/${nom}`));
  vue.vider();
  const msg = $('f-message');
  msg.hidden = false;
  msg.textContent = 'Lecture du gcode… (la première fois, l\'agent l\'analyse sur la machine)';
  try {
    const meta = await vue.charger(p.nom);
    if (ouverte !== p) return;              // une autre fiche a été ouverte entre-temps
    const n = meta.layers.length;
    $('f-couches').textContent = n;
    const c = $('f-couche');
    c.max = Math.max(0, n - 1);
    c.value = n - 1;
    c.disabled = !n;
    majCouche(n - 1);
    msg.hidden = n > 0;
    if (!n) msg.textContent = 'Ce fichier ne contient aucune extrusion.';
  } catch (e) {
    if (ouverte !== p) return;
    $('f-couches').textContent = '—';
    msg.textContent = `Aperçu impossible : ${e.message}`;
  }
}

// présélectionne l'emplacement de l'ACE dont le fil ressemble le plus à celui prévu par le fichier
function conseillerEmplacement(p) {
  const el = $('f-conseil');
  const ace = dernierEtat?.ace;
  el.hidden = true;
  if (!ace || !ace.fils || !ace.fils.length) return;
  const c = Filament.conseil(p.filament, ace.fils);
  if (!c) {
    el.hidden = !p.filament;
    el.textContent = 'Aucun emplacement de l\'ACE ne contient de fil.';
    return;
  }
  $('f-slot').value = String(c.emplacement);
  const meme = Filament.alerte(p.filament, { emplacement: c.emplacement, matiere: c.matiere }) === null;
  el.innerHTML = `Conseillé : ${Filament.pastille(c.color)}emplacement ${c.emplacement}`
    + (c.matiere ? ` (${Filament.echapper(c.matiere)})` : '')
    + (meme ? ' : le plus proche du fil prévu.' : ' : attention, aucun emplacement n\'a la même matière.');
  el.classList.toggle('alerte', !meme);
  el.hidden = false;
}

function majCouche(i) {
  const L = vue && vue.meta ? vue.meta.layers : [];
  $('f-couche-txt').textContent = L.length ? `${i + 1} / ${L.length}` : '—';
}

$('f-couche').addEventListener('input', (ev) => {
  const i = Number(ev.target.value);
  vue.afficherJusqua(i);
  majCouche(i);
});
document.querySelectorAll('#fiche [data-vue]').forEach((b) => b.addEventListener('click', () => vue && vue.vue(b.dataset.vue)));
$('f-fermer').onclick = () => $('fiche').close();
$('fiche').addEventListener('click', (ev) => { if (ev.target === $('fiche')) $('fiche').close(); });
$('fiche').addEventListener('close', () => { ouverte = null; });

$('f-imprimer').onclick = async () => {
  if (!ouverte) return;
  $('f-imprimer').disabled = true;
  const ok = await lancerImpression(ouverte.nom, $('f-slot').value);
  $('f-imprimer').disabled = false;
  if (ok) $('fiche').close();
};

$('recherche').addEventListener('input', () => { afficherCartes(); if (modeSelection) majBarreSelection(); });
$('tri').addEventListener('change', afficherCartes);

// ---------------------------------------------------------------- démarrage

await Page.demarrer({
  etat: (e) => { dernierEtat = e; },
  machine: () => { basculerSelection(false); return charger(); },
  fichiers: (liste) => { fichiers = liste; calculer(); },
  operation: annoncerOperation,
});
