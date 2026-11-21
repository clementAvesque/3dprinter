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
  choisi = null;
  $('panneau').hidden = true;
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
  $('btn-imprimer').disabled = e.state !== 'READY';
  remplirEmplacements(e.ace?.fils);
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
  for (const f of liste) {
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
    nom.textContent = f.nom;                       // jamais interprété comme du HTML
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
    zone.appendChild(carte);
  }
}

function choisir(f) {
  choisi = f.nom;
  $('choix-nom').textContent = f.nom;
  $('choix-infos').textContent = [f.temps_estime ? duree(f.temps_estime) : null, f.poids ? `${arrondi(f.poids, 1)} g` : null,
    f.filament?.types?.[0] ? `prévu : ${f.filament.types[0]}` : null].filter(Boolean).join(' · ');
  $('panneau').hidden = false;
  afficherFichiers();
}

$('recherche').addEventListener('input', afficherFichiers);

// ---------------------------------------------------------------- impression

$('btn-imprimer').addEventListener('click', async () => {
  if (!choisi) return;
  const corps = { fichier: choisi };
  if ($('emplacement').value) corps.emplacement = Number($('emplacement').value);
  $('btn-imprimer').disabled = true;
  const r = await api('POST', `/machines/${encodeURIComponent(machine)}/print`, corps);
  $('btn-imprimer').disabled = false;
  if (!r.ok) return toast(texteErreur(r.json), true);
  operations.set(r.json.operation, `Lancement de ${choisi}`);
  toast(`Lancement de ${choisi}…`);
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
