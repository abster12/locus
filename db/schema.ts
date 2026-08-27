import type { Db } from "./open.ts";

export const SCHEMA_VERSION = 5;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_accounts (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL,
  account_kind TEXT NOT NULL DEFAULT 'live',
  UNIQUE(source, external_id, account_kind)
);

CREATE TABLE IF NOT EXISTS source_collections (
  id TEXT PRIMARY KEY,
  source_account_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(source_account_id, external_id)
);

CREATE TABLE IF NOT EXISTS capture_runs (
  id TEXT PRIMARY KEY,
  source_collection_id TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  coverage TEXT,
  status TEXT NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 0,
  upserted_count INTEGER NOT NULL DEFAULT 0,
  removed_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_detail TEXT,
  checkpoint TEXT,
  last_sequence INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS source_records (
  id TEXT PRIMARY KEY,
  source_account_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  revision TEXT,
  item_id TEXT,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  source_position INTEGER,
  metadata TEXT,
  UNIQUE(source_account_id, external_id)
);

CREATE TABLE IF NOT EXISTS source_memberships (
  source_collection_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_position INTEGER,
  PRIMARY KEY (source_collection_id, source_record_id)
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  title TEXT,
  body TEXT,
  url TEXT NOT NULL,
  author_name TEXT,
  author_handle TEXT,
  published_at TEXT,
  source_saved_at TEXT,
  first_observed_at TEXT NOT NULL,
  captured_at TEXT,
  media TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  timestamp_source TEXT NOT NULL,
  capture_run_id TEXT
);

CREATE TABLE IF NOT EXISTS item_state (
  item_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  snoozed_until TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT
);

CREATE TABLE IF NOT EXISTS memberships (
  item_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, target_id, target_kind),
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_ref TEXT NOT NULL,
  item_revisions TEXT NOT NULL,
  generator_id TEXT NOT NULL,
  generator_version TEXT NOT NULL,
  content TEXT NOT NULL,
  citations TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capture_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  source_account_id TEXT,
  capabilities TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS capture_sessions (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  source_collection_id TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  mode TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  capture_run_id TEXT NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  finished_at TEXT,
  coverage TEXT,
  account_external_id TEXT NOT NULL,
  collection_external_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capture_batches (
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  PRIMARY KEY (session_id, sequence),
  UNIQUE (session_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS capture_seen (
  capture_run_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  PRIMARY KEY (capture_run_id, external_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS link_previews (
  url TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  title TEXT,
  description TEXT,
  image TEXT,
  site_name TEXT,
  fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_observed ON items(first_observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_source_records_item ON source_records(item_id);
CREATE INDEX IF NOT EXISTS idx_activities_item ON activities(item_id);
CREATE INDEX IF NOT EXISTS idx_memberships_item ON memberships(item_id);
CREATE INDEX IF NOT EXISTS idx_notes_item ON notes(item_id);
CREATE INDEX IF NOT EXISTS idx_runs_collection ON capture_runs(source_collection_id, started_at DESC);
`;

type ForeignKey = { table: string; from: string; to: string; on_delete: string };

/**
 * Upgrade databases created before Item relationships were enforced.
 * SQLite cannot add a foreign key to an existing table, so the three child
 * tables are rebuilt after invalid rows are removed. This is intentionally
 * idempotent: opening an already-upgraded database does no table work.
 */
export function migrateSchema(db: Db): void {
  const current = Number((db.prepare(`PRAGMA user_version`).get() as { user_version?: number } | undefined)?.user_version ?? 0);
  if (current >= SCHEMA_VERSION) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    // Clean data that could not satisfy the new Item and target relationships.
    db.exec(`
      DELETE FROM item_state WHERE item_id NOT IN (SELECT id FROM items);
      DELETE FROM notes WHERE item_id NOT IN (SELECT id FROM items);
      DELETE FROM memberships
       WHERE item_id NOT IN (SELECT id FROM items)
          OR (target_kind = 'tag' AND target_id NOT IN (SELECT id FROM tags))
          OR (target_kind = 'collection' AND target_id NOT IN (SELECT id FROM collections));
    `);

    if (!hasItemForeignKey(db, "item_state")) {
      rebuildItemState(db);
    }
    if (!hasItemForeignKey(db, "notes")) {
      rebuildNotes(db);
    }
    if (!hasItemForeignKey(db, "memberships")) {
      rebuildMemberships(db);
    }
    migrateCaptureBatches(db);
    migrateSourceAccounts(db);

    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original migration error.
    }
    throw error;
  }
}

function migrateSourceAccounts(db: Db): void {
  const columns = db.prepare(`PRAGMA table_info(source_accounts)`).all() as { name: string }[];
  if (!columns.some((column) => column.name === "account_kind")) {
    db.exec(`ALTER TABLE source_accounts ADD COLUMN account_kind TEXT NOT NULL DEFAULT 'live'`);
  }
  // Preserve the provenance of identities imported by the older schema. New
  // generic imports set this explicitly at session start below.
  db.exec(`
    UPDATE source_accounts
       SET account_kind = 'imported'
     WHERE account_kind = 'live'
       AND (
         external_id = 'reddit-export'
         OR external_id LIKE 'import:%'
         OR external_id LIKE 'fixture:%'
         OR id IN (
           SELECT DISTINCT sr.source_account_id
             FROM source_records sr
             JOIN activities a ON a.item_id = sr.item_id
            WHERE a.kind = 'imported'
         )
         OR id IN (
           SELECT DISTINCT cs.source_account_id
             FROM capture_sessions cs
             JOIN capture_tokens t ON t.id = cs.token_id
            WHERE t.source = cs.source
              AND t.source_account_id IS NULL
         )
       )
  `);
  const indexes = db.prepare(`PRAGMA index_list('source_accounts')`).all() as {
    name: string;
    unique: number;
    origin: string;
  }[];
  const hasLegacyIdentityIndex = indexes.some((index) => {
    if (index.unique !== 1 || index.origin === "pk") return false;
    const quotedName = `"${index.name.replaceAll('"', '""')}"`;
    const columns = db.prepare(`PRAGMA index_info(${quotedName})`).all() as { name: string | null }[];
    return columns.map((column) => column.name ?? "").join("\u0000") === "source\u0000external_id";
  });
  if (!hasLegacyIdentityIndex) return;
  db.exec(`
    ALTER TABLE source_accounts RENAME TO source_accounts_legacy;
    CREATE TABLE source_accounts (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      display_name TEXT,
      created_at TEXT NOT NULL,
      account_kind TEXT NOT NULL DEFAULT 'live',
      UNIQUE(source, external_id, account_kind)
    );
    INSERT INTO source_accounts (id, source, external_id, display_name, created_at, account_kind)
      SELECT id, source, external_id, display_name, created_at, account_kind FROM source_accounts_legacy;
    DROP TABLE source_accounts_legacy;
  `);
}

/**
 * The original schema made an idempotency key globally unique. Rebuild that
 * table for existing databases so a key is scoped to its capture session
 * without discarding the capture history already recorded there.
 */
function migrateCaptureBatches(db: Db): void {
  const indexes = db.prepare(`PRAGMA index_list('capture_batches')`).all() as {
    name: string;
    unique: number;
    origin: string;
  }[];
  const uniqueColumns = (index: { name: string }): string[] => {
    const quotedName = `"${index.name.replaceAll('"', '""')}"`;
    const columns = db.prepare(`PRAGMA index_info(${quotedName})`).all() as { name: string | null }[];
    return columns.map((column) => column.name ?? "");
  };
  const hasGlobalIdempotencyIndex = indexes.some(
    (index) => index.unique === 1 && index.origin !== "pk" && uniqueColumns(index).join("\u0000") === "idempotency_key",
  );
  const hasSessionIdempotencyIndex = indexes.some(
    (index) => index.unique === 1 && uniqueColumns(index).join("\u0000") === "session_id\u0000idempotency_key",
  );
  if (!hasGlobalIdempotencyIndex && hasSessionIdempotencyIndex) return;

  db.exec(`
    CREATE TABLE capture_batches_migration (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      PRIMARY KEY (session_id, sequence),
      UNIQUE (session_id, idempotency_key)
    );
    INSERT INTO capture_batches_migration (session_id, sequence, idempotency_key)
      SELECT session_id, sequence, idempotency_key FROM capture_batches;
    DROP TABLE capture_batches;
    ALTER TABLE capture_batches_migration RENAME TO capture_batches;
  `);
}

function hasItemForeignKey(db: Db, table: string): boolean {
  const keys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as ForeignKey[];
  return keys.some(
    (key) => key.table === "items" && key.from === "item_id" && key.to === "id" && key.on_delete.toUpperCase() === "CASCADE",
  );
}

function rebuildItemState(db: Db): void {
  db.exec(`
    ALTER TABLE item_state RENAME TO item_state_legacy;
    CREATE TABLE item_state (
      item_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      snoozed_until TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
    );
    INSERT INTO item_state (item_id, status, snoozed_until, updated_at)
      SELECT item_id, status, snoozed_until, updated_at FROM item_state_legacy;
    DROP TABLE item_state_legacy;
  `);
}

function rebuildNotes(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_notes_item;
    ALTER TABLE notes RENAME TO notes_legacy;
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
    );
    INSERT INTO notes (id, item_id, body, created_at, updated_at)
      SELECT id, item_id, body, created_at, updated_at FROM notes_legacy;
    DROP TABLE notes_legacy;
    CREATE INDEX IF NOT EXISTS idx_notes_item ON notes(item_id);
  `);
}

function rebuildMemberships(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_memberships_item;
    ALTER TABLE memberships RENAME TO memberships_legacy;
    CREATE TABLE memberships (
      item_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL,
      PRIMARY KEY (item_id, target_id, target_kind),
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
    );
    INSERT INTO memberships (item_id, target_id, target_kind, actor, created_at)
      SELECT item_id, target_id, target_kind, actor, created_at FROM memberships_legacy;
    DROP TABLE memberships_legacy;
    CREATE INDEX IF NOT EXISTS idx_memberships_item ON memberships(item_id);
  `);
}
