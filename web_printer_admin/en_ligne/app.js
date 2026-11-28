// Page « Imprimer » : état en direct (flux /events), caméra, fichiers, lancement d'une impression.
const ETATS = { READY: 'Prête', PRINTING: 'Impression', BREAK: 'En pause', ERROR: 'Erreur' };
let machine = null;            // identifiant de la machine affichée
let fichiers = [];
let choisi = null;             // nom du gcode sélectionné
let dernierEtat = null;
const operations = new Map();  // id -> libellé (pour annoncer leur résultat)

// ---------------------------------------------------------------- démarrage

(async function demarrer() {
  const me = await api('GET', '/me');
  if (!me.ok) return;                                  // api() a déjà redirigé vers /connexion
  memoriserCsrf(me.json.csrf);
  $('utilisateur').textContent = me.json.utilisateur.nom;

  const l = await api('GET', '/machines');
  afficherAgent(l.json.agent);
  const liste = l.json.machines || [];
  const select = $('machine');
  for (const m of liste) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.nom;
    select.appendChild(o);
  }
  select.hidden = liste.length < 2;
  if (!liste.length) { $('cartes').textContent = 'Aucune machine : l\'agent ne s\'est jamais connecté.'; return; }
  // même machine que sur les pages Suivi 3D et Galerie
  let memo = null;
  try { memo = sessionStorage.getItem('machine'); } catch { /* navigation privée */ }
  const id = liste.some((m) => m.id === memo) ? memo : liste[0].id;
  select.value = id;
  await choisirMachine(id);
  ecouter();
})();

async function choisirMachine(id) {
  machine = id;
  try { sessionStorage.setItem('machine', id); } catch { /* navigation privée */ }
  if ($('fiche').open) $('fiche').close();
  choisi = null;
  arreterDirect();
  const m = await api('GET', `/machines/${encodeURIComponent(id)}`);
  if (m.ok) afficherEtat(m.json.etat, m.json.enLigne);
  await chargerFichiers();
}

$('machine').addEventListener('change', (ev) => choisirMachine(ev.target.value));

// ---------------------------------------------------------------- temps réel

function ecouter() {
  const flux = new EventSource(`${API}/events`, { withCredentials: AUTRE_ADRESSE });
  flux.addEventListener('agent', (ev) => afficherAgent(JSON.parse(ev.data)));
  flux.addEventListener('etat', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.machine === machine) afficherEtat(d.donnees, true);
  });
  flux.addEventListener('fichiers', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.machine === machine) { fichiers = d.donnees.liste || []; afficherFichiers(); }
  });
  flux.addEventListener('operation', (ev) => {
    const op = JSON.parse(ev.data);
    if (!operations.has(op.id) || op.statut === 'en_cours') return;
    const libelle = operations.get(op.id);
    operations.delete(op.id);
    if (op.statut === 'ok') toast(`${libelle} : terminé`);
    else toast(`${libelle} : ${texteErreur({ erreur: op.erreur, detail: op.detail })}`, true);
  });
  // coupure (session expirée, réseau) : le navigateur se reconnecte seul ; si la session est finie, retour à la connexion
  flux.onerror = () => setTimeout(async () => { if (flux.readyState === EventSource.CLOSED) await api('GET', '/me'); }, 3000);
}

function afficherAgent(a) {
  const ok = !!a?.connecte;
  $('point').className = `point ${ok ? 'on' : 'off'}`;
  $('agent-etat').textContent = ok ? 'agent connecté' : 'agent hors ligne';
  if (!ok) { $('badge').className = 'badge HORS'; $('badge').textContent = 'Hors ligne'; }
}

function afficherEtat(e, enLigne) {
  dernierEtat = e;
  if (!e || !enLigne) {
    $('badge').className = 'badge HORS';
    $('badge').textContent = 'Hors ligne';
    return;
  }
  const etat = e.online === false ? 'HORS' : e.state;
  $('badge').className = `badge ${etat || ''}`;
  $('badge').textContent = e.online === false ? 'Machine injoignable' : ETATS[e.state] || 'Inconnu';

  const p = e.print;
  const imprime = (e.state === 'PRINTING' || e.state === 'BREAK') && p;
  $('pr-fichier').textContent = imprime ? p.filename : 'Aucune impression';
  $('pr-barre').style.width = `${imprime ? p.progress_percent : 0}%`;
  $('pr-pct').textContent = imprime ? `${p.progress_percent} %` : '—';
  $('pr-couche').textContent = imprime && p.layer != null ? `${p.layer} / ${p.total_layers ?? '?'}` : '—';
  $('pr-ecoule').textContent = imprime ? duree(p.elapsed_seconds) : '—';
  $('pr-restant').textContent = imprime ? duree(p.remaining_seconds) : '—';
  $('pr-vitesse').textContent = p?.speed_factor != null ? `${Math.round(p.speed_factor * 100)} %` : '—';
  $('pr-ventilo').textContent = p?.fan_percent != null ? `${p.fan_percent} %` : '—';
  const t = (x) => (x?.value == null ? '—' : `${arrondi(x.value)} °C${x.target ? ` / ${x.target}` : ''}`);
  $('t-buse').textContent = t(e.nozzle?.temperature);
  $('t-lit').textContent = t(e.bed?.temperature);
  const u = p?.filament?.utilise;
  $('fil').textContent = imprime && u?.emplacement ? `fil : emplacement ${u.emplacement}${u.matiere ? ` · ${u.matiere}` : ''}` : '';

  $('btn-pause').disabled = e.state !== 'PRINTING';
  $('btn-reprise').disabled = e.state !== 'BREAK';
  $('btn-annuler').disabled = !imprime;
  remplirEmplacements(e.ace?.fils);
  majOccupation();
  afficherReglages(e, imprime);
}

// ---------------------------------------------------------------- ACE, températures, mouvements, réglages

const ETATS_ACE = { ON: 'Prêt', OFF: 'Non détecté', DRY: 'Séchage en cours' };

function afficherReglages(e, imprime) {
  // ACE : les 4 emplacements, celui chargé dans la tête mis en avant
  const ace = e.ace || {};
  $('ace-etat').className = `badge ${ace.state || ''}`;
  $('ace-etat').textContent = ETATS_ACE[ace.state] || '—';
  const signature = JSON.stringify([ace.fils, ace.slot_actif]);
  if ($('slots').dataset.signature !== signature) {
    $('slots').dataset.signature = signature;
    $('slots').replaceChildren(...[1, 2, 3, 4].map((i) => {
      const f = (ace.fils || []).find((x) => x.emplacement === i);
      const couleur = couleurSure(f?.color);
      const d = document.createElement('div');
      d.className = `slot${ace.slot_actif === i ? ' actif' : ''}`;
      d.title = couleur ? `${f.matiere || 'matière inconnue'} · ${couleur}` : 'vide';
      const bobine = document.createElement('div');
      bobine.className = `bobine${couleur ? '' : ' vide'}`;
      if (couleur) bobine.style.background = couleur;
      const num = document.createElement('b');
      num.textContent = String(i);
      const mat = document.createElement('span');
      mat.textContent = couleur ? (f.matiere || '?') : 'vide';
      d.append(bobine, num, mat);
      if (ace.slot_actif === i) {
        const t = document.createElement('span');
        t.className = 'tete';
        t.textContent = 'dans la tête';
        d.append(t);
      }
      return d;
    }));
    remplirFilSlot(ace.fils, ace.slot_actif);
  }
  const seche = ace.state === 'DRY';
  $('btn-dry').disabled = seche || ace.state === 'OFF';
  $('btn-dry-stop').disabled = !seche;

  // températures
  const t = (x) => (x?.value == null ? '—' : `${arrondi(x.value)} °C`);
  const c = (x) => (x?.target ? `cible : ${x.target} °C` : 'cible : off');
  $('tc-buse').textContent = t(e.nozzle?.temperature);
  $('cible-buse').textContent = c(e.nozzle?.temperature);
  $('tc-lit').textContent = t(e.bed?.temperature);
  $('cible-lit').textContent = c(e.bed?.temperature);

  // position et mouvements (bloqués pendant une impression)
  const pos = e.nozzle?.position || {};
  $('pos-x').textContent = arrondi(pos.x, 1);
  $('pos-y').textContent = arrondi(pos.y, 1);
  $('pos-z').textContent = arrondi(pos.z, 2);
  const occupe = !!imprime || e.online === false;
  document.querySelectorAll('[data-jog], [data-home], #btn-moteurs, #btn-charger, #btn-decharger')
    .forEach((b) => { b.disabled = occupe; });
  $('mvt-info').hidden = !imprime;

  // curseurs : valeurs de la machine, sauf celui qu'on est en train de bouger
  const p = e.print;
  if (p?.speed_factor != null) majCurseur('speed', Math.round(p.speed_factor * 100));
  if (p?.fan_percent != null) majCurseur('fan', Math.round(p.fan_percent));
  if (p?.flow_factor != null) majCurseur('flow', Math.round(p.flow_factor * 100));
}

function majCurseur(id, valeur) {
  if (document.activeElement === $(id) || Date.now() - (Number($(id).dataset.touche) || 0) < 5000) return;
  $(id).value = valeur;
  $(`v-${id}`).textContent = `${valeur} %`;
}

function remplirFilSlot(fils, actif) {
  const s = $('fil-slot');
  const avant = s.value;
  s.replaceChildren(...[['', 'Sans ACE (fil direct)'], ...[1, 2, 3, 4].map((i) => {
    const f = (fils || []).find((x) => x.emplacement === i);
    return [String(i), `Emplacement ${i}${f?.color ? ` · ${f.matiere || '?'}` : ' · vide'}`];
  })].map(([v, txt]) => { const o = document.createElement('option'); o.value = v; o.textContent = txt; return o; }));
  // première fois : l'emplacement chargé dans la tête ; ensuite on garde le choix de l'utilisateur
  const defaut = actif ? String(actif) : ((fils || []).length ? '1' : '');
  s.value = s.dataset.rempli && [...s.options].some((o) => o.value === avant) ? avant : defaut;
  s.dataset.rempli = '1';
}

// emplacements de l'ACE avec leur couleur et leur matière (ceux qui ont du fil)
function remplirEmplacements(fils) {
  const s = $('emplacement');
  const avant = s.value;
  const signature = JSON.stringify(fils || []);
  if (s.dataset.signature === signature) return;
  s.dataset.signature = signature;
  s.innerHTML = '';
  const defaut = document.createElement('option');
  defaut.value = '';
  defaut.textContent = 'Emplacement par défaut (1)';
  s.appendChild(defaut);
  for (const f of fils || []) {
    if (!f.color) continue;
    const o = document.createElement('option');
    o.value = String(f.emplacement);
    o.textContent = `Emplacement ${f.emplacement}${f.matiere ? ` · ${f.matiere}` : ''} (${f.color})`;
    s.appendChild(o);
  }
  s.value = [...s.options].some((o) => o.value === avant) ? avant : '';
}

// ---------------------------------------------------------------- fichiers

async function chargerFichiers() {
  const r = await api('GET', `/machines/${encodeURIComponent(machine)}/files`);
  if (!r.ok) { $('cartes').textContent = texteErreur(r.json); return; }
  fichiers = r.json;
  afficherFichiers();
}

function afficherFichiers() {
  const filtre = $('recherche').value.trim().toLowerCase();
  const liste = fichiers.filter((f) => f.nom.toLowerCase().includes(filtre)).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  $('nb-fichiers').textContent = `(${fichiers.length})`;
  const zone = $('cartes');
  zone.replaceChildren();
  if (!liste.length) { zone.textContent = fichiers.length ? 'Aucun fichier ne correspond.' : 'Aucun gcode : envoies-en un.'; return; }
  // rangés par dossier : plaques à faire d'abord (commandes validées), puis les autres, puis les plaques imprimées
  const DOSSIERS = [['a_faire', 'Plaques à faire'], ['', 'Autres fichiers'], ['imprimees', 'Plaques imprimées']];
  const dossierDe = (nom) => (nom.includes('/') ? nom.slice(0, nom.indexOf('/')) : '');
  const connus = new Set(DOSSIERS.map(([d]) => d));
  const groupes = [...DOSSIERS, ...[...new Set(liste.map((f) => dossierDe(f.nom)))].filter((d) => !connus.has(d)).map((d) => [d, d])];
  for (const [dossier, titre] of groupes) {
    const dedans = liste.filter((f) => dossierDe(f.nom) === dossier);
    if (!dedans.length) continue;
    const entete = document.createElement('h3');
    entete.className = 'groupe-fichiers';
    entete.textContent = `${titre} (${dedans.length})`;
    zone.appendChild(entete);
    for (const f of dedans) zone.appendChild(carteFichier(f));
  }
}

function carteFichier(f) {
  {
    const carte = document.createElement('button');
    carte.type = 'button';
    carte.className = `carte${f.nom === choisi ? ' choisie' : ''}`;
    carte.title = f.nom;
    const vignette = document.createElement('div');
    vignette.className = 'vignette';
    if (f.miniature) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = `${API}/machines/${encodeURIComponent(machine)}/files/${cheminUrl(f.nom)}/thumbnail`;
      img.onerror = () => { vignette.textContent = 'pas d\'aperçu'; };
      vignette.appendChild(img);
    } else {
      vignette.textContent = 'pas d\'aperçu';
    }
    const corps = document.createElement('div');
    corps.className = 'corps';
    const nom = document.createElement('span');
    nom.className = 'nom';
    nom.textContent = f.nom.split('/').pop();      // nom sans le dossier (en titre de section) ; jamais du HTML
    const infos = document.createElement('span');
    infos.className = 'muted small';
    const couleur = couleurSure(f.filament?.couleurs?.[0]);
    infos.textContent = [f.temps_estime ? duree(f.temps_estime) : null, f.poids ? `${arrondi(f.poids, 1)} g` : null,
      f.filament?.types?.[0]].filter(Boolean).join(' · ') || ' ';
    if (couleur) {
      const pastille = document.createElement('span');
      pastille.className = 'pastille';
      pastille.style.background = couleur;
      infos.prepend(pastille, ' ');
    }
    corps.append(nom, infos);
    carte.append(vignette, corps);
    carte.addEventListener('click', () => choisir(f));
    return carte;
  }
}

// ---------------------------------------------------------------- fiche d'un gcode (fenêtre)
// Clic sur un gcode : fenêtre avec son aperçu 3D couche par couche, le plastique prévu, le choix de
// l'emplacement de l'ACE (conseillé d'après le fil prévu), « Imprimer » et « Supprimer ».

let vue = null;                 // aperçu 3D (module chargé à la première ouverture)
const tailleTexte = (n) => (n == null ? '—' : n < 1048576 ? `${Math.round(n / 1024)} Ko` : `${arrondi(n / 1048576, 1)} Mo`);

async function choisir(f) {
  choisi = f.nom;
  $('choix-nom').textContent = f.nom;
  $('choix-nom').title = f.nom;
  $('fiche-temps').textContent = f.temps_estime ? duree(f.temps_estime) : '—';
  $('fiche-poids').textContent = f.poids ? `${arrondi(f.poids, 1)} g` : '—';
  $('fiche-taille').textContent = tailleTexte(f.taille_octets);
  $('fiche-couches').textContent = '…';
  $('fiche-fil').innerHTML = Filament.prevu(f.filament ?? null);
  $('fiche-suivi').href = `suivi.html?f=${encodeURIComponent(f.nom)}`;
  conseillerEmplacement(f);
  majOccupation();
  afficherFichiers();
  if (!$('fiche').open) $('fiche').showModal();

  const msg = $('fiche-message');
  msg.hidden = false;
  msg.textContent = 'Lecture du gcode… (la première fois, l\'agent l\'analyse sur la machine)';
  try {
    if (!vue) {
      const { Apercu3D } = await import('./apercu3d.js');
      vue = new Apercu3D($('fiche-vue'), (nom) => `${API}/machines/${encodeURIComponent(machine)}/files/${nom}`);
    }
    vue.vider();
    const meta = await vue.charger(f.nom);
    if (choisi !== f.nom) return;            // un autre gcode a été ouvert entre-temps
    const n = meta.layers.length;
    $('fiche-couches').textContent = n;
    const c = $('fiche-couche');
    c.max = Math.max(0, n - 1);
    c.value = n - 1;
    c.disabled = !n;
    majCoucheFiche(n - 1);
    msg.hidden = n > 0;
    if (!n) msg.textContent = 'Ce fichier ne contient aucune extrusion.';
  } catch (e) {
    if (choisi !== f.nom) return;
    $('fiche-couches').textContent = '—';
    msg.textContent = `Aperçu impossible : ${e.message}`;
  }
}

function majCoucheFiche(i) {
  const L = vue?.meta ? vue.meta.layers : [];
  $('fiche-couche-txt').textContent = L.length ? `${i + 1} / ${L.length} · ${arrondi(L[i][0], 2)} mm` : '—';
}
$('fiche-couche').addEventListener('input', (ev) => {
  const i = Number(ev.target.value);
  vue?.afficherJusqua(i);
  majCoucheFiche(i);
});
document.querySelectorAll('#fiche [data-vue]').forEach((b) => b.addEventListener('click', () => vue?.vue(b.dataset.vue)));
$('fiche-fermer').addEventListener('click', () => $('fiche').close());
$('fiche').addEventListener('close', () => { choisi = null; afficherFichiers(); });

// présélectionne l'emplacement de l'ACE dont le fil ressemble le plus à celui prévu par le gcode
function conseillerEmplacement(f) {
  const el = $('fiche-conseil');
  const fils = dernierEtat?.ace?.fils;
  el.hidden = true;
  el.classList.remove('alerte');
  if (!fils || !fils.length) return;
  const c = Filament.conseil(f.filament, fils);
  if (!c) {
    el.hidden = !f.filament;
    el.textContent = 'Aucun emplacement de l\'ACE ne contient de fil.';
    return;
  }
  $('emplacement').value = String(c.emplacement);
  const meme = Filament.alerte(f.filament, { emplacement: c.emplacement, matiere: c.matiere }) === null;
  el.innerHTML = `Conseillé : ${Filament.pastille(c.color)}emplacement ${c.emplacement}`
    + (c.matiere ? ` (${Filament.echapper(c.matiere)})` : '')
    + (meme ? ' : le plus proche du plastique prévu.' : ' : attention, aucun emplacement n\'a la même matière.');
  el.classList.toggle('alerte', !meme);
  el.hidden = false;
}

// plastique choisi différent de celui prévu : prévenir avant de lancer
$('emplacement').addEventListener('change', () => {
  const f = fichiers.find((x) => x.nom === choisi);
  const s = Number($('emplacement').value) || 1;          // vide = emplacement 1 par défaut
  const fil = dernierEtat?.ace?.fils?.find((x) => x.emplacement === s);
  const a = f && fil ? Filament.alerte(f.filament, { emplacement: s, matiere: fil.matiere }) : null;
  const el = $('fiche-conseil');
  el.classList.toggle('alerte', !!a);
  el.hidden = !a && !fil;
  if (a) el.textContent = `⚠ ${a}`;
  else if (fil) el.innerHTML = `${Filament.pastille(fil.color)}Emplacement ${s}${fil.matiere ? ` · ${Filament.echapper(fil.matiere)}` : ''}`;
});

function majOccupation() {
  const pret = dernierEtat?.state === 'READY';
  $('btn-imprimer').disabled = !pret;
  $('fiche-occupee').hidden = pret || !dernierEtat;
  $('fiche-occupee').textContent = dernierEtat?.state === 'PRINTING' || dernierEtat?.state === 'BREAK'
    ? 'L\'imprimante est déjà en train d\'imprimer.' : 'L\'imprimante n\'est pas prête.';
}

$('recherche').addEventListener('input', afficherFichiers);

// ---------------------------------------------------------------- impression

$('btn-imprimer').addEventListener('click', async () => {
  if (!choisi) return;
  const nom = choisi;
  const corps = { fichier: nom };
  if ($('emplacement').value) corps.emplacement = Number($('emplacement').value);
  $('btn-imprimer').disabled = true;
  const r = await api('POST', `/machines/${encodeURIComponent(machine)}/print`, corps);
  $('btn-imprimer').disabled = false;
  if (!r.ok) return toast(texteErreur(r.json), true);
  operations.set(r.json.operation, `Lancement de ${nom}`);
  toast(`Lancement de ${nom}…`);
  $('fiche').close();
});

// ---------------------------------------------------------------- suppression (code 2FA redemandé par le serveur)

$('fiche-supprimer').addEventListener('click', async () => {
  if (!choisi) return;
  const nom = choisi;
  const d = $('suppression');
  $('suppr-nom').textContent = nom;
  d.returnValue = '';
  d.showModal();
  $('suppr-ok').focus();
  const oui = await new Promise((ok) => d.addEventListener('close', () => ok(d.returnValue === 'oui'), { once: true }));
  if (!oui) return;
  $('fiche-supprimer').disabled = true;
  const r = await api('DELETE', `/machines/${encodeURIComponent(machine)}/files/${cheminUrl(nom)}`);
  $('fiche-supprimer').disabled = false;
  if (!r.ok) { if (r.json?.erreur !== 'annule') toast(texteErreur(r.json), true); return; }
  toast(`${nom} supprimé`);
  if (vue?.nom === nom) vue.vider();
  $('fiche').close();
  await chargerFichiers();
});

// envoie une commande ; les longues (home, chargement...) répondent 202 et finissent plus tard (flux « operation »)
async function commande(chemin, libelle, corps = {}, methode = 'POST', bouton = null) {
  if (!machine) return false;
  if (bouton) bouton.disabled = true;
  const r = await api(methode, `/machines/${encodeURIComponent(machine)}${chemin}`, corps);
  if (bouton) bouton.disabled = false;
  if (!r.ok) { toast(texteErreur(r.json), true); return false; }
  if (r.statut === 202 && r.json?.operation) { operations.set(r.json.operation, libelle); toast(`${libelle}…`); }
  else toast(libelle);
  return true;
}
$('btn-pause').addEventListener('click', () => commande('/print/pause', 'Pause demandée'));
$('btn-reprise').addEventListener('click', () => commande('/print/resume', 'Reprise demandée'));
$('btn-annuler').addEventListener('click', () => {
  if (confirm(`Annuler l'impression de ${dernierEtat?.print?.filename || 'la pièce'} ?`)) commande('/print/cancel', 'Impression annulée');
});
$('conf-annuler').addEventListener('click', () => $('confirmation').close());

// vitesse, débit, ventilateur : envoyés quand on lâche le curseur
for (const [id, chemin, nom] of [['speed', '/speed', 'Vitesse'], ['flow', '/flow', 'Débit'], ['fan', '/fan', 'Ventilateur']]) {
  $(id).addEventListener('input', () => { $(`v-${id}`).textContent = `${$(id).value} %`; $(id).dataset.touche = Date.now(); });
  $(id).addEventListener('change', () => {
    $(id).dataset.touche = Date.now();
    commande(chemin, `${nom} : ${$(id).value} %`, { percent: Number($(id).value) }, 'PUT');
  });
}

// lumière : bascule (l'état de la lampe n'est pas remonté par la machine)
let lumiere = true;
$('btn-lumiere').addEventListener('click', async () => {
  if (await commande('/light', lumiere ? 'Lumière éteinte' : 'Lumière allumée', { on: !lumiere }, 'PUT', $('btn-lumiere'))) lumiere = !lumiere;
  $('btn-lumiere').style.opacity = lumiere ? '1' : '.5';
});

// températures
document.querySelectorAll('[data-chauffe]').forEach((form) => {
  const cible = form.dataset.chauffe;
  const nom = cible === 'buse' ? 'Buse' : 'Plateau';
  const champ = form.querySelector('input');
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const temp = Number(champ.value);
    commande('/temperature', `${nom} : chauffe à ${temp} °C`, { cible, temp }, 'PUT', form.querySelector('button:not([type])'));
  });
  form.querySelector('[data-off]').addEventListener('click', () => commande('/temperature', `${nom} : chauffe coupée`, { cible, temp: 0 }, 'PUT'));
});

// séchage de l'ACE
$('btn-dry').addEventListener('click', () => {
  const temp = Number($('dry-temp').value), duree = Number($('dry-duree').value);
  if (!(temp >= 30 && temp <= 70) || !(duree >= 10 && duree <= 1440)) return toast('Séchage : 30 à 70 °C, 10 à 1440 minutes', true);
  commande('/ace/dry', `Séchage lancé : ${temp} °C pendant ${duree} min`, { temp, duree }, 'POST', $('btn-dry'));
});
$('btn-dry-stop').addEventListener('click', () => commande('/ace/dry', 'Séchage arrêté', {}, 'DELETE', $('btn-dry-stop')));

// mouvements
let pas = 10;
document.querySelectorAll('[data-pas]').forEach((b) => b.addEventListener('click', () => {
  pas = Number(b.dataset.pas);
  document.querySelectorAll('[data-pas]').forEach((x) => x.classList.toggle('actif', x === b));
}));
document.querySelectorAll('[data-home]').forEach((b) => b.addEventListener('click', () => {
  const axes = b.dataset.home;
  commande('/home', `Mise à l'origine ${axes || 'XYZ'}`, axes ? { axes } : {});
}));
document.querySelectorAll('[data-jog]').forEach((b) => b.addEventListener('click', () => {
  const axe = b.dataset.jog, d = pas * Number(b.dataset.dir);
  commande('/move', `${axe.toUpperCase()} ${d > 0 ? '+' : ''}${String(d).replace('.', ',')} mm`, { [axe]: d, relatif: true }, 'POST', b);
}));
$('btn-moteurs').addEventListener('click', () => commande('/motors/off', 'Moteurs coupés', {}, 'POST', $('btn-moteurs')));

// filament : charger / décharger
function corpsFilament() {
  const corps = { temp: Number($('fil-temp').value) };
  if ($('fil-slot').value) corps.emplacement = Number($('fil-slot').value);
  return corps;
}
const nomSlot = () => ($('fil-slot').value ? `emplacement ${$('fil-slot').value}` : 'sans ACE');
$('btn-charger').addEventListener('click', () => commande('/filament/load', `Chargement (${nomSlot()})`, corpsFilament(), 'POST', $('btn-charger')));
$('btn-decharger').addEventListener('click', () => commande('/filament/unload', `Déchargement (${nomSlot()})`, corpsFilament(), 'POST', $('btn-decharger')));

// filament : extruder / rétracter de quelques mm (moteur de la tête seulement, sans l'ACE)
let longueurFil = 10;
document.querySelectorAll('[data-longueur]').forEach((b) => b.addEventListener('click', () => {
  longueurFil = Number(b.dataset.longueur);
  document.querySelectorAll('[data-longueur]').forEach((x) => x.classList.toggle('actif', x === b));
}));
for (const [id, sens, nom] of [['btn-extruder', 1, 'Extrusion'], ['btn-retracter', -1, 'Rétraction']]) {
  $(id).addEventListener('click', () => commande('/filament/extrude', `${nom} de ${longueurFil} mm`,
    { longueur: sens * longueurFil, temp: Number($('fil-temp').value) }, 'POST', $(id)));
}

// envoi d'un gcode (barre de progression : XMLHttpRequest, fetch ne la donne pas)
$('envoi').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = $('envoi-fichier').files[0];
  if (!f) return;
  const form = new FormData();
  form.append('file', f);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${API}/machines/${encodeURIComponent(machine)}/files`);
  xhr.withCredentials = AUTRE_ADRESSE;
  xhr.setRequestHeader('X-CSRF-Token', Session.csrf);
  const barre = $('envoi-barre');
  barre.hidden = false;
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) barre.firstElementChild.style.width = `${(e.loaded / e.total) * 100}%`; };
  xhr.onload = () => {
    barre.hidden = true;
    barre.firstElementChild.style.width = '0';
    let r = {};
    try { r = JSON.parse(xhr.responseText); } catch { /* réponse vide */ }
    if (xhr.status === 401) { location.href = PAGE_CONNEXION; return; }
    if (xhr.status !== 202) { toast(texteErreur(r), true); return; }
    operations.set(r.operation, `Envoi de ${f.name}`);
    toast(`${f.name} reçu par le serveur : transfert vers la machine…`);
    $('envoi').reset();
  };
  xhr.onerror = () => { barre.hidden = true; toast('Envoi interrompu', true); };
  xhr.send(form);
});

// ---------------------------------------------------------------- caméra

let photoUrl = null;                             // image de la dernière photo (blob)

function arreterDirect() {
  $('cam').removeAttribute('src');               // ferme le flux : l'agent arrête d'envoyer des images
  $('cam').hidden = true;
  $('cam-vide').hidden = false;
  $('btn-direct').textContent = 'Voir en direct';
}

// explique pourquoi la caméra ne répond pas (l'agent renvoie l'erreur de l'imprimante, ex. « HTTP 503 »)
function raisonCamera(json) {
  const detail = String(json?.detail || '');
  if (/HTTP 503/.test(detail)) {
    return 'Le service caméra de l\'imprimante est arrêté (HTTP 503). Sous Rinkhals : écran de l\'imprimante, '
      + 'Paramètres > Rinkhals > Apps > mjpg-streamer, active et démarre l\'app. La caméra ne peut pas servir '
      + 'en même temps les apps Anycubic.';
  }
  if (/fail connexion/.test(detail)) return 'La caméra de l\'imprimante ne répond pas (Wi-Fi de l\'imprimante ?).';
  return `Caméra indisponible : ${texteErreur(json)}`;
}

// une photo (sert aussi de test avant le direct) ; retourne true si l'imprimante en a donné une
async function prendrePhoto() {
  let rep;
  try {
    rep = await fetch(`${API}/machines/${encodeURIComponent(machine)}/camera/snapshot?t=${Date.now()}`,
      { credentials: AUTRE_ADRESSE ? 'include' : 'same-origin' });
  } catch {
    toast('Le serveur ne répond pas.', true);
    return false;
  }
  if (!rep.ok) {
    arreterDirect();
    toast(raisonCamera(await rep.json().catch(() => null)), true);
    return false;
  }
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = URL.createObjectURL(await rep.blob());
  $('cam').src = photoUrl;
  $('cam').hidden = false;
  $('cam-vide').hidden = true;
  return true;
}

$('btn-direct').addEventListener('click', async () => {
  if ($('cam').getAttribute('src')?.includes('/stream')) return arreterDirect();
  $('btn-direct').disabled = true;
  const ok = await prendrePhoto();               // la caméra marche-t-elle ? sinon on dit pourquoi
  $('btn-direct').disabled = false;
  if (!ok) return;
  $('cam').src = `${API}/machines/${encodeURIComponent(machine)}/camera/stream`;
  $('btn-direct').textContent = 'Arrêter le direct';
});

$('btn-photo').addEventListener('click', () => {
  arreterDirect();
  prendrePhoto();
});
$('cam').addEventListener('error', () => {
  if (!$('cam').getAttribute('src')) return;
  arreterDirect();
  toast('Caméra indisponible', true);
});

// ---------------------------------------------------------------- déconnexion

$('deconnexion').addEventListener('click', async () => {
  await api('POST', '/auth/logout', {});
  memoriserCsrf('');
  location.href = PAGE_CONNEXION;
});
document.addEventListener('visibilitychange', () => {
  // page cachée (téléphone en veille) : on coupe le direct pour ne pas consommer la connexion de la maison
  if (document.hidden && $('cam').getAttribute('src')?.includes('/stream')) arreterDirect();
});
