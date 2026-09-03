-- Trip Documents, days, stops, changesets, advisories, receipts, and share hashes.
-- Public share HTML is later. Owner share routes use these tables.

CREATE TABLE trips (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  destination TEXT NOT NULL,
  timezone TEXT,
  start_date TEXT,
  end_date TEXT,
  duration_days INTEGER NOT NULL,
  travelers TEXT,
  context_json TEXT NOT NULL DEFAULT '{}',
  inferences_json TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(library_id, id)
);

CREATE INDEX trips_library_updated ON trips(library_id, updated_at DESC);

CREATE TABLE trip_days (
  id TEXT PRIMARY KEY NOT NULL,
  trip_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  date TEXT,
  label TEXT NOT NULL,
  theme TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(trip_id, position),
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

CREATE INDEX trip_days_trip ON trip_days(trip_id, position);

CREATE TABLE trip_stops (
  id TEXT PRIMARY KEY NOT NULL,
  trip_id TEXT NOT NULL,
  day_id TEXT,
  position INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'confirmed' CHECK (state IN ('confirmed', 'draft')),
  provenance_json TEXT NOT NULL DEFAULT '{}',
  public_notes TEXT NOT NULL DEFAULT '',
  private_notes TEXT NOT NULL DEFAULT '',
  time_window TEXT,
  duration_minutes INTEGER,
  reservation TEXT,
  stored_facts_json TEXT NOT NULL DEFAULT '[]',
  alternatives_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
  FOREIGN KEY (day_id) REFERENCES trip_days(id) ON DELETE SET NULL
);

CREATE INDEX trip_stops_order ON trip_stops(trip_id, day_id, position);

CREATE TABLE trip_changesets (
  id TEXT PRIMARY KEY NOT NULL,
  trip_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  result_revision INTEGER NOT NULL,
  actor TEXT NOT NULL,
  instruction TEXT,
  client_mutation_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'change' CHECK (kind IN ('change', 'undo', 'redo')),
  operations_json TEXT NOT NULL,
  inverse_json TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  reverses_id TEXT,
  payload_hash TEXT NOT NULL,
  undone_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(trip_id, client_mutation_id),
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

CREATE INDEX trip_changesets_trip ON trip_changesets(trip_id, created_at);

CREATE TABLE trip_advisories (
  id TEXT PRIMARY KEY NOT NULL,
  trip_id TEXT NOT NULL,
  reviewed_revision INTEGER NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('travel_feasibility', 'strain', 'missing_information')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'concern', 'urgent')),
  opinion TEXT NOT NULL,
  rationale TEXT NOT NULL,
  day_refs_json TEXT NOT NULL DEFAULT '[]',
  stop_refs_json TEXT NOT NULL DEFAULT '[]',
  actor TEXT NOT NULL DEFAULT 'agent',
  client_mutation_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  dismissed_at TEXT,
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

CREATE INDEX trip_advisories_trip ON trip_advisories(trip_id, created_at);
CREATE INDEX trip_advisories_mutation ON trip_advisories(trip_id, client_mutation_id);

CREATE TABLE trip_share_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  trip_id TEXT NOT NULL,
  trip_revision INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

CREATE INDEX trip_share_snapshots_trip ON trip_share_snapshots(trip_id);

CREATE TABLE trip_mutation_receipts (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  client_mutation_id TEXT NOT NULL,
  trip_id TEXT,
  kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  result_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(library_id, client_mutation_id)
);

CREATE TABLE trip_review_intents (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (library_id, session_id, trip_id),
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);
