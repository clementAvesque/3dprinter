// Bon de colis d'une commande (bon.html?commande=ID) : adresse de livraison, pièces à mettre dans le colis
// (une case à cocher par pièce), plaques d'où elles sortent. Tout est écrit avec textContent : rien de ce
// que le client a saisi (nom, adresse, noms de fichiers) n'est interprété comme du HTML.

(() => {
  const el = (tag, classe, texte) => { const e = document.createElement(tag); if (classe) e.className = classe; if (texte != null) e.textContent = texte; return e; };
  const euros = (cts) => (cts == null ? '—' : `${(cts / 100).toFixed(2).replace('.', ',')} €`);
  const mm = (v) => `${Math.round(v * 10) / 10}`.replace('.', ',');
  const jour = (ms) => (ms ? new Date(ms).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }) : '—');

  function bloc(titre, ...contenu) {
    const s = el('section', 'bon-bloc');
    s.append(el('h2', null, titre), ...contenu);
    return s;
  }

  function afficher(c) {
    const zone = $('bon');
    zone.replaceChildren();
    document.title = `Bon de colis ${c.ref || c.id} · Imprimantes`;

    const tete = el('header', 'bon-tete');
    const gauche = el('div');
    gauche.append(el('h1', null, 'Bon de colis'), el('p', 'muted', `Commande ${c.ref || ''} · n° ${c.id} · payée le ${jour(c.paye_le)}`));
    tete.append(gauche, el('div', 'bon-ref', c.ref || String(c.id)));

    // adresse en gros : lisible pour coller / recopier sur le colis
    const a = c.livraison_adresse || {};
    const adresse = el('div', 'bon-adresse');
    for (const l of [c.livraison_nom, a.ligne1, a.ligne2, `${a.code_postal || ''} ${a.ville || ''}`.trim(), a.pays].filter(Boolean)) adresse.append(el('div', null, l));
    const contact = el('p', 'muted small', `${c.client?.nom || ''} · ${c.client?.email || ''}${a.telephone ? ` · ${a.telephone}` : ''}`);

    // contenu : une case par pièce, regroupé par devis (= plateau)
    const liste = c.devis_liste?.length ? c.devis_liste : [c.devis];
    const pieces = el('div');
    let total = 0;
    for (const d of liste) {
      pieces.append(el('h3', null, `Devis ${d.ref || d.id}`));
      const ul = el('ul', 'bon-pieces');
      for (const p of d.pieces) {
        total += p.quantite;
        const li = el('li');
        li.append(el('span', 'case'), el('b', null, `${p.quantite} ×`), el('span', null, p.nom),
          el('span', 'muted', `${mm(p.dims_mm[0])} × ${mm(p.dims_mm[1])} × ${mm(p.dims_mm[2])} mm`
            + (p.echelle && p.echelle !== 1 ? ` · taille ×${String(p.echelle).replace('.', ',')}` : '')));
        ul.append(li);
      }
      pieces.append(ul);
    }
    pieces.append(el('p', 'small', `${total} pièce(s) au total · ${euros(c.total_cts)}`));

    const plaques = (c.plaques || []).map((p) => `${p.numero}${p.fichier ? ` (${p.fichier.split('/').pop()})` : ''}`);
    zone.append(tete,
      bloc('Livrer à', adresse, contact),
      bloc('Contenu du colis', pieces),
      bloc('Plaques', el('p', 'small', plaques.join(' · ') || 'aucune plaque enregistrée')),
      el('p', 'bon-pied muted small', 'Merci pour ta commande ! Un souci avec une pièce ? Réponds simplement à l\'e-mail de confirmation.'));
    $('imprimer').disabled = false;
  }

  async function charger() {
    const id = new URLSearchParams(location.search).get('commande');
    if (!id || !/^\d+$/.test(id)) { $('bon-message').textContent = 'Commande non précisée.'; return; }
    const r = await api('GET', `/boutique/commandes/${encodeURIComponent(id)}`);
    if (!r.ok) { $('bon-message').textContent = `Impossible de charger la commande : ${texteErreur(r.json)}`; return; }
    afficher(r.json);
  }

  $('imprimer').addEventListener('click', () => window.print());
  charger();
})();
