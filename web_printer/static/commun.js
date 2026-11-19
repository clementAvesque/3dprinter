// Outils partagés par les pages Suivi 3D et Galerie (script classique : fonctions globales).

const $ = (id) => document.getElementById(id);

const ETATS = { READY: "Prête", PRINTING: "Impression", BREAK: "En pause", ERROR: "Erreur" };

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

function duree(secondes) {
  if (secondes == null) return "—";
  const h = Math.floor(secondes / 3600);
  const m = Math.floor((secondes % 3600) / 60);
  const s = Math.floor(secondes % 60);
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min ${String(s).padStart(2, "0")}`;
}

const arrondi = (v, n = 1) => (v == null ? "—" : Number(v).toFixed(n));

function octets(n) {
  if (n == null) return "—";
  const unites = ["o", "Ko", "Mo", "Go"];
  let i = 0;
  while (n >= 1024 && i < unites.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(1).replace(".", ",") : n} ${unites[i]}`;
}

function dateCourte(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

// URL d'un fichier : chaque morceau du chemin est encodé, les "/" des sous-dossiers restent
const cheminUrl = (nom) => nom.split("/").map(encodeURIComponent).join("/");

// pastille verte/rouge + badge d'état dans l'en-tête
function majEntete(e) {
  if (!e) return;
  $("dot").className = "dot " + (e.online ? "on" : "off");
  $("badge").className = "badge " + (e.online ? e.state || "" : "ERROR");
  $("badge").textContent = e.online ? ETATS[e.state] || "Inconnu" : "Hors ligne";
}

async function lireEtat() {
  try {
    return await (await fetch("/api/state")).json();
  } catch {
    $("dot").className = "dot off";
    $("badge").textContent = "Serveur arrêté";
    return null;
  }
}

// lance une impression ; le backend répond tout de suite (202) puis travaille en tâche de fond :
// on suit la tâche et on affiche son résultat quand elle se termine
async function lancerImpression(filename, slot) {
  const rep = await fetch("/api/print/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, slot }),
  });
  const res = await rep.json();
  if (!rep.ok) { toast(messageErreur(res), true); return false; }
  toast(`Lancé : ${res.tache}`);
  const suivre = setInterval(async () => {
    const d = await lireEtat();
    const t = d && d.tache;
    if (!t || t.en_cours || t.nom !== res.tache) return;
    clearInterval(suivre);
    const r = t.resultat || {};
    if (r.error) toast(`${t.nom} : ${messageErreur(r)}`, true);
    else toast(`Impression démarrée : ${filename}`);
    for (const a of r.avertissements || []) toast(`⚠ ${a}`, true);
  }, 2000);
  return true;
}
