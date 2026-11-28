// Page Vidéos (en ligne) : les enregistrements faits par l'agent (dossier image/videos du Raspberry),
// à regarder, télécharger ou supprimer. Les vidéos passent par l'agent puis le serveur : rien n'est gardé
// en ligne, seul le Raspberry les stocke.

let videos = [];          // [{nom, taille, date (s), en_cours}]
let dernierEtat = null;
let aSupprimer = null;

// adresse d'une vidéo pour la balise <video> ou un lien (cookie de session envoyé par le navigateur)
const urlVideo = (nom, telecharger = false) =>
  `${Page.url(`/recordings/${encodeURIComponent(nom)}`)}${telecharger ? '?telecharger=1' : ''}`;

// « P0013_2026-11-27_20261128_183000.mp4 » -> « P0013_2026-11-27 » (nom du gcode, sans la date d'enregistrement)
const titre = (nom) => nom.replace(/\.mp4$/, '').replace(/_\d{8}_\d{6}$/, '');

async function charger() {
  $('videos').innerHTML = '<p class="muted">Chargement…</p>';
  const r = await api('GET', `/machines/${encodeURIComponent(Page.machine)}/recordings`);
  if (!r.ok) {
    videos = [];
    $('videos').innerHTML = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `Impossible de lire les vidéos : ${texteErreur(r.json)}`;
    $('videos').appendChild(p);
    resumer();
    return;
  }
  videos = Array.isArray(r.json) ? r.json : [];
  afficher();
}

function resumer() {
  $('r-nb').textContent = videos.length;
  $('r-taille').textContent = octets(videos.reduce((s, v) => s + (v.taille || 0), 0));
}

function afficherEtat(e) {
  dernierEtat = e;
  const rec = e?.enregistrement;
  $('r-etat').textContent = rec?.recording
    ? (rec.timelapse ? `en cours · ${rec.images ?? 0} images` : 'en cours')
    : (e?.auto_record?.actif ? `prêt (1 image / ${e.auto_record.timelapse ?? '?'} s)` : 'coupé');
}

function afficher() {
  resumer();
  const filtre = $('recherche').value.trim().toLowerCase();
  const liste = videos.filter((v) => !filtre || v.nom.toLowerCase().includes(filtre));
  const zone = $('videos');
  zone.innerHTML = '';
  if (!liste.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = videos.length ? 'Aucune vidéo ne correspond.' : 'Aucune vidéo pour l\'instant.';
    zone.appendChild(p);
    return;
  }
  for (const v of liste) {
    const carte = document.createElement('div');
    carte.className = 'carte';
    carte.innerHTML = `
      <div class="vignette" title="Regarder">▶</div>
      <div class="corps">
        <span class="nom"></span>
        <span class="muted small infos"></span>
      </div>
      <div class="actions">
        <button class="regarder">Regarder</button>
        <a class="bouton telecharger" download>Télécharger</a>
        <button class="danger supprimer">Supprimer</button>
      </div>`;
    carte.querySelector('.nom').textContent = titre(v.nom);
    carte.querySelector('.nom').title = v.nom;
    carte.querySelector('.infos').textContent = `${dateCourte(v.date)} · ${octets(v.taille)}${v.en_cours ? ' · en cours d\'enregistrement' : ''}`;
    const lien = carte.querySelector('.telecharger');
    lien.href = urlVideo(v.nom, true);
    lien.setAttribute('download', v.nom);
    carte.querySelector('.vignette').addEventListener('click', () => regarder(v));
    carte.querySelector('.regarder').addEventListener('click', () => regarder(v));
    const suppr = carte.querySelector('.supprimer');
    // la vidéo en cours est encore écrite par l'agent : on attend la fin de l'impression
    suppr.disabled = !!v.en_cours;
    if (v.en_cours) suppr.title = 'Enregistrement en cours : attends la fin de l\'impression';
    suppr.addEventListener('click', () => demanderSuppression(v));
    zone.appendChild(carte);
  }
}

// ---------------------------------------------------------------- lecture

function regarder(v) {
  $('l-titre').textContent = titre(v.nom);
  $('l-infos').textContent = `${v.nom} · ${dateCourte(v.date)} · ${octets(v.taille)}`
    + (v.en_cours ? ' · enregistrement en cours : la vidéo s\'arrête où elle en était au moment de l\'ouverture' : '');
  $('l-telecharger').href = urlVideo(v.nom, true);
  $('l-telecharger').setAttribute('download', v.nom);
  const video = $('l-video');
  video.src = urlVideo(v.nom);
  $('lecteur').showModal();
  video.play().catch(() => { /* lecture auto refusée : les commandes restent là */ });
}

$('l-video').addEventListener('error', () => {
  if ($('lecteur').open) toast('Lecture impossible : l\'agent est peut-être hors ligne. Essaie « Télécharger ».', true);
});

function fermerLecteur() {
  const video = $('l-video');
  video.pause();
  video.removeAttribute('src');   // coupe le téléchargement en cours
  video.load();
}
$('l-fermer').addEventListener('click', () => $('lecteur').close());
$('lecteur').addEventListener('close', fermerLecteur);

// ---------------------------------------------------------------- suppression (code 2FA redemandé par le serveur)

function demanderSuppression(v) {
  aSupprimer = v.nom;
  $('s-nom').textContent = v.nom;
  $('suppression').returnValue = '';
  $('suppression').showModal();
}

$('suppression').addEventListener('close', async () => {
  const nom = aSupprimer;
  aSupprimer = null;
  if ($('suppression').returnValue !== 'oui' || !nom) return;
  const r = await api('DELETE', `/machines/${encodeURIComponent(Page.machine)}/recordings/${encodeURIComponent(nom)}`);
  if (!r.ok) return toast(`Suppression : ${texteErreur(r.json)}`, true);
  toast('Vidéo supprimée');
  videos = videos.filter((v) => v.nom !== nom);
  afficher();
});

// ---------------------------------------------------------------- démarrage

$('recherche').addEventListener('input', afficher);
$('btn-actualiser').addEventListener('click', charger);

(async () => {
  let enregistrait = false;
  await Page.demarrer({
    etat: (e) => {
      afficherEtat(e);
      // un enregistrement vient de finir : la nouvelle vidéo apparaît sans recharger la page
      const maintenant = !!e?.enregistrement?.recording;
      if (enregistrait && !maintenant) setTimeout(charger, 3000);
      enregistrait = maintenant;
    },
    machine: () => charger(),
    operation: annoncerOperation,
  });
})();
