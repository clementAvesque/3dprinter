// Page Suivi 3D : la pièce en 3D, les couches déjà imprimées, et la buse en direct.
// L'état vient de /api/state (rafraîchi toutes les 2 s par le backend).

import { Apercu3D, COULEURS_TYPES } from "./apercu3d.js";

const vue = new Apercu3D($("vue"));
let enCharge = null;          // fichier en cours de lecture (évite deux chargements en même temps)
let imprime = false;
let fichierImpression = null;

// ---------------------------------------------------------------------------
// Fichier affiché
// ---------------------------------------------------------------------------

async function afficherFichier(nom) {
  if (!nom || nom === vue.nom || nom === enCharge) return;
  enCharge = nom;
  const msg = $("vue-message");
  msg.hidden = false;
  msg.textContent = `Lecture de ${nom}…`;
  try {
    const meta = await vue.charger(nom);
    const n = meta.layers.length;
    const curseur = $("couche");
    curseur.max = Math.max(0, n - 1);
    curseur.value = n - 1;
    curseur.disabled = n === 0;
    majTexteCouche(n - 1);
    const hauteur = meta.bbox ? `${arrondi(meta.bbox[5], 2)} mm de haut` : "";
    $("infos").textContent = [`${n} couches`, `${meta.segments.toLocaleString("fr-FR")} trajets`, hauteur]
      .filter(Boolean).join(" · ");
    msg.hidden = n > 0;
    if (!n) msg.textContent = "Ce fichier ne contient aucune extrusion.";
  } catch (e) {
    msg.hidden = false;
    msg.textContent = `Aperçu impossible : ${e.message}`;
  } finally {
    enCharge = null;
  }
  $("choix").value = nom;
}

function majTexteCouche(i) {
  const L = vue.meta ? vue.meta.layers : [];
  $("couche-txt").textContent = L.length ? `${i + 1} / ${L.length} · ${arrondi(L[i][0], 2)} mm` : "—";
}

async function remplirChoix() {
  const gcodes = await (await fetch("/api/gcodes")).json();
  const choix = $("choix");
  choix.innerHTML = '<option value="">— choisir un fichier —</option>';
  for (const nom of Object.keys(gcodes).sort((a, b) => a.localeCompare(b, "fr"))) {
    const o = document.createElement("option");
    o.value = o.textContent = nom;
    choix.appendChild(o);
  }
  if (vue.nom) choix.value = vue.nom;
}

function remplirLegende() {
  const ul = $("legende");
  const noms = ["Paroi externe", "Paroi interne", "Remplissage", "Remplissage plein",
    "Surface dessus/dessous", "Support", "Jupe / bordure", "Autre"];
  ul.innerHTML = "";
  noms.forEach((nom, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="carre"></span>${nom}`;
    li.firstChild.style.background = COULEURS_TYPES[i];
    ul.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// Direct
// ---------------------------------------------------------------------------

// fil prévu par le gcode et emplacement réellement utilisé (hors impression : le fichier affiché)
let filFichier = { nom: null, fil: undefined };

async function afficherFilament(f) {
  let prevu = f ? f.prevu : undefined;
  if (prevu === undefined && vue.nom) {
    if (filFichier.nom !== vue.nom) {
      const g = await (await fetch("/api/gcodes")).json();
      filFichier = { nom: vue.nom, fil: (g[vue.nom] || {}).filament ?? null };
    }
    prevu = filFichier.fil;
  }
  $("fil-prevu").innerHTML = prevu === undefined ? "—" : Filament.prevu(prevu);
  $("fil-utilise").innerHTML = f ? Filament.utilise(f.utilise) : '<span class="muted">Aucune impression en cours</span>';
  const a = f ? Filament.alerte(f.prevu, f.utilise) : null;
  $("fil-alerte").hidden = !a;
  $("fil-alerte").textContent = a ? `⚠ ${a}` : "";
}

// couche en cours : le firmware la donne, mais selon les versions elle compte à partir de 0 ou de 1 ;
// la hauteur de la buse départage
function coucheEnCours(p, z) {
  const iz = vue.coucheDeZ(z);
  if (p.layer != null && p.total_layers === vue.nbCouches) {
    if (iz === p.layer || iz === p.layer - 1) return iz;
    return Math.max(0, p.layer - 1);
  }
  return iz;
}

async function rafraichir() {
  const d = await lireEtat();
  const e = d && d.etat;
  if (!e) return;
  majEntete(e);

  const p = e.print;
  imprime = (e.state === "PRINTING" || e.state === "BREAK") && !!(p && p.filename);
  fichierImpression = imprime ? p.filename : null;

  // panneau impression
  $("fichier").textContent = imprime ? p.filename : "Aucune impression";
  $("barre").style.width = (imprime ? p.progress_percent : 0) + "%";
  $("pct").textContent = imprime ? `${p.progress_percent} %` : "—";
  $("couche-impr").textContent = imprime && p.layer != null ? `${p.layer} / ${p.total_layers ?? "?"}` : "—";
  $("ecoule").textContent = imprime ? duree(p.elapsed_seconds) : "—";
  $("restant").textContent = imprime ? duree(p.remaining_seconds) : "—";

  // buse
  const pos = e.nozzle.position || {};
  $("bx").textContent = arrondi(pos.x, 2);
  $("by").textContent = arrondi(pos.y, 2);
  $("bz").textContent = arrondi(pos.z, 2);
  const tb = e.nozzle.temperature, tl = e.bed.temperature;
  $("t-buse").textContent = tb.value == null ? "—" : `${arrondi(tb.value)} °C${tb.target ? ` / ${tb.target}` : ""}`;
  $("t-lit").textContent = tl.value == null ? "—" : `${arrondi(tl.value)} °C${tl.target ? ` / ${tl.target}` : ""}`;
  $("vitesse").textContent = p && p.speed_factor != null ? `${Math.round(p.speed_factor * 100)} %` : "—";
  $("ventilo").textContent = p && p.fan_percent != null ? `${p.fan_percent} %` : "—";
  vue.placerBuse(pos.x, pos.y, pos.z);
  afficherFilament(imprime ? p.filament : null);

  // suivi de la pièce en cours
  if (!imprime || !$("direct").checked) return;
  if (vue.nom !== fichierImpression) await afficherFichier(fichierImpression);
  if (vue.nom !== fichierImpression || !vue.nbCouches) return;

  // préparation (chauffe, nivellement, purge) : le temps d'impression reste à 0 et la buse est
  // souvent levée, on n'affiche donc rien comme imprimé. (Le firmware peut encore annoncer
  // « couche 0 / 0 » pendant la première couche : c'est la hauteur de la buse qui prend le relais.)
  const commence = p.elapsed_seconds > 0 || (p.layer != null && p.layer >= 1);
  if (!commence) {
    vue.afficherJusqua(0, vue.meta.layers[0][1]);
    $("couche").value = 0;
    $("couche-txt").textContent = `préparation · ${vue.nbCouches} couches`;
    return;
  }
  const i = coucheEnCours(p, pos.z);
  vue.afficherJusqua(i, vue.progressionParBuse(i, pos.x, pos.y));
  $("couche").value = i;
  majTexteCouche(i);
}

// ---------------------------------------------------------------------------
// Événements
// ---------------------------------------------------------------------------

$("couche").addEventListener("input", (ev) => {
  // déplacer le curseur = explorer : on arrête de suivre l'impression
  $("direct").checked = false;
  const i = Number(ev.target.value);
  vue.afficherJusqua(i);
  majTexteCouche(i);
});

$("direct").addEventListener("change", () => {
  if ($("direct").checked) rafraichir();
});

$("choix").addEventListener("change", (ev) => {
  if (!ev.target.value) return;
  if (ev.target.value !== fichierImpression) $("direct").checked = false;
  afficherFichier(ev.target.value);
});

document.querySelectorAll("[data-vue]").forEach((b) => b.addEventListener("click", () => vue.vue(b.dataset.vue)));

// ---------------------------------------------------------------------------

remplirLegende();
await remplirChoix();
const demande = new URLSearchParams(location.search).get("f");
if (demande) {
  $("direct").checked = false;
  await afficherFichier(demande);
}
await rafraichir();
setInterval(rafraichir, 2000);
