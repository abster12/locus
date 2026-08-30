import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { wipeLibrary } from "../core/library.ts";
import { RejectedPayload } from "../core/sanitize.ts";
import { importLibraryArchive, writeLibraryArchive } from "../server/library-archive.ts";
import { acceptSuggestion, applyProposal, createPlace, getAtlasProjection, setExactPlace, setHomeBase } from "../server/atlas/module.ts";

const NOW = "2026-08-29T12:00:00.000Z";

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-atlas-archive-")), "t.db"));
}

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "locus-atlas-archive-file-")), name);
}

function insertItem(database: ReturnType<typeof mem>, id: string): void {
  database
    .prepare(
      `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
       VALUES (?, 'reel', NULL, ?, ?, ?, '[]', ?, ?)`,
    )
    .run(id, "weekend in Northstar City", `https://www.instagram.com/reel/${id}/`, NOW, NOW, NOW);
}

test("library archive round-trips Places, assignments, and home base without secrets", async () => {
  const source = mem();
  insertItem(source, "item-1");
  const land = createPlace(source, "local", { name: "Exampleland", kind: "country" }, NOW);
  const city = createPlace(source, "local", { name: "Northstar City", kind: "city", parentId: land.id }, NOW);
  setExactPlace(source, "local", "item-1", { placeId: city.id }, 0, NOW);
  setHomeBase(source, "local", city.id);

  const dest = tmpFile("atlas.ndjson");
  writeLibraryArchive(source, dest);
  const archive = readFileSync(dest, "utf8");
  assert.match(archive, /"kind":"atlasPlace"/);
  assert.match(archive, /"kind":"atlasAssignment"/);
  assert.doesNotMatch(archive, /"kind":"atlasAttempt"/);
  assert.match(archive, /atlas\.homePlaceId/);
  assert.match(archive, /Northstar City/);
  source.close();

  const target = mem();
  const result = await importLibraryArchive(target, dest);
  assert.ok(result.ok);
  const atlas = getAtlasProjection(target, "local");
  assert.equal(atlas.home.place?.name, "Northstar City");
  assert.equal(atlas.destinations[0]?.items[0]?.assignment.actor, "user");
  assert.equal(atlas.destinations[0]?.items[0]?.item.id, "item-1");
  target.close();
});

test("user Place survives source change across archive restore", async () => {
  const source = mem();
  const caption = "Philippines or Spain";
  source
    .prepare(
      `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
       VALUES ('item-1', 'reel', NULL, ?, ?, ?, '[]', ?, ?)`,
    )
    .run(caption, "https://www.instagram.com/reel/item-1/", NOW, NOW, NOW);
  applyProposal(source, "local", "item-1", {
    itemId: "item-1",
    relevance: "atlas",
    destinations: [
      { name: "Philippines", kind: "country", role: "primary", evidence: [{ field: "body", start: 0, end: 11, text: "Philippines" }] },
      { name: "Spain", kind: "country", role: "primary", evidence: [{ field: "body", start: 15, end: 20, text: "Spain" }] },
    ],
  }, NOW);
  const version = getAtlasProjection(source, "local").needsPlace.items[0]?.assignment?.version ?? 1;
  acceptSuggestion(source, "local", "item-1", 0, version, NOW);
  source.prepare(`UPDATE items SET body = ?, updated_at = ? WHERE id = ?`).run("caption rewritten with no place words", NOW, "item-1");
  const dest = tmpFile("override.ndjson");
  writeLibraryArchive(source, dest);
  source.close();
  const target = mem();
  const result = await importLibraryArchive(target, dest);
  assert.ok(result.ok);
  const atlas = getAtlasProjection(target, "local");
  assert.equal(atlas.destinations[0]?.title, "Philippines");
  assert.equal(atlas.destinations[0]?.items[0]?.assignment.actor, "user");
  target.close();
});

test("hostile atlas import with a bogus assignment payload is rejected", async () => {
  const dest = tmpFile("payload.ndjson");
  writeFileSync(
    dest,
    [
      JSON.stringify({ kind: "manifest", format: "locus-library", version: 1, counts: { item: 1, atlasPlace: 1, atlasAssignment: 1 } }),
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
        kind: "atlasPlace",
        id: "land-1",
        name: "Exampleland",
        kindName: "country",
        parentId: null,
        altNames: [],
        createdAt: NOW,
        updatedAt: NOW,
      }),
      JSON.stringify({
        kind: "atlasAssignment",
        id: "as-1",
        itemId: "item-1",
        outcome: "placed",
        actor: "user",
        primaryPlaceId: "land-1",
        sourceRevision: "abc",
        writeVersion: 1,
        payload: { containedPlaceIds: [], extra: true },
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ].join("\n") + "\n",
  );
  const target = mem();
  await assert.rejects(() => importLibraryArchive(target, dest), RejectedPayload);
  target.close();
});

test("hostile atlas import with a missing parent is rejected", async () => {
  const target = mem();
  insertItem(target, "item-1");
  const dest = tmpFile("hostile.ndjson");
  writeFileSync(
    dest,
    [
      JSON.stringify({ kind: "manifest", format: "locus-library", version: 1, counts: { item: 1, atlasPlace: 1, atlasAssignment: 1 } }),
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
        kind: "atlasPlace",
        id: "city-1",
        name: "Northstar City",
        kindName: "city",
        parentId: "missing-parent",
        altNames: [],
        createdAt: NOW,
        updatedAt: NOW,
      }),
      JSON.stringify({
        kind: "atlasAssignment",
        id: "as-1",
        itemId: "item-1",
        outcome: "placed",
        actor: "user",
        primaryPlaceId: "city-1",
        sourceRevision: "abc",
        writeVersion: 1,
        payload: { containedPlaceIds: [], mentionedPlaceIds: [], peerPlaceIds: [], suggestions: [] },
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ].join("\n") + "\n",
  );
  wipeLibrary(target);
  await assert.rejects(() => importLibraryArchive(target, dest), RejectedPayload);
  target.close();
});
