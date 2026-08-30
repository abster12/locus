import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { addTag } from "../core/commands.ts";
import { applyProposal, createPlace, type AtlasProjection } from "../server/atlas/module.ts";

process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_PORT = "8794";
process.env.LOCUS_ATLAS_WORKER = "0";
const { listen } = await import("../server/http/server.ts");

const TS = "2026-08-29T12:00:00.000Z";

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-atlas-http-")), "t.db"));
}

function insertItem(database: ReturnType<typeof mem>, id: string, body: string): void {
  database
    .prepare(
      `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
       VALUES (?, 'reel', NULL, ?, ?, ?, '[]', ?, ?)`,
    )
    .run(id, body, `https://www.instagram.com/reel/${id}/`, TS, TS, TS);
}

async function start(database: ReturnType<typeof mem>) {
  const app = listen(database);
  const base = `http://127.0.0.1:${app.port}`;
  const sessionResponse = await eventually(() => fetch(`${base}/api/session`));
  const session = (await sessionResponse.json()) as { csrf: string };
  const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const headers = { cookie, "content-type": "application/json", "x-csrf-token": session.csrf };
  return {
    base,
    headers,
    close: () => app.close(),
    get: (path: string) => fetch(`${base}${path}`, { headers }),
    post: (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
  };
}

async function eventually(request: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await request();
    } catch {
      if (attempt === 19) throw new Error("server did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("unreachable");
}

test("atlas HTTP projection, placement, stale writes, and CSRF", async () => {
  const database = mem();
  insertItem(database, "ph-1", "Philippines guide from Mumbai");
  insertItem(database, "food-1", "dosa in Northstar City");
  addTag(database, "ph-1", "travel");
  addTag(database, "food-1", "food");
  applyProposal(database, "local", "ph-1", {
    itemId: "ph-1",
    relevance: "atlas",
    destinations: [
      { name: "Philippines", kind: "country", role: "primary", evidence: [{ field: "body", start: 0, end: 11, text: "Philippines" }] },
      { name: "Mumbai", kind: "city", role: "mentioned", evidence: [{ field: "body", start: 23, end: 29, text: "Mumbai" }] },
    ],
  }, TS);
  const app = await start(database);
  try {
    const atlas = (await (await app.get("/api/atlas")).json()) as AtlasProjection & { analysis: { available: boolean } };
    assert.equal(atlas.destinations[0]?.title, "Philippines");
    assert.equal(atlas.destinations[0]?.count, 1);
    assert.equal(typeof atlas.analysis.available, "boolean");
    assert.ok("queued" in atlas.analysis);

    const city = createPlace(database, "local", { name: "Northstar City", kind: "city" }, TS);
    const placed = await app.post("/api/atlas/items/food-1/place", { placeId: city.id, expectedVersion: 0, actor: "analyzer" });
    assert.equal(placed.status, 200);
    const body = (await placed.json()) as { assignment: { actor: string; version: number }; atlas: AtlasProjection };
    assert.equal(body.assignment.actor, "user");
    assert.ok(body.atlas.destinations.some((section) => section.items.some((row) => row.item.id === "food-1")));

    const stale = await app.post("/api/atlas/items/food-1/change", { placeId: city.id, expectedVersion: 0 });
    assert.equal(stale.status, 409);

    const missing = await app.post("/api/atlas/items/nope/place", { name: "Ghost", expectedVersion: 0 });
    assert.equal(missing.status, 404);

    const home = await app.post("/api/atlas/home", { placeId: city.id });
    assert.equal(home.status, 200);
    const homeBody = (await home.json()) as { home: { name: string }; atlas: AtlasProjection };
    assert.equal(homeBody.home.name, "Northstar City");
    assert.equal(homeBody.atlas.home.place?.name, "Northstar City");

    const csrf = await fetch(`${app.base}/api/atlas/items/food-1/not-atlas`, {
      method: "POST",
      headers: { cookie: app.headers.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: body.assignment.version }),
    });
    assert.equal(csrf.status, 403);
  } finally {
    await app.close();
  }
});
