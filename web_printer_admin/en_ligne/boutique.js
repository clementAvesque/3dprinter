// Page Boutique (admin) : commandes des clients (valider, refuser = rembourser, expédier), lots, factures
// et clients. Données : /api/v1/boutique (comptes admin seulement).
// Une commande payée n'apporte que du gcode, découpé par le serveur (OrcaSlicer) : jamais de fichier
// envoyé par le navigateur d'un client.

import { Apercu3D } from './apercu3d.js';

const STATUTS = {
  en_attente_paiement: ['attente paiement', ''], abandonnee: ['abandonnée', ''], payee: ['à valider', 'warn'],
  validee: ['validée', 'accent'], dans_un_lot: ['dans un lot', 'accent'], en_impression: ['en impression', 'accent'],
  suspendue: ['suspendue', 'warn'], imprimee: ['à expédier', 'ok'], expediee: ['expédiée', 'ok'], livree: ['livrée', 'ok'],
  remboursee: ['remboursée', 'danger'],
};
const PROPRETES = { fine: 'Fine 0,2 mm + lissage', rapide: 'Rapide 0,28 mm' };
const euros = (cts) => (cts == null ? '—' : `${(cts / 100).toFixed(2).replace('.', ',')} €`);
const date = (ms) => (ms ? new Date(ms).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const jours = (ms) => (ms ? Math.ceil((ms - Date.now()) / 864e5) : null);
const mm = (v) => `${Math.round(v * 10) / 10}`.replace('.', ',');
const echapper = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const B = (chemin) => `/boutique${chemin}`;

let ouverte = null;

// ---------------------------------------------------------------- résumé

async function chargerResume() {
  const r = await api('GET', B('/resume'));
  if (!r.ok) return toast(texteErreur(r.json), true);
  const d = r.json;
  $('r-valider').textContent = d.a_valider;
  $('r-retard').textContent = d.en_retard_objectif;
  $('r-devis').textContent = d.devis_en_attente;
  $('r-clients').textContent = d.clients;
  const alertes = [];
  if (!d.paiement_configure) alertes.push('Stripe n\'est pas encore branché : refus et remboursements automatiques sont en attente.');
  if (d.courriel === 'journal') alertes.push('Aucun service d\'e-mail : les e-mails sont seulement écrits dans les logs du serveur.');
  $('r-alertes').hidden = !alertes.length;
  $('r-alertes').textContent = alertes.join(' ');
}

// ---------------------------------------------------------------- onglets

const chargeurs = { commandes: chargerCommandes, lots: chargerLots, factures: chargerFactures, clients: chargerClients };
let onglet = 'commandes';
document.querySelectorAll('[data-onglet]').forEach((b) => b.addEventListener('click', () => {
  onglet = b.dataset.onglet;
  document.querySelectorAll('[data-onglet]').forEach((x) => x.classList.toggle('actif', x === b));
  for (const nom of Object.keys(chargeurs)) $(`o-${nom}`).hidden = nom !== onglet;
  chargeurs[onglet]();
}));

function remplir(tbody, lignes, vide, colonnes) {
  const t = $(tbody);
  t.innerHTML = lignes.length ? '' : `<tr><td colspan="${colonnes}" class="muted">${vide}</td></tr>`;
  for (const l of lignes) t.appendChild(l);
}

function ligne(cellules) {
  const tr = document.createElement('tr');
  tr.innerHTML = cellules.join('');
  return tr;
}

// ---------------------------------------------------------------- commandes

async function chargerCommandes() {
  const statut = $('filtre-statut').value;
  const r = await api('GET', B(`/commandes${statut ? `?statut=${statut}` : ''}`));
  if (!r.ok) return toast(texteErreur(r.json), true);
  remplir('t-commandes', r.json.map((c) => {
    const [txt, ton] = STATUTS[c.statut] || [c.statut, ''];
    const limite = c.statut === 'payee' ? c.validation_limite_le : c.envoi_limite_le;
    const j = ['payee', 'validee', 'dans_un_lot', 'en_impression', 'suspendue', 'imprimee'].includes(c.statut) ? jours(limite) : null;
    const tr = ligne([`<td>${c.id}</td>`, `<td class="nom">${echapper(c.client.nom)}<br><span class="muted small">${echapper(c.client.email)}</span></td>`,
      `<td>${c.nb_pieces}</td>`, `<td>${euros(c.total_cts)}</td>`, `<td><span class="statut ${ton}">${txt}</span></td>`,
      `<td>${j == null ? '—' : `<span class="${j <= 2 ? 'statut danger' : ''}">${j} j</span>`}</td>`]);
    tr.className = 'cliquable';
    tr.onclick = () => ouvrirCommande(c.id);
    return tr;
  }), 'Aucune commande ici.', 6);
}

$('filtre-statut').addEventListener('change', chargerCommandes);
$('rafraichir').addEventListener('click', () => { chargerResume(); chargeurs[onglet](); });

async function ouvrirCommande(id) {
  const r = await api('GET', B(`/commandes/${id}`));
  if (!r.ok) return toast(texteErreur(r.json), true);
  const c = r.json;
  ouverte = c;
  const [txt] = STATUTS[c.statut] || [c.statut];
  $('c-titre').textContent = `Commande n° ${c.id}`;
  $('c-statut').textContent = txt;
  $('c-total').textContent = euros(c.total_cts);
  $('c-paye').textContent = date(c.paye_le);
  const limite = c.statut === 'payee' ? c.validation_limite_le : c.envoi_limite_le;
  $('c-echeance').textContent = limite ? `${date(limite)} (${jours(limite)} j)` : '—';
  $('c-client').textContent = `${c.client.nom} · ${c.client.email}`;
  const a = c.livraison_adresse || {};
  $('c-adresse').textContent = [c.livraison_nom, a.ligne1, a.ligne2, `${a.code_postal || ''} ${a.ville || ''}`.trim(), a.pays].filter(Boolean).join(', ');
  const rg = c.devis.reglages;
  $('c-reglages').textContent = `Remplissage ${rg.remplissage_pct} % · ${rg.couches_surface} couches de surface · ${PROPRETES[rg.proprete]}`;
  const ul = $('c-pieces');
  ul.innerHTML = '';
  for (const p of c.devis.pieces) {
    const li = document.createElement('li');
    li.textContent = `${p.nom} × ${p.quantite} · ${mm(p.dims_mm[0])} × ${mm(p.dims_mm[1])} × ${mm(p.dims_mm[2])} mm`;
    ul.appendChild(li);
  }
  const d = c.devis;
  $('c-decoupe').textContent = d.poids_g == null ? '' : `${mm(d.poids_g)} g · ${d.nb_couches} couches · ${duree(d.duree_s)}`;
  const tel = $('c-gcode');
  tel.hidden = ['en_attente_paiement', 'abandonnee'].includes(c.statut) || d.statut !== 'pret';
  tel.href = `${API}/boutique/commandes/${c.id}/gcode`;
  $('c-motif').hidden = !c.motif_refus;
  $('c-motif').textContent = c.motif_refus ? `Motif : ${c.motif_refus}` : '';
  actions(c);
  $('fiche').showModal();
  voirGcode(c);
}

function actions(c) {
  const zone = $('c-actions');
  zone.innerHTML = '';
  const bouton = (texte, classe, fn) => {
    const b = document.createElement('button');
    b.textContent = texte;
    b.className = classe;
    b.onclick = async () => { b.disabled = true; await fn(); b.disabled = false; };
    zone.appendChild(b);
  };
  if (c.statut === 'payee') bouton('Valider', 'primaire', () => agir(`/commandes/${c.id}/valider`, 'Commande validée'));
  if (['payee', 'validee', 'suspendue'].includes(c.statut)) bouton('Refuser et rembourser', 'danger', () => refuser(c));
  if (c.statut === 'imprimee') bouton('Expédiée…', 'primaire', () => expedier(c));
  if (c.statut === 'expediee') bouton('Livrée', 'fantome', () => agir(`/commandes/${c.id}/livree`, 'Commande livrée'));
}

async function agir(chemin, message, corps = {}) {
  const r = await api('POST', B(chemin), corps);
  if (!r.ok) { toast(texteErreur(r.json), true); return false; }
  toast(message);
  await Promise.all([chargerResume(), chargerCommandes()]);
  if (ouverte) await ouvrirCommande(ouverte.id);
  return true;
}

function demander(dialogue, formulaire, annuler) {
  const d = $(dialogue);
  d.returnValue = '';
  d.showModal();
  $(annuler).onclick = () => d.close();
  return new Promise((ok) => d.addEventListener('close', () => ok(d.returnValue === 'ok'), { once: true }));
}

async function refuser(c) {
  $('refus-detail').value = '';
  if (!(await demander('refus', 'refus-form', 'refus-annuler'))) return;
  const motif = [$('refus-motif').value, $('refus-detail').value.trim()].filter(Boolean).join(' : ');
  await agir(`/commandes/${c.id}/refuser`, 'Commande refusée et remboursée', { motif });
}

async function expedier(c) {
  $('expedition-suivi').value = '';
  if (!(await demander('expedition', 'expedition-form', 'expedition-annuler'))) return;
  await agir(`/commandes/${c.id}/expedier`, 'Commande expédiée, client prévenu', { numero_suivi: $('expedition-suivi').value.trim() });
}

$('c-fermer').onclick = () => $('fiche').close();
$('fiche').addEventListener('close', () => { ouverte = null; });

// ---------------------------------------------------------------- aperçu 3D du gcode de la commande

const duree = (sec) => {
  if (sec == null) return '—';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
};

let vue = null;
async function voirGcode(c) {
  const msg = $('c-message');
  msg.hidden = false;
  if (['en_attente_paiement', 'abandonnee'].includes(c.statut)) {
    vue?.vider();
    msg.textContent = 'Pas encore payée : le gcode sera disponible après le paiement.';
    return;
  }
  msg.textContent = 'Chargement de l\'aperçu du gcode…';
  try {
    vue ||= new Apercu3D($('c-vue'), () => `${API}/boutique/commandes/${ouverte.id}/gcode`);
    await vue.charger('gcode');
    msg.hidden = true;
  } catch (e) {
    msg.textContent = `Aperçu impossible : ${e.message}`;
  }
}

// ---------------------------------------------------------------- lots, factures, clients

async function chargerLots() {
  const r = await api('GET', B('/lots'));
  if (!r.ok) return toast(texteErreur(r.json), true);
  remplir('t-lots', r.json.map((l) => ligne([`<td>${l.id}</td>`, `<td>${echapper(l.imprimante_id)}</td>`,
    `<td>${l.proprete_mm === 0.2 ? 'Fine' : 'Rapide'}</td>`, `<td>${l.nb_pieces}</td>`, `<td>${l.commandes.join(', ') || '—'}</td>`,
    `<td>${echapper(l.statut)}</td>`, `<td>${date(l.cree_le)}</td>`])), 'Aucun lot pour l\'instant.', 7);
}

async function chargerFactures() {
  const r = await api('GET', B('/factures'));
  if (!r.ok) return toast(texteErreur(r.json), true);
  remplir('t-factures', r.json.map((f) => ligne([`<td>${echapper(f.numero)}</td>`, `<td>${f.commande_id}</td>`,
    `<td class="nom">${echapper(f.client_nom)}<br><span class="muted small">${echapper(f.client_email)}</span></td>`,
    `<td>${euros(f.total_cts)}</td>`, `<td>${date(f.emise_le)}</td>`])), 'Aucune facture pour l\'instant (elles arrivent avec le paiement).', 5);
}

async function chargerClients() {
  const r = await api('GET', B('/clients'));
  if (!r.ok) return toast(texteErreur(r.json), true);
  remplir('t-clients', r.json.map((c) => ligne([`<td>${echapper(c.nom)}</td>`, `<td>${echapper(c.email)}</td>`,
    `<td>${c.email_verifie ? 'oui' : '<span class="statut warn">non</span>'}</td>`, `<td>${c.commandes}</td>`,
    `<td>${new Date(c.cree_le).toLocaleDateString('fr-FR')}</td>`])), 'Aucun client.', 5);
}

// ---------------------------------------------------------------- démarrage

await Page.demarrer({});
await Promise.all([chargerResume(), chargerCommandes()]);
