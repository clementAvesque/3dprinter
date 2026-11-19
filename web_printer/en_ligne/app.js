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
  await choisirMachine(liste[0].id);
  ecouter();
})();

async function choisirMachine(id) {
  machine = id;
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

async function commande(chemin, libelle) {
  const r = await api('POST', `/machines/${encodeURIComponent(machine)}${chemin}`, {});
  if (r.ok) toast(libelle);
  else toast(texteErreur(r.json), true);
}
$('btn-pause').addEventListener('click', () => commande('/print/pause', 'Pause demandée'));
$('btn-reprise').addEventListener('click', () => commande('/print/resume', 'Reprise demandée'));
$('btn-annuler').addEventListener('click', () => {
  if (confirm(`Annuler l'impression de ${dernierEtat?.print?.filename || 'la pièce'} ?`)) commande('/print/cancel', 'Impression annulée');
});
$('conf-annuler').addEventListener('click', () => $('confirmation').close());

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

function arreterDirect() {
  $('cam').removeAttribute('src');               // ferme le flux : l'agent arrête d'envoyer des images
  $('cam').hidden = true;
  $('cam-vide').hidden = false;
  $('btn-direct').textContent = 'Voir en direct';
}

$('btn-direct').addEventListener('click', () => {
  if ($('cam').getAttribute('src')?.includes('/stream')) return arreterDirect();
  $('cam').src = `${API}/machines/${encodeURIComponent(machine)}/camera/stream`;
  $('cam').hidden = false;
  $('cam-vide').hidden = true;
  $('btn-direct').textContent = 'Arrêter le direct';
});

$('btn-photo').addEventListener('click', () => {
  arreterDirect();
  $('cam').src = `${API}/machines/${encodeURIComponent(machine)}/camera/snapshot?t=${Date.now()}`;
  $('cam').hidden = false;
  $('cam-vide').hidden = true;
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
