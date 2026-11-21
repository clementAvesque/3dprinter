'use strict';
// Base SQLite (intégrée à Node 22, aucune dépendance native) : comptes, sessions, journal d'audit, agent,
// et les tables de la boutique (db-boutique.js).

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { schemaBoutique } = require('./db-boutique');

function ouvrir(dossier) {
  const db = new DatabaseSync(path.join(dossier, 'serveur.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS utilisateurs (
      id            INTEGER PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      nom           TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('lecteur', 'operateur', 'admin')),
      hash          TEXT NOT NULL,                 -- Argon2id
      totp_secret   TEXT NOT NULL,                 -- base32
      totp_dernier  INTEGER NOT NULL DEFAULT 0,    -- dernier pas de temps utilisé (anti-rejeu du code)
      codes_secours TEXT NOT NULL DEFAULT '[]',    -- empreintes SHA-256, usage unique
      actif         INTEGER NOT NULL DEFAULT 1,
      cree          INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,               -- SHA-256 du jeton (le jeton lui-même n'est jamais stocké)
      pub_id       TEXT NOT NULL UNIQUE,           -- identifiant montrable (liste des sessions)
      user_id      INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
      etape        TEXT NOT NULL CHECK (etape IN ('2fa', 'ok')),
      csrf         TEXT NOT NULL,
      cree         INTEGER NOT NULL,
      vu           INTEGER NOT NULL,
      dernier_2fa  INTEGER NOT NULL DEFAULT 0,
      ip           TEXT,
      agent_nav    TEXT
    );

    CREATE TABLE IF NOT EXISTS audit (
      id        INTEGER PRIMARY KEY,
      ts        INTEGER NOT NULL,
      user_id   INTEGER,
      ip        TEXT,
      action    TEXT NOT NULL,
      cible     TEXT,
      resultat  TEXT NOT NULL,
      detail    TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);

    CREATE TABLE IF NOT EXISTS agent (
      id            TEXT PRIMARY KEY,
      cle_publique  TEXT NOT NULL,                 -- Ed25519, PEM
      revoque       INTEGER NOT NULL DEFAULT 0,
      enrole        INTEGER NOT NULL
    );
  `);
  schemaBoutique(db);
  return db;
}

module.exports = { ouvrir };
