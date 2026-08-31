import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { applyTripChanges, createTrip } from "../server/trips/module.ts";

process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_PORT = "8806";
const { listen } = await import("../server/http/server.ts");

const TS = "2026-09-01T09:00:00.000Z";

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-trips-share-http-")), "t.db"));
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

test("share HTTP: preview writes nothing, publish/update/revoke, public page needs no session", async () => {
  const database = mem();
  const app = await start(database);
  try {
    const trip = createTrip(database, "local", { destination: "Kyoto, Japan", durationDays: 2 }, TS);
    applyTripChanges(
      database,
      "local",
      trip.id,
      { expectedRevision: 1, clientMutationId: "m1", operations: [{ type: "addStop", dayId: trip.days[0]!.id, content: { kind: "outside", title: "Fushimi Inari", notes: null, url: null }, publicNotes: "Go at sunrise", privateNotes: "PRIVATE STAYS PRIVATE" }] },
      "user",
      TS,
    );

    // Unauthenticated callers can neither publish nor read the share state.
    const anonymous = await fetch(`${app.base}/api/trips/${trip.id}/share`);
    assert.equal(anonymous.status, 401);
    const anonymousPublish = await fetch(`${app.base}/api/trips/${trip.id}/share/publish`, { method: "POST", body: "{}" });
    assert.equal(anonymousPublish.status, 401);

    // CSRF is enforced on the mutating share routes like everywhere else.
    const noCsrf = await fetch(`${app.base}/api/trips/${trip.id}/share/publish`, {
      method: "POST",
      headers: { cookie: app.headers.cookie, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(noCsrf.status, 403);

    // Preview shows the exact snapshot without creating any public payload.
    const preview = await app.post(`/api/trips/${trip.id}/share/preview`, {});
    assert.equal(preview.status, 200);
    const previewBody = (await preview.json()) as { snapshot: { title: string; days: { stops: { name: string }[] }[] }; digest: string; revision: number; shared: null };
    assert.equal(previewBody.snapshot.title, "Kyoto, Japan");
    assert.equal(previewBody.snapshot.days[0]!.stops[0]!.name, "Fushimi Inari");
    assert.equal(previewBody.shared, null);
    assert.equal(previewBody.revision, 2);
    assert.match(previewBody.digest, /^[0-9a-f]{64}$/);
    const beforePublish = await fetch(`${app.base}/s/guessing-a-token`);
    assert.equal(beforePublish.status, 404);

    // Publish mints the capability link. The trip is at revision 2 after m1.
    const publish = await app.post(`/api/trips/${trip.id}/share/publish`, { expectedRevision: 2, clientMutationId: "pub-1", digest: previewBody.digest });
    assert.equal(publish.status, 200);
    const { token } = (await publish.json()) as { token: string };
    assert.ok(token.length >= 43);

    // The public page needs no cookie and carries no private text.
    const pub = await fetch(`${app.base}/s/${token}`);
    assert.equal(pub.status, 200);
    const html = await pub.text();
    assert.match(html, /Fushimi Inari/);
    assert.match(html, /Last updated/);
    assert.match(html, /Go at sunrise/);
    assert.ok(!html.includes("PRIVATE STAYS PRIVATE"));
    assert.ok(!html.includes("<script"));
    assert.equal((await fetch(`${app.base}/s/${token}x`)).status, 404);

    // Share state is readable by the owner.
    const state = await app.get(`/api/trips/${trip.id}/share`);
    assert.equal(((await state.json()) as { shared: { revision: number } }).shared.revision, 2);

    // A private edit stays private until an explicit publish; republish
    // replaces the token.
    applyTripChanges(
      database,
      "local",
      trip.id,
      { expectedRevision: 2, clientMutationId: "m2", operations: [{ type: "addStop", dayId: trip.days[1]!.id, content: { kind: "outside", title: "Day 2 stop", notes: null, url: null } }] },
      "user",
      TS,
    );
    const stale = await fetch(`${app.base}/s/${token}`);
    assert.ok(!(await stale.text()).includes("Day 2 stop"));

    const stalePreview = await app.post(`/api/trips/${trip.id}/share/publish`, {
      expectedRevision: 3,
      clientMutationId: "pub-stale",
      digest: previewBody.digest,
    });
    assert.equal(stalePreview.status, 409, "an edit after preview cannot publish the unapproved snapshot");

    const nextPreview = (await (await app.post(`/api/trips/${trip.id}/share/preview`, {})).json()) as { digest: string };
    const republish = await app.post(`/api/trips/${trip.id}/share/publish`, { expectedRevision: 3, clientMutationId: "pub-2", digest: nextPreview.digest });
    const { token: token2 } = (await republish.json()) as { token: string };
    assert.notEqual(token2, token);
    const refreshed = await fetch(`${app.base}/s/${token2}`);
    assert.match(await refreshed.text(), /Day 2 stop/);
    assert.equal((await fetch(`${app.base}/s/${token}`)).status, 404, "old token is dead after republish");

    // Revoke kills the current link.
    const revoke = await app.post(`/api/trips/${trip.id}/share/revoke`, { expectedRevision: 3, clientMutationId: "rev-1" });
    assert.equal(((await revoke.json()) as { revoked: boolean }).revoked, true);
    assert.equal((await fetch(`${app.base}/s/${token2}`)).status, 404);
    const stateAfter = await app.get(`/api/trips/${trip.id}/share`);
    assert.equal(((await stateAfter.json()) as { shared: unknown }).shared, null);

    // Unknown trips are 404 on every share route.
    assert.equal((await app.post(`/api/trips/missing/share/preview`, {})).status, 404);
    assert.equal((await app.post(`/api/trips/missing/share/publish`, { expectedRevision: 1, clientMutationId: "pub-x" })).status, 404);
    assert.equal((await app.get(`/api/trips/missing/share`)).status, 404);
    assert.equal((await app.post(`/api/trips/missing/share/revoke`, { expectedRevision: 1, clientMutationId: "rev-x" })).status, 404);
  } finally {
    await app.close();
    database.close();
  }
});
