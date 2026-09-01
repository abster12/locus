import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import type { TripDocument, TripStop, TripSummary } from "../server/trips/module.ts";
import { createPlace } from "../server/atlas/module.ts";
import { loadInstall, sign } from "../server/http/session.ts";

process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_PORT = "8805";
const { listen } = await import("../server/http/server.ts");

const TS = "2026-09-01T09:00:00.000Z";


/** Existing test stops are outside content; reference stops resolve server-side. */
function titleOf(stop: { content: TripStop["content"] }): string {
  if (stop.content.kind === "outside") return stop.content.title;
  return stop.content.kind === "item" ? "a saved item" : "a place";
}

function notesOf(stop: { content: TripStop["content"] }): string | null {
  return stop.content.kind === "outside" ? stop.content.notes : null;
}

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-trips-http-")), "t.db"));
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

/** A bare GET /api/session (no cookie sent) mints one fresh signed session;
 * the csrf token is install-wide and shared across jars by design. */
async function secondJar(base: string) {
  const res = await fetch(`${base}/api/session`);
  const { csrf } = (await res.json()) as { csrf: string };
  const cookie = res.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const headers = { cookie, "content-type": "application/json", "x-csrf-token": csrf };
  return {
    headers,
    get: (path: string) => fetch(`${base}${path}`, { headers }),
    post: (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
  };
}

/** Trusted payload is everything before the "." in the cookie value. */
function sessionIdOf(cookie: string): string {
  return cookie.slice("locus_session=".length).split(".")[0]!;
}

test("trips HTTP: create, list, get, update, csrf, 404, and trusted ownership", async () => {
  const database = mem();
  const app = await start(database);
  try {
    // CSRF is enforced globally on mutating API calls.
    const noCsrf = await fetch(`${app.base}/api/trips`, {
      method: "POST",
      headers: { cookie: app.headers.cookie, "content-type": "application/json" },
      body: JSON.stringify({ destination: "Kyoto", durationDays: 3 }),
    });
    assert.equal(noCsrf.status, 403);

    // Without a session nothing is readable.
    const anonymous = await fetch(`${app.base}/api/trips`);
    assert.equal(anonymous.status, 401);

    const create = await app.post("/api/trips", {
      destination: "Kyoto, Japan",
      startDate: "2026-10-12",
      endDate: "2026-10-15",
      timezone: "Asia/Tokyo",
      travelers: "2 adults",
      context: { pace: "slow mornings", mustDos: ["Nishiki Market"] },
      clientMutationId: "create-1",
      // Trusted fields from the body are ignored, never stored.
      libraryId: "hosted-b",
      actor: "agent",
    });
    assert.equal(create.status, 200);
    const created = ((await create.json()) as { trip: TripDocument }).trip;
    assert.ok(created.id);
    assert.equal(created.libraryId, "local");
    assert.equal(created.title, "Kyoto, Japan");
    assert.equal(created.revision, 1);
    assert.equal(created.durationDays, 4);
    assert.equal(created.days.length, 4);
    assert.equal(created.days[0]!.date, "2026-10-12");
    assert.deepEqual(created.context.mustDos, ["Nishiki Market"]);
    assert.equal(Object.hasOwn(created, "actor"), false);

    const invalid = await app.post("/api/trips", { destination: "Kyoto", durationDays: 0, clientMutationId: "create-bad" });
    assert.equal(invalid.status, 400);
    const mismatch = await app.post("/api/trips", {
      destination: "Kyoto",
      startDate: "2026-10-12",
      endDate: "2026-10-15",
      durationDays: 9,
      clientMutationId: "create-mismatch",
    });
    assert.equal(invalid.status, 400);
    assert.equal(mismatch.status, 400);

    const list = await app.get("/api/trips");
    assert.equal(list.status, 200);
    const trips = ((await list.json()) as { trips: TripSummary[] }).trips;
    assert.equal(trips.length, 1);
    assert.equal(trips[0]!.id, created.id);

    const got = await app.get(`/api/trips/${created.id}`);
    assert.equal(got.status, 200);
    assert.equal(((await got.json()) as { trip: TripDocument }).trip.id, created.id);

    const missing = await app.get("/api/trips/nope");
    assert.equal(missing.status, 404);

    const updated = await app.post(`/api/trips/${created.id}/update`, {
      expectedRevision: created.revision,
      clientMutationId: "upd-1",
      destination: "Kyoto, Japan",
      startDate: "2026-10-12",
      endDate: "2026-10-15",
      title: "Kyoto in October",
    });
    assert.equal(updated.status, 200);
    const updatedTrip = ((await updated.json()) as { trip: TripDocument }).trip;
    assert.equal(updatedTrip.revision, 2);
    assert.equal(updatedTrip.title, "Kyoto in October");

    const missingUpdate = await app.post("/api/trips/nope/update", { expectedRevision: 1, clientMutationId: "upd-x", destination: "Kyoto", durationDays: 3 });
    assert.equal(missingUpdate.status, 404);
  } finally {
    await app.close();
    database.close();
  }
});

test("trips HTTP: rejections never create documents and the index stays empty", async () => {
  const database = mem();
  const app = await start(database);
  try {
    const bad = await app.post("/api/trips", { destination: "Kyoto", clientMutationId: "create-incomplete" });
    assert.equal(bad.status, 400);
    const list = await app.get("/api/trips");
    assert.equal(((await list.json()) as { trips: TripSummary[] }).trips.length, 0);
  } finally {
    await app.close();
    database.close();
  }
});

test("trips HTTP: rename, duplicate, archive, restore, and confirmed delete", async () => {
  const database = mem();
  const app = await start(database);
  try {
    const create = await app.post("/api/trips", {
      destination: "Kyoto, Japan",
      durationDays: 3,
      clientMutationId: "create-lifecycle",
      // Trusted fields from the body are ignored, never used.
      libraryId: "hosted-b",
      actor: "agent",
    });
    assert.equal(create.status, 200);
    const trip = ((await create.json()) as { trip: TripDocument }).trip;

    // CSRF is enforced on every mutating trips route.
    const noCsrf = await fetch(`${app.base}/api/trips/${trip.id}/rename`, {
      method: "POST",
      headers: { cookie: app.headers.cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "X" }),
    });
    assert.equal(noCsrf.status, 403);

    const badTitle = await app.post(`/api/trips/${trip.id}/rename`, { expectedRevision: trip.revision, clientMutationId: "rn-0", title: "" });
    assert.equal(badTitle.status, 400);

    const renamed = await app.post(`/api/trips/${trip.id}/rename`, { expectedRevision: trip.revision, clientMutationId: "rn-1", title: "Kyoto in October" });
    assert.equal(renamed.status, 200);
    const renamedTrip = ((await renamed.json()) as { trip: TripDocument }).trip;
    assert.equal(renamedTrip.title, "Kyoto in October");
    assert.equal(renamedTrip.revision, 2);

    const missingRename = await app.post("/api/trips/nope/rename", { expectedRevision: 1, clientMutationId: "rn-x", title: "X" });
    assert.equal(missingRename.status, 404);

    const duplicated = await app.post(`/api/trips/${trip.id}/duplicate`, { expectedRevision: renamedTrip.revision, clientMutationId: "dup-1" });
    assert.equal(duplicated.status, 200);
    const copy = ((await duplicated.json()) as { trip: TripDocument }).trip;
    assert.notEqual(copy.id, trip.id);
    assert.equal(copy.revision, 1);
    assert.equal(copy.title, "Kyoto in October");
    assert.equal(copy.archivedAt, null);

    const archived = await app.post(`/api/trips/${trip.id}/archive`, { expectedRevision: renamedTrip.revision, clientMutationId: "arch-1" });
    assert.equal(archived.status, 200);
    const archivedTrip = ((await archived.json()) as { trip: TripDocument }).trip;
    assert.ok(archivedTrip.archivedAt);
    assert.equal(archivedTrip.revision, 3);

    const restored = await app.post(`/api/trips/${trip.id}/restore`, { expectedRevision: archivedTrip.revision, clientMutationId: "rest-1" });
    assert.equal(restored.status, 200);
    const restoredTrip = ((await restored.json()) as { trip: TripDocument }).trip;
    assert.equal(restoredTrip.archivedAt, null);
    assert.equal(restoredTrip.revision, 4);

    const missingArchive = await app.post("/api/trips/nope/archive", { expectedRevision: 1, clientMutationId: "arch-x" });
    assert.equal(missingArchive.status, 404);

    // Delete is human-only: no confirm, no deletion.
    const unconfirmed = await app.post(`/api/trips/${copy.id}/delete`, {});
    assert.equal(unconfirmed.status, 400);
    const wrongConfirm = await app.post(`/api/trips/${copy.id}/delete`, { confirm: "yes" });
    assert.equal(wrongConfirm.status, 400);
    assert.equal(((await (await app.get(`/api/trips/${copy.id}`)).json()) as { trip: TripDocument }).trip.id, copy.id);

    const deleted = await app.post(`/api/trips/${copy.id}/delete`, { confirm: "DELETE", expectedRevision: copy.revision, clientMutationId: "del-1" });
    assert.equal(deleted.status, 200);
    assert.deepEqual((await deleted.json()) as { deleted: boolean }, { deleted: true });
    assert.equal((await app.get(`/api/trips/${copy.id}`)).status, 404);

    const replayDelete = await app.post(`/api/trips/${copy.id}/delete`, { confirm: "DELETE", expectedRevision: copy.revision, clientMutationId: "del-1" });
    assert.equal(replayDelete.status, 200, "exact delete retry after the trip is gone");
    assert.deepEqual((await replayDelete.json()) as { deleted: boolean }, { deleted: true });

    const missingDelete = await app.post("/api/trips/nope/delete", { confirm: "DELETE", expectedRevision: 1, clientMutationId: "del-x" });
    assert.equal(missingDelete.status, 404);

    // The list only ever contains this session's Library.
    const list = await app.get("/api/trips");
    const trips = ((await list.json()) as { trips: TripSummary[] }).trips;
    assert.deepEqual(trips.map((row) => row.id), [trip.id]);
  } finally {
    await app.close();
    database.close();
  }
});

test("trips HTTP: changes, undo, redo, history, stale 409, invalid 400, actor forced", async () => {
  const database = mem();
  const app = await start(database);
  try {
    const created = ((await (await app.post("/api/trips", { destination: "Kyoto", startDate: "2026-10-12", endDate: "2026-10-14", clientMutationId: "create-changes" })).json()) as { trip: TripDocument })
      .trip;
    const day1 = created.days[0]!.id;
    const changes = (operations: unknown, mutationId: string, expectedRevision: number, extra: Record<string, unknown> = {}) =>
      app.post(`/api/trips/${created.id}/changes`, { expectedRevision, clientMutationId: mutationId, operations, ...extra });
    const addNishiki = [{ type: "addStop", dayId: day1, content: { kind: "outside", title: "Nishiki Market" } }];

    // CSRF is enforced globally on Day Planner mutations.
    const noCsrf = await fetch(`${app.base}/api/trips/${created.id}/changes`, {
      method: "POST",
      headers: { cookie: app.headers.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, clientMutationId: "nc", operations: addNishiki }),
    });
    assert.equal(noCsrf.status, 403);

    const added = await changes(addNishiki, "m1", 1, { instruction: "pack day one", actor: "agent" });
    assert.equal(added.status, 200);
    const addedBody = (await added.json()) as { trip: TripDocument; changeset: { actor: string; instruction: string | null; summary: string }; replayed: boolean; canUndo: boolean; canRedo: boolean };
    assert.equal(addedBody.trip.revision, 2);
    assert.equal(titleOf(addedBody.trip.days[0]!.stops[0]!), "Nishiki Market");
    assert.equal(addedBody.trip.days[0]!.stops[0]!.state, "confirmed", "human stops are Confirmed as text and data");
    assert.equal(addedBody.replayed, false);
    assert.equal(addedBody.canUndo, true);
    assert.equal(addedBody.canRedo, false);
    assert.equal(addedBody.changeset.actor, "user", "the body never chooses the actor");
    assert.equal(addedBody.changeset.instruction, "pack day one");
    assert.match(addedBody.changeset.summary, /added "Nishiki Market" to Day 1/);

    // A network retry with the identical body replays; a changed payload with
    // the same mutation id is rejected.
    const retry = await changes(addNishiki, "m1", 1, { instruction: "pack day one" });
    assert.equal(retry.status, 200);
    assert.equal(((await retry.json()) as { replayed: boolean }).replayed, true);
    const repurposed = await changes([{ type: "addStop", dayId: day1, content: { kind: "outside", title: "Different" } }], "m1", 2);
    assert.equal(repurposed.status, 400);
    assert.equal(((await (await app.get(`/api/trips/${created.id}`)).json()) as { trip: TripDocument }).trip.revision, 2);

    // Stale expected revision is a 409 conflict and writes nothing.
    const stale = await changes([{ type: "addStop", dayId: day1, content: { kind: "outside", title: "B" } }], "m2", 1);
    assert.equal(stale.status, 409);

    // Invalid operations are 400s.
    assert.equal((await changes([{ type: "bogus" }], "m3", 2)).status, 400);
    assert.equal((await changes([{ type: "addStop", dayId: "nope", content: { kind: "outside", title: "B" } }], "m3", 2)).status, 400);
    assert.equal((await changes([{ type: "moveStop", stopId: "missing" }], "m3", 2)).status, 400);
    assert.equal((await changes([], "m3", 2)).status, 400);
    assert.equal(
      (await app.post(`/api/trips/${created.id}/changes`, { expectedRevision: 2, clientMutationId: "m3", operations: [{ type: "moveStop", stopId: "x", atPosition: 0 }] })).status,
      400,
      "absolute indexes are module-internal",
    );
    assert.equal(((await (await app.get(`/api/trips/${created.id}`)).json()) as { trip: TripDocument }).trip.revision, 2, "rejections leave the document alone");

    // Missing trips are 404 for every route.
    assert.equal((await app.post("/api/trips/nope/changes", { expectedRevision: 1, clientMutationId: "m4", operations: addNishiki })).status, 404);
    assert.equal((await app.get("/api/trips/nope/history")).status, 404);
    assert.equal((await app.post("/api/trips/nope/undo", { expectedRevision: 2, clientMutationId: "u0" })).status, 404);

    const history = await app.get(`/api/trips/${created.id}/history`);
    assert.equal(history.status, 200);
    const historyBody = (await history.json()) as { changesets: { actor: string; instruction: string | null; kind: string }[]; canUndo: boolean; canRedo: boolean };
    assert.deepEqual(historyBody.changesets.map((row) => row.kind), ["change"]);
    assert.equal(historyBody.canUndo, true);
    assert.equal(historyBody.canRedo, false);

    const undone = await app.post(`/api/trips/${created.id}/undo`, { expectedRevision: 2, clientMutationId: "u1" });
    assert.equal(undone.status, 200);
    const undoneBody = (await undone.json()) as { trip: TripDocument; changeset: { kind: string; reversesId: string | null } };
    assert.equal(undoneBody.trip.revision, 3);
    assert.deepEqual(undoneBody.trip.days[0]!.stops, []);
    assert.equal(undoneBody.changeset.kind, "undo");
    assert.ok(undoneBody.changeset.reversesId);

    // Stale undo is a conflict too.
    assert.equal((await app.post(`/api/trips/${created.id}/undo`, { expectedRevision: 2, clientMutationId: "u2" })).status, 409);

    const redone = await app.post(`/api/trips/${created.id}/redo`, { expectedRevision: 3, clientMutationId: "r1" });
    assert.equal(redone.status, 200);
    const redoneBody = (await redone.json()) as { trip: TripDocument; changeset: { kind: string }; canRedo: boolean };
    assert.equal(redoneBody.trip.revision, 4);
    assert.equal(titleOf(redoneBody.trip.days[0]!.stops[0]!), "Nishiki Market");
    assert.equal(redoneBody.changeset.kind, "redo");
    assert.equal(redoneBody.canRedo, false);

    const finalHistory = await app.get(`/api/trips/${created.id}/history`);
    const finalBody = (await finalHistory.json()) as { changesets: { kind: string }[] };
    assert.deepEqual(finalBody.changesets.map((row) => row.kind), ["redo", "undo", "change"], "history is newest first");
  } finally {
    await app.close();
    database.close();
  }
});

test("trips HTTP: addStop state round-trips without trusting client actor", async () => {
  const database = mem();
  const app = await start(database);
  try {
    const created = ((await (await app.post("/api/trips", { destination: "Kyoto", durationDays: 2, clientMutationId: "create-state" })).json()) as { trip: TripDocument }).trip;
    const day1 = created.days[0]!.id;
    const draftOp = { type: "addStop", dayId: day1, content: { kind: "outside", title: "Maybe later" }, state: "draft" };

    const humanDraft = await app.post(`/api/trips/${created.id}/changes`, {
      expectedRevision: 1,
      clientMutationId: "d1",
      operations: [draftOp],
      actor: "agent",
    });
    assert.equal(humanDraft.status, 200);
    const humanBody = (await humanDraft.json()) as { trip: TripDocument; changeset: { actor: string } };
    const draftStop = humanBody.trip.days[0]!.stops[0]!;
    assert.equal(humanBody.changeset.actor, "user");
    assert.equal(draftStop.state, "draft");
    assert.deepEqual(draftStop.provenance, { actor: "user", via: "manual" });

    const agentForced = await app.post(`/api/trips/${created.id}/agent/changes`, {
      expectedRevision: 2,
      clientMutationId: "a1",
      operations: [{ type: "addStop", dayId: day1, content: { kind: "outside", title: "Agent cafe" }, state: "confirmed" }],
      actor: "user",
    });
    assert.equal(agentForced.status, 200);
    const agentBody = (await agentForced.json()) as { trip: TripDocument; changeset: { actor: string } };
    const agentStop = agentBody.trip.days[0]!.stops[1]!;
    assert.equal(agentBody.changeset.actor, "agent");
    assert.equal(agentStop.state, "draft", "agent route stays Draft even when Confirmed is requested");
    assert.deepEqual(agentStop.provenance, { actor: "agent", via: "agent" });

    const invalid = await app.post(`/api/trips/${created.id}/changes`, {
      expectedRevision: 3,
      clientMutationId: "bad",
      operations: [{ type: "addStop", dayId: day1, content: { kind: "outside", title: "Ghost" }, state: "published" }],
    });
    assert.equal(invalid.status, 400);
    const after = ((await (await app.get(`/api/trips/${created.id}`)).json()) as { trip: TripDocument }).trip;
    assert.equal(after.revision, 3, "invalid add state leaves the revision alone");
    assert.equal(after.days[0]!.stops.length, 2);
  } finally {
    await app.close();
    database.close();
  }
});

test("trips HTTP: source search is bounded and outside stops create no Library rows", async () => {
  const database = mem();
  database
    .prepare(
      `INSERT INTO items (id, content_type, title, body, url, author_handle, first_observed_at, media, created_at, updated_at)
       VALUES (?, 'post', ?, ?, ?, 'cook', ?, '[]', ?, ?)`,
    )
    .run("item-src", "Nishiki snack walk", "a long stored caption that must not be returned", "https://x.com/a/status/5", TS, TS, TS);
  createPlace(database, "local", { name: "Nishiki Market", kind: "landmark" });
  const app = await start(database);
  try {
    // Search is a read: reachable with a session, bounded fields only.
    const search = await app.get("/api/trips/sources?q=nishiki");
    assert.equal(search.status, 200);
    const body = (await search.json()) as { items: { id: string; title: string; source: string | null }[]; places: { id: string; name: string; kind: string }[] };
    assert.equal(body.items.length, 1);
    assert.deepEqual(Object.keys(body.items[0]!).sort(), ["id", "source", "title"]);
    assert.equal(body.items[0]!.title, "Nishiki snack walk");
    assert.equal(body.places.length, 1);
    assert.deepEqual(Object.keys(body.places[0]!).sort(), ["id", "kind", "name"]);
    assert.ok(!JSON.stringify(body).includes("long stored caption"), "captions never leave the Library projection");
    assert.equal(body.places[0]!.name, "Nishiki Market");

    // Unauthenticated search reads nothing.
    const anonymous = await fetch(`${app.base}/api/trips/sources?q=nishiki`);
    assert.equal(anonymous.status, 401);

    // Creating a trip and adding an outside stop creates no Library entities.
    const count = (table: string) => (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const before = { items: count("items"), places: count("atlas_places"), tags: count("tags"), collections: count("collections"), assignments: count("atlas_assignments") };
    const created = await app.post("/api/trips", { destination: "Kyoto", durationDays: 2, clientMutationId: "create-outside" });
    assert.equal(created.status, 200);
    const trip = ((await created.json()) as { trip: TripDocument }).trip;
    const added = await app.post(`/api/trips/${trip.id}/changes`, {
      expectedRevision: 1,
      clientMutationId: "outside-1",
      operations: [{ type: "addStop", dayId: trip.days[0]!.id, content: { kind: "outside", title: "Outside idea", notes: null, url: "https://example.com/note" } }],
    });
    assert.equal(added.status, 200);
    const after = { items: count("items"), places: count("atlas_places"), tags: count("tags"), collections: count("collections"), assignments: count("atlas_assignments") };
    assert.deepEqual(after, before, "outside content stays trip-owned");

    // The resolved stop list keeps the outside content distinct from references.
    const got = await app.get(`/api/trips/${trip.id}`);
    const doc = ((await got.json()) as { trip: TripDocument }).trip;
    assert.deepEqual(doc.days[0]!.stops[0]!.content, { kind: "outside", title: "Outside idea", notes: null, url: "https://example.com/note" });
    assert.equal(doc.days[0]!.stops[0]!.broken, false);
  } finally {
    await app.close();
    database.close();
  }
});

test("trips HTTP: agent review records advisories and the human dismisses them", async () => {
  const database = mem();
  const app = await start(database);
  try {
    const create = await app.post("/api/trips", { destination: "Kyoto", startDate: "2026-10-12", endDate: "2026-10-13", clientMutationId: "create-review" });
    const trip = ((await create.json()) as { trip: TripDocument }).trip;
    const dayId = trip.days[1]!.id;
    const flags = [{ category: "strain", severity: "concern", opinion: "Tuesday feels tight", rationale: "Two timed stops back to back", dayRefs: [dayId], stopRefs: [] }];

    // CSRF applies to the agent route like every mutating route.
    const noCsrf = await fetch(`${app.base}/api/trips/${trip.id}/agent/review`, {
      method: "POST",
      headers: { cookie: app.headers.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: trip.revision, clientMutationId: "rev-1", flags }),
    });
    assert.equal(noCsrf.status, 403);

    const unarmed = await app.post(`/api/trips/${trip.id}/agent/review`, {
      expectedRevision: trip.revision,
      clientMutationId: "rev-0",
      flags,
    });
    assert.equal(unarmed.status, 403, "review without Ask agent to review stores nothing");

    assert.equal((await app.post(`/api/trips/${trip.id}/review-intent`, {})).status, 200);
    const review = await app.post(`/api/trips/${trip.id}/agent/review`, {
      expectedRevision: trip.revision,
      clientMutationId: "rev-1",
      flags,
      // Trusted fields from the body are ignored, never stored.
      libraryId: "hosted-b",
      actor: "user",
    });
    assert.equal(review.status, 200);
    const reviewed = (await review.json()) as { trip: TripDocument; replayed: boolean };
    assert.equal(reviewed.replayed, false);
    assert.equal(reviewed.trip.advisories.length, 1);
    assert.equal(reviewed.trip.advisories[0]!.actor, "agent", "actor is derived from the trusted adapter route");
    assert.equal(reviewed.trip.advisories[0]!.reviewedRevision, trip.revision);

    // A second use of the consumed intent is forbidden, never a replay.
    const retry = await app.post(`/api/trips/${trip.id}/agent/review`, {
      expectedRevision: trip.revision,
      clientMutationId: "rev-1",
      flags,
    });
    assert.equal(retry.status, 403, "the first successful review consumed the intent");

    // Re-arm: the intent binds the revision at arm time, so a stale body conflicts.
    assert.equal((await app.post(`/api/trips/${trip.id}/review-intent`, {})).status, 200);
    const stale = await app.post(`/api/trips/${trip.id}/agent/review`, {
      expectedRevision: 99,
      clientMutationId: "rev-2",
      flags,
    });
    assert.equal(stale.status, 409);

    // Re-arm again: a rejected payload keeps the intent, so this is not a reuse error.
    assert.equal((await app.post(`/api/trips/${trip.id}/review-intent`, {})).status, 200);
    const smuggled = await app.post(`/api/trips/${trip.id}/agent/review`, {
      expectedRevision: trip.revision,
      clientMutationId: "rev-3",
      flags: [{ ...flags[0], coordinates: { lat: 35, lng: 135 } }],
    });
    assert.equal(smuggled.status, 400);

    const missing = await app.post("/api/trips/nope/agent/review", {
      expectedRevision: 1,
      clientMutationId: "rev-4",
      flags,
    });
    assert.equal(missing.status, 404);

    const advisoryId = reviewed.trip.advisories[0]!.id;
    const dismissed = await app.post(`/api/trips/${trip.id}/advisories/${advisoryId}/dismiss`, { expectedRevision: trip.revision, clientMutationId: "dis-1" });
    assert.equal(dismissed.status, 200);
    assert.equal(((await dismissed.json()) as { trip: TripDocument }).trip.advisories.length, 0);
    const again = await app.post(`/api/trips/${trip.id}/advisories/${advisoryId}/dismiss`, { expectedRevision: trip.revision, clientMutationId: "dis-1" });
    assert.equal(again.status, 200, "dismissal is idempotent");
    const unknownAdvisory = await app.post(`/api/trips/${trip.id}/advisories/missing/dismiss`, { expectedRevision: trip.revision, clientMutationId: "dis-x" });
    assert.equal(unknownAdvisory.status, 400);

    // The dismissed advisory stays exposed through the authorized history read
    // while the active document no longer lists it.
    const historyAfterDismiss = await app.get(`/api/trips/${trip.id}/history`);
    assert.equal(historyAfterDismiss.status, 200);
    const historyBody = (await historyAfterDismiss.json()) as { dismissedAdvisories: { id: string; opinion: string; reviewedRevision: number; dismissedAt: string | null }[] };
    const record = historyBody.dismissedAdvisories.find((row) => row.id === advisoryId);
    assert.ok(record, "the dismissed advisory is exposed through the history read");
    assert.equal(record!.opinion, "Tuesday feels tight");
    assert.equal(record!.reviewedRevision, trip.revision);
    assert.ok(record!.dismissedAt, "the dismissal time is exposed");
    assert.equal(((await (await app.get(`/api/trips/${trip.id}`)).json()) as { trip: TripDocument }).trip.advisories.length, 0, "the active list stays empty");
  } finally {
    await app.close();
    database.close();
  }
});

test("trips HTTP: two cookie jars get distinct identities and review intents stay session-bound", async () => {
  const database = mem();
  const app = await start(database);
  try {
    const other = await secondJar(app.base);

    // Distinct valid identities: each jar carries a unique signed session id.
    assert.notEqual(sessionIdOf(other.headers.cookie), sessionIdOf(app.headers.cookie));
    assert.equal((await app.get("/api/trips")).status, 200);
    assert.equal((await other.get("/api/trips")).status, 200);

    const create = await app.post("/api/trips", { destination: "Kyoto", startDate: "2026-10-12", endDate: "2026-10-13", clientMutationId: "two-jars" });
    const trip = ((await create.json()) as { trip: TripDocument }).trip;
    const flags = [{ category: "strain", severity: "concern", opinion: "Tuesday feels tight", rationale: "Two timed stops back to back", dayRefs: [trip.days[1]!.id], stopRefs: [] }];

    // The owner arms and consumes its own intent.
    assert.equal((await app.post(`/api/trips/${trip.id}/review-intent`, {})).status, 200);
    assert.equal((await app.post(`/api/trips/${trip.id}/agent/review`, { expectedRevision: trip.revision, clientMutationId: "a-1", flags })).status, 200);

    // Another valid session cannot consume that intent.
    assert.equal((await app.post(`/api/trips/${trip.id}/review-intent`, {})).status, 200);
    const stranger = await other.post(`/api/trips/${trip.id}/agent/review`, { expectedRevision: trip.revision, clientMutationId: "b-1", flags });
    assert.equal(stranger.status, 403);

    // The rejection consumed nothing: the owner can still review.
    const owner = await app.post(`/api/trips/${trip.id}/agent/review`, { expectedRevision: trip.revision, clientMutationId: "a-2", flags });
    assert.equal(owner.status, 200);

    // Tampered and malformed cookies fail authentication (401).
    const [id, sig] = app.headers.cookie.slice("locus_session=".length).split(".");
    const flipped = (parseInt(sig![0]!, 16) ^ 1).toString(16) + sig!.slice(1);
    const install = loadInstall();
    const desk = `desk.${sign(install.sessionSecret, "desk")}`;
    for (const value of [`${id}.${flipped}`, `${id}.${sig}.x`, "no-dot", ".nosig", `.${sig}`, desk]) {
      const bad = await fetch(`${app.base}/api/trips`, { headers: { cookie: `locus_session=${value}` } });
      assert.equal(bad.status, 401, `cookie ${value}`);
    }
  } finally {
    await app.close();
    database.close();
  }
});

test("trips HTTP: create requires a mutation id and exact retries do not duplicate", async () => {
  const database = mem();
  const app = await start(database);
  try {
    const missingId = await app.post("/api/trips", { destination: "Kyoto", durationDays: 2 });
    assert.equal(missingId.status, 400);

    const body = { destination: "Kyoto", durationDays: 2, clientMutationId: "create-replay" };
    const first = await app.post("/api/trips", body);
    assert.equal(first.status, 200);
    const created = ((await first.json()) as { trip: TripDocument }).trip;

    const retry = await app.post("/api/trips", body);
    assert.equal(retry.status, 200);
    assert.equal(((await retry.json()) as { trip: TripDocument }).trip.id, created.id);

    const conflict = await app.post("/api/trips", { ...body, destination: "Osaka" });
    assert.equal(conflict.status, 400);

    const list = await app.get("/api/trips");
    assert.equal(((await list.json()) as { trips: TripSummary[] }).trips.length, 1);
  } finally {
    await app.close();
    database.close();
  }
});
