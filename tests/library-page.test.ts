import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db/open.ts";
import { itemCounts, listItemsPage } from "../core/library.ts";

function db() {
  const dir = mkdtempSync(join(tmpdir(), "locus-library-page-"));
  const value = openDb(join(dir, "library.db"));
  value.prepare(`INSERT INTO source_accounts (id, source, external_id, display_name, created_at) VALUES ('a', 'x', 'a', 'A', '2026-08-27T00:00:00Z')`).run();
  value.prepare(`INSERT INTO source_collections (id, source_account_id, external_id, name, created_at) VALUES ('c', 'a', 'bookmarks', 'Bookmarks', '2026-08-27T00:00:00Z')`).run();
  return value;
}

function insertItem(value: ReturnType<typeof db>, id: string, observed: string, status?: string) {
  value.prepare(`INSERT INTO items (id, content_type, body, url, first_observed_at, media, created_at, updated_at) VALUES (?, 'post', ?, ?, ?, '[]', ?, ?)`).run(
    id,
    id,
    `https://x.com/a/status/${id}`,
    observed,
    observed,
    observed,
  );
  value.prepare(`INSERT INTO source_records (id, source_account_id, external_id, item_id, first_observed_at, last_observed_at) VALUES (?, 'a', ?, ?, ?, ?)`).run(
    `r-${id}`,
    id,
    id,
    observed,
    observed,
  );
  if (status) value.prepare(`INSERT INTO item_state (item_id, status, updated_at) VALUES (?, ?, ?)`).run(id, status, observed);
}

function addTag(value: ReturnType<typeof db>, itemId: string, id: string, name: string) {
  value.prepare(`INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?)`).run(id, name);
  const tag = value.prepare(`SELECT id FROM tags WHERE name = ?`).get(name) as { id: string };
  value.prepare(`INSERT INTO memberships (item_id, target_id, target_kind, created_at) VALUES (?, ?, 'tag', ?)`).run(
    itemId,
    tag.id,
    "2026-08-27T00:00:00Z",
  );
}

test("Item pages have stable cursor ordering and library-wide counts", () => {
  const value = db();
  for (let i = 0; i < 123; i += 1) insertItem(value, `i-${String(i).padStart(3, "0")}`, "2026-08-27T00:00:00Z");
  insertItem(value, "archived", "2026-08-27T00:00:00Z", "archived");
  insertItem(value, "rejected", "2026-08-27T00:00:00Z", "rejected");

  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = listItemsPage(value, { view: "recent" }, { cursor, limit: 50 });
    seen.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  assert.equal(seen.length, 123);
  assert.equal(new Set(seen).size, 123);
  assert.equal(seen.includes("archived"), false);
  assert.equal(seen.includes("rejected"), false);
  assert.equal(listItemsPage(value, { view: "recent" }, { limit: 1 }).counts.total, 123);
  assert.equal(itemCounts(value, { view: "inbox" }).inbox, 123);
  value.close();
});

test("recent pages follow the displayed date and search URL-only Items", () => {
  const value = db();
  insertItem(value, "published", "2026-09-04T08:00:00Z");
  value.prepare(`UPDATE items SET published_at = '2026-09-02T08:00:00Z' WHERE id = 'published'`).run();
  insertItem(value, "codex-router", "2026-09-04T09:00:00Z");
  value.prepare(`UPDATE items SET body = NULL, url = 'https://github.com/duolahypercho/codex-router' WHERE id = 'codex-router'`).run();

  assert.deepEqual(listItemsPage(value, { view: "recent" }).items.map((item) => item.id), ["codex-router", "published"]);
  assert.deepEqual(listItemsPage(value, { q: "codex" }).items.map((item) => item.id), ["codex-router"]);
  value.close();
});

test("shelf pages and counts share shelf membership semantics", () => {
  const value = db();
  insertItem(value, "tech-item", "2026-08-27T00:00:00Z");
  insertItem(value, "else-item", "2026-08-27T00:00:00Z");
  insertItem(value, "mixed-item", "2026-08-27T00:00:00Z");
  addTag(value, "tech-item", "tag-tech", "AI");
  addTag(value, "else-item", "tag-random", "random");
  addTag(value, "mixed-item", "tag-tech-mixed", "tech");
  addTag(value, "mixed-item", "tag-random-mixed", "random");

  const techPage = listItemsPage(value, { shelf: "tech" });
  assert.deepEqual(techPage.items.map((item) => item.id).sort(), ["mixed-item", "tech-item"]);
  assert.equal(techPage.counts.total, 2);
  assert.equal(techPage.counts.shelves.tech, 2);
  assert.equal(techPage.counts.shelves.else, 2);
  assert.deepEqual(itemCounts(value, { shelf: "tech" }), techPage.counts);

  const elsePage = listItemsPage(value, { shelf: "else" });
  assert.deepEqual(elsePage.items.map((item) => item.id).sort(), ["else-item", "mixed-item"]);
  assert.equal(elsePage.counts.total, 2);
  assert.equal(elsePage.counts.shelves.tech, 2);
  assert.equal(elsePage.counts.shelves.else, 2);
  assert.deepEqual(itemCounts(value, { shelf: "else" }), elsePage.counts);
  value.close();
});
