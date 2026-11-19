// Affichage du filament (script classique, utilisé par les trois pages) :
//   - le fil PRÉVU par le gcode (réglages du slicer : matière, couleur, profil)
//   - l'emplacement de l'ACE réellement UTILISÉ (lu sur la machine ou fixé au lancement)
// Données : `filament` de /api/state (print.filament) et `filament` des entrées de /api/gcodes.

const Filament = (() => {
  const echapper = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // couleur venant du fichier ou de la machine : seulement un vrai code hexadécimal
  const couleurSure = (c) => (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c || "") ? c.slice(0, 7) : null);

  function pastille(couleur) {
    const c = couleurSure(couleur);
    return c ? `<span class="pastille-fil" style="background:${c}"></span>`
      : '<span class="pastille-fil inconnue"></span>';
  }

  // "PLA" et "PLA High Speed" sont compatibles ; "PLA" et "PETG" non
  function compatibles(a, b) {
    if (!a || !b) return true;
    a = a.toUpperCase(); b = b.toUpperCase();
    return a.includes(b) || b.includes(a);
  }

  function distance(c1, c2) {
    c1 = couleurSure(c1); c2 = couleurSure(c2);
    if (!c1 || !c2) return 200;
    const v = (c, i) => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
    return Math.hypot(v(c1, 0) - v(c2, 0), v(c1, 1) - v(c2, 1), v(c1, 2) - v(c2, 2));
  }

  function prevu(fil, { court = false } = {}) {
    if (!fil) return '<span class="muted">Inconnu (réglages absents du fichier)</span>';
    const n = Math.max(fil.types.length, fil.couleurs.length, 1);
    const lignes = [];
    for (let i = 0; i < n; i++) {
      const morceaux = [fil.types[i], court ? null : fil.noms[i]].filter(Boolean).map(echapper);
      const outil = n > 1 ? `<span class="muted">T${i}</span> ` : "";
      lignes.push(`<span class="fil">${outil}${pastille(fil.couleurs[i])}${morceaux.join(" · ") || "—"}</span>`);
    }
    if (!court && fil.poids) lignes.push(`<span class="muted small">${Number(fil.poids).toFixed(1)} g prévus</span>`);
    if (!court && Array.isArray(fil.outils) && fil.outils.length === 0) {
      lignes.push('<span class="muted small">Le fichier ne choisit aucun emplacement : '
        + "l'imprimante prend celui associé à T0 (le 1, ou celui choisi au lancement).</span>");
    }
    return lignes.join("");
  }

  const SOURCES = {
    machine: "chargé dans la tête",
    lancement: "choisi au lancement",
  };

  function utilise(u) {
    if (!u || !u.emplacement) {
      return '<span class="muted">Inconnu : aucun fil chargé dans la tête pour l\'instant</span>';
    }
    const matiere = u.matiere ? ` · ${echapper(u.matiere)}` : "";
    const source = SOURCES[u.source] ? `<span class="muted small">${SOURCES[u.source]}</span>` : "";
    return `<span class="fil">${pastille(u.couleur)}Emplacement ${u.emplacement}${matiere}</span>${source}`;
  }

  // phrase d'alerte si la matière chargée ne correspond pas à celle du fichier, sinon null
  function alerte(fil, u) {
    const type = fil && fil.types[0];
    if (!type || !u || !u.matiere || compatibles(type, u.matiere)) return null;
    return `Le fichier est prévu pour du ${type}, mais l'emplacement ${u.emplacement} contient du ${u.matiere}.`;
  }

  // emplacement de l'ACE le plus proche du fil prévu (même matière d'abord, puis couleur la plus proche)
  function conseil(fil, fils) {
    if (!fil || !fils) return null;
    let meilleur = null;
    for (const f of fils) {
      if (!f.color) continue;
      const score = (compatibles(fil.types[0], f.matiere) ? 0 : 1000) + distance(fil.couleurs[0], f.color);
      if (!meilleur || score < meilleur.score) meilleur = { ...f, score };
    }
    return meilleur;
  }

  return { pastille, prevu, utilise, alerte, conseil, echapper };
})();
