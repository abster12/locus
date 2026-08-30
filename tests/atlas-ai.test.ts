import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { RejectedPayload } from "../core/sanitize.ts";
import { addTag } from "../core/commands.ts";
import { applyProposal, enqueueAtlasItem, getAtlasProjection } from "../server/atlas/module.ts";
import {
  analyzeAtlasItem,
  drainAtlasWorker,
  parseProposalJson,
  startAtlasWorker,
  stopAtlasWorker,
  type AtlasScreener,
  type AtlasInterpreter,
} from "../server/atlas/ai.ts";

const NOW = "2026-08-29T12:00:00.000Z";

function db() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-atlas-ai-")), "t.db"));
}

function insertItem(value: ReturnType<typeof db>, id: string, body: string): void {
  value
    .prepare(
      `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
       VALUES (?, 'reel', NULL, ?, ?, ?, '[]', ?, ?)`,
    )
    .run(id, body, `https://www.instagram.com/reel/${id}/`, NOW, NOW, NOW);
}

test("fake interpreter proposal is validated at the Atlas module boundary", async () => {
  const value = db();
  const body = "Philippines guide from Mumbai";
  insertItem(value, "ph-1", body);
  const interpreter: AtlasInterpreter = {
    interpret: async () => ({
      itemId: "ph-1",
      relevance: "atlas",
      destinations: [
        { name: "Philippines", kind: "country", role: "primary", evidence: [{ field: "body", start: 0, end: 11, text: "Philippines" }] },
        { name: "Mumbai", kind: "city", role: "mentioned", evidence: [{ field: "body", start: 23, end: 29, text: "Mumbai" }] },
      ],
    }),
  };
  await analyzeAtlasItem(value, "local", "ph-1", interpreter, NOW);
  const atlas = getAtlasProjection(value, "local");
  assert.deepEqual(atlas.destinations.map((section) => section.title), ["Philippines"]);
  value.close();
});

test("malformed interpreter output keeps the last valid assignment", async () => {
  const value = db();
  const body = "Japan trip";
  insertItem(value, "jp-1", body);
  applyProposal(value, "local", "jp-1", {
    itemId: "jp-1",
    relevance: "atlas",
    destinations: [{ name: "Japan", kind: "country", role: "primary", evidence: [{ field: "body", start: 0, end: 5, text: "Japan" }] }],
  }, NOW);
  value.prepare(`UPDATE items SET body = ?, updated_at = ? WHERE id = ?`).run("Japan and Spain", NOW, "jp-1");
  await assert.rejects(
    () => analyzeAtlasItem(value, "local", "jp-1", { interpret: async () => ({ itemId: "jp-1", relevance: "atlas", destinations: [{ name: "Atlantis", kind: "country", role: "primary", evidence: [] }] }) }, NOW),
    RejectedPayload,
  );
  assert.equal(getAtlasProjection(value, "local").destinations[0]?.title, "Japan");
  value.close();
});

test("worker drains a queued Item through a fake interpreter", async () => {
  const value = db();
  insertItem(value, "q-1", "Lisbon walk");
  addTag(value, "q-1", "travel");
  enqueueAtlasItem(value, "local", "q-1", NOW);
  startAtlasWorker(value, {
    screener: {
      screen: async () => ({ "q-1": { atlasCandidate: true } }),
    } satisfies AtlasScreener,
    interpreter: {
      interpret: async () => ({
        itemId: "q-1",
        relevance: "atlas",
        destinations: [{ name: "Lisbon", kind: "city", role: "primary", evidence: [{ field: "body", start: 0, end: 6, text: "Lisbon" }] }],
      }),
    },
  });
  await drainAtlasWorker(value);
  assert.equal(getAtlasProjection(value, "local").destinations[0]?.title, "Lisbon");
  stopAtlasWorker(value);
  value.close();
});

test("worker can drain screening even when detailed interpretation is unavailable", async () => {
  const value = db();
  insertItem(value, "screen-only", "a plain note");
  enqueueAtlasItem(value, "local", "screen-only", NOW);
  startAtlasWorker(value, {
    screener: { screen: async () => ({ "screen-only": { atlasCandidate: false } }) },
    interpreter: null,
  });
  await drainAtlasWorker(value);
  assert.equal((value.prepare(`SELECT status, candidate FROM atlas_screenings WHERE item_id = ?`).get("screen-only") as { status: string; candidate: number }).status, "succeeded");
  assert.equal(getAtlasProjection(value, "local").needsPlace.count, 0);
  stopAtlasWorker(value);
  value.close();
});

test("worker keeps a Travel screen negative reviewable after detailed not_atlas", async () => {
  const value = db();
  insertItem(value, "travel-negative-worker", "somewhere for the weekend");
  addTag(value, "travel-negative-worker", "travel");
  enqueueAtlasItem(value, "local", "travel-negative-worker", NOW);
  startAtlasWorker(value, {
    screener: { screen: async () => ({ "travel-negative-worker": { atlasCandidate: false } }) },
    interpreter: {
      interpret: async () => ({ itemId: "travel-negative-worker", relevance: "not_atlas", destinations: [] }),
    },
  });
  await drainAtlasWorker(value);
  const row = value.prepare(`SELECT outcome, actor FROM atlas_assignments WHERE item_id = ?`).get("travel-negative-worker") as { outcome: string; actor: string };
  assert.equal(row.outcome, "needs_place");
  assert.equal(row.actor, "analyzer");
  assert.equal(getAtlasProjection(value, "local").needsPlace.items.some((item) => item.item.id === "travel-negative-worker"), true);
  stopAtlasWorker(value);
  value.close();
});

test("screen results never attach to a revision changed while the provider was running", async () => {
  const value = db();
  insertItem(value, "screen-race", "old caption");
  enqueueAtlasItem(value, "local", "screen-race", NOW);
  startAtlasWorker(value, {
    screener: {
      screen: async () => {
        value.prepare(`UPDATE items SET body = ?, updated_at = ? WHERE id = ?`).run("new caption", NOW, "screen-race");
        return { "screen-race": { atlasCandidate: true } };
      },
    },
    interpreter: null,
  });
  await drainAtlasWorker(value);
  const screening = value.prepare(`SELECT status, candidate FROM atlas_screenings WHERE item_id = ?`).get("screen-race") as { status: string; candidate: number | null };
  assert.equal(screening.status, "queued");
  assert.equal(screening.candidate, null);
  assert.equal((value.prepare(`SELECT COUNT(*) AS n FROM atlas_attempts WHERE item_id = ?`).get("screen-race") as { n: number }).n, 0);
  stopAtlasWorker(value);
  value.close();
});

test("proposal JSON parser requires an object", () => {
  assert.equal((parseProposalJson('{"itemId":"a","relevance":"not_atlas"}', "a") as { relevance: string }).relevance, "not_atlas");
  const extra = parseProposalJson('{"itemId":"a","relevance":"atlas","confidence":0.9,"destinations":[]}', "a") as Record<string, unknown>;
  assert.equal(extra.confidence, undefined);
  assert.deepEqual(extra.destinations, []);
  assert.throws(() => parseProposalJson("not json", "a"), RejectedPayload);
});

test("proposal JSON parser extracts one balanced object from provider prose", () => {
  const parsed = parseProposalJson('Here is the result: {"itemId":"a","relevance":"not_atlas","destinations":[]}\\nThanks {"ignored":true}', "a") as {
    itemId: string;
    relevance: string;
    destinations: unknown[];
  };
  assert.equal(parsed.itemId, "a");
  assert.equal(parsed.relevance, "not_atlas");
  assert.deepEqual(parsed.destinations, []);
});
