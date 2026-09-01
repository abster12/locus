import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { addTag } from "../core/commands.ts";
import { captionRevision, normalizeCaption, type KitchenItem, type TonightEntry, type TonightMutationResult, type TonightView } from "../server/kitchen/module.ts";

process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_PORT = "8793";
const { listen } = await import("../server/http/server.ts");

const TS = "2026-08-29T12:00:00.000Z";

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-kitchen-http-")), "t.db"));
}

function insertItem(database: ReturnType<typeof mem>, id: string, body = "mix flour", url = `https://www.instagram.com/reel/${id}/`): void {
  database
    .prepare(
      `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
       VALUES (?, 'reel', NULL, ?, ?, ?, '[]', ?, ?)`,
    )
    .run(id, body, url, TS, TS, TS);
}

function food(database: ReturnType<typeof mem>, id: string): void {
  addTag(database, id, "food");
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
    post: (path: string, body: unknown, extra: Record<string, string> = {}) =>
      fetch(`${base}${path}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) }),
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

test("kitchen index, detail eligibility, recipe writes, and removal over HTTP", async () => {
  const database = mem();
  insertItem(database, "food-1", "200 g paneer\nGrill it");
  insertItem(database, "food-2", "cake batter");
  insertItem(database, "plain-1", "not food");
  food(database, "food-1");
  food(database, "food-2");
  const app = await start(database);
  try {
    const index = await (await app.get("/api/kitchen")).json() as {
      items: KitchenItem[];
      nextCursor: string | null;
      counts: { foodSaves: number; structuredRecipes: number; tonight: number };
    };
    assert.deepEqual(index.items.map((row) => row.item.id), ["food-2", "food-1"]);
    assert.deepEqual(index.counts, { foodSaves: 2, structuredRecipes: 0, tonight: 0 });
    assert.equal(index.items[0]?.availability, "caption");
    assert.equal(index.items[0]?.showCaptionPreview, false);

    const paged = await (await app.get("/api/kitchen?limit=1")).json() as typeof index;
    assert.equal(paged.items.length, 1);
    assert.ok(paged.nextCursor);
    assert.equal(paged.counts.foodSaves, 2); // counts stay library-wide on every page

    const searched = await (await app.get("/api/kitchen?q=paneer")).json() as typeof index;
    assert.deepEqual(searched.items.map((row) => row.item.id), ["food-1"]);

    const detail = await app.get("/api/kitchen/items/food-1");
    assert.equal(detail.status, 200);
    const kitchenItem = await detail.json() as KitchenItem;
    assert.equal(kitchenItem.item.id, "food-1");
    assert.equal(kitchenItem.caption, "200 g paneer\nGrill it");
    assert.equal(kitchenItem.recipe, null);

    assert.equal((await app.get("/api/kitchen/items/plain-1")).status, 404);
    assert.equal((await app.get("/api/kitchen/items/missing")).status, 404);

    const revision = captionRevision(normalizeCaption("200 g paneer\nGrill it"));
    const ok = await app.post("/api/kitchen/items/food-1/recipe", {
      expectedSourceRevision: revision,
      status: "draft",
      draft: {
        version: 1,
        ingredients: [{ id: "ing-1", raw: "200 g paneer", name: "paneer", evidence: { kind: "user" } }],
        steps: [],
      },
    });
    assert.equal(ok.status, 200);
    const saved = (await ok.json()) as { document: { id: string; status: string; sourceRevision: string } };
    assert.equal(saved.document.status, "draft");
    assert.equal(saved.document.sourceRevision, revision);

    // Agent actors are not reachable from HTTP: a client-sent actor field is ignored.
    const withActor = await app.post("/api/kitchen/items/food-1/recipe", {
      expectedSourceRevision: revision,
      status: "reviewed",
      actor: "agent",
      draft: {
        version: 1,
        ingredients: [{ id: "ing-1", raw: "x", name: "x", evidence: { kind: "user" } }],
        steps: [],
      },
    });
    assert.equal(withActor.status, 200);
    assert.equal(((await withActor.json()) as typeof saved).document.status, "reviewed");

    const stale = await app.post("/api/kitchen/items/food-1/recipe", {
      expectedSourceRevision: "deadbeef",
      status: "draft",
      draft: { version: 1, ingredients: [], steps: [{ id: "s", instruction: "x", ingredientIds: [], evidence: { kind: "user" } }] },
    });
    assert.equal(stale.status, 409);

    const invalid = await app.post("/api/kitchen/items/food-1/recipe", {
      expectedSourceRevision: revision,
      status: "draft",
      draft: { version: 1, ingredients: [{ id: "ing-1", raw: "x", name: "x" }], steps: [] },
    });
    assert.equal(invalid.status, 400);

    assert.equal((await app.post("/api/kitchen/items/plain-1/recipe", { expectedSourceRevision: revision, status: "draft", draft: { version: 1, ingredients: [], steps: [{ id: "s", instruction: "x", ingredientIds: [], evidence: { kind: "user" } }] } })).status, 404);
    assert.equal((await app.post("/api/kitchen/items/missing/recipe", { expectedSourceRevision: revision, status: "draft", draft: {} })).status, 404);

    const removed = await app.post("/api/kitchen/items/food-1/recipe/remove", {});
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { removed: true });
    assert.equal((await app.post("/api/kitchen/items/food-1/recipe/remove", {})).status, 404);
  } finally {
    await app.close();
    database.close();
  }
});

test("kitchen tonight routes: CSRF, eligibility, idempotence, reorder, and clear", async () => {
  const database = mem();
  insertItem(database, "food-1", "soup");
  insertItem(database, "food-2", "stew");
  insertItem(database, "plain-1", "not food");
  food(database, "food-1");
  food(database, "food-2");
  const app = await start(database);
  try {
    // Mutations without the CSRF token are rejected.
    const noCsrf = await fetch(`${app.base}/api/kitchen/tonight`, {
      method: "POST",
      headers: { cookie: app.headers.cookie, "content-type": "application/json" },
      body: JSON.stringify({ itemId: "food-1" }),
    });
    assert.equal(noCsrf.status, 403);

    const first = await app.post("/api/kitchen/tonight", { itemId: "food-1" });
    assert.equal(first.status, 200);
    const entry = await first.json() as TonightEntry;
    assert.equal(entry.item?.item.id, "food-1");

    const duplicate = await app.post("/api/kitchen/tonight", { itemId: "food-1" });
    assert.equal(duplicate.status, 200);
    assert.equal(((await duplicate.json()) as TonightEntry).id, entry.id);

    assert.equal((await app.post("/api/kitchen/tonight", { itemId: "missing" })).status, 404);
    assert.equal((await app.post("/api/kitchen/tonight", { itemId: "plain-1" })).status, 409);

    const second = await (await app.post("/api/kitchen/tonight", { itemId: "food-2" })).json() as TonightEntry;

    const index = await (await app.get("/api/kitchen")).json() as { counts: { tonight: number } };
    assert.equal(index.counts.tonight, 2);

    const reordered = await app.post("/api/kitchen/tonight/reorder", { entryIds: [second.id, entry.id] });
    assert.equal(reordered.status, 200);
    const list = (await (await app.get("/api/kitchen/tonight")).json()) as TonightEntry[];
    assert.deepEqual(list.map((row) => row.itemId), ["food-2", "food-1"]);
    assert.deepEqual(list.map((row) => row.order), [0, 1]);

    assert.equal((await app.post("/api/kitchen/tonight/reorder", { entryIds: [entry.id] })).status, 409);
    assert.equal((await app.post("/api/kitchen/tonight/reorder", { entryIds: [entry.id, second.id, "invented"] })).status, 409);
    assert.equal((await app.post("/api/kitchen/tonight/reorder", { entryIds: "nope" })).status, 400);
    assert.deepEqual(
      ((await (await app.get("/api/kitchen/tonight")).json()) as TonightEntry[]).map((row) => row.itemId),
      ["food-2", "food-1"],
    );

    const removed = await app.post(`/api/kitchen/tonight/${entry.id}/remove`, {});
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { removed: true });
    assert.equal((await app.post(`/api/kitchen/tonight/${entry.id}/remove`, {})).status, 404);
    assert.equal((await app.post("/api/kitchen/tonight/not-an-entry/remove", {})).status, 404);

    const cleared = await app.post("/api/kitchen/tonight/clear", {});
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { removed: 1 });
    assert.deepEqual(await (await app.get("/api/kitchen/tonight")).json(), []);
  } finally {
    await app.close();
    database.close();
  }
});

test("tonight-only items stay detailed and missing items hydrate as null", async () => {
  const database = mem();
  insertItem(database, "food-1", "curry");
  food(database, "food-1");
  const app = await start(database);
  try {
    const added = await (await app.post("/api/kitchen/tonight", { itemId: "food-1" })).json() as TonightEntry;

    // The Item leaves the Food shelf but stays on Tonight: still detailed.
    database.prepare(`DELETE FROM memberships WHERE item_id = 'food-1'`).run();
    assert.equal((await app.get("/api/kitchen/items/food-1")).status, 200);
    const index = await (await app.get("/api/kitchen")).json() as { items: unknown[] };
    assert.deepEqual(index.items, []);

    // Deleting the Item keeps a broken pin with item:null; detail is 404.
    database.prepare(`DELETE FROM items WHERE id = 'food-1'`).run();
    assert.equal((await app.get("/api/kitchen/items/food-1")).status, 404);
    const tonight = (await (await app.get("/api/kitchen/tonight")).json()) as TonightEntry[];
    assert.equal(tonight.length, 1);
    assert.equal(tonight[0]?.id, added.id);
    assert.equal(tonight[0]?.item, null);
    assert.equal((await app.post(`/api/kitchen/tonight/${added.id}/remove`, {})).status, 200);
  } finally {
    await app.close();
    database.close();
  }
});

test("kitchen routes reject unauthenticated requests", async () => {
  const database = mem();
  insertItem(database, "food-1", "mix");
  food(database, "food-1");
  const app = await start(database);
  try {
    const anonymous = await fetch(`${app.base}/api/kitchen`);
    assert.equal(anonymous.status, 401);
    const anonymousPost = await fetch(`${app.base}/api/kitchen/tonight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: "food-1" }),
    });
    assert.equal(anonymousPost.status, 401);
  } finally {
    await app.close();
    database.close();
  }
});

test("agent propose-recipe and tonight apply over HTTP", async () => {
  const database = mem();
  insertItem(database, "food-1", "200 g paneer\nGrill it");
  insertItem(database, "food-2", "beans");
  insertItem(database, "plain-1", "not food");
  food(database, "food-1");
  food(database, "food-2");
  const app = await start(database);
  try {
    const revision = captionRevision(normalizeCaption("200 g paneer\nGrill it"));
    const captionDraft = {
      version: 1,
      ingredients: [
        { id: "ing-1", raw: "200 g paneer", name: "paneer", evidence: { kind: "caption", spans: [{ start: 0, end: 12, text: "200 g paneer" }] } },
      ],
      steps: [],
    };
    const generatedDraft = {
      version: 1,
      ingredients: [{ id: "ing-1", raw: "salt", name: "salt", evidence: { kind: "generated" } }],
      steps: [],
    };

    // Client-sent status and actor are ignored: the trusted session forces
    // actor "agent" and the module forces Draft.
    const proposed = await app.post("/api/kitchen/items/food-1/propose-recipe", {
      expectedSourceRevision: revision,
      status: "reviewed",
      actor: "user",
      draft: captionDraft,
    });
    assert.equal(proposed.status, 200);
    const doc = (await proposed.json()) as { document: { status: string; updatedBy: string; provenance: string } };
    assert.equal(doc.document.status, "draft");
    assert.equal(doc.document.updatedBy, "agent");
    assert.equal(doc.document.provenance, "caption");

    // allowGenerate must be boolean when present.
    const badFlag = await app.post("/api/kitchen/items/food-2/propose-recipe", {
      expectedSourceRevision: captionRevision(normalizeCaption("beans")),
      draft: captionDraft,
      allowGenerate: "yes",
    });
    assert.equal(badFlag.status, 400);

    // Generated evidence without consent rejects the write and stores nothing.
    const unconsented = await app.post("/api/kitchen/items/food-2/propose-recipe", {
      expectedSourceRevision: captionRevision(normalizeCaption("beans")),
      draft: generatedDraft,
    });
    assert.equal(unconsented.status, 400);
    assert.equal(((await (await app.get("/api/kitchen/items/food-2")).json()) as KitchenItem).recipe, null);

    // With explicit consent the suggestion stores as a labelled generated draft.
    const consented = await app.post("/api/kitchen/items/food-2/propose-recipe", {
      expectedSourceRevision: captionRevision(normalizeCaption("beans")),
      draft: generatedDraft,
      allowGenerate: true,
    });
    assert.equal(consented.status, 200);
    const genDoc = (await consented.json()) as { document: { status: string; provenance: string } };
    assert.equal(genDoc.document.status, "draft");
    assert.equal(genDoc.document.provenance, "generated");

    const stale = await app.post("/api/kitchen/items/food-1/propose-recipe", { expectedSourceRevision: "deadbeef", draft: captionDraft });
    assert.equal(stale.status, 409);
    assert.equal((await app.post("/api/kitchen/items/missing/propose-recipe", { expectedSourceRevision: revision, draft: captionDraft })).status, 404);

    // Unauthenticated agent routes behave like every other kitchen route.
    const anonymous = await fetch(`${app.base}/api/kitchen/items/food-1/propose-recipe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedSourceRevision: revision, draft: captionDraft }),
    });
    assert.equal(anonymous.status, 401);

    // The human route keeps returning the plain array; the agent route adds revision.
    assert.deepEqual((await (await app.get("/api/kitchen/tonight")).json()) as TonightEntry[], []);
    const state = (await (await app.get("/api/kitchen/tonight/state")).json()) as TonightView;
    assert.equal(state.revision, 1);

    // One apply commits add+reorder atomically against the expected revision.
    const first = await app.post("/api/kitchen/tonight/apply", {
      expectedRevision: 1,
      clientMutationId: "webmcp-1",
      operations: [{ op: "add", itemId: "food-1" }, { op: "add", itemId: "food-2" }],
    });
    assert.equal(first.status, 200);
    const applied = (await first.json()) as TonightMutationResult;
    assert.equal(applied.replayed, false);
    assert.equal(applied.revision, 2);
    assert.deepEqual(applied.entries.map((entry) => entry.itemId), ["food-1", "food-2"]);

    const reorder = await app.post("/api/kitchen/tonight/apply", {
      expectedRevision: 2,
      clientMutationId: "webmcp-2",
      operations: [{ op: "reorder", itemIds: ["food-2", "food-1"] }],
    });
    assert.equal(reorder.status, 200);
    assert.deepEqual(((await reorder.json()) as TonightMutationResult).entries.map((entry) => entry.itemId), ["food-2", "food-1"]);

    // Retrying the same clientMutationId replays without duplicating entries.
    const replay = await app.post("/api/kitchen/tonight/apply", {
      expectedRevision: 1,
      clientMutationId: "webmcp-1",
      operations: [{ op: "add", itemId: "food-1" }, { op: "add", itemId: "food-2" }],
    });
    assert.equal(replay.status, 200);
    const replayed = (await replay.json()) as TonightMutationResult;
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.revision, 2);
    assert.equal(((await (await app.get("/api/kitchen/tonight")).json()) as TonightEntry[]).length, 2);

    // The same id with a different payload is a conflict, never a second write.
    assert.equal(
      (await app.post("/api/kitchen/tonight/apply", {
        expectedRevision: 3,
        clientMutationId: "webmcp-1",
        operations: [{ op: "add", itemId: "food-1" }, { op: "add", itemId: "food-2" }],
      })).status,
      409,
    );

    // Stale revisions and missing CSRF both reject without mutating.
    assert.equal(
      (await app.post("/api/kitchen/tonight/apply", {
        expectedRevision: 1,
        clientMutationId: "webmcp-stale",
        operations: [{ op: "remove", itemId: "food-1" }],
      })).status,
      409,
    );
    const noCsrf = await fetch(`${app.base}/api/kitchen/tonight/apply`, {
      method: "POST",
      headers: { cookie: app.headers.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 3, clientMutationId: "webmcp-csrf", operations: [{ op: "remove", itemId: "food-1" }] }),
    });
    assert.equal(noCsrf.status, 403);
    assert.deepEqual(((await (await app.get("/api/kitchen/tonight")).json()) as TonightEntry[]).map((entry) => entry.itemId), ["food-2", "food-1"]);

    // Composition never touches Recipe Documents.
    const before = ((await (await app.get("/api/kitchen/items/food-1")).json()) as KitchenItem).recipe as { status: string; sourceRevision: string };
    assert.equal(before.status, "draft");
    const removed = await app.post("/api/kitchen/tonight/apply", {
      expectedRevision: 3,
      clientMutationId: "webmcp-3",
      operations: [{ op: "remove", itemId: "food-1" }],
    });
    assert.equal(removed.status, 200);
    const after = ((await (await app.get("/api/kitchen/items/food-1")).json()) as KitchenItem).recipe as { status: string; sourceRevision: string };
    assert.equal(after.status, before.status);
    assert.equal(after.sourceRevision, before.sourceRevision);
  } finally {
    await app.close();
    database.close();
  }
});
