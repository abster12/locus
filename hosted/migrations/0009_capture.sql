-- Account Sources and Capture Protocol. Library-scoped uniques.
-- Jobs and extension heartbeats live in D1 (leases + expiry). No in-memory loop.

CREATE TABLE source_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL,
  account_kind TEXT NOT NULL DEFAULT 'live' CHECK (account_kind IN ('live', 'imported', 'disconnected'))
);

CREATE UNIQUE INDEX source_accounts_library_uidx
  ON source_accounts(library_id, source, external_id, account_kind);
CREATE INDEX source_accounts_library_idx ON source_accounts(library_id, source);

CREATE TABLE source_collections (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  source_account_id TEXT NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX source_collections_account_uidx
  ON source_collections(source_account_id, external_id);
CREATE INDEX source_collections_library_idx ON source_collections(library_id);

CREATE TABLE capture_runs (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  source_collection_id TEXT NOT NULL REFERENCES source_collections(id) ON DELETE CASCADE,
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

CREATE INDEX capture_runs_collection_idx ON capture_runs(source_collection_id, started_at);
CREATE INDEX capture_runs_library_idx ON capture_runs(library_id);

CREATE TABLE source_records (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  source_account_id TEXT NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  revision TEXT,
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  source_position INTEGER,
  metadata TEXT
);

CREATE UNIQUE INDEX source_records_account_uidx
  ON source_records(source_account_id, external_id);
CREATE INDEX source_records_item_idx ON source_records(item_id);
CREATE INDEX source_records_library_idx ON source_records(library_id);

CREATE TABLE source_memberships (
  source_collection_id TEXT NOT NULL REFERENCES source_collections(id) ON DELETE CASCADE,
  source_record_id TEXT NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  source_position INTEGER,
  PRIMARY KEY (source_collection_id, source_record_id)
);

CREATE TABLE capture_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  source_account_id TEXT,
  capabilities TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX capture_tokens_library_idx ON capture_tokens(library_id, revoked_at);
CREATE INDEX capture_tokens_account_idx ON capture_tokens(source_account_id);

CREATE TABLE capture_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
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

CREATE INDEX capture_sessions_library_idx ON capture_sessions(library_id);
CREATE INDEX capture_sessions_run_idx ON capture_sessions(capture_run_id);

CREATE TABLE capture_batches (
  session_id TEXT NOT NULL REFERENCES capture_sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  PRIMARY KEY (session_id, sequence)
);

CREATE UNIQUE INDEX capture_batches_idempotency_uidx
  ON capture_batches(session_id, idempotency_key);

CREATE TABLE capture_seen (
  capture_run_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  PRIMARY KEY (capture_run_id, external_id)
);

CREATE TABLE capture_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'cancelled')),
  token_id TEXT,
  token_plain TEXT,
  progress_json TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX capture_jobs_wait_idx ON capture_jobs(library_id, status, created_at);
CREATE INDEX capture_jobs_account_idx ON capture_jobs(source_account_id, status);

CREATE TABLE capture_heartbeats (
  library_id TEXT PRIMARY KEY NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  last_seen_at TEXT NOT NULL
);
