-- Intake extras: batch history, tag evidence, Library MCP capabilities.
-- Every private root is Library-scoped. Do not copy local global uniques.

CREATE TABLE intake_tag_evidence (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  PRIMARY KEY (item_id, tag_id)
);

CREATE TABLE intake_batches (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  client_mutation_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('user', 'agent')),
  created_at TEXT NOT NULL,
  context_version TEXT,
  instruction TEXT,
  result_json TEXT NOT NULL,
  PRIMARY KEY (library_id, client_mutation_id)
);

CREATE TABLE library_capabilities (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('library:read', 'library:write')),
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX library_capabilities_library_idx ON library_capabilities(library_id, revoked_at);
