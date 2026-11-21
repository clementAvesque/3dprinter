'use strict';
// File de découpe (src/orca.js) seule, avec le faux Orca : arrêt du serveur en pleine découpe.
//   npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { ouvrir } = require('../src/db');
const { creerDecoupeur } = require('../src/orca');

test('arrêt du serveur pendant une découpe : le devis revient en file (pas en erreur) et reprend au redémarrage', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-test-'));
  const db = ouvrir(dossier);
  const now = Date.now();
  const client = db.prepare("INSERT INTO clients (email, hash, nom, cree_le) VALUES ('o@test', 'x', 'O', ?)").run(now).lastInsertRowid;
  fs.mkdirSync(path.join(dossier, 'stl'));
  fs.writeFileSync(path.join(dossier, 'stl', 'p.stl.gz'), zlib.gzipSync(Buffer.alloc(184)));
  const f = db.prepare(`INSERT INTO fichiers_stl (client_id, nom_origine, chemin, taille_octets, sha256, triangles, dim_x_mm, dim_y_mm,
    dim_z_mm, cree_le, expire_le) VALUES (?, 'p.stl', 'stl/p.stl.gz', 184, 'x', 2, 10, 10, 10, ?, ?)`).run(client, now, now + 864e5).lastInsertRowid;
  const devis = db.prepare(`INSERT INTO devis (client_id, imprimante_id, remplissage_pct, couches_surface, proprete_mm, statut, cree_le)
    VALUES (?, 'kobra-1', 96, 3, 0.2, 'attente', ?)`).run(client, now).lastInsertRowid;
  db.prepare('INSERT INTO devis_pieces (devis_id, fichier_id, quantite) VALUES (?, ?, 1)').run(devis, f);

  const config = { donnees: dossier, orca: { commande: [process.execPath, path.join(__dirname, 'faux-orca.js')],
    profils: path.join(__dirname, '..', 'orca'), delaiMs: 60e3, intervalleMs: 50 } };
  const statut = () => db.prepare('SELECT statut, erreur, decoupe_debut_le FROM devis WHERE id = ?').get(devis);
  const decoupeur = creerDecoupeur({ config, db, calculerPrix: () => ({ prix_matiere_cts: 1, livraison_cts: 1 }) });
  for (let i = 0; i < 100 && statut().statut !== 'decoupe'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(statut().statut, 'decoupe');
  assert.ok(statut().decoupe_debut_le >= now, 'début de découpe noté (barre de progression)');
  await new Promise((r) => setTimeout(r, 300));                        // Orca est bien lancé

  await decoupeur.arreter();
  assert.equal(statut().statut, 'attente', JSON.stringify(statut()));
  assert.equal(statut().erreur, null);
  db.close();
  fs.rmSync(dossier, { recursive: true, force: true });
});
