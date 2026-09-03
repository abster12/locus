-- Kitchen Recipe Documents and Tonight. Library-scoped uniques.

CREATE TABLE kitchen_recipe_documents (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'reviewed')),
  source_revision TEXT NOT NULL,
  source_caption TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (updated_by IN ('user', 'agent')),
  draft_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(library_id, item_id)
);

CREATE INDEX kitchen_recipe_library_item ON kitchen_recipe_documents(library_id, item_id);

CREATE TABLE kitchen_tonight_entries (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(library_id, item_id),
  UNIQUE(library_id, position)
);

CREATE INDEX kitchen_tonight_library_position ON kitchen_tonight_entries(library_id, position);

CREATE TABLE kitchen_tonight_state (
  library_id TEXT PRIMARY KEY NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL
);

CREATE TABLE kitchen_tonight_mutations (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  client_mutation_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  result_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(library_id, client_mutation_id)
);
