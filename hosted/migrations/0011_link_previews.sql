-- Link preview cache for the Desk. Every private root is Library-scoped;
-- the cache unique includes library_id. Rows hold public page metadata only.

CREATE TABLE link_previews (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  title TEXT,
  description TEXT,
  image TEXT,
  site_name TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (library_id, url)
);
