-- Atlas Places and Place Assignments. Library-scoped uniques.
-- Home base and backfill cursors live in library_settings, not a global key.

CREATE TABLE library_settings (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (library_id, key)
);

CREATE TABLE atlas_places (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('country', 'admin', 'city', 'neighbourhood', 'venue', 'landmark', 'natural', 'place')),
  parent_id TEXT,
  alt_names TEXT NOT NULL DEFAULT '[]',
  lat REAL,
  lng REAL,
  external_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(library_id, id),
  FOREIGN KEY (parent_id) REFERENCES atlas_places(id) ON DELETE RESTRICT
);

CREATE INDEX atlas_places_library ON atlas_places(library_id, name);
CREATE INDEX atlas_places_parent ON atlas_places(parent_id);

CREATE TABLE atlas_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('placed', 'needs_place', 'multiple', 'not_atlas')),
  actor TEXT NOT NULL CHECK (actor IN ('analyzer', 'user')),
  primary_place_id TEXT,
  source_revision TEXT NOT NULL,
  write_version INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(library_id, item_id),
  CHECK (
    (outcome = 'placed' AND primary_place_id IS NOT NULL) OR
    (outcome IN ('needs_place', 'multiple', 'not_atlas') AND primary_place_id IS NULL)
  ),
  FOREIGN KEY (library_id, primary_place_id) REFERENCES atlas_places(library_id, id) ON DELETE RESTRICT
);

CREATE INDEX atlas_assignments_library ON atlas_assignments(library_id, outcome);
CREATE INDEX atlas_assignments_place ON atlas_assignments(primary_place_id);

CREATE TABLE atlas_attempts (
  item_id TEXT PRIMARY KEY NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  source_revision TEXT NOT NULL,
  analyzer_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  retryable INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  next_attempt_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX atlas_attempts_queue ON atlas_attempts(library_id, status, next_attempt_at);

CREATE TABLE atlas_screenings (
  item_id TEXT PRIMARY KEY NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  source_revision TEXT NOT NULL,
  screening_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  candidate INTEGER,
  retryable INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  next_attempt_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX atlas_screenings_queue ON atlas_screenings(library_id, status, next_attempt_at);
