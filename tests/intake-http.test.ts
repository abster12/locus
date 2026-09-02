import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { createCollection } from "../core/commands.ts";
import { listItems } from "../core/library.ts";

process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_PORT = "8848";
const { listen } = await import("../server/http/server.ts");

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-intake-http-")), "t.db"));
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
    cookie,
    headers,
    close: () => app.close(),
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

test("POST /api/intake saves a user Item and rejects CSRF, session, and impersonation", async () => {
  const database = mem();
  const app = await start(database);
  try {
    const ok = await app.post("/api/intake", {
      url: "https://example.com/essay",
      title: "Essay",
      body: "First paragraph",
      authorName: "Ada",
      publishedAt: "2026-01-02",
      media: [{ url: "https://example.com/pic.jpg" }],
    });
    assert.equal(ok.status, 200);
    const saved = (await ok.json()) as { outcome: string; item: { url: string; title: string; intakeActor: string; status: string; source: string | null } };
    assert.equal(saved.outcome, "created");
    assert.equal(saved.item.url, "https://example.com/essay");
    assert.equal(saved.item.title, "Essay");
    assert.equal(saved.item.status, "inbox");
    assert.equal(saved.item.source, null);
    assert.equal(saved.item.intakeActor, "user");

    const omitted = await app.post("/api/intake", { url: "https://example.com/today" });
    assert.equal(omitted.status, 200);
    const today = (await omitted.json()) as { item: { publishedAt: string | null } };
    assert.ok(today.item.publishedAt);

    const yours = await fetch(`${app.base}/api/items?source=you`, { headers: app.headers });
    assert.equal(yours.status, 200);
    const page = (await yours.json()) as { items: { url: string }[] };
    assert.deepEqual(page.items.map((item) => item.url).sort(), ["https://example.com/essay", "https://example.com/today"]);

    const csrf = await fetch(`${app.base}/api/intake`, {
      method: "POST",
      headers: { cookie: app.cookie, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/csrf" }),
    });
    assert.equal(csrf.status, 403);
    assert.match(await csrf.text(), /csrf/);

    const anon = await fetch(`${app.base}/api/intake`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "nope" },
      body: JSON.stringify({ url: "https://example.com/anon" }),
    });
    assert.equal(anon.status, 401);

    const impersonate = await app.post("/api/intake", {
      url: "https://example.com/agent",
      actor: "agent",
      libraryId: "other",
    });
    assert.equal(impersonate.status, 400);
    assert.match(await impersonate.text(), /unsupported field/);

    assert.equal(listItems(database).length, 2);
  } finally {
    await app.close();
    database.close();
  }
});

test("POST /api/intake preview and commit organize without partial writes", async () => {
  const database = mem();
  const collection = createCollection(database, "Research", "Deep reading");
  database.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-food', 'food', NULL)`).run();
  const app = await start(database);
  try {
    const preview = await app.post("/api/intake/preview", {
      url: "https://example.com/essay",
      title: "Essay",
      collectionIds: [collection.id],
      tagIds: ["tag-food"],
      newTags: ["Local First"],
    });
    assert.equal(preview.status, 200);
    const shown = (await preview.json()) as {
      item: { url: string; title: string | null; publishedAt: string | null };
      missing: string[];
      collections: { name: string }[];
      tags: { id: string | null; name: string }[];
    };
    assert.equal(shown.item.url, "https://example.com/essay");
    assert.equal(shown.item.title, "Essay");
    assert.ok(shown.item.publishedAt);
    assert.deepEqual(shown.missing, ["source text", "author", "media"]);
    assert.deepEqual(shown.collections.map((entry) => entry.name), ["Research"]);
    assert.deepEqual(shown.tags.map((entry) => entry.name), ["food", "Local First"]);
    assert.equal(listItems(database).length, 0);

    const saved = await app.post("/api/intake", {
      url: "https://example.com/essay",
      title: "Essay",
      collectionIds: [collection.id],
      tagIds: ["tag-food"],
      newTags: ["Local First"],
    });
    assert.equal(saved.status, 200);
    const body = (await saved.json()) as {
      item: { id: string; tags: { name: string }[]; collections: { name: string }[]; status: string };
    };
    assert.equal(body.item.status, "inbox");
    assert.deepEqual(body.item.collections.map((entry) => entry.name), ["Research"]);
    assert.deepEqual(body.item.tags.map((entry) => entry.name).sort(), ["Local First", "food"]);

    const inCollection = await fetch(`${app.base}/api/items?collectionId=${collection.id}`, { headers: app.headers });
    assert.equal(((await inCollection.json()) as { items: { id: string }[] }).items.map((item) => item.id).join(), body.item.id);
    const tagged = await fetch(`${app.base}/api/items?q=Local%20First`, { headers: app.headers });
    assert.equal(((await tagged.json()) as { items: { id: string }[] }).items.map((item) => item.id).join(), body.item.id);

    const rejected = await app.post("/api/intake", {
      url: "https://example.com/nope",
      tagIds: ["missing"],
    });
    assert.equal(rejected.status, 400);
    assert.match(await rejected.text(), /unknown tag/);
    assert.equal(listItems(database).length, 1);
  } finally {
    await app.close();
    database.close();
  }
});

test("intake context, search, and draft prepare stay read-only and session-bound", async () => {
  const database = mem();
  const collection = createCollection(database, "Research", "Deep reading");
  database.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-tech', 'tech', '#333')`).run();
  const app = await start(database);
  try {
    const saved = await app.post("/api/intake", {
      url: "https://example.com/essay",
      title: "Local-first software",
      body: "SECRET-BODY",
    });
    assert.equal(saved.status, 200);

    const contextRes = await fetch(`${app.base}/api/intake/context`, { headers: app.headers });
    assert.equal(contextRes.status, 200);
    const context = (await contextRes.json()) as {
      version: string;
      collections: { name: string }[];
      tags: { name: string; color: string | null }[];
    };
    assert.equal(context.version.length, 64);
    assert.equal(context.collections[0]?.name, "Research");
    assert.equal(context.tags.find((tag) => tag.name === "tech")?.color, "#333");
    assert.equal(JSON.stringify(context).includes("SECRET-BODY"), false);

    const searchRes = await fetch(`${app.base}/api/intake/search?q=local-first`, { headers: app.headers });
    assert.equal(searchRes.status, 200);
    const search = (await searchRes.json()) as { items: { title: string; url: string }[] };
    assert.equal(search.items.length, 1);
    assert.equal(search.items[0]?.title, "Local-first software");
    assert.equal(JSON.stringify(search).includes("SECRET-BODY"), false);

    const anon = await fetch(`${app.base}/api/intake/context`);
    assert.equal(anon.status, 401);

    const prepared = await app.post("/api/intake/drafts/prepare", {
      drafts: [{
        url: "https://example.com/new",
        title: "Draft",
        collectionIds: [collection.id],
        tagIds: ["tag-tech"],
        proposedNewTags: ["Local First"],
        rationale: "Fits research",
        evidenceBasis: "title",
      }],
    });
    assert.equal(prepared.status, 200);
    const body = (await prepared.json()) as {
      drafts: { item: { url: string; publishedAt: string | null }; tags: { proposed: boolean }[] }[];
      context: { version: string };
    };
    assert.equal(body.drafts.length, 1);
    assert.equal(body.context.version, context.version);
    assert.equal(body.drafts[0]?.item.url, "https://example.com/new");
    assert.equal(body.drafts[0]?.item.publishedAt, null);
    assert.equal(body.drafts[0]?.tags.some((tag) => tag.proposed), true);
    assert.equal(listItems(database).length, 1);
    assert.equal((database.prepare(`SELECT COUNT(*) AS n FROM tags`).get() as { n: number }).n, 1);

    const csrf = await fetch(`${app.base}/api/intake/drafts/prepare`, {
      method: "POST",
      headers: { cookie: app.cookie, "content-type": "application/json" },
      body: JSON.stringify({ drafts: [{ url: "https://example.com/x" }] }),
    });
    assert.equal(csrf.status, 403);
  } finally {
    await app.close();
    database.close();
  }
});

test("POST /api/intake/batch creates agent Items and rejects impersonation", async () => {
  const database = mem();
  const collection = createCollection(database, "Research");
  database.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-tech', 'tech', '#333')`).run();
  const app = await start(database);
  try {
    const contextRes = await fetch(`${app.base}/api/intake/context`, { headers: app.headers });
    const context = (await contextRes.json()) as { version: string };
    const body = {
      clientMutationId: "http-1",
      instruction: "save this to Research",
      contextVersion: context.version,
      drafts: [{
        url: "https://example.com/agent-essay",
        title: "Agent essay",
        observedFields: ["title"],
        collectionIds: [collection.id],
        tagIds: ["tag-tech"],
        classifications: [{
          tagId: "tag-tech",
          rationale: "User asked to save it as tech",
          evidence: [{ field: "instruction", text: "save this to Research" }],
        }],
      }],
    };
    const created = await app.post("/api/intake/batch", body);
    assert.equal(created.status, 200);
    const result = (await created.json()) as {
      actor: string;
      drafts: { outcome: string; item: { id: string; url: string; intakeActor: string; publishedAt: string | null } }[];
    };
    assert.equal(result.actor, "agent");
    assert.equal(result.drafts[0]?.outcome, "created");
    assert.equal(result.drafts[0]?.item.url, "https://example.com/agent-essay");
    assert.equal(result.drafts[0]?.item.intakeActor, "agent");
    assert.equal(result.drafts[0]?.item.publishedAt, null);
    const detail = await fetch(`${app.base}/api/items/${result.drafts[0]!.item.id}`, { headers: app.headers });
    assert.equal(detail.status, 200);
    const shown = (await detail.json()) as {
      item: { classifications: { tagId: string; rationale: string; evidence: { field: string; text: string }[] }[] };
    };
    assert.deepEqual(shown.item.classifications, [{
      tagId: "tag-tech",
      rationale: "User asked to save it as tech",
      evidence: [{ field: "instruction", text: "save this to Research" }],
    }]);

    const replay = await app.post("/api/intake/batch", body);
    assert.equal(replay.status, 200);
    assert.equal(listItems(database).length, 1);

    const stale = await app.post("/api/intake/batch", {
      ...body,
      clientMutationId: "http-2",
      contextVersion: "deadbeef",
    });
    assert.equal(stale.status, 400);
    assert.match(await stale.text(), /stale context/);

    const impersonate = await app.post("/api/intake/batch", {
      ...body,
      clientMutationId: "http-3",
      actor: "user",
      libraryId: "other",
    });
    assert.equal(impersonate.status, 400);
    assert.match(await impersonate.text(), /unsupported field/);

    const csrf = await fetch(`${app.base}/api/intake/batch`, {
      method: "POST",
      headers: { cookie: app.cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(csrf.status, 403);
    assert.equal(listItems(database).length, 1);
  } finally {
    await app.close();
    database.close();
  }
});

test("POST /api/intake/drafts/save is a reviewed agent batch and tags are created separately", async () => {
  const database = mem();
  const collection = createCollection(database, "Research");
  database.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-tech', 'tech', '#333')`).run();
  const app = await start(database);
  try {
    const tagRes = await app.post("/api/intake/tags", { name: "Local First" });
    assert.equal(tagRes.status, 200);
    const tagBody = (await tagRes.json()) as { tag: { id: string; name: string }; context: { version: string } };
    assert.equal(tagBody.tag.name, "Local First");
    const saved = await app.post("/api/intake/drafts/save", {
      clientMutationId: "sheet-1",
      contextVersion: tagBody.context.version,
      drafts: [{
        url: "https://example.com/reviewed",
        title: "Reviewed essay",
        tagIds: ["tag-tech", tagBody.tag.id],
        collectionIds: [collection.id],
      }],
    });
    assert.equal(saved.status, 200);
    const result = (await saved.json()) as {
      actor: string;
      drafts: { outcome: string; item: { url: string; intakeActor: string } }[];
    };
    assert.equal(result.actor, "agent");
    assert.equal(result.drafts[0]?.outcome, "created");
    assert.equal(result.drafts[0]?.item.intakeActor, "agent");
    assert.equal(result.drafts[0]?.item.url, "https://example.com/reviewed");

    const impersonate = await app.post("/api/intake/drafts/save", {
      clientMutationId: "sheet-2",
      contextVersion: tagBody.context.version,
      reviewed: true,
      actor: "user",
      drafts: [{ url: "https://example.com/nope" }],
    });
    assert.equal(impersonate.status, 400);
    assert.match(await impersonate.text(), /unsupported field/);

    const stale = await app.post("/api/intake/drafts/save", {
      clientMutationId: "sheet-3",
      contextVersion: "deadbeef",
      drafts: [{ url: "https://example.com/stale" }],
    });
    assert.equal(stale.status, 400);
    assert.match(await stale.text(), /stale context/);
    assert.equal(listItems(database).length, 1);

    const csrf = await fetch(`${app.base}/api/intake/drafts/save`, {
      method: "POST",
      headers: { cookie: app.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        clientMutationId: "sheet-4",
        contextVersion: tagBody.context.version,
        drafts: [{ url: "https://example.com/csrf" }],
      }),
    });
    assert.equal(csrf.status, 403);
  } finally {
    await app.close();
    database.close();
  }
});
