'use strict';
// Tables de la boutique (site client) : voir web_printer_user/CONCEPTION.md, section « MLD ».
// Toutes les dates sont en millisecondes (Date.now()), tous les montants en centimes entiers.
// Les comptes clients sont séparés des comptes admin (table utilisateurs) : une session client ne
// donne jamais accès à l'API admin.

const IMPRIMANTES_DEFAUT = [
  // Kobra 3 : plateau 250 x 250 x 260 mm, buse 0,4 mm
  { id: 'kobra-1', nom: 'Kobra 3', x: 250, y: 250, z: 260, buse: 0.4, profil: 'kobra3' },
];

// Plaques (table lots) : un plateau imprimé d'un coup. Étape 1 : une plaque par devis d'une commande validée ;
// étape 2 : plusieurs commandes fusionnées sur une plaque (d'où lot_pieces, pièce par pièce).
//   a_envoyer -> a_faire (gcode dans « a_faire/ » de l'imprimante) -> en_impression -> imprimee (à valider)
//   -> validee (rangée dans « imprimees/ ») ; ratée : retour à a_faire ; annulee : commande remboursée
const SCHEMA_PLAQUES = `
    CREATE TABLE IF NOT EXISTS lots (
      id              INTEGER PRIMARY KEY,
      imprimante_id   TEXT NOT NULL REFERENCES imprimantes(id),
      proprete_mm     REAL NOT NULL CHECK (proprete_mm IN (0.2, 0.4)),
      statut          TEXT NOT NULL DEFAULT 'a_envoyer' CHECK (statut IN (
                        'a_envoyer', 'a_faire', 'en_impression', 'imprimee', 'validee', 'annulee')),
      gcode_chemin    TEXT,                                -- gcode sur le serveur (celui du devis à l'étape 1)
      fichier_machine TEXT,                                -- nom sur l'imprimante : a_faire/P0007_... puis imprimees/...
      rangement       TEXT,                                -- déplacement vers imprimees/ pas encore fait (agent absent)
      duree_s         INTEGER,
      tentatives      INTEGER NOT NULL DEFAULT 0,
      erreur          TEXT,
      cree_le         INTEGER NOT NULL,
      envoye_le       INTEGER,
      lance_le        INTEGER,
      fini_le         INTEGER,
      valide_le       INTEGER,
      valide_par      INTEGER REFERENCES utilisateurs(id)
    );
    CREATE INDEX IF NOT EXISTS lots_statut ON lots(statut);

    CREATE TABLE IF NOT EXISTS lot_pieces (
      id               INTEGER PRIMARY KEY,
      lot_id           INTEGER NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
      devis_piece_id   INTEGER NOT NULL REFERENCES devis_pieces(id),
      quantite         INTEGER NOT NULL,
      remplissage_pct  INTEGER NOT NULL,                   -- repris du devis : réglage par objet dans Orca
      couches_surface  INTEGER NOT NULL,
      pos_x_mm         REAL,
      pos_y_mm         REAL
    );
    CREATE INDEX IF NOT EXISTS lot_pieces_lot ON lot_pieces(lot_id);
    CREATE INDEX IF NOT EXISTS lot_pieces_piece ON lot_pieces(devis_piece_id);`;

// texte UTF-8 lu par erreur en latin1 (« Ã© » pour « é ») -> texte d'origine ; sinon inchangé
function reparerNom(nom) {
  if (!/[\u0080-ÿ]/.test(nom) || /[^\u0000-ÿ]/.test(nom)) return nom;
  const utf8 = Buffer.from(nom, 'latin1').toString('utf8');
  return utf8.includes('�') ? nom : utf8;
}

function schemaBoutique(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id             INTEGER PRIMARY KEY,
      email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
      hash           TEXT NOT NULL,                       -- Argon2id
      nom            TEXT NOT NULL,
      email_verifie  INTEGER NOT NULL DEFAULT 0,
      actif          INTEGER NOT NULL DEFAULT 1,
      cree_le        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions_client (
      id          TEXT PRIMARY KEY,                       -- SHA-256 du jeton (jamais stocké en clair)
      client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      csrf        TEXT NOT NULL,
      cree_le     INTEGER NOT NULL,
      vu_le       INTEGER NOT NULL,
      ip          TEXT,
      agent_nav   TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_client_client ON sessions_client(client_id);

    -- vérification de l'e-mail et lien éphémère « mot de passe oublié » (usage unique)
    CREATE TABLE IF NOT EXISTS jetons_email (
      id          TEXT PRIMARY KEY,                       -- SHA-256 du jeton envoyé par e-mail
      client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      type        TEXT NOT NULL CHECK (type IN ('verification', 'mot_de_passe')),
      cree_le     INTEGER NOT NULL,
      expire_le   INTEGER NOT NULL,
      utilise_le  INTEGER
    );
    CREATE INDEX IF NOT EXISTS jetons_email_client ON jetons_email(client_id, type);

    CREATE TABLE IF NOT EXISTS adresses (
      id           INTEGER PRIMARY KEY,
      client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      nom_complet  TEXT NOT NULL,
      ligne1       TEXT NOT NULL,
      ligne2       TEXT,
      code_postal  TEXT NOT NULL,
      ville        TEXT NOT NULL,
      pays         TEXT NOT NULL DEFAULT 'FR',
      telephone    TEXT,
      cree_le      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS adresses_client ON adresses(client_id);

    -- même identifiant que la machine de l'agent (ex. kobra-1)
    CREATE TABLE IF NOT EXISTS imprimantes (
      id            TEXT PRIMARY KEY,
      nom           TEXT NOT NULL,
      plateau_x_mm  INTEGER NOT NULL,
      plateau_y_mm  INTEGER NOT NULL,
      plateau_z_mm  INTEGER NOT NULL,
      buse_mm       REAL NOT NULL,
      profil_orca   TEXT NOT NULL,
      disponible    INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS fichiers_stl (
      id             INTEGER PRIMARY KEY,
      client_id      INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      nom_origine    TEXT NOT NULL,
      chemin         TEXT NOT NULL,                       -- relatif au dossier de données, compressé (gzip)
      taille_octets  INTEGER NOT NULL,                    -- taille d'origine
      sha256         TEXT NOT NULL,
      triangles      INTEGER NOT NULL,
      dim_x_mm       REAL NOT NULL,
      dim_y_mm       REAL NOT NULL,
      dim_z_mm       REAL NOT NULL,
      volume_mm3     REAL,
      cree_le        INTEGER NOT NULL,
      expire_le      INTEGER NOT NULL                     -- 30 j ; repoussé à 2 ans quand il entre dans une commande payée
    );
    CREATE INDEX IF NOT EXISTS fichiers_stl_client ON fichiers_stl(client_id);
    CREATE INDEX IF NOT EXISTS fichiers_stl_expire ON fichiers_stl(expire_le);

    CREATE TABLE IF NOT EXISTS devis (
      id                INTEGER PRIMARY KEY,
      client_id         INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      imprimante_id     TEXT NOT NULL REFERENCES imprimantes(id),
      remplissage_pct   INTEGER NOT NULL CHECK (remplissage_pct BETWEEN 5 AND 100),
      couches_surface   INTEGER NOT NULL CHECK (couches_surface BETWEEN 2 AND 10),
      proprete_mm       REAL NOT NULL CHECK (proprete_mm IN (0.2, 0.4)),
      statut            TEXT NOT NULL DEFAULT 'attente' CHECK (statut IN ('attente', 'decoupe', 'pret', 'erreur')),
      erreur            TEXT,
      gcode_chemin      TEXT,                              -- gcode du devis seul (30 j après la fin de la commande)
      poids_g           REAL,
      duree_s           INTEGER,
      nb_couches        INTEGER,
      prix_matiere_cts  INTEGER,
      livraison_cts     INTEGER,
      cree_le           INTEGER NOT NULL,
      decoupe_le        INTEGER
    );
    CREATE INDEX IF NOT EXISTS devis_client ON devis(client_id);
    CREATE INDEX IF NOT EXISTS devis_statut ON devis(statut);

    CREATE TABLE IF NOT EXISTS devis_pieces (
      id            INTEGER PRIMARY KEY,
      devis_id      INTEGER NOT NULL REFERENCES devis(id) ON DELETE CASCADE,
      fichier_id    INTEGER NOT NULL REFERENCES fichiers_stl(id),
      quantite      INTEGER NOT NULL CHECK (quantite BETWEEN 1 AND 50),
      pos_x_mm      REAL,
      pos_y_mm      REAL,
      rotation_deg  REAL NOT NULL DEFAULT 0,
      poids_g       REAL
    );
    CREATE INDEX IF NOT EXISTS devis_pieces_devis ON devis_pieces(devis_id);
    CREATE INDEX IF NOT EXISTS devis_pieces_fichier ON devis_pieces(fichier_id);

    CREATE TABLE IF NOT EXISTS commandes (
      id                    INTEGER PRIMARY KEY,
      client_id             INTEGER NOT NULL REFERENCES clients(id),
      devis_id              INTEGER NOT NULL UNIQUE REFERENCES devis(id),
      statut                TEXT NOT NULL DEFAULT 'en_attente_paiement' CHECK (statut IN (
                              'en_attente_paiement', 'abandonnee', 'payee', 'validee', 'dans_un_lot',
                              'en_impression', 'suspendue', 'imprimee', 'expediee', 'livree', 'remboursee')),
      livraison_nom         TEXT NOT NULL,
      livraison_adresse     TEXT NOT NULL,                 -- copie figée (JSON) de l'adresse
      sous_total_cts        INTEGER NOT NULL,
      livraison_cts         INTEGER NOT NULL,
      total_cts             INTEGER NOT NULL,
      stripe_session_id     TEXT UNIQUE,
      stripe_paiement_id    TEXT,
      valide_par            INTEGER REFERENCES utilisateurs(id),
      motif_refus           TEXT,
      cree_le               INTEGER NOT NULL,
      paye_le               INTEGER,
      validation_limite_le  INTEGER,                       -- paye_le + 10 jours
      valide_le             INTEGER,
      envoi_limite_le       INTEGER,                       -- valide_le + 2 mois
      suspendue_le          INTEGER,
      rembourse_le          INTEGER,
      rembourse_par         TEXT CHECK (rembourse_par IN ('admin', 'auto_validation', 'auto_envoi')),
      expedie_le            INTEGER,
      numero_suivi          TEXT
    );
    CREATE INDEX IF NOT EXISTS commandes_client ON commandes(client_id);
    CREATE INDEX IF NOT EXISTS commandes_statut ON commandes(statut);

    -- devis d'une commande (commande groupée : plusieurs devis payés ensemble, une seule livraison).
    -- commandes.devis_id garde le premier devis ; un devis n'appartient qu'à une commande.
    CREATE TABLE IF NOT EXISTS commande_devis (
      commande_id  INTEGER NOT NULL REFERENCES commandes(id) ON DELETE CASCADE,
      devis_id     INTEGER NOT NULL UNIQUE REFERENCES devis(id),
      PRIMARY KEY (commande_id, devis_id)
    );
    CREATE TRIGGER IF NOT EXISTS commande_devis_premier AFTER INSERT ON commandes BEGIN
      INSERT OR IGNORE INTO commande_devis (commande_id, devis_id) VALUES (NEW.id, NEW.devis_id);
    END;
    -- commandes d'avant les commandes groupées
    INSERT OR IGNORE INTO commande_devis (commande_id, devis_id) SELECT id, devis_id FROM commandes;

    CREATE TABLE IF NOT EXISTS factures (
      id           INTEGER PRIMARY KEY,
      commande_id  INTEGER NOT NULL UNIQUE REFERENCES commandes(id),
      numero       TEXT NOT NULL UNIQUE,                   -- suite sans trou par année : 2026-000123
      total_cts    INTEGER NOT NULL,
      pdf_chemin   TEXT,
      emise_le     INTEGER NOT NULL
    );

    -- webhooks Stripe déjà traités : un même événement n'est jamais appliqué deux fois
    CREATE TABLE IF NOT EXISTS evenements_stripe (
      id           TEXT PRIMARY KEY,
      commande_id  INTEGER REFERENCES commandes(id),
      type         TEXT NOT NULL,
      recu_le      INTEGER NOT NULL
    );

    -- rappels e-mail envoyés à l'admin avant chaque échéance (jamais deux fois le même)
    CREATE TABLE IF NOT EXISTS rappels (
      id           INTEGER PRIMARY KEY,
      commande_id  INTEGER NOT NULL REFERENCES commandes(id) ON DELETE CASCADE,
      echeance     TEXT NOT NULL CHECK (echeance IN ('validation', 'envoi')),
      palier       TEXT NOT NULL CHECK (palier IN ('moitie', 'quart', 'j5', 'j2', 'depasse')),
      prevu_le     INTEGER NOT NULL,
      envoye_le    INTEGER,
      UNIQUE (commande_id, echeance, palier)
    );

    ${SCHEMA_PLAQUES}
  `);

  // ancienne table des lots (avant les plaques) : jamais utilisée, recréée si elle est vide
  const ancienne = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lots'").get()?.sql || '';
  if (!ancienne.includes("'a_envoyer'")) {
    const vide = db.prepare('SELECT (SELECT count(*) FROM lots) + (SELECT count(*) FROM lot_pieces) n').get().n === 0;
    if (vide) db.exec(`DROP TABLE lot_pieces; DROP TABLE lots; ${SCHEMA_PLAQUES}`);
    else console.error('[base] table lots ancienne et non vide : plaques désactivées tant qu\'elle n\'est pas migrée');
  }

  // colonnes ajoutées après la mise en ligne (bases existantes : ajoutées au démarrage)
  const ajouterColonne = (table, colonne, type) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === colonne)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${colonne} ${type}`);
    }
  };
  ajouterColonne('devis', 'decoupe_debut_le', 'INTEGER');     // début de la découpe : barre de progression du client
  ajouterColonne('devis_pieces', 'echelle', 'REAL NOT NULL DEFAULT 1');   // multiplicateur de taille (STL en mètres...)

  // galerie : pseudo public d'un client (unique), projets réalisés publiés par leur auteur, devis créés d'après eux
  ajouterColonne('clients', 'pseudo', 'TEXT');
  ajouterColonne('devis', 'publication_id', 'INTEGER');         // devis créé depuis la galerie (projet d'un autre client)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS clients_pseudo ON clients(pseudo COLLATE NOCASE) WHERE pseudo IS NOT NULL;
    CREATE TABLE IF NOT EXISTS publications (
      id          INTEGER PRIMARY KEY,
      uuid        TEXT UNIQUE,
      client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      devis_id    INTEGER NOT NULL UNIQUE REFERENCES devis(id) ON DELETE CASCADE,  -- le projet (devis commandé et imprimé)
      titre       TEXT NOT NULL,
      cree_le     INTEGER NOT NULL,
      retiree_le  INTEGER,                                     -- retirée par son auteur (ou compte supprimé)
      choisie     INTEGER NOT NULL DEFAULT 0                   -- nombre de devis créés d'après elle
    );
    CREATE INDEX IF NOT EXISTS publications_visibles ON publications(retiree_le, cree_le);
  `);
  // les STL du projet s'ouvrent dans l'atelier des visiteurs (pour les ajuster). Toutes les publications, y compris
  // celles d'avant cette colonne (décision de l'exploitant, auteurs prévenus par lui) ; 0 = aperçu seul.
  ajouterColonne('publications', 'partage_stl', 'INTEGER NOT NULL DEFAULT 1');

  // noms de STL envoyés avant le décodage UTF-8 de busboy : « cassÃ© » au lieu de « cassé ». Réparés au
  // démarrage ; un nom déjà correct ne bouge pas (relu en latin1, il ne forme pas de l'UTF-8 valide).
  const reparer = db.prepare('UPDATE fichiers_stl SET nom_origine = ? WHERE id = ?');
  for (const f of db.prepare("SELECT id, nom_origine FROM fichiers_stl WHERE nom_origine GLOB '*[^ -~]*'").all()) {
    const repare = reparerNom(f.nom_origine);
    if (repare !== f.nom_origine) reparer.run(repare, f.id);
  }

  // identifiant public (UUID v4) de ce que voit le client : les numéros internes (1, 2, 3...) ne sortent jamais
  // du serveur, personne ne peut deviner combien de devis ou de commandes existent ni lire ceux des autres.
  // Rempli par un déclencheur à chaque insertion (quel que soit le code qui insère), et pour les lignes existantes.
  const UUID_SQL = `lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2)
    || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))`;
  for (const table of ['devis', 'commandes', 'fichiers_stl', 'adresses', 'publications']) {
    ajouterColonne(table, 'uuid', 'TEXT');
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${table}_uuid ON ${table}(uuid);
      CREATE TRIGGER IF NOT EXISTS ${table}_uuid_auto AFTER INSERT ON ${table} WHEN NEW.uuid IS NULL BEGIN
        UPDATE ${table} SET uuid = ${UUID_SQL} WHERE id = NEW.id;
      END;
      UPDATE ${table} SET uuid = ${UUID_SQL} WHERE uuid IS NULL;
    `);
  }

  const inserer = db.prepare(`INSERT OR IGNORE INTO imprimantes
    (id, nom, plateau_x_mm, plateau_y_mm, plateau_z_mm, buse_mm, profil_orca, disponible) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`);
  for (const i of IMPRIMANTES_DEFAUT) inserer.run(i.id, i.nom, i.x, i.y, i.z, i.buse, i.profil);
}

module.exports = { schemaBoutique, reparerNom };
