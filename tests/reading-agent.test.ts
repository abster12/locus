import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { MissingResource } from "../core/commands.ts";
import { RejectedPayload } from "../core/sanitize.ts";
import {
  AGENT_READING_LIST_LIMIT,
  AGENT_READING_TEXT_LIMIT,
  LOCAL_LIBRARY_ID,
  getAgentReadingDocument,
  getReadingDocument,
  importReadingRecords,
  listReadingDocuments,
  listReadingDocumentsForAgent,
  reconcileItem,
  removeReadingDocument,
  updateReadingProgress,
} from "../server/reading/module.ts";

process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_PORT = "8801";
process.env.LOCUS_READING_WORKER = "0";

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-reading-agent-")), "t.db"));
}

function nowAt(i: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
}

function paragraph(id: string, text: string) {
  return { id, type: "paragraph" as const, inlines: [{ text, marks: [] as [] }] };
}

function seedDoc(
  db: ReturnType<typeof mem>,
  opts: {
    id: string;
    availability?: string;
    kind?: string;
    title?: string;
    publication?: string;
    excerpt?: string;
    searchText?: string;
    readingMinutes?: number | null;
    originalStatus?: string;
    failureCode?: string | null;
    canonicalUrl?: string;
    content?: string | null;
    libraryId?: string;
    lastSavedAt?: string;
    removedAt?: string;
  },
): void {
  const saved = opts.lastSavedAt ?? nowAt(0);
  const contentBlocks = opts.content
    ? { version: 1, blocks: [paragraph(`${opts.id}-p`, opts.content)] }
    : null;
  importReadingRecords(
    db,
    {
      documents: [
        {
          kind: "readingDocument",
          id: opts.id,
          canonicalUrl: opts.canonicalUrl ?? `https://example.com/p/${opts.id}`,
          observedUrl: opts.canonicalUrl ?? `https://example.com/p/${opts.id}`,
          kindName: opts.kind ?? "article",
          availability: opts.availability ?? "ready",
          originalStatus: opts.originalStatus ?? "unknown",
          failureCode: opts.failureCode ?? null,
          title: opts.title ?? `Title ${opts.id}`,
          publication: opts.publication ?? "Pub",
          excerpt: opts.excerpt ?? null,
          searchText: opts.searchText ?? opts.content ?? null,
          readingMinutes: opts.readingMinutes ?? 5,
          contentBlocks,
          lastSavedAt: saved,
          createdAt: saved,
          updatedAt: saved,
          removedAt: opts.removedAt,
        },
      ],
      provenance: [],
      progress: [],
      itemIds: new Set(),
    },
    opts.libraryId ?? LOCAL_LIBRARY_ID,
  );
}

function insertItem(
  db: ReturnType<typeof mem>,
  id: string,
  permalink: string,
  body: string,
  source = "x",
): void {
  const now = "2026-08-27T00:00:00.000Z";
  db.prepare(
    `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
     VALUES (?, 'post', ?, ?, ?, ?, '[]', ?, ?)`,
  ).run(id, `Item ${id}`, body, permalink, now, now, now);
  db.prepare(
    `INSERT INTO source_accounts (id, source, external_id, display_name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`acct-${id}`, source, id, id, now);
  db.prepare(
    `INSERT INTO source_records (id, source_account_id, external_id, item_id, first_observed_at, last_observed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`rec-${id}`, `acct-${id}`, id, id, now, now);
}

test("agent list includes every non-removed availability and kind the visual queue hides", () => {
  const db = mem();
  seedDoc(db, { id: "ready", availability: "ready" });
  seedDoc(db, { id: "pending", availability: "pending" });
  seedDoc(db, { id: "meta", availability: "metadata_only" });
  seedDoc(db, { id: "blocked", availability: "blocked" });
  seedDoc(db, { id: "unsupported", availability: "unsupported" });
  seedDoc(db, { id: "error", availability: "error" });
  seedDoc(db, { id: "unknown", kind: "unknown", availability: "ready" });
  seedDoc(db, { id: "pdf", kind: "pdf", availability: "metadata_only" });
  seedDoc(db, { id: "gone", removedAt: nowAt(9) });
  insertItem(db, "candidate-only", "https://x.com/a/status/1", "no outbound article here");

  const visual = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue", limit: 100 });
  assert.deepEqual(visual.unread.items.map((row) => row.id).sort(), ["ready"]);
  assert.equal(visual.preparing.count, 1);

  const agent = listReadingDocumentsForAgent(db, LOCAL_LIBRARY_ID, { view: "queue", limit: 50 });
  assert.deepEqual(
    agent.items.map((row) => row.id).sort(),
    ["blocked", "error", "meta", "pdf", "pending", "ready", "unknown", "unsupported"],
  );
  assert.equal(agent.items.some((row) => row.id === "gone"), false);
  assert.equal(agent.items.length, 8);
  assert.ok(agent.items.every((row) => !("contentBlocks" in row) && !("heroAssetId" in row) && !("text" in row)));
  db.close();
});

test("agent list paginates at 50, forwards cursors, and rejects a 51 limit", () => {
  const db = mem();
  for (let i = 0; i < 60; i += 1) {
    seedDoc(db, { id: `doc-${String(i).padStart(4, "0")}`, lastSavedAt: nowAt(i) });
  }
  const first = listReadingDocumentsForAgent(db, LOCAL_LIBRARY_ID, {});
  assert.equal(first.items.length, AGENT_READING_LIST_LIMIT);
  assert.ok(first.nextCursor);
  const second = listReadingDocumentsForAgent(db, LOCAL_LIBRARY_ID, { cursor: first.nextCursor! });
  assert.equal(second.items.length, 10);
  assert.equal(second.nextCursor, null);
  const ids = [...first.items, ...second.items].map((row) => row.id);
  assert.equal(ids.length, 60);
  assert.equal(new Set(ids).size, 60);
  assert.throws(() => listReadingDocumentsForAgent(db, LOCAL_LIBRARY_ID, { limit: 51 }), RejectedPayload);
  assert.throws(() => listReadingDocumentsForAgent(db, LOCAL_LIBRARY_ID, { limit: 0 }), RejectedPayload);
  db.close();
});

test("agent list rejects malformed filters instead of falling back", () => {
  const db = mem();
  seedDoc(db, { id: "ready" });
  assert.throws(
    () => listReadingDocumentsForAgent(db, LOCAL_LIBRARY_ID, { view: "all" as never }),
    RejectedPayload,
  );
  assert.throws(
    () => listReadingDocumentsForAgent(db, LOCAL_LIBRARY_ID, { sort: "mood" as never }),
    RejectedPayload,
  );
  assert.throws(() => listReadingDocumentsForAgent(db, LOCAL_LIBRARY_ID, { kind: "essay" }), RejectedPayload);
  assert.throws(() => listReadingDocumentsForAgent(db, LOCAL_LIBRARY_ID, { source: "??" }), RejectedPayload);
  assert.throws(
    () => listReadingDocumentsForAgent(db, LOCAL_LIBRARY_ID, { q: "x".repeat(201) }),
    RejectedPayload,
  );
  assert.throws(
    () => listReadingDocumentsForAgent(db, LOCAL_LIBRARY_ID, { cursor: "not-a-cursor" }),
    RejectedPayload,
  );
  const ok = listReadingDocumentsForAgent(db, LOCAL_LIBRARY_ID, { view: "queue", sort: "recent", kind: "article" });
  assert.equal(ok.items[0]?.id, "ready");
  db.close();
});

test("agent list honors unread vs finished, kind, source, and search without changing progress", () => {
  const db = mem();
  seedDoc(db, {
    id: "essay",
    title: "Thoughtful essay",
    content: "stored thoughtful body",
    searchText: "stored thoughtful body",
  });
  seedDoc(db, { id: "done", title: "Finished piece" });
  seedDoc(db, { id: "pdf", kind: "pdf", availability: "metadata_only", title: "A PDF" });
  updateReadingProgress(db, LOCAL_LIBRARY_ID, "done", { op: "finished" });
  insertItem(db, "item-s", "https://x.com/a/status/1", "https://example.com/p/essay extra-token", "reddit");
  reconcileItem(db, LOCAL_LIBRARY_ID, "item-s");

  const unread = listReadingDocumentsForAgent(db, LOCAL_LIBRARY_ID, { view: "queue" });
  assert.deepEqual(unread.items.map((row) => row.id).sort(), ["essay", "pdf"]);
  const finished = listReadingDocumentsForAgent(db, LOCAL_LIBRARY_ID, { view: "finished" });
  assert.deepEqual(finished.items.map((row) => row.id), ["done"]);
  const pdfs = listReadingDocumentsForAgent(db, LOCAL_LIBRARY_ID, { kind: "pdf" });
  assert.deepEqual(pdfs.items.map((row) => row.id), ["pdf"]);
  const reddit = listReadingDocumentsForAgent(db, LOCAL_LIBRARY_ID, { source: "reddit" });
  assert.ok(reddit.items.some((row) => row.id === "essay"));
  const found = listReadingDocumentsForAgent(db, LOCAL_LIBRARY_ID, { q: "thoughtful" });
  assert.ok(found.items.some((row) => row.id === "essay"));
  assert.equal(updateReadingProgress(db, LOCAL_LIBRARY_ID, "done", { op: "finished" })?.state, "finished");
  db.close();
});

test("agent list stays inside the requested Library", () => {
  const db = mem();
  seedDoc(db, { id: "mine" });
  seedDoc(db, { id: "theirs", libraryId: "other" });
  const mine = listReadingDocumentsForAgent(db, LOCAL_LIBRARY_ID, {});
  assert.deepEqual(mine.items.map((row) => row.id), ["mine"]);
  const theirs = listReadingDocumentsForAgent(db, "other", {});
  assert.deepEqual(theirs.items.map((row) => row.id), ["theirs"]);
  db.close();
});

test("agent document projection flattens stored text, caps it, and bounds provenance", () => {
  const db = mem();
  const long = "α".repeat(AGENT_READING_TEXT_LIMIT + 10);
  const now = "2026-08-27T00:00:00.000Z";
  const itemIds = new Set<string>();
  const provenance: Record<string, unknown>[] = [];
  for (let i = 0; i < 6; i += 1) {
    const id = `item-${i}`;
    itemIds.add(id);
    db.prepare(
      `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
       VALUES (?, 'post', ?, ?, ?, ?, '[]', ?, ?)`,
    ).run(id, `Saved ${id}`, `captured body ${i}`, `https://x.com/a/status/${i}`, now, now, now);
    db.prepare(`INSERT INTO tags (id, name) VALUES (?, ?)`).run(`tag-${i}`, `tag-${i}`);
    db.prepare(
      `INSERT INTO memberships (item_id, target_id, target_kind, actor, created_at) VALUES (?, ?, 'tag', 'user', ?)`,
    ).run(id, `tag-${i}`, now);
    db.prepare(
      `INSERT INTO notes (id, item_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(`n-${i}a`, id, `first note ${i} ${"z".repeat(300)}`, now, now);
    db.prepare(
      `INSERT INTO notes (id, item_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(`n-${i}b`, id, `second note ${i}`, now, now);
    db.prepare(
      `INSERT INTO notes (id, item_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(`n-${i}c`, id, `third note ${i}`, now, now);
    provenance.push({
      kind: "readingProvenance",
      documentId: "stored",
      itemId: id,
      observedUrl: "https://example.com/p/stored",
      discoveredAt: nowAt(i),
    });
  }
  importReadingRecords(db, {
    documents: [
      {
        kind: "readingDocument",
        id: "stored",
        canonicalUrl: "https://example.com/p/stored",
        observedUrl: "https://example.com/p/stored",
        kindName: "article",
        availability: "ready",
        originalStatus: "unknown",
        title: "Stored essay",
        excerpt: "short",
        searchText: long.slice(0, 1000),
        readingMinutes: 12,
        contentBlocks: { version: 1, blocks: [paragraph("stored-p", long)] },
        lastSavedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ],
    provenance,
    progress: [],
    itemIds,
  });

  const listed = listReadingDocumentsForAgent(db, LOCAL_LIBRARY_ID, {});
  assert.equal(listed.items[0]?.hasStoredText, true);
  assert.equal(listed.items[0]?.canonicalUrl, "https://example.com/p/stored");

  const doc = getAgentReadingDocument(db, LOCAL_LIBRARY_ID, "stored");
  assert.equal(doc.hasStoredText, true);
  assert.equal(doc.totalTextLength, AGENT_READING_TEXT_LIMIT + 10);
  assert.equal(doc.truncated, true);
  assert.equal(doc.text?.length, AGENT_READING_TEXT_LIMIT);
  assert.equal(doc.provenance.length, 5);
  assert.ok(doc.provenance.every((entry) => entry.notes.length === 2 && entry.notes.every((note) => note.length <= 240)));
  assert.ok(doc.provenance.some((entry) => entry.notes.some((note) => note.length === 240)));
  assert.ok(doc.provenance.every((entry) => !("body" in entry) && !("itemId" in entry)));
  assert.equal(doc.canonicalUrl, "https://example.com/p/stored");
  assert.ok(!("contentBlocks" in doc));
  assert.ok(getReadingDocument(db, LOCAL_LIBRARY_ID, "stored").contentBlocks);
  db.close();
});

test("agent document inspection keeps source-only rows honest and hides unsafe URLs", () => {
  const db = mem();
  seedDoc(db, { id: "meta", availability: "metadata_only", originalStatus: "unknown" });
  seedDoc(db, { id: "unsafe", originalStatus: "gone" });
  const meta = getAgentReadingDocument(db, LOCAL_LIBRARY_ID, "meta");
  assert.equal(meta.hasStoredText, false);
  assert.equal(meta.text, null);
  assert.equal(meta.truncated, false);
  assert.equal(meta.totalTextLength, 0);
  assert.equal(meta.availability, "metadata_only");
  assert.equal(meta.canonicalUrl, "https://example.com/p/meta");
  assert.equal(getAgentReadingDocument(db, LOCAL_LIBRARY_ID, "unsafe").canonicalUrl, null);
  db.close();
});

test("missing, removed, and foreign ids are the same not-found", () => {
  const db = mem();
  seedDoc(db, { id: "live" });
  seedDoc(db, { id: "other-doc", libraryId: "other" });
  removeReadingDocument(db, LOCAL_LIBRARY_ID, "live");
  const errors = ["invented", "live", "other-doc"].map((id) => {
    try {
      getAgentReadingDocument(db, LOCAL_LIBRARY_ID, id);
      throw new Error("expected missing");
    } catch (err) {
      assert.ok(err instanceof MissingResource);
      return (err as Error).message;
    }
  });
  assert.equal(errors[0], errors[1]);
  assert.equal(errors[0], errors[2]);
  db.close();
});

async function sessionCookie(base: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const res = await fetch(`${base}/api/session`);
      const cookie = res.headers.get("set-cookie")?.split(";", 1)[0];
      if (res.ok && cookie) return cookie;
    } catch {
      // server not accepting yet
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("session never became available");
}

test("HTTP audience=agent returns hidden availability states the visual list omits", async () => {
  const { listen } = await import("../server/http/server.ts");
  const database = mem();
  seedDoc(database, { id: "ready", content: "stored agent-visible body" });
  seedDoc(database, { id: "meta", availability: "metadata_only" });
  seedDoc(database, { id: "blocked", availability: "blocked" });
  const app = listen(database);
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const cookie = await sessionCookie(base);

    const visual = (await (await fetch(`${base}/api/reading?view=queue`, { headers: { cookie } })).json()) as {
      view: string;
      preparing: unknown;
      unread: { items: { id: string }[] };
    };
    assert.deepEqual(visual.unread.items.map((row) => row.id), ["ready"]);
    assert.ok("preparing" in visual);

    const agent = await fetch(`${base}/api/reading?audience=agent`, { headers: { cookie } });
    assert.equal(agent.status, 200);
    const agentBody = (await agent.json()) as {
      items: { id: string; hasStoredText: boolean; contentBlocks?: unknown }[];
      nextCursor: string | null;
      counts: { unread: number };
    };
    assert.deepEqual(agentBody.items.map((row) => row.id).sort(), ["blocked", "meta", "ready"]);
    const stored = agentBody.items.find((row) => row.id === "ready")!;
    assert.equal(stored.hasStoredText, true);
    assert.equal("contentBlocks" in stored, false);
    assert.equal(agentBody.nextCursor, null);
    assert.equal(typeof agentBody.counts.unread, "number");

    // libraryId in the query is ignored; data stays in the local Library.
    const foreign = await fetch(`${base}/api/reading?audience=agent&libraryId=other`, { headers: { cookie } });
    assert.equal(foreign.status, 200);
    const foreignBody = (await foreign.json()) as { items: { id: string }[] };
    assert.deepEqual(foreignBody.items.map((row) => row.id).sort(), ["blocked", "meta", "ready"]);
  } finally {
    await app.close();
    database.close();
  }
});

test("HTTP audience=agent rejects malformed filters instead of widening", async () => {
  const { listen } = await import("../server/http/server.ts");
  const database = mem();
  seedDoc(database, { id: "ready" });
  const app = listen(database);
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const cookie = await sessionCookie(base);
    for (const bad of ["kind=essay", "limit=51", "limit=abc", "view=all", "sort=mood", "cursor=garbage", "q=" + "x".repeat(201)]) {
      const res = await fetch(`${base}/api/reading?audience=agent&${bad}`, { headers: { cookie } });
      assert.equal(res.status, 400, bad);
    }
  } finally {
    await app.close();
    database.close();
  }
});

test("HTTP audience=agent document projection, 404, and unchanged visual detail", async () => {
  const { listen } = await import("../server/http/server.ts");
  const database = mem();
  seedDoc(database, { id: "ready", content: "stored agent-visible body" });
  seedDoc(database, { id: "meta", availability: "metadata_only" });
  const app = listen(database);
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const cookie = await sessionCookie(base);

    const detail = await fetch(`${base}/api/reading/ready?audience=agent`, { headers: { cookie } });
    assert.equal(detail.status, 200);
    const doc = ((await detail.json()) as { document: Record<string, unknown> }).document;
    assert.equal(doc.hasStoredText, true);
    assert.equal(doc.text, "stored agent-visible body");
    assert.equal(doc.truncated, false);
    assert.equal(doc.totalTextLength, "stored agent-visible body".length);
    assert.equal("contentBlocks" in doc, false);
    assert.ok(Array.isArray(doc.provenance));

    const meta = ((await (
      await fetch(`${base}/api/reading/meta?audience=agent`, { headers: { cookie } })
    ).json()) as { document: { hasStoredText: boolean; text: string | null; canonicalUrl: string | null } }).document;
    assert.equal(meta.hasStoredText, false);
    assert.equal(meta.text, null);
    assert.equal(meta.canonicalUrl, "https://example.com/p/meta");

    const missing = await fetch(`${base}/api/reading/invented?audience=agent`, { headers: { cookie } });
    assert.equal(missing.status, 404);

    // Without audience=agent the visual detail is unchanged (contentBlocks present).
    const visual = (await (await fetch(`${base}/api/reading/ready`, { headers: { cookie } })).json()) as {
      document: { contentBlocks: unknown; hasStoredText?: unknown };
    };
    assert.ok(visual.document.contentBlocks);
    assert.equal("hasStoredText" in visual.document, false);
  } finally {
    await app.close();
    database.close();
  }
});
