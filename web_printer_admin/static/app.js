// Interface de l'imprimante : lit /api/state toutes les 2 s et envoie les commandes au backend Flask.

const $ = (id) => document.getElementById(id);

const ETATS = { READY: "Prête", PRINTING: "Impression", BREAK: "En pause", ERROR: "Erreur" };

let fichierChoisi = null;     // gcode sélectionné dans la liste
let tacheEnCours = null;      // nom de la tâche longue suivie (pour afficher son résultat à la fin)
let reglageActif = null;      // slider en train d'être déplacé (pour ne pas l'écraser pendant le glisser)

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

function toast(message, erreur = false) {
  const el = document.createElement("div");
  el.className = "toast" + (erreur ? " erreur" : "");
  el.textContent = message;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), erreur ? 7000 : 3500);
}

function messageErreur(res) {
  const msg = res.detail ? `${res.error} : ${res.detail}` : res.error;
  return res.conseil ? `${msg} — ${res.conseil}` : msg;
}

// envoie une commande ; affiche une notification d'erreur ou de succès
async function api(chemin, corps = {}, succes = null) {
  try {
    const rep = await fetch(chemin, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corps),
    });
    const res = await rep.json();
    if (!rep.ok) {
      toast(messageErreur(res), true);
      return null;
    }
    if (rep.status === 202) {
      tacheEnCours = res.tache;
      toast(`Lancé : ${res.tache}`);
    } else if (succes) {
      toast(succes);
    }
    rafraichir();
    return res;
  } catch {
    toast("Le serveur ne répond pas", true);
    return null;
  }
}

function duree(secondes) {
  if (secondes == null) return "—";
  const h = Math.floor(secondes / 3600);
  const m = Math.floor((secondes % 3600) / 60);
  const s = Math.floor(secondes % 60);
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min ${String(s).padStart(2, "0")}`;
}

const arrondi = (v, n = 1) => (v == null ? "—" : Number(v).toFixed(n));

function octets(n) {
  // taille de fichier lisible : 3452000 -> "3,3 Mo"
  const unites = ["o", "Ko", "Mo", "Go"];
  let i = 0;
  while (n >= 1024 && i < unites.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(1).replace(".", ",") : n} ${unites[i]}`;
}

// ---------------------------------------------------------------------------
// Affichage de l'état
// ---------------------------------------------------------------------------

async function rafraichir() {
  let data;
  try {
    data = await (await fetch("/api/state")).json();
  } catch {
    $("dot").className = "dot off";
    $("badge").textContent = "Serveur arrêté";
    return;
  }
  afficherTache(data.tache, data.synchro);
  afficherEnregistrement(data.enregistrement);
  const e = data.etat;
  if (!e) return;     // le backend n'a pas encore fait son premier update

  // en-tête
  $("dot").className = "dot " + (e.online ? "on" : "off");
  $("badge").className = "badge " + (e.online ? e.state || "" : "ERROR");
  $("badge").textContent = e.online ? ETATS[e.state] || "Inconnu" : "Hors ligne";

  // températures
  const buse = e.nozzle.temperature, lit = e.bed.temperature;
  $("t-buse").textContent = arrondi(buse.value);
  $("c-buse").textContent = buse.target ? `${buse.target} °C` : "off";
  $("t-lit").textContent = arrondi(lit.value);
  $("c-lit").textContent = lit.target ? `${lit.target} °C` : "off";

  // position
  const pos = e.nozzle.position;
  $("pos-x").textContent = arrondi(pos.x, 2);
  $("pos-y").textContent = arrondi(pos.y, 2);
  $("pos-z").textContent = arrondi(pos.z, 2);

  // impression
  const p = e.print;
  const imprime = e.state === "PRINTING" || e.state === "BREAK";
  $("pr-fichier").textContent = imprime && p ? p.filename : "Aucune impression";
  $("pr-barre").style.width = (imprime && p ? p.progress_percent : 0) + "%";
  $("pr-pct").textContent = imprime && p ? `${p.progress_percent} %` : "—";
  $("pr-couche").textContent = imprime && p && p.layer != null ? `${p.layer} / ${p.total_layers ?? "?"}` : "—";
  $("pr-ecoule").textContent = imprime && p ? duree(p.elapsed_seconds) : "—";
  $("pr-restant").textContent = imprime && p ? duree(p.remaining_seconds) : "—";
  // filament : prévu par le fichier / emplacement réellement utilisé
  const fil = imprime && p ? p.filament : null;
  $("pr-fil").hidden = !fil;
  if (fil) {
    $("pr-fil-prevu").innerHTML = Filament.prevu(fil.prevu, { court: true });
    $("pr-fil-utilise").innerHTML = Filament.utilise(fil.utilise);
    const a = Filament.alerte(fil.prevu, fil.utilise);
    $("pr-fil-alerte").hidden = !a;
    $("pr-fil-alerte").textContent = a ? `⚠ ${a}` : "";
  }

  $("btn-pause").disabled = e.state !== "PRINTING";
  $("btn-reprise").disabled = e.state !== "BREAK";
  $("btn-annuler").disabled = !imprime;

  if (p) {
    majSlider("speed", Math.round((p.speed_factor ?? 1) * 100));
    majSlider("fan", p.fan_percent);
  }

  // ACE
  afficherAce(e.ace);
}

function majSlider(id, valeur) {
  if (reglageActif === id || valeur == null) return;
  $(id).value = valeur;
  $("v-" + id).textContent = valeur + " %";
}

function afficherAce(ace) {
  $("ace-etat").className = "badge petit " + (ace.state || "");
  $("ace-etat").textContent = { ON: "Prêt", OFF: "Non détecté", DRY: "Séchage" }[ace.state] || "—";
  const fils = ace.fils || [];
  $("slots").innerHTML = "";
  for (let i = 1; i <= 4; i++) {
    const fil = fils.find((f) => f.emplacement === i);
    const vide = !fil || fil.color == null;
    const div = document.createElement("div");
    div.className = "slot";
    div.innerHTML = `<div class="pastille ${vide ? "vide" : ""}"></div><span>${i} · ${vide ? "vide" : fil.color}</span>`;
    if (!vide) div.firstChild.style.background = fil.color;
    $("slots").appendChild(div);
  }
}

let synchroEnCours = false;

function afficherTache(t, synchro) {
  // synchro des gcodes de la machine : quand elle se termine, on recharge la liste des fichiers
  const synchroActive = !!(synchro && synchro.en_cours);
  if (synchroEnCours && !synchroActive) chargerGcodes();
  synchroEnCours = synchroActive;

  if (t.en_cours || synchroActive) {
    $("tache").hidden = false;
    $("tache").textContent = t.en_cours ? `⏳ ${t.nom}…` : "⏳ Récupération des fichiers de l'imprimante…";
    if (t.en_cours) tacheEnCours = t.nom;
    return;
  }
  $("tache").hidden = true;
  // la tâche qu'on suivait vient de se terminer : on affiche son résultat une fois
  if (tacheEnCours && t.nom === tacheEnCours) {
    const res = t.resultat || {};
    if (res.error) toast(`${t.nom} : ${messageErreur(res)}`, true);
    else toast(`Terminé : ${t.nom}`);
    for (const a of res.avertissements || []) toast(`⚠ ${a}`, true);
    tacheEnCours = null;
    chargerGcodes();
  }
}

// ---------------------------------------------------------------------------
// Caméra : flux vidéo MJPEG lu directement sur l'imprimante (une seule connexion ouverte).
// Si le flux est coupé : nouvel essai toutes les 15 s, pour ne pas surcharger l'imprimante.
// ---------------------------------------------------------------------------

async function demarrerFlux() {
  try {
    const { stream_url } = await (await fetch("/api/camera/stream")).json();
    $("cam").hidden = false;
    $("cam-off").hidden = true;
    $("cam").src = "";              // force le navigateur à rouvrir le flux
    $("cam").src = stream_url;
  } catch {
    setTimeout(demarrerFlux, 15000);
  }
}
$("cam").onerror = () => {
  if (!$("cam").getAttribute("src")) return;      // src vidé volontairement par demarrerFlux
  $("cam").hidden = true;
  $("cam-off").hidden = false;
  setTimeout(demarrerFlux, 15000);
};

// ---------------------------------------------------------------------------
// Enregistrement vidéo
// ---------------------------------------------------------------------------

let enregistrait = false;     // pour détecter la fin d'un enregistrement (bouton ou fin de print)

function afficherEnregistrement(rec) {
  if (!rec) return;
  // enregistrement automatique de chaque impression (réglage de la librairie)
  if (rec.auto) {
    $("rec-chaque").checked = rec.auto.actif;
    $("rec-chaque-mode").textContent = rec.auto.actif
      ? `(${rec.auto.timelapse ? `timelapse 1 image / ${rec.auto.timelapse} s` : "vidéo temps réel"})` : "";
  }
  $("rec-badge").hidden = !rec.recording;
  $("btn-rec").textContent = rec.recording ? "⏹ Arrêter" : "⏺ Enregistrer";
  $("btn-rec").classList.toggle("actif", rec.recording);
  $("rec-mode").disabled = rec.recording;
  $("rec-auto").disabled = rec.recording;
  if (rec.recording) {
    $("rec-duree").textContent = duree(rec.duree) + (rec.timelapse ? ` · ${rec.images} images` : "");
  }
  if (enregistrait && !rec.recording) {
    const fin = rec.dernier || {};
    if (fin.error) toast(`Enregistrement : ${messageErreur(fin)}`, true);
    chargerVideos();
  }
  enregistrait = rec.recording;
}

// cocher = chaque impression est filmée, avec le type choisi dans la liste au moment du clic
$("rec-chaque").onchange = async () => {
  const actif = $("rec-chaque").checked;
  const res = await fetch("/api/record/auto", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actif, timelapse: $("rec-mode").value || null }),
  });
  if (!res.ok) { toast(messageErreur(await res.json()), true); return; }
  toast(actif ? "Chaque impression sera enregistrée" : "Enregistrement automatique coupé");
  rafraichir();
};

$("btn-rec").onclick = async () => {
  $("btn-rec").disabled = true;     // démarrer ou finaliser la vidéo prend quelques secondes
  if ($("btn-rec").classList.contains("actif")) {
    const res = await api("/api/record/stop");
    if (res) toast(`Vidéo enregistrée (${octets(res.taille)})`);
  } else {
    const timelapse = $("rec-mode").value || null;
    await api("/api/record/start", { timelapse, auto_stop: $("rec-auto").checked }, "Enregistrement démarré");
  }
  $("btn-rec").disabled = false;
  chargerVideos();
};

async function chargerVideos() {
  let videos;
  try {
    videos = await (await fetch("/api/recordings")).json();
  } catch {
    return;
  }
  $("videos-nb").textContent = videos.length;
  const ul = $("videos");
  ul.innerHTML = "";
  if (!videos.length) {
    ul.innerHTML = '<li class="vide">Aucune vidéo pour l\'instant</li>';
    return;
  }
  for (const v of videos) {
    const li = document.createElement("li");
    const lien = document.createElement("a");
    lien.href = "/recordings/" + encodeURIComponent(v.nom);
    lien.target = "_blank";            // s'ouvre dans un onglet : lecture ou téléchargement
    lien.className = "nom";
    lien.textContent = v.nom;
    const infos = document.createElement("span");
    infos.className = "muted small";
    infos.textContent = v.en_cours
      ? "en cours…"
      : `${octets(v.taille)} · ${new Date(v.date * 1000).toLocaleString("fr-FR")}`;
    li.append(lien, infos);
    if (!v.en_cours) {
      const suppr = document.createElement("button");
      suppr.className = "ghost";
      suppr.textContent = "✕";
      suppr.title = "Supprimer la vidéo";
      suppr.onclick = async () => {
        if (!confirm(`Supprimer ${v.nom} ?`)) return;
        await fetch("/api/recordings/" + encodeURIComponent(v.nom), { method: "DELETE" });
        chargerVideos();
      };
      li.append(suppr);
    }
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Graphique des températures
// ---------------------------------------------------------------------------

async function dessinerGraphique() {
  let hist;
  try {
    hist = (await (await fetch("/api/history")).json()).temp;
  } catch {
    return;
  }
  const canvas = $("graph");
  const ratio = window.devicePixelRatio || 1;
  const L = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = L * ratio;
  canvas.height = H * ratio;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  ctx.clearRect(0, 0, L, H);
  if (hist.length < 2) return;

  const style = getComputedStyle(document.documentElement);
  const t0 = hist[0].timestamp, t1 = hist[hist.length - 1].timestamp;
  const max = Math.max(50, ...hist.map((h) => h.temperature)) * 1.1;
  const x = (t) => ((t - t0) / Math.max(t1 - t0, 1)) * (L - 30) + 30;
  const y = (v) => H - 6 - (v / max) * (H - 12);

  // axe : quelques repères
  ctx.fillStyle = style.getPropertyValue("--muted");
  ctx.strokeStyle = style.getPropertyValue("--border");
  ctx.font = "11px system-ui";
  for (const v of [0, Math.round(max / 2), Math.round(max * 0.9)]) {
    ctx.fillText(v, 0, y(v) + 4);
    ctx.beginPath(); ctx.moveTo(30, y(v)); ctx.lineTo(L, y(v)); ctx.stroke();
  }

  for (const [capteur, couleur] of [["nozzle", "--buse"], ["bed", "--lit"]]) {
    const points = hist.filter((h) => h.capteur === capteur);
    ctx.strokeStyle = style.getPropertyValue(couleur);
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((h, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, x(h.timestamp), y(h.temperature)));
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Fichiers
// ---------------------------------------------------------------------------

async function chargerGcodes() {
  const gcodes = await (await fetch("/api/gcodes")).json();
  const ul = $("gcodes");
  ul.innerHTML = "";
  const noms = Object.keys(gcodes).sort();
  if (!noms.length) {
    ul.innerHTML = '<li class="vide">Aucun fichier : envoie un .gcode</li>';
    return;
  }
  for (const nom of noms) {
    const g = gcodes[nom];
    const li = document.createElement("li");
    const infos = [
      g.temps_estime ? duree(g.temps_estime) : null,
      g.poids ? `${arrondi(g.poids)} g` : null,
      g.taille_octets ? octets(g.taille_octets) : null,
    ].filter(Boolean).join(" · ");
    li.innerHTML = `<div class="miniature"></div><div class="fichier"><span class="nom"></span>`
      + `<span class="muted small">${infos}</span></div>`;
    li.querySelector(".nom").textContent = nom;   // textContent : un nom de fichier n'est jamais interprété en HTML
    if (g.miniature) {
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.src = `/api/gcodes/thumb/${nom.split("/").map(encodeURIComponent).join("/")}`;
      img.onerror = () => img.remove();         // miniature absente : on garde le carré vide
      li.firstChild.appendChild(img);
    }
    li.classList.toggle("choisi", nom === fichierChoisi);
    li.onclick = () => { fichierChoisi = nom; chargerGcodes(); };
    ul.appendChild(li);
  }
}

$("upload").onsubmit = async (ev) => {
  ev.preventDefault();
  const fichier = $("upload-fichier").files[0];
  if (!fichier) return;
  const form = new FormData();
  form.append("file", fichier);
  const rep = await fetch("/api/gcodes", { method: "POST", body: form });
  const res = await rep.json();
  if (!rep.ok) return toast(messageErreur(res), true);
  tacheEnCours = res.tache;
  toast(`Lancé : ${res.tache}`);
  $("upload").reset();
  rafraichir();
};

$("btn-imprimer").onclick = () => {
  if (!fichierChoisi) return toast("Choisis d'abord un fichier dans la liste", true);
  api("/api/print/start", { filename: fichierChoisi, slot: $("slot").value });
};

// ---------------------------------------------------------------------------
// Boutons
// ---------------------------------------------------------------------------

$("btn-pause").onclick = () => api("/api/print/pause", {}, "Impression en pause");
$("btn-reprise").onclick = () => api("/api/print/resume", {}, "Impression reprise");
$("btn-annuler").onclick = () => {
  if (confirm("Annuler l'impression en cours ?")) api("/api/print/cancel", {}, "Impression annulée");
};

// sliders : la commande part quand on relâche, pas à chaque pixel
for (const [id, chemin] of [["speed", "/api/speed"], ["flow", "/api/flow"], ["fan", "/api/fan"]]) {
  const el = $(id);
  el.oninput = () => { reglageActif = id; $("v-" + id).textContent = el.value + " %"; };
  el.onchange = async () => { await api(chemin, { percent: el.value }, `${id} : ${el.value} %`); reglageActif = null; };
}

document.querySelectorAll("[data-chauffe]").forEach((form) => {
  const cible = form.dataset.chauffe;
  const nom = cible === "nozzle" ? "Buse" : "Plateau";
  form.onsubmit = (ev) => {
    ev.preventDefault();
    const temp = form.querySelector("input").value;
    api("/api/temperature", { cible, temp }, `${nom} → ${temp} °C`);
  };
  form.querySelector("[data-off]").onclick = () => api("/api/temperature", { cible, temp: 0 }, `${nom} : chauffe coupée`);
});

document.querySelectorAll("[data-light]").forEach((b) => {
  b.onclick = () => api("/api/light", { on: b.dataset.light === "1" });
});

document.querySelectorAll("[data-home]").forEach((b) => {
  b.onclick = () => api("/api/home", { axes: b.dataset.home });
});

document.querySelectorAll("[data-jog]").forEach((b) => {
  b.onclick = () => {
    const pas = Number($("pas").value) * Number(b.dataset.dir);
    api("/api/move", { [b.dataset.jog]: pas, relative: true });
  };
});

$("btn-moteurs").onclick = () => api("/api/motors/off", {}, "Moteurs coupés");

$("btn-charger").onclick = () => api("/api/filament/load", { slot: $("fil-slot").value, temp: $("fil-temp").value });
$("btn-decharger").onclick = () => api("/api/filament/unload", { slot: $("fil-slot").value, temp: $("fil-temp").value });
document.querySelectorAll("[data-extrude]").forEach((b) => {
  b.onclick = () => api("/api/extrude", { length: b.dataset.extrude });
});

$("btn-dry").onclick = () => api("/api/ace/dry", { temp: $("dry-temp").value, duration: $("dry-duree").value }, "Séchage lancé");
$("btn-dry-stop").onclick = () => api("/api/ace/dry/stop", {}, "Séchage arrêté");

// console gcode
$("console").onsubmit = async (ev) => {
  ev.preventDefault();
  const script = $("console-cmd").value;
  const log = $("console-log");
  log.textContent += `> ${script}\n`;
  const rep = await fetch("/api/gcode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script }),
  });
  const res = await rep.json();
  log.textContent += (rep.ok ? "ok" : messageErreur(res)) + "\n";
  log.scrollTop = log.scrollHeight;
  $("console-cmd").value = "";
};

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

rafraichir();
demarrerFlux();
chargerVideos();
chargerGcodes();
dessinerGraphique();
setInterval(rafraichir, 2000);
setInterval(dessinerGraphique, 10000);
