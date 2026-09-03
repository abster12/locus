-- Desk + Save a link. Every private root is Library-scoped.
-- Uniques include library_id. Do not copy the local global tag unique.

CREATE TABLE items (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
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

CREATE UNIQUE INDEX items_library_url_uidx ON items(library_id, url);
CREATE INDEX items_library_idx ON items(library_id);

CREATE TABLE item_state (
  item_id TEXT PRIMARY KEY NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  snoozed_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE activities (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  timestamp_source TEXT NOT NULL,
  capture_run_id TEXT
);

CREATE TABLE item_intake (
  item_id TEXT PRIMARY KEY NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  actor TEXT NOT NULL CHECK (actor IN ('user', 'agent')),
  created_at TEXT NOT NULL,
  observed_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX item_intake_library_idx ON item_intake(library_id);

CREATE TABLE tags (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT
);

CREATE UNIQUE INDEX tags_library_name_uidx ON tags(library_id, name);

CREATE TABLE collections (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX collections_library_idx ON collections(library_id);

CREATE TABLE memberships (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, target_id, target_kind)
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX notes_item_idx ON notes(item_id);
