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
  UNIQUE(source, external_id)
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
  updated_at TEXT NOT NULL
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
  PRIMARY KEY (item_id, target_id, target_kind)
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
  idempotency_key TEXT NOT NULL UNIQUE,
  PRIMARY KEY (session_id, sequence)
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
