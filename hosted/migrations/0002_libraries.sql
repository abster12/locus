CREATE TABLE libraries (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE library_memberships (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role = 'owner'),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (library_id, user_id)
);

CREATE INDEX library_memberships_library_idx
  ON library_memberships(library_id);
