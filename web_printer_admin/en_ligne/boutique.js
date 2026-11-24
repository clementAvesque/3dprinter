// Page Boutique (admin) : commandes des clients (valider, refuser = rembourser, expédier, bon de colis),
// plaques à imprimer, factures et clients. Données : /api/v1/boutique (comptes admin seulement).
// Une commande payée n'apporte que du gcode, découpé par le serveur (OrcaSlicer) : jamais de fichier
// envoyé par le navigateur d'un client.

import { Apercu3D } from './apercu3d.js';
import { brancherApercuStl } from './apercu-stl.js';

const STATUTS = {
  en_attente_paiement: ['attente paiement', ''], abandonnee: ['abandonnée', ''], payee: ['à valider', 'warn'],
  validee: ['validée · envoi à l\'imprimante', 'accent'], dans_un_lot: ['en attente d\'impression', 'accent'],
  en_impression: ['en cours d\'impression', 'accent'], suspendue: ['suspendue', 'warn'], imprimee: ['imprimée · à expédier', 'ok'],
  expediee: ['envoyée', 'ok'], livree: ['livrée', 'ok'], remboursee: ['remboursée', 'danger'],
};
const STATUTS_PLAQUE = {
  a_envoyer: ['à envoyer à l\'imprimante', 'warn'], a_faire: ['à faire', 'accent'], en_impression: ['en cours d\'impression', 'accent'],
  imprimee: ['imprimée · à valider', 'warn'], validee: ['validée', 'ok'], annulee: ['annulée', ''],
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
  if (d.paiement_mode === 'test') alertes.push('Stripe est en mode test : les paiements sont fictifs (carte 4242…).');
  if (d.courriel === 'journal') alertes.push('Aucun service d\'e-mail : les e-mails sont seulement écrits dans les logs du serveur.');
  $('r-alertes').hidden = !alertes.length;
  $('r-alertes').textContent = alertes.join(' ');
}

// ---------------------------------------------------------------- onglets

const chargeurs = { commandes: chargerCommandes, plaques: chargerPlaques, factures: chargerFactures, clients: chargerClients };
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
  $('c-titre').textContent = `Commande n° ${c.id}${c.ref ? ` · réf. client ${c.ref}` : ''}`;
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
  // un bloc par devis (commande groupée : plusieurs devis = plusieurs plateaux, une seule livraison)
  const liste = c.devis_liste?.length ? c.devis_liste : [c.devis];
  const payee = !['en_attente_paiement', 'abandonnee'].includes(c.statut);
  const ul = $('c-pieces');
  ul.innerHTML = '';
  for (const d of liste) {
    const li = document.createElement('li');
    li.className = 'devis-commande';
    const titre = document.createElement('div');
    titre.className = 'row';
    const b = document.createElement('button');
    b.className = 'fantome';
    b.textContent = `Devis n° ${d.id}${d.ref ? ` · ${d.ref}` : ''}`;
    b.title = 'voir son gcode en 3D';
    b.disabled = !payee || d.statut !== 'pret';
    b.onclick = () => voirGcode(c, d.id);
    const infos = document.createElement('span');
    infos.className = 'muted small';
    infos.textContent = d.poids_g == null ? '' : `${mm(d.poids_g)} g · ${d.nb_couches} couches · ${duree(d.duree_s)}`;
    titre.append(b, infos);
    if (payee && d.statut === 'pret') {
      const tel = document.createElement('a');
      tel.className = 'lien small';
      tel.textContent = 'télécharger le gcode';
      tel.href = `${API}/boutique/commandes/${c.id}/devis/${d.id}/gcode`;
      titre.append(tel);
    }
    const pieces = document.createElement('ul');
    pieces.className = 'small muted';
    for (const p of d.pieces) {
      const lp = document.createElement('li');
      lp.textContent = `${p.nom} × ${p.quantite} · ${mm(p.dims_mm[0])} × ${mm(p.dims_mm[1])} × ${mm(p.dims_mm[2])} mm`
        + (p.echelle && p.echelle !== 1 ? ` (taille ×${String(p.echelle).replace('.', ',')})` : '');
      pieces.appendChild(lp);
    }
    li.append(titre, pieces);
    ul.appendChild(li);
  }
  const plaquesTxt = (c.plaques || []).map((p) => `${p.numero} (${(STATUTS_PLAQUE[p.statut] || [p.statut])[0]})`).join(', ');
  $('c-decoupe').textContent = [liste.length > 1 ? `Commande groupée : ${liste.length} devis, ${liste.length} plateaux, une seule livraison.` : '',
    plaquesTxt ? `Plaques : ${plaquesTxt}.` : ''].filter(Boolean).join(' ');
  $('c-gcode').hidden = true;      // un lien par devis, dans la liste
  $('c-motif').hidden = !c.motif_refus;
  $('c-motif').textContent = c.motif_refus ? `Motif : ${c.motif_refus}` : '';
  actions(c);
  $('fiche').showModal();
  voirGcode(c, liste[0].id);
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
  // bon de colis : page à imprimer et à glisser dans le colis (adresse, pièces, plaques)
  if (!['en_attente_paiement', 'abandonnee', 'remboursee'].includes(c.statut)) {
    bouton('Bon de colis', 'fantome', () => { window.open(`bon.html?commande=${encodeURIComponent(c.id)}`, '_blank', 'noopener'); });
  }
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
async function voirGcode(c, devisId) {
  const msg = $('c-message');
  msg.hidden = false;
  if (['en_attente_paiement', 'abandonnee'].includes(c.statut)) {
    vue?.vider();
    msg.textContent = 'Pas encore payée : le gcode sera disponible après le paiement.';
    return;
  }
  msg.textContent = `Chargement de l'aperçu du gcode (devis n° ${devisId})…`;
  try {
    vue ||= new Apercu3D($('c-vue'), (nom) => `${API}/boutique/commandes/${ouverte.id}/devis/${nom}/gcode`);
    await vue.charger(String(devisId));
    msg.hidden = true;
  } catch (e) {
    msg.textContent = `Aperçu impossible : ${e.message}`;
  }
}

// ---------------------------------------------------------------- plaques, factures, clients

// ---- réimprimer des pièces choisies sur une plaque (« je refais juste ce taquet »)
// Chaque plaque porte une check-list de ses exemplaires (lus dans le gcode) ; dès qu'une case est cochée,
// un bouton apparaît sous la liste et demande au serveur une nouvelle plaque avec ces seules pièces.
// La plaque d'origine n'est pas touchée : rien n'est marqué « raté ».
function listeAReimprimer(p, objets) {
  const coches = new Set();
  const liste = document.createElement('div');
  liste.className = 'tri';
  objets.forEach((o, i) => {
    const label = document.createElement('label');
    label.className = 'objet-ligne';
    const caseO = document.createElement('input');
    caseO.type = 'checkbox';
    caseO.onchange = () => { if (caseO.checked) coches.add(o.nom); else coches.delete(o.nom); maj(); };
    const pastille = document.createElement('span');
    pastille.className = 'objet-pastille';
    pastille.textContent = String(i + 1);
    const texte = document.createElement('span');
    texte.textContent = `${o.piece_nom} · n° ${o.exemplaire}${o.client_nom ? ` · ${o.client_nom}` : ''}`;
    label.append(caseO, pastille, texte);
    // le nom du fichier vient du client et ne veut souvent rien dire : la forme, elle, est sûre
    brancherApercuStl(label, `${API}/boutique/plaques/${p.id}/pieces/${o.piece_id}/stl`, o.dims_mm, o.piece_nom);
    liste.append(label);
  });
  const bouton = document.createElement('button');
  bouton.type = 'button';
  bouton.className = 'primaire';
  bouton.onclick = async () => {
    bouton.disabled = true;
    const r = await api('POST', B(`/plaques/${p.id}/refaire`), { objets: [...coches] });
    if (!r.ok) { bouton.disabled = false; return toast(texteErreur(r.json), true); }
    toast(`Nouvelle plaque ${r.json.reprise} : ${r.json.pieces} pièce(s), découpe en cours.`);
    await chargerPlaques();
  };
  function maj() {
    bouton.hidden = !coches.size;
    bouton.textContent = `Régénérer une plaque avec ${coches.size} pièce${coches.size > 1 ? 's' : ''}`;
  }
  maj();
  return [liste, bouton];
}

// bloc dépliable : les exemplaires ne sont demandés au serveur qu'à l'ouverture (une plaque = une requête)
function choixPieces(p) {
  const bloc = document.createElement('details');
  bloc.className = 'plaque-choix';
  const titre = document.createElement('summary');
  titre.textContent = 'Réimprimer des pièces…';
  bloc.append(titre);
  let charge = false;
  bloc.addEventListener('toggle', async () => {
    if (!bloc.open || charge) return;
    charge = true;
    const attente = document.createElement('p');
    attente.className = 'muted small';
    attente.textContent = 'Lecture des pièces du plateau…';
    bloc.append(attente);
    const r = await api('GET', B(`/plaques/${p.id}/objets`));
    if (!r.ok) {
      charge = false;
      attente.className = 'small statut danger';
      attente.textContent = texteErreur(r.json);
      return;
    }
    attente.replaceWith(...listeAReimprimer(p, r.json.objets));
  });
  return bloc;
}

async function chargerPlaques() {
  const r = await api('GET', B('/plaques'));
  if (!r.ok) return toast(texteErreur(r.json), true);
  remplir('t-plaques', r.json.map((p) => {
    const [txt, ton] = p.en_decoupe ? ['reprise · découpe en cours', 'accent'] : STATUTS_PLAQUE[p.statut] || [p.statut, ''];
    const liens = [p.reprise_de ? `reprise de ${p.reprise_de}` : null, p.reprises?.length ? `ratées refaites sur ${p.reprises.join(', ')}` : null]
      .filter(Boolean).join(' · ');
    const contenu = p.contenu.map((c) => `<b>${echapper(c.ref)}</b> · ${echapper(c.client_nom)}<br><span class="muted small">`
      + `${c.pieces.map((pc) => `${echapper(pc.nom)} × ${pc.quantite}${pc.ratees ? ` (${pc.ratees} ratée${pc.ratees > 1 ? 's' : ''})` : ''}`).join(', ')}</span>`).join('<br>') || '—';
    const tr = ligne([`<td><b>${echapper(p.numero)}</b>${p.tentatives > 1 ? `<br><span class="muted small">${p.tentatives} essais</span>` : ''}`
      + `${liens ? `<br><span class="muted small">${echapper(liens)}</span>` : ''}</td>`,
      `<td class="nom">${contenu}</td>`, `<td class="small">${echapper(p.fichier || '—')}</td>`,
      `<td><span class="statut ${ton}">${txt}</span>${p.erreur ? `<br><span class="small statut danger">${echapper(p.erreur)}</span>` : ''}</td>`,
      `<td>${duree(p.duree_s)}</td>`, '<td class="actions-plaque"></td>']);
    tr.querySelector('.nom').append(choixPieces(p));
    const zone = tr.querySelector('.actions-plaque');
    const bouton = (texte, classe, fn) => {
      const b = document.createElement('button');
      b.textContent = texte;
      b.className = classe;
      b.onclick = async () => { b.disabled = true; await fn(); b.disabled = false; };
      zone.appendChild(b);
    };
    if (p.statut === 'a_faire') {
      bouton('Lancer', 'primaire', () => agirPlaque(p, 'lancer', `Plaque ${p.numero} lancée`));
      if (p.machine_occupee) zone.lastChild.title = 'l\'imprimante est déjà en train d\'imprimer';
    }
    if (p.statut === 'a_envoyer') bouton('Renvoyer', 'fantome', () => agirPlaque(p, 'renvoyer', `Plaque ${p.numero} : envoi relancé`));
    if (p.statut === 'imprimee') bouton('Valider…', 'primaire', async () => Plaques.montrer(p));
    return tr;
  }), 'Aucune plaque : elles sont créées quand tu valides une commande.', 6);
}

document.addEventListener('plaques-changees', () => { if (onglet === 'plaques') chargerPlaques(); chargerResume(); });

async function agirPlaque(p, action, message) {
  const r = await api('POST', B(`/plaques/${p.id}/${action}`), {});
  if (!r.ok) { toast(texteErreur(r.json), true); return; }
  toast(message);
  await chargerPlaques();
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
