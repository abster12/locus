import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { SCHEMA_VERSION } from "../db/schema.ts";
import { addTag, removeTag } from "../core/commands.ts";
import { wipeLibrary } from "../core/library.ts";
import { RejectedPayload } from "../core/sanitize.ts";
import {
  AtlasConflict,
  ANALYZER_POLICY_VERSION,
  SCREENING_POLICY_VERSION,
  TRAVEL_OVERRIDE_CURSOR_SETTING,
  LOCAL_LIBRARY_ID,
  acceptSuggestion,
  applyAtlasScreening,
  applyProposal,
  atlasLibraryIsEmpty,
  backfillAtlas,
  backfillTravelAtlas,
  changePlace,
  claimAtlasBatch,
  claimAtlasScreeningBatch,
  createPlace,
  deletePlace,
  enqueueAtlasItem,
  enqueueAtlasAnalysis,
  exportAtlasRecords,
  failAtlasAttempt,
  failAtlasScreening,
  getAtlasProjection,
  importAtlasRecords,
  leaveUnresolved,
  markMultiple,
  markNotAtlas,
  retryAtlasAnalysis,
  searchPlaces,
  setExactPlace,
  setHomeBase,
  sourceRevision,
  screeningInputRevision,
} from "../server/atlas/module.ts";

const NOW = "2026-08-29T12:00:00.000Z";
const LIB = LOCAL_LIBRARY_ID;

function db() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-atlas-")), "t.db"));
}

function insertItem(
  value: ReturnType<typeof db>,
  id: string,
  opts: { title?: string | null; body?: string | null } = {},
): void {
  value
    .prepare(
      `INSERT INTO items (id, content_type, title, body, url, author_handle, first_observed_at, media, created_at, updated_at)
       VALUES (?, 'reel', ?, ?, ?, 'traveler', ?, '[]', ?, ?)`,
    )
    .run(id, opts.title ?? null, opts.body ?? null, `https://www.instagram.com/reel/${id}/`, NOW, NOW, NOW);
}

function span(field: "title" | "body", source: string, text: string) {
  const start = source.indexOf(text);
  assert.ok(start >= 0, `missing ${text}`);
  return { field, start, end: start + text.length, text };
}

function primary(name: string, source: { title?: string; body?: string }, text: string, extra: Record<string, unknown> = {}) {
  const field = source.title?.includes(text) ? "title" : "body";
  const raw = field === "title" ? source.title ?? "" : source.body ?? "";
  return { name, kind: extra.kind ?? "country", role: "primary", evidence: [span(field, raw, text)], ...extra };
}

test("schema 12 creates Atlas tables and wipe clears them", () => {
  const value = db();
  assert.equal((value.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version, SCHEMA_VERSION);
  insertItem(value, "item-1", { title: "Northstar City" });
  const land = createPlace(value, LIB, { name: "Exampleland", kind: "country" }, NOW);
  const place = createPlace(value, LIB, { name: "Northstar City", kind: "city", parentId: land.id }, NOW);
  setExactPlace(value, LIB, "item-1", { placeId: place.id }, 0, NOW);
  setHomeBase(value, LIB, place.id);
  backfillAtlas(value, LIB, NOW);
  wipeLibrary(value);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM atlas_places`).get() as { n: number }).n, 0);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM atlas_assignments`).get() as { n: number }).n, 0);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM atlas_attempts`).get() as { n: number }).n, 0);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM atlas_screenings`).get() as { n: number }).n, 0);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'atlas.%'`).get() as { n: number }).n, 0);
  assert.equal(atlasLibraryIsEmpty(value), true);
  value.close();
});

test("invented places work without a compiled geography list", () => {
  const value = db();
  insertItem(value, "item-1", { title: "weekend in Northstar City" });
  const land = createPlace(value, LIB, { name: "Exampleland", kind: "country" }, NOW);
  const city = createPlace(value, LIB, { name: "Northstar City", kind: "city", parentId: land.id, altNames: ["North Star"] }, NOW);
  setHomeBase(value, LIB, city.id);
  setExactPlace(value, LIB, "item-1", { placeId: city.id }, 0, NOW);
  const atlas = getAtlasProjection(value, LIB);
  assert.equal(atlas.home.place?.name, "Northstar City");
  assert.equal(atlas.destinations[0]?.kind, "around_home");
  assert.equal(atlas.destinations[0]?.items[0]?.item.id, "item-1");
  assert.equal(searchPlaces(value, LIB, "north star")[0]?.id, city.id);
  value.close();
});

test("a Philippines destination mentioning Mumbai appears once under Philippines", () => {
  const value = db();
  const body = "Philippines guide for Indian travelers flying from Mumbai";
  insertItem(value, "ph-1", { title: "islands", body });
  applyProposal(value, LIB, "ph-1", {
    itemId: "ph-1",
    relevance: "atlas",
    destinations: [
      primary("Philippines", { body }, "Philippines"),
      { name: "India", kind: "country", role: "mentioned", evidence: [span("body", body, "Indian")] },
      { name: "Mumbai", kind: "city", role: "mentioned", evidence: [span("body", body, "Mumbai")] },
    ],
  }, NOW);
  const atlas = getAtlasProjection(value, LIB);
  assert.deepEqual(atlas.destinations.map((section) => section.title), ["Philippines"]);
  assert.equal(atlas.destinations[0]?.count, 1);
  assert.equal(atlas.destinations[0]?.items[0]?.assignment.mentioned.map((place) => place.name).includes("Mumbai"), true);
  assert.equal(atlas.counts.items, 1);
  value.close();
});

test("comparison places do not duplicate membership", () => {
  const value = db();
  const body = "Lisbon is cheaper than Bali this year";
  insertItem(value, "lis-1", { body });
  applyProposal(value, LIB, "lis-1", {
    itemId: "lis-1",
    relevance: "atlas",
    destinations: [
      primary("Lisbon", { body }, "Lisbon", { kind: "city" }),
      { name: "Bali", kind: "place", role: "mentioned", evidence: [span("body", body, "Bali")] },
    ],
  }, NOW);
  const atlas = getAtlasProjection(value, LIB);
  assert.deepEqual(atlas.destinations.map((section) => section.title), ["Lisbon"]);
  assert.equal(atlas.destinations.some((section) => section.title === "Bali"), false);
  value.close();
});

test("a genuine multi-destination proposal appears once in Multiple destinations", () => {
  const value = db();
  const body = "Japan and Spain in one month";
  insertItem(value, "multi-1", { body });
  applyProposal(value, LIB, "multi-1", {
    itemId: "multi-1",
    relevance: "atlas",
    multiple: true,
    destinations: [primary("Japan", { body }, "Japan"), primary("Spain", { body }, "Spain")],
  }, NOW);
  const atlas = getAtlasProjection(value, LIB);
  assert.equal(atlas.multiple.length, 1);
  assert.equal(atlas.multiple[0]?.item.id, "multi-1");
  assert.equal(atlas.destinations.length, 0);
  assert.equal(atlas.counts.items, 1);
  value.close();
});

test("contained cities stay metadata under one primary", () => {
  const value = db();
  const body = "Japan with Kyoto and Osaka";
  insertItem(value, "jp-1", { body });
  applyProposal(value, LIB, "jp-1", {
    itemId: "jp-1",
    relevance: "atlas",
    destinations: [
      primary("Japan", { body }, "Japan"),
      { name: "Kyoto", kind: "city", role: "contained", evidence: [span("body", body, "Kyoto")] },
      { name: "Osaka", kind: "city", role: "contained", evidence: [span("body", body, "Osaka")] },
    ],
  }, NOW);
  const atlas = getAtlasProjection(value, LIB);
  assert.equal(atlas.destinations.length, 1);
  assert.equal(atlas.destinations[0]?.title, "Japan");
  assert.deepEqual(atlas.destinations[0]?.contained, ["Kyoto", "Osaka"]);
  assert.equal(atlas.destinations[0]?.items[0]?.assignment.contained.map((place) => place.name).join(","), "Kyoto,Osaka");
  value.close();
});

test("a geographic false positive is not for Atlas", () => {
  const value = db();
  insertItem(value, "prod-1", { title: "USA charger adapter" });
  applyProposal(value, LIB, "prod-1", { itemId: "prod-1", relevance: "not_atlas", destinations: [] }, NOW);
  const atlas = getAtlasProjection(value, LIB);
  assert.equal(atlas.destinations.length, 0);
  assert.equal(atlas.needsPlace.count, 0);
  value.close();
});

test("a resolved Food Item without Travel appears in Atlas and keeps its tags", () => {
  const value = db();
  insertItem(value, "food-1", { title: "dosa in Northstar City" });
  addTag(value, "food-1", "food");
  const city = createPlace(value, LIB, { name: "Northstar City", kind: "city" }, NOW);
  setExactPlace(value, LIB, "food-1", { placeId: city.id }, 0, NOW);
  const atlas = getAtlasProjection(value, LIB);
  assert.equal(atlas.destinations[0]?.items[0]?.item.id, "food-1");
  const tags = value.prepare(`SELECT t.name FROM memberships m JOIN tags t ON t.id = m.target_id WHERE m.item_id = 'food-1'`).all() as { name: string }[];
  assert.deepEqual(tags.map((row) => row.name), ["food"]);
  value.close();
});

test("unresolved Travel stays in Needs a place when analysis is unavailable", () => {
  const value = db();
  insertItem(value, "tr-1", { title: "somewhere new" });
  addTag(value, "tr-1", "travel");
  insertItem(value, "other-1", { title: "not travel" });
  const atlas = getAtlasProjection(value, LIB);
  assert.equal(atlas.needsPlace.count, 1);
  assert.equal(atlas.needsPlace.items[0]?.item.id, "tr-1");
  assert.equal(atlas.needsPlace.items[0]?.assignment, null);
  setExactPlace(value, LIB, "tr-1", { name: "Quiet Harbour", kind: "city" }, 0, NOW);
  const placed = getAtlasProjection(value, LIB);
  assert.equal(placed.needsPlace.count, 0);
  assert.equal(placed.destinations[0]?.title, "Quiet Harbour");
  value.close();
});

test("competing primaries become Needs a place and accept a suggestion", () => {
  const value = db();
  const body = "Maybe Japan maybe Spain";
  insertItem(value, "amb-1", { body });
  applyProposal(value, LIB, "amb-1", {
    itemId: "amb-1",
    relevance: "atlas",
    destinations: [primary("Japan", { body }, "Japan"), primary("Spain", { body }, "Spain")],
  }, NOW);
  const review = getAtlasProjection(value, LIB);
  assert.equal(review.needsPlace.count, 1);
  assert.equal(review.needsPlace.items[0]?.assignment?.suggestions.length, 2);
  const version = review.needsPlace.items[0]?.assignment?.version ?? 0;
  acceptSuggestion(value, LIB, "amb-1", 0, version, NOW);
  const atlas = getAtlasProjection(value, LIB);
  assert.equal(atlas.needsPlace.count, 0);
  assert.equal(atlas.destinations[0]?.title, "Japan");
  value.close();
});

test("malformed analyzer output writes nothing", () => {
  const value = db();
  const body = "Japan trip";
  insertItem(value, "bad-1", { body });
  applyProposal(value, LIB, "bad-1", {
    itemId: "bad-1",
    relevance: "atlas",
    destinations: [primary("Japan", { body }, "Japan")],
  }, NOW);
  const before = getAtlasProjection(value, LIB).destinations[0]?.items[0]?.assignment.id;
  const four = "Japan Spain India Peru";
  insertItem(value, "bad-2", { body: four });
  assert.throws(
    () => applyProposal(value, LIB, "bad-2", { itemId: "nope", relevance: "atlas", destinations: [] }, NOW),
    RejectedPayload,
  );
  assert.throws(
    () => applyProposal(value, LIB, "bad-2", {
      itemId: "bad-2",
      relevance: "atlas",
      destinations: [
        primary("Japan", { body: four }, "Japan"),
        primary("Spain", { body: four }, "Spain"),
        primary("India", { body: four }, "India"),
        primary("Peru", { body: four }, "Peru"),
      ],
    }, NOW),
    RejectedPayload,
  );
  value.prepare(`UPDATE items SET body = ?, updated_at = ? WHERE id = ?`).run("Japan and also Spain", NOW, "bad-1");
  assert.throws(
    () => applyProposal(value, LIB, "bad-1", { itemId: "bad-1", relevance: "atlas", destinations: [{ name: "Atlantis", kind: "place", role: "primary", evidence: [] }] }, NOW),
    RejectedPayload,
  );
  assert.throws(
    () => applyProposal(value, LIB, "bad-1", { itemId: "bad-1", relevance: "atlas", destinations: [{ name: "Japan", kind: "country", role: "guess", evidence: [] }] }, NOW),
    RejectedPayload,
  );
  const after = getAtlasProjection(value, LIB);
  assert.equal(after.destinations[0]?.items[0]?.assignment.id, before);
  assert.equal(after.destinations[0]?.title, "Japan");
  assert.equal(after.needsPlace.items.some((row) => row.item.id === "bad-2"), false);
  value.close();
});

test("evidence must sit inside the captured text", () => {
  const value = db();
  insertItem(value, "ev-1", { title: "Hello", body: "World" });
  assert.throws(
    () => applyProposal(value, LIB, "ev-1", {
      itemId: "ev-1",
      relevance: "atlas",
      destinations: [{ name: "Japan", kind: "country", role: "primary", evidence: [{ field: "body", start: 0, end: 5, text: "Japan" }] }],
    }, NOW),
    RejectedPayload,
  );
  assert.throws(
    () => applyProposal(value, LIB, "ev-1", {
      itemId: "ev-1",
      relevance: "atlas",
      destinations: [{ name: "Japan", kind: "country", role: "primary", evidence: [] }],
    }, NOW),
    RejectedPayload,
  );
  value.close();
});

test("user override outranks a later automatic proposal and source change", () => {
  const value = db();
  const body = "Philippines guide";
  insertItem(value, "ov-1", { body });
  applyProposal(value, LIB, "ov-1", {
    itemId: "ov-1",
    relevance: "atlas",
    destinations: [primary("Philippines", { body }, "Philippines")],
  }, NOW);
  const inferred = getAtlasProjection(value, LIB).destinations[0]?.items[0]?.assignment;
  assert.equal(inferred?.actor, "analyzer");
  const spain = createPlace(value, LIB, { name: "Spain", kind: "country" }, NOW);
  changePlace(value, LIB, "ov-1", spain.id, inferred!.version, NOW);
  applyProposal(value, LIB, "ov-1", {
    itemId: "ov-1",
    relevance: "atlas",
    destinations: [primary("Philippines", { body }, "Philippines")],
  }, NOW);
  value.prepare(`UPDATE items SET body = ?, updated_at = ? WHERE id = ?`).run("now about Japan", NOW, "ov-1");
  applyProposal(value, LIB, "ov-1", {
    itemId: "ov-1",
    relevance: "atlas",
    destinations: [{ name: "Japan", kind: "country", role: "primary", evidence: [{ field: "body", start: 10, end: 15, text: "Japan" }] }],
  }, NOW);
  const atlas = getAtlasProjection(value, LIB);
  assert.equal(atlas.destinations[0]?.title, "Spain");
  assert.equal(atlas.destinations[0]?.items[0]?.assignment.actor, "user");
  value.close();
});

test("human Not for Atlas stays suppressed after reanalysis", () => {
  const value = db();
  const body = "USA charger";
  insertItem(value, "no-1", { body });
  addTag(value, "no-1", "travel");
  markNotAtlas(value, LIB, "no-1", 0, NOW);
  applyProposal(value, LIB, "no-1", {
    itemId: "no-1",
    relevance: "atlas",
    destinations: [primary("USA", { body }, "USA")],
  }, NOW);
  const atlas = getAtlasProjection(value, LIB);
  assert.equal(atlas.destinations.length, 0);
  assert.equal(atlas.needsPlace.count, 0);
  const tags = value.prepare(`SELECT t.name FROM memberships m JOIN tags t ON t.id = m.target_id WHERE m.item_id = 'no-1'`).all() as { name: string }[];
  assert.deepEqual(tags.map((row) => row.name), ["travel"]);
  value.close();
});

test("inferred placement is eligible for reanalysis after source text changes", () => {
  const value = db();
  const body = "Japan trip";
  insertItem(value, "re-1", { body });
  addTag(value, "re-1", "travel");
  applyProposal(value, LIB, "re-1", {
    itemId: "re-1",
    relevance: "atlas",
    destinations: [primary("Japan", { body }, "Japan")],
  }, NOW);
  value.prepare(`UPDATE items SET body = ?, updated_at = ? WHERE id = ?`).run("Spain instead", NOW, "re-1");
  enqueueAtlasItem(value, LIB, "re-1", NOW);
  applyAtlasScreening(value, LIB, "re-1", { atlasCandidate: true }, NOW);
  const claimed = claimAtlasBatch(value, LIB, NOW);
  assert.deepEqual(claimed, ["re-1"]);
  applyProposal(value, LIB, "re-1", {
    itemId: "re-1",
    relevance: "atlas",
    destinations: [{ name: "Spain", kind: "country", role: "primary", evidence: [{ field: "body", start: 0, end: 5, text: "Spain" }] }],
  }, NOW);
  assert.equal(getAtlasProjection(value, LIB).destinations[0]?.title, "Spain");
  value.close();
});

test("Change place moves the Item once and keeps distinct counts", () => {
  const value = db();
  insertItem(value, "mv-1", { title: "move me" });
  const a = createPlace(value, LIB, { name: "Alpha", kind: "country" }, NOW);
  const b = createPlace(value, LIB, { name: "Beta", kind: "country" }, NOW);
  const first = setExactPlace(value, LIB, "mv-1", { placeId: a.id }, 0, NOW);
  changePlace(value, LIB, "mv-1", b.id, first.version, NOW);
  const atlas = getAtlasProjection(value, LIB);
  assert.deepEqual(atlas.destinations.map((section) => section.title), ["Beta"]);
  assert.equal(atlas.counts.items, 1);
  assert.throws(() => changePlace(value, LIB, "mv-1", a.id, first.version, NOW), AtlasConflict);
  value.close();
});

test("Leave unresolved keeps a review row without inventing a destination", () => {
  const value = db();
  const body = "Maybe Japan maybe Spain";
  insertItem(value, "lv-1", { body });
  applyProposal(value, LIB, "lv-1", {
    itemId: "lv-1",
    relevance: "atlas",
    destinations: [primary("Japan", { body }, "Japan"), primary("Spain", { body }, "Spain")],
  }, NOW);
  const version = getAtlasProjection(value, LIB).needsPlace.items[0]?.assignment?.version ?? 0;
  leaveUnresolved(value, LIB, "lv-1", version, NOW);
  const atlas = getAtlasProjection(value, LIB);
  assert.equal(atlas.needsPlace.count, 1);
  assert.equal(atlas.destinations.length, 0);
  value.close();
});

test("same leaf names under different parents stay distinct", () => {
  const value = db();
  const north = createPlace(value, LIB, { name: "Northland", kind: "country" }, NOW);
  const south = createPlace(value, LIB, { name: "Southland", kind: "country" }, NOW);
  const a = createPlace(value, LIB, { name: "Springfield", kind: "city", parentId: north.id }, NOW);
  const b = createPlace(value, LIB, { name: "Springfield", kind: "city", parentId: south.id }, NOW);
  assert.notEqual(a.id, b.id);
  const hits = searchPlaces(value, LIB, "Springfield");
  assert.equal(hits.length, 2);
  assert.ok(searchPlaces(value, LIB, "").length >= 4);
  assert.ok(hits.every((place) => place.ancestors[0]?.name === "Northland" || place.ancestors[0]?.name === "Southland"));
  value.close();
});

test("parent cycles, missing parents, and referenced deletes are rejected", () => {
  const value = db();
  insertItem(value, "item-1", { title: "x" });
  const land = createPlace(value, LIB, { name: "Exampleland", kind: "country" }, NOW);
  const city = createPlace(value, LIB, { name: "Northstar City", kind: "city", parentId: land.id }, NOW);
  setExactPlace(value, LIB, "item-1", { placeId: city.id }, 0, NOW);
  setHomeBase(value, LIB, land.id);
  assert.throws(() => createPlace(value, LIB, { name: "Ghost", parentId: "missing" }, NOW), /not found/);
  assert.throws(() => deletePlace(value, LIB, city.id), RejectedPayload);
  assert.throws(() => deletePlace(value, LIB, land.id), RejectedPayload);
  const spare = createPlace(value, LIB, { name: "Unused Hollow", kind: "venue" }, NOW);
  deletePlace(value, LIB, spare.id);
  assert.equal(searchPlaces(value, LIB, "Unused Hollow").length, 0);
  value.close();
});

test("home base is a projection over Places, not copied assignment data", () => {
  const value = db();
  insertItem(value, "home-1", { title: "local cafe" });
  insertItem(value, "away-1", { title: "far cafe" });
  const land = createPlace(value, LIB, { name: "Exampleland", kind: "country" }, NOW);
  const city = createPlace(value, LIB, { name: "Northstar City", kind: "city", parentId: land.id }, NOW);
  const venue = createPlace(value, LIB, { name: "Dock Cafe", kind: "venue", parentId: city.id }, NOW);
  const other = createPlace(value, LIB, { name: "Elsewhere", kind: "city", parentId: land.id }, NOW);
  const far = createPlace(value, LIB, { name: "Otherland", kind: "country" }, NOW);
  insertItem(value, "home-2", { title: "dock brunch" });
  setExactPlace(value, LIB, "home-1", { placeId: city.id }, 0, NOW);
  setExactPlace(value, LIB, "home-2", { placeId: venue.id }, 0, NOW);
  const away = setExactPlace(value, LIB, "away-1", { placeId: far.id }, 0, NOW);
  const unset = getAtlasProjection(value, LIB);
  assert.equal(unset.home.place, null);
  assert.ok(unset.destinations.some((section) => section.title === "Exampleland" || section.title === "Northstar City" || section.items.length > 0));
  setHomeBase(value, LIB, city.id);
  const around = getAtlasProjection(value, LIB);
  assert.equal(around.destinations[0]?.kind, "around_home");
  assert.deepEqual(around.destinations[0]?.items.map((row) => row.item.id), ["home-1", "home-2"]);
  assert.equal(around.destinations.some((section) => section.items.some((row) => row.item.id === "away-1")), true);
  setHomeBase(value, LIB, other.id);
  const moved = getAtlasProjection(value, LIB);
  assert.equal(moved.destinations.some((section) => section.kind === "around_home"), false);
  assert.equal(moved.destinations.flatMap((section) => section.items).length, 3);
  const assignment = value.prepare(`SELECT primary_place_id AS id FROM atlas_assignments WHERE item_id = 'home-1'`).get() as { id: string };
  assert.equal(assignment.id, city.id);
  assert.equal(away.primary?.id, far.id);
  value.close();
});

test("empty captured text stays unresolved and queue is idempotent per revision", () => {
  const value = db();
  insertItem(value, "empty-1", { title: null, body: null });
  insertItem(value, "plain-1", { title: "no geography" });
  assert.equal(applyProposal(value, LIB, "empty-1", { itemId: "empty-1", relevance: "atlas" }, NOW), null);
  assert.equal(getAtlasProjection(value, LIB).needsPlace.count, 0);
  addTag(value, "empty-1", "travel");
  assert.equal(getAtlasProjection(value, LIB).needsPlace.count, 1);
  enqueueAtlasItem(value, LIB, "empty-1", NOW);
  enqueueAtlasItem(value, LIB, "empty-1", NOW);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM atlas_screenings`).get() as { n: number }).n, 1);
  failAtlasScreening(value, "empty-1", "provider down", NOW);
  retryAtlasAnalysis(value, LIB, "empty-1", NOW);
  assert.deepEqual(claimAtlasBatch(value, LIB, NOW), ["empty-1"]);
  value.close();
});

test("backfill screens existing Items and archive round-trips Places", () => {
  const value = db();
  insertItem(value, "a-1", { title: "one" });
  insertItem(value, "b-1", { title: "two" });
  addTag(value, "a-1", "travel");
  assert.equal(backfillAtlas(value, LIB, NOW), false);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM atlas_screenings`).get() as { n: number }).n, 2);
  assert.deepEqual(
    (value.prepare(`SELECT item_id FROM atlas_screenings ORDER BY item_id`).all() as { item_id: string }[]).map((row) => row.item_id),
    ["a-1", "b-1"],
  );
  const land = createPlace(value, LIB, { name: "Exampleland", kind: "country" }, NOW);
  setExactPlace(value, LIB, "a-1", { placeId: land.id }, 0, NOW);
  setHomeBase(value, LIB, land.id);
  const exported = exportAtlasRecords(value, LIB);
  const dest = db();
  insertItem(dest, "a-1", { title: "one" });
  insertItem(dest, "b-1", { title: "two" });
  importAtlasRecords(dest, {
    places: exported.records.filter((row) => row.kind === "atlasPlace"),
    assignments: exported.records.filter((row) => row.kind === "atlasAssignment"),
    itemIds: new Set(["a-1", "b-1"]),
  });
  dest.prepare(`INSERT INTO settings (key, value) VALUES ('atlas.homePlaceId', ?)`).run(land.id);
  const atlas = getAtlasProjection(dest, LIB);
  assert.equal(atlas.home.place?.name, "Exampleland");
  assert.equal(atlas.destinations[0]?.items[0]?.assignment.actor, "user");
  assert.equal(sourceRevision("one", null).length, 64);
  dest.close();
  value.close();
});

test("all Items are queued for screening regardless of topic tags", () => {
  const value = db();
  insertItem(value, "food-1", { title: "dosa in Northstar City" });
  addTag(value, "food-1", "food");
  enqueueAtlasItem(value, LIB, "food-1", NOW);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM atlas_screenings`).get() as { n: number }).n, 1);
  addTag(value, "food-1", "travel");
  enqueueAtlasItem(value, LIB, "food-1", NOW);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM atlas_screenings`).get() as { n: number }).n, 1);
  value.close();
});

test("only screen-positive Items enter detailed extraction and screen negatives stay out", () => {
  const value = db();
  insertItem(value, "food-screen", { title: "Dock Cafe brunch" });
  insertItem(value, "plain-screen", { title: "USA charger adapter" });
  insertItem(value, "travel-screen", { title: "Weekend in Northstar City" });
  addTag(value, "food-screen", "food");
  addTag(value, "travel-screen", "travel");
  enqueueAtlasItem(value, LIB, "food-screen", NOW);
  enqueueAtlasItem(value, LIB, "plain-screen", NOW);
  enqueueAtlasItem(value, LIB, "travel-screen", NOW);
  assert.deepEqual(claimAtlasScreeningBatch(value, LIB, NOW, "screen", 60_000, 8).sort(), ["food-screen", "plain-screen", "travel-screen"]);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM atlas_attempts`).get() as { n: number }).n, 0);
  applyAtlasScreening(value, LIB, "food-screen", { atlasCandidate: true }, NOW);
  applyAtlasScreening(value, LIB, "plain-screen", { atlasCandidate: false }, NOW);
  applyAtlasScreening(value, LIB, "travel-screen", { atlasCandidate: true }, NOW);
  assert.deepEqual(
    (value.prepare(`SELECT item_id FROM atlas_attempts ORDER BY item_id`).all() as { item_id: string }[]).map((row) => row.item_id),
    ["food-screen", "travel-screen"],
  );
  assert.equal(getAtlasProjection(value, LIB).needsPlace.items.some((row) => row.item.id === "plain-screen"), false);
  assert.equal(getAtlasProjection(value, LIB).needsPlace.items.some((row) => row.item.id === "travel-screen"), true);
  value.close();
});

test("Travel screen negatives still enter detailed extraction", () => {
  const value = db();
  insertItem(value, "travel-negative", { title: "a weekend somewhere" });
  addTag(value, "travel-negative", "travel");
  enqueueAtlasItem(value, LIB, "travel-negative", NOW);
  assert.deepEqual(claimAtlasScreeningBatch(value, LIB, NOW, "screen", 60_000, 8), ["travel-negative"]);
  applyAtlasScreening(value, LIB, "travel-negative", { atlasCandidate: false }, NOW);
  assert.deepEqual(claimAtlasBatch(value, LIB, NOW, "atlas", 60_000, 8), ["travel-negative"]);
  applyProposal(value, LIB, "travel-negative", { itemId: "travel-negative", relevance: "not_atlas", destinations: [] }, NOW);
  const atlas = getAtlasProjection(value, LIB);
  assert.equal(atlas.needsPlace.items.some((row) => row.item.id === "travel-negative"), true);
  assert.equal(atlas.needsPlace.items.find((row) => row.item.id === "travel-negative")?.assignment?.outcome, "needs_place");
  value.close();
});

test("user not-atlas remains authoritative for Travel", () => {
  const value = db();
  insertItem(value, "travel-user-negative", { title: "a weekend somewhere" });
  addTag(value, "travel-user-negative", "travel");
  applyProposal(value, LIB, "travel-user-negative", { itemId: "travel-user-negative", relevance: "not_atlas", destinations: [] }, NOW);
  const before = getAtlasProjection(value, LIB).needsPlace.items.find((row) => row.item.id === "travel-user-negative")?.assignment;
  assert.equal(before?.outcome, "needs_place");
  markNotAtlas(value, LIB, "travel-user-negative", before?.version ?? 0, NOW);
  enqueueAtlasItem(value, LIB, "travel-user-negative", NOW);
  assert.equal(getAtlasProjection(value, LIB).needsPlace.items.some((row) => row.item.id === "travel-user-negative"), false);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM atlas_screenings WHERE item_id = ?`).get("travel-user-negative") as { n: number }).n, 0);
  value.close();
});

test("tag changes revise screening input and restore normal policy after Travel removal", () => {
  const value = db();
  insertItem(value, "tag-revision", { title: "a plain note" });
  addTag(value, "tag-revision", "food");
  enqueueAtlasItem(value, LIB, "tag-revision", NOW);
  const first = value.prepare(`SELECT source_revision FROM atlas_screenings WHERE item_id = ?`).get("tag-revision") as { source_revision: string };
  applyAtlasScreening(value, LIB, "tag-revision", { atlasCandidate: false }, NOW);

  addTag(value, "tag-revision", "travel");
  enqueueAtlasItem(value, LIB, "tag-revision", NOW);
  const second = value.prepare(`SELECT source_revision, status FROM atlas_screenings WHERE item_id = ?`).get("tag-revision") as { source_revision: string; status: string };
  assert.notEqual(second.source_revision, first.source_revision);
  assert.equal(second.status, "queued");
  assert.equal(second.source_revision, screeningInputRevision("a plain note", null, ["food", "travel"]));
  assert.deepEqual(claimAtlasScreeningBatch(value, LIB, NOW, "screen", 60_000, 8), ["tag-revision"]);
  applyAtlasScreening(value, LIB, "tag-revision", { atlasCandidate: false }, NOW);
  assert.deepEqual(claimAtlasBatch(value, LIB, NOW, "atlas", 60_000, 8), ["tag-revision"]);
  applyProposal(value, LIB, "tag-revision", { itemId: "tag-revision", relevance: "not_atlas", destinations: [] }, NOW);

  const travelTag = value.prepare(`SELECT t.id FROM tags t WHERE lower(t.name) = 'travel'`).get() as { id: string };
  removeTag(value, "tag-revision", travelTag.id);
  enqueueAtlasItem(value, LIB, "tag-revision", NOW);
  const third = value.prepare(`SELECT source_revision, status FROM atlas_screenings WHERE item_id = ?`).get("tag-revision") as { source_revision: string; status: string };
  assert.notEqual(third.source_revision, second.source_revision);
  assert.equal(third.status, "queued");
  assert.equal(third.source_revision, screeningInputRevision("a plain note", null, ["food"]));
  assert.deepEqual(claimAtlasScreeningBatch(value, LIB, NOW, "screen", 60_000, 8), ["tag-revision"]);
  applyAtlasScreening(value, LIB, "tag-revision", { atlasCandidate: false }, NOW);
  assert.deepEqual(claimAtlasBatch(value, LIB, NOW, "atlas", 60_000, 8), []);
  assert.equal(value.prepare(`SELECT outcome FROM atlas_assignments WHERE item_id = ?`).get("tag-revision")?.outcome, "not_atlas");
  value.close();
});

test("Travel override backfill is bounded, versioned, and skips user decisions", () => {
  const value = db();
  for (let i = 0; i < 51; i += 1) {
    const id = `travel-migration-${String(i).padStart(2, "0")}`;
    insertItem(value, id, { title: i === 1 ? "trip 1 in Northstar" : `trip ${i}` });
    addTag(value, id, "travel");
  }
  const userId = "travel-migration-00";
  applyProposal(value, LIB, userId, { itemId: userId, relevance: "not_atlas", destinations: [] }, NOW);
  const userAssignment = getAtlasProjection(value, LIB).needsPlace.items.find((row) => row.item.id === userId)?.assignment;
  markNotAtlas(value, LIB, userId, userAssignment?.version ?? 0, NOW);
  applyProposal(value, LIB, "travel-migration-01", {
    itemId: "travel-migration-01",
    relevance: "atlas",
    destinations: [primary("Northstar", { title: "trip 1 in Northstar" }, "Northstar", { kind: "city" })],
  }, NOW);

  assert.equal(backfillTravelAtlas(value, LIB, NOW), true);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM atlas_attempts WHERE status = 'queued'`).get() as { n: number }).n, 48);
  assert.equal((value.prepare(`SELECT analyzer_version FROM atlas_attempts WHERE item_id = ?`).get("travel-migration-01") as { analyzer_version: number }).analyzer_version, ANALYZER_POLICY_VERSION);
  assert.equal((value.prepare(`SELECT status FROM atlas_attempts WHERE item_id = ?`).get("travel-migration-01") as { status: string }).status, "succeeded");
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM atlas_attempts WHERE item_id = ?`).get(userId) as { n: number }).n, 0);
  assert.equal(backfillTravelAtlas(value, LIB, NOW), false);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM atlas_attempts WHERE status = 'queued'`).get() as { n: number }).n, 49);
  assert.equal((value.prepare(`SELECT value FROM settings WHERE key = ?`).get(TRAVEL_OVERRIDE_CURSOR_SETTING) as { value: string }).value, "done");
  assert.equal(backfillTravelAtlas(value, LIB, NOW), false);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM atlas_attempts WHERE status = 'queued'`).get() as { n: number }).n, 49);
  value.close();
});

test("repeated versioned backfill reaches done without re-screening", () => {
  const value = db();
  insertItem(value, "bf-1", { title: "one" });
  insertItem(value, "bf-2", { title: "two" });
  assert.equal(backfillAtlas(value, LIB, NOW), false);
  assert.equal(backfillAtlas(value, LIB, NOW), false);
  assert.equal((value.prepare(`SELECT value FROM settings WHERE key = 'atlas.backfill.cursor'`).get() as { value: string }).value, "done");
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM atlas_screenings`).get() as { n: number }).n, 2);
  assert.equal((value.prepare(`SELECT value FROM settings WHERE key = 'atlas.backfill.version'`).get() as { value: string }).value, String(SCREENING_POLICY_VERSION));
  value.close();
});

test("wrong evidence offsets still place when the name is in the text", () => {
  const value = db();
  const body = "How I planned my Philippines trip";
  insertItem(value, "ph-2", { body });
  addTag(value, "ph-2", "travel");
  applyProposal(value, LIB, "ph-2", {
    itemId: "ph-2",
    relevance: "atlas",
    destinations: [{ name: "Philippines", kind: "country", role: "primary", evidence: [{ field: "body", start: 0, end: 4, text: "xxxx" }] }],
  }, NOW);
  assert.equal(getAtlasProjection(value, LIB).destinations[0]?.title, "Philippines");
  value.close();
});

test("non-Travel local place evidence is repaired from returned text", () => {
  const value = db();
  const body = "Dosa at Dock Cafe in Northstar City";
  insertItem(value, "food-2", { body });
  addTag(value, "food-2", "food");
  applyProposal(value, LIB, "food-2", {
    itemId: "food-2",
    relevance: "atlas",
    destinations: [{ name: "Dock Cafe", kind: "venue", role: "primary", evidence: [{ text: "Dock Cafe" }] }],
  }, NOW);
  const card = getAtlasProjection(value, LIB).destinations[0]?.items[0];
  assert.equal(card?.item.id, "food-2");
  assert.equal(card?.assignment.primary?.name, "Dock Cafe");
  value.close();
});

test("analyzer policy versions requeue old terminal work but never override a user assignment", () => {
  const value = db();
  insertItem(value, "old-1", { title: "Old place" });
  enqueueAtlasAnalysis(value, LIB, "old-1", NOW);
  applyProposal(value, LIB, "old-1", { itemId: "old-1", relevance: "not_atlas", destinations: [] }, NOW);
  value.prepare(`UPDATE atlas_attempts SET analyzer_version = 1 WHERE item_id = ?`).run("old-1");
  enqueueAtlasAnalysis(value, LIB, "old-1", NOW);
  const requeued = value.prepare(`SELECT status, analyzer_version FROM atlas_attempts WHERE item_id = ?`).get("old-1") as { status: string; analyzer_version: number };
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.analyzer_version, ANALYZER_POLICY_VERSION);

  insertItem(value, "screen-old", { title: "Previously analyzed place" });
  enqueueAtlasAnalysis(value, LIB, "screen-old", NOW);
  applyProposal(value, LIB, "screen-old", { itemId: "screen-old", relevance: "not_atlas", destinations: [] }, NOW);
  applyAtlasScreening(value, LIB, "screen-old", { atlasCandidate: true }, NOW);
  assert.equal((value.prepare(`SELECT status FROM atlas_attempts WHERE item_id = ?`).get("screen-old") as { status: string }).status, "queued");

  insertItem(value, "user-1", { title: "User place" });
  enqueueAtlasAnalysis(value, LIB, "user-1", NOW);
  const place = createPlace(value, LIB, { name: "User Place", kind: "venue" }, NOW);
  setExactPlace(value, LIB, "user-1", { placeId: place.id }, 0, NOW);
  enqueueAtlasAnalysis(value, LIB, "user-1", NOW);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM atlas_attempts WHERE item_id = ?`).get("user-1") as { n: number }).n, 0);
  assert.equal(getAtlasProjection(value, LIB).destinations[0]?.items.some((row) => row.item.id === "user-1"), true);
  value.close();
});

test("an analyzer not_atlas result keeps a Travel-tagged Item reviewable", () => {
  const value = db();
  insertItem(value, "tr-2", { title: "weekend somewhere" });
  addTag(value, "tr-2", "travel");
  applyProposal(value, LIB, "tr-2", { itemId: "tr-2", relevance: "not_atlas", destinations: [] }, NOW);
  const atlas = getAtlasProjection(value, LIB);
  assert.equal(atlas.destinations.length, 0);
  assert.equal(atlas.needsPlace.count, 1);
  assert.equal(atlas.needsPlace.items[0]?.item.id, "tr-2");
  value.close();
});

test("mark multiple from review uses suggested peers", () => {
  const value = db();
  const body = "Japan and Spain";
  insertItem(value, "md-1", { body });
  applyProposal(value, LIB, "md-1", {
    itemId: "md-1",
    relevance: "atlas",
    destinations: [primary("Japan", { body }, "Japan"), primary("Spain", { body }, "Spain")],
  }, NOW);
  const version = getAtlasProjection(value, LIB).needsPlace.items[0]?.assignment?.version ?? 0;
  markMultiple(value, LIB, "md-1", version, NOW);
  const atlas = getAtlasProjection(value, LIB);
  assert.equal(atlas.multiple.length, 1);
  assert.ok(atlas.multiple[0]!.assignment.peers.length >= 2);
  value.close();
});
