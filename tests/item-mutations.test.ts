import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { SCHEMA_VERSION } from "../db/schema.ts";
import {
  MissingResource,
  addNote,
  addTag,
  addToCollection,
  createCollection,
  removeFromCollection,
  removeTag,
  setStatus,
} from "../core/commands.ts";
import { RejectedPayload } from "../core/sanitize.ts";

function db() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-")), "items.db"));
}

function insertItem(database: ReturnType<typeof db>, id = "item-1"): void {
  database
    .prepare(
      `INSERT INTO items (
        id, content_type, title, body, url, author_name, author_handle, published_at, source_saved_at,
        first_observed_at, captured_at, media, created_at, updated_at
      ) VALUES (?, 'post', NULL, NULL, 'https://example.com/item', NULL, NULL, NULL, NULL, ?, NULL, '[]', ?, ?)`,
    )
    .run(id, "2026-08-27T00:00:00.000Z", "2026-08-27T00:00:00.000Z", "2026-08-27T00:00:00.000Z");
}

test("Item mutations reject missing Items and leave all tables unchanged", () => {
  const database = db();
  const before = {
    items: database.prepare(`SELECT COUNT(*) AS n FROM items`).get() as { n: number },
    states: database.prepare(`SELECT COUNT(*) AS n FROM item_state`).get() as { n: number },
    notes: database.prepare(`SELECT COUNT(*) AS n FROM notes`).get() as { n: number },
    tags: database.prepare(`SELECT COUNT(*) AS n FROM tags`).get() as { n: number },
    memberships: database.prepare(`SELECT COUNT(*) AS n FROM memberships`).get() as { n: number },
  };

  assert.throws(() => setStatus(database, "missing", "accepted"), MissingResource);
  assert.throws(() => addTag(database, "missing", "new-tag"), MissingResource);
  assert.throws(() => addNote(database, "missing", "note"), MissingResource);
  assert.throws(() => addToCollection(database, "missing", "missing-collection"), MissingResource);
  assert.throws(() => removeTag(database, "missing", "missing-tag"), MissingResource);
  assert.throws(() => removeFromCollection(database, "missing", "missing-collection"), MissingResource);

  assert.deepEqual(
    {
      items: database.prepare(`SELECT COUNT(*) AS n FROM items`).get(),
      states: database.prepare(`SELECT COUNT(*) AS n FROM item_state`).get(),
      notes: database.prepare(`SELECT COUNT(*) AS n FROM notes`).get(),
      tags: database.prepare(`SELECT COUNT(*) AS n FROM tags`).get(),
      memberships: database.prepare(`SELECT COUNT(*) AS n FROM memberships`).get(),
    },
    before,
  );
});

test("Item mutations reject missing targets and valid relationships survive delete", () => {
  const database = db();
  insertItem(database);
  const collection = createCollection(database, "Reading");

  assert.throws(() => addToCollection(database, "item-1", "missing-collection"), MissingResource);
  assert.throws(() => removeFromCollection(database, "item-1", "missing-collection"), MissingResource);
  assert.throws(() => removeTag(database, "item-1", "missing-tag"), MissingResource);

  const tag = addTag(database, "item-1", "Useful");
  addToCollection(database, "item-1", collection.id);
  addNote(database, "item-1", "remember this");
  setStatus(database, "item-1", "accepted");

  database.prepare(`DELETE FROM items WHERE id = ?`).run("item-1");
  assert.equal((database.prepare(`SELECT COUNT(*) AS n FROM item_state`).get() as { n: number }).n, 0);
  assert.equal((database.prepare(`SELECT COUNT(*) AS n FROM notes`).get() as { n: number }).n, 0);
  assert.equal((database.prepare(`SELECT COUNT(*) AS n FROM memberships`).get() as { n: number }).n, 0);
  assert.equal((database.prepare(`SELECT COUNT(*) AS n FROM tags`).get() as { n: number }).n, 1);
  void tag;
});

test("empty Item organization inputs are normal validation errors", () => {
  const database = db();
  insertItem(database);
  assert.throws(() => addTag(database, "item-1", "  "), RejectedPayload);
  assert.throws(() => addNote(database, "item-1", "  "), RejectedPayload);
  assert.throws(() => createCollection(database, "  "), RejectedPayload);
});

test("opening a pre-relationship database removes orphans and installs cascading FKs", () => {
  const path = join(mkdtempSync(join(tmpdir(), "locus-")), "legacy.db");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE items (
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
      media TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL);
    CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT);
    CREATE TABLE item_state (item_id TEXT PRIMARY KEY, status TEXT NOT NULL, snoozed_until TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE notes (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE memberships (
      item_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL,
      PRIMARY KEY (item_id, target_id, target_kind)
    );
    INSERT INTO items VALUES ('item-1', 'post', NULL, NULL, 'https://example.com/item', NULL, NULL, NULL, NULL,
      '2026-08-27T00:00:00.000Z', NULL, '[]', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z');
    INSERT INTO collections VALUES ('collection-1', 'Reading', NULL, '2026-08-27T00:00:00.000Z');
    INSERT INTO tags VALUES ('tag-1', 'Useful', NULL);
    INSERT INTO item_state VALUES ('item-1', 'inbox', NULL, '2026-08-27T00:00:00.000Z');
    INSERT INTO item_state VALUES ('missing-item', 'inbox', NULL, '2026-08-27T00:00:00.000Z');
    INSERT INTO notes VALUES ('note-1', 'item-1', 'valid', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z');
    INSERT INTO notes VALUES ('note-2', 'missing-item', 'orphan', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z');
    INSERT INTO memberships VALUES ('item-1', 'tag-1', 'tag', 'user', '2026-08-27T00:00:00.000Z');
    INSERT INTO memberships VALUES ('missing-item', 'tag-1', 'tag', 'user', '2026-08-27T00:00:00.000Z');
    INSERT INTO memberships VALUES ('item-1', 'missing-tag', 'tag', 'user', '2026-08-27T00:00:00.000Z');
  `);
  legacy.close();

  const database = openDb(path);
  assert.equal((database.prepare(`SELECT COUNT(*) AS n FROM item_state`).get() as { n: number }).n, 1);
  assert.equal((database.prepare(`SELECT COUNT(*) AS n FROM notes`).get() as { n: number }).n, 1);
  assert.equal((database.prepare(`SELECT COUNT(*) AS n FROM memberships`).get() as { n: number }).n, 1);
  assert.equal((database.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version, SCHEMA_VERSION);
  for (const table of ["item_state", "notes", "memberships"]) {
    const keys = database.prepare(`PRAGMA foreign_key_list(${table})`).all() as { table: string; on_delete: string }[];
    assert.ok(keys.some((key) => key.table === "items" && key.on_delete === "CASCADE"), table);
  }
  database.prepare(`DELETE FROM items WHERE id = ?`).run("item-1");
  assert.equal((database.prepare(`SELECT COUNT(*) AS n FROM notes`).get() as { n: number }).n, 0);
  assert.equal((database.prepare(`SELECT COUNT(*) AS n FROM memberships`).get() as { n: number }).n, 0);
});
