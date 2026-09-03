-- Reading documents, provenance, and progress. Library-scoped uniques.
-- Article bytes live in D1. Images stay at their original URL (no asset table).

CREATE TABLE reading_documents (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  canonical_url TEXT NOT NULL,
  observed_url TEXT NOT NULL,
  final_url TEXT,
  kind TEXT NOT NULL,
  availability TEXT NOT NULL,
  failure_code TEXT,
  original_status TEXT NOT NULL DEFAULT 'unknown',
  original_checked_at TEXT,
  title TEXT,
  subtitle TEXT,
  byline TEXT,
  publication TEXT,
  published_at TEXT,
  language TEXT,
  excerpt TEXT,
  search_text TEXT,
  word_count INTEGER,
  reading_minutes INTEGER,
  content_blocks TEXT,
  content_hash TEXT,
  hero_asset_id TEXT,
  last_saved_at TEXT NOT NULL,
  removed_at TEXT,
  undo_token TEXT,
  undo_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  fetched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(library_id, id),
  UNIQUE(library_id, canonical_url)
);

CREATE TABLE reading_provenance (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  observed_url TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  PRIMARY KEY (library_id, document_id, item_id),
  FOREIGN KEY (library_id, document_id) REFERENCES reading_documents(library_id, id) ON DELETE CASCADE
);

CREATE TABLE reading_progress (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  state TEXT NOT NULL,
  progress REAL NOT NULL,
  anchor TEXT,
  first_opened_at TEXT,
  last_opened_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (library_id, document_id),
  FOREIGN KEY (library_id, document_id) REFERENCES reading_documents(library_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_reading_documents_queue ON reading_documents(library_id, removed_at, availability, last_saved_at, id);
CREATE INDEX idx_reading_documents_work ON reading_documents(next_attempt_at, lease_expires_at);
CREATE INDEX idx_reading_provenance_item ON reading_provenance(item_id);
CREATE INDEX idx_reading_provenance_document ON reading_provenance(document_id);
