import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { addTag } from "../core/commands.ts";
import { wipeLibrary } from "../core/library.ts";
import { RejectedPayload } from "../core/sanitize.ts";
import { importJsonl } from "../server/import.ts";
import { importLibraryArchive, writeLibraryArchive } from "../server/library-archive.ts";
import {
  captionRevision,
  getKitchenItem,
  getTonight,
  normalizeCaption,
  putRecipeDocument,
} from "../server/kitchen/module.ts";

const NOW = "2026-08-29T12:00:00.000Z";

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-kitchen-archive-")), "t.db"));
}

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "locus-kitchen-archive-file-")), name);
}

function insertItem(database: ReturnType<typeof mem>, id: string, body = "mix flour"): void {
  database
    .prepare(
      `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
       VALUES (?, 'reel', NULL, ?, ?, ?, '[]', ?, ?)`,
    )
    .run(id, body, `https://www.instagram.com/reel/${id}/`, NOW, NOW, NOW);
}

function seedKitchen(database: ReturnType<typeof mem>): void {
  insertItem(database, "item-1");
  addTag(database, "item-1", "food");
  putRecipeDocument(
    database,
    "local",
    "item-1",
    {
      expectedSourceRevision: captionRevision(normalizeCaption("mix flour")),
      status: "reviewed",
      draft: {
        version: 1,
        title: "Flour mix",
        titleEvidence: { kind: "user" },
        ingredients: [{ id: "ing-1", raw: "flour", name: "flour", evidence: { kind: "user" } }],
        steps: [{ id: "step-1", instruction: "Mix it.", ingredientIds: ["ing-1"], evidence: { kind: "user" } }],
      },
    },
    "user",
    NOW,
  );
}

test("library archive round-trips Recipe Documents and broken Tonight pins", async () => {
  const source = mem();
  seedKitchen(source);
  source.prepare(
    `INSERT INTO kitchen_tonight_entries (id, library_id, item_id, position, created_at, updated_at)
     VALUES ('pin-1', 'local', 'item-1', 0, ?, ?)`,
  ).run(NOW, NOW);
  // Broken pin: the Item is gone; Tonight retains the reference by design.
  source.prepare(
    `INSERT INTO kitchen_tonight_entries (id, library_id, item_id, position, created_at, updated_at)
     VALUES ('pin-broken', 'local', 'gone', 1, ?, ?)`,
  ).run(NOW, NOW);

  const dest = tmpFile("kitchen.ndjson");
  writeLibraryArchive(source, dest);
  const archive = readFileSync(dest, "utf8");
  assert.match(archive, /"kind":"kitchenRecipeDocument"/);
  assert.match(archive, /"kind":"kitchenTonightEntry"/);
  source.close();

  const target = mem();
  // The archive carries item-1 itself; recipes restore after their Item.
  const result = await importLibraryArchive(target, dest);
  assert.ok(result.ok);

  const recipe = getKitchenItem(target, "local", "item-1")?.recipe;
  assert.ok(recipe && "status" in recipe && "sourceCaption" in recipe);
  assert.equal(recipe.status, "reviewed");
  assert.equal(recipe.sourceCaption, "mix flour");
  assert.equal(recipe.sourceRevision, captionRevision(normalizeCaption("mix flour")));
  assert.equal("draft" in recipe && recipe.draft.title, "Flour mix");

  const tonight = getTonight(target, "local");
  assert.deepEqual(tonight.map((row) => row.itemId), ["item-1", "gone"]);
  assert.ok(tonight[0]?.item);
  assert.equal(tonight[1]?.item, null);

  // Restoring into the same library is a conflict until it is cleared.
  await assert.rejects(() => importLibraryArchive(target, dest));
  wipeLibrary(target);
  assert.equal(getTonight(target, "local").length, 0);
  assert.equal(getKitchenItem(target, "local", "item-1")?.recipe ?? null, null);
  target.close();
});

test("archives without Kitchen records still import and orphan recipes are rejected", async () => {
  const target = mem();
  const old = tmpFile("old.ndjson");
  writeFileSync(
    old,
    [
      JSON.stringify({ kind: "manifest", format: "locus-library", version: 1, counts: { item: 1 } }),
      JSON.stringify({
        kind: "item",
        id: "item-1",
        contentType: "post",
        url: "https://x.com/a/status/1",
        firstObservedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ].join("\n") + "\n",
  );
  const result = await importLibraryArchive(target, old);
  assert.ok(result.ok);
  assert.equal((target.prepare(`SELECT COUNT(*) AS n FROM kitchen_recipe_documents`).get() as { n: number }).n, 0);
  assert.equal((target.prepare(`SELECT COUNT(*) AS n FROM kitchen_tonight_entries`).get() as { n: number }).n, 0);

  wipeLibrary(target);
  const orphan = tmpFile("orphan.ndjson");
  writeFileSync(
    orphan,
    [
      JSON.stringify({
        kind: "manifest",
        format: "locus-library",
        version: 1,
        counts: { item: 1, kitchenRecipeDocument: 1, kitchenTonightEntry: 1 },
      }),
      JSON.stringify({
        kind: "item",
        id: "item-1",
        contentType: "post",
        url: "https://x.com/a/status/1",
        firstObservedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      }),
      JSON.stringify({
        kind: "kitchenRecipeDocument",
        id: "doc-1",
        itemId: "item-missing",
        schemaVersion: 1,
        status: "draft",
        sourceRevision: captionRevision(""),
        sourceCaption: "",
        updatedBy: "user",
        draft: { version: 1, ingredients: [], steps: [{ id: "step-1", instruction: "x", ingredientIds: [], evidence: { kind: "user" } }] },
        createdAt: NOW,
        updatedAt: NOW,
      }),
      JSON.stringify({
        kind: "kitchenTonightEntry",
        id: "pin-1",
        itemId: "item-1",
        position: 0,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ].join("\n") + "\n",
  );
  await assert.rejects(() => importLibraryArchive(target, orphan), RejectedPayload);
  // The failed import rolls back the whole transaction, item included.
  assert.equal((target.prepare(`SELECT COUNT(*) AS n FROM items`).get() as { n: number }).n, 0);
  assert.equal((target.prepare(`SELECT COUNT(*) AS n FROM kitchen_tonight_entries`).get() as { n: number }).n, 0);
  target.close();
});

test("generic capture JSONL import never restores Kitchen data", () => {
  const db = mem();
  const jsonl = [
    JSON.stringify({
      type: "session",
      protocolVersion: 1,
      source: "x",
      producer: { id: "test", version: "1" },
      accountExternalId: "acct",
      collection: { externalId: "bookmarks", name: "Bookmarks" },
      mode: "snapshot",
      observedAt: NOW,
    }),
    JSON.stringify({
      type: "batch",
      sessionId: "pending",
      sequence: 1,
      idempotencyKey: "j1",
      changes: [
        { kind: "upsert", externalId: "1", item: { contentType: "post", title: "From JSONL", body: "mix", url: "https://x.com/a/status/9" } },
      ],
    }),
    JSON.stringify({ type: "finish", sessionId: "pending", coverage: "partial" }),
  ].join("\n");
  importJsonl(db, jsonl, { dryRun: false });
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM items`).get() as { n: number }).n, 1);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM kitchen_recipe_documents`).get() as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM kitchen_tonight_entries`).get() as { n: number }).n, 0);
  db.close();
});
