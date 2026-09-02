import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { addTag, createCollection, removeTag } from "../core/commands.ts";
import { getItem, itemMatchesFilter, listItems } from "../core/library.ts";
import { finishSession, ingestBatch, issueToken, lookupToken, startSession } from "../server/capture/ingest.ts";
import { commitIntakeBatch, commitIntakeItem, commitReviewedDrafts, createIntakeTag, exportIntakeRecords, getIntakeContext, getIntakeProvenance, preparePresentedDrafts, previewIntakeItem, searchLibrary } from "../server/intake/module.ts";
import { getAtlasProjection } from "../server/atlas/module.ts";
import { getKitchenIndex, getTonight } from "../server/kitchen/module.ts";
import { RejectedPayload } from "../core/sanitize.ts";

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-intake-")), "t.db"));
}

const session = {
  protocolVersion: 1 as const,
  source: "x" as const,
  producer: { id: "test", version: "1" },
  accountExternalId: "acct",
  collection: { externalId: "bookmarks", name: "Bookmarks" },
  mode: "snapshot" as const,
  observedAt: "2026-08-23T12:00:00.000Z",
};

test("a valid URL becomes an ordinary Inbox Item with Intake provenance", () => {
  const db = mem();
  const now = "2026-08-23T12:00:00.000Z";
  const result = commitIntakeItem(db, { libraryId: "local", actor: "user" }, {
    url: "https://example.com/essay",
    title: "Essay",
  }, now);
  assert.equal(result.outcome, "created");
  assert.equal(result.actor, "user");
  assert.equal(result.item.url, "https://example.com/essay");
  assert.equal(result.item.title, "Essay");
  assert.equal(result.item.contentType, "link");
  assert.equal(result.item.status, "inbox");
  assert.equal(result.item.source, null);
  assert.equal(result.item.intakeActor, "user");
  assert.equal(result.item.capturedAt, null);
  assert.equal(result.item.publishedAt, "2026-08-23T00:00:00.000Z");
  assert.equal(
    (db.prepare(`SELECT kind FROM activities WHERE item_id = ?`).get(result.item.id) as { kind: string }).kind,
    "added",
  );
  assert.equal(listItems(db, { view: "inbox" }).map((item) => item.id).join(), result.item.id);
  assert.equal(listItems(db, { source: "you" }).map((item) => item.id).join(), result.item.id);
  assert.equal(getAtlasProjection(db, "local").analysis.queued, 1);
  assert.equal(listItems(db, { source: "x" }).length, 0);
});

test("agent intake leaves a missing publication date missing", () => {
  const db = mem();
  const result = commitIntakeItem(db, { libraryId: "local", actor: "agent" }, { url: "https://example.com/agent" });
  assert.equal(result.item.publishedAt, null);
  assert.equal(listItems(db, { source: "you" }).length, 0);
});

test("payload library and actor fields cannot impersonate trusted context", () => {
  const db = mem();
  assert.throws(
    () => commitIntakeItem(
      db,
      { libraryId: "local", actor: "agent" },
      { url: "https://example.com/a", libraryId: "other", actor: "user" },
    ),
    (error: unknown) => error instanceof RejectedPayload && /unsupported field/.test(error.message),
  );
  assert.equal(listItems(db).length, 0);
});

function reject(input: unknown, pattern: RegExp): void {
  const db = mem();
  assert.throws(
    () => commitIntakeItem(db, { libraryId: "local", actor: "user" }, input),
    (error: unknown) => error instanceof RejectedPayload && pattern.test(error.message),
  );
  assert.equal(listItems(db).length, 0);
}

test("invalid intake fields are rejected without persisting", () => {
  reject({ url: "javascript:alert(1)" }, /http or https/);
  reject({ url: "ftp://example.com/a" }, /http or https/);
  reject({ url: "https://user:pass@example.com/a" }, /credentials/);
  reject({ url: "https://example.com/a", publishedAt: "not-a-date" }, /timestamp/);
  reject({ url: "https://example.com/a", title: "ok\u202Ehidden" }, /control characters/);
  reject({ url: "https://example.com/a", title: "x".repeat(501) }, /too long/);
  reject({ url: "https://example.com/a", extra: true }, /unsupported field/);
  reject(
    { url: "https://example.com/a", media: [{ url: "javascript:alert(1)" }] },
    /http or https/,
  );
  reject(
    {
      url: "https://example.com/a",
      media: Array.from({ length: 9 }, (_, i) => ({ url: `https://example.com/${i}.jpg` })),
    },
    /media exceeds/,
  );
});

test("reconciliation failure rolls back the Item", () => {
  const db = mem();
  db.exec(`CREATE TRIGGER intake_fail_atlas BEFORE INSERT ON atlas_screenings
    BEGIN SELECT RAISE(ABORT, 'atlas failed'); END;`);
  assert.throws(
    () => commitIntakeItem(db, { libraryId: "local", actor: "user" }, { url: "https://example.com/rollback" }),
    (error: unknown) => error instanceof Error && /atlas failed/.test(error.message),
  );
  assert.equal(listItems(db).length, 0);
});

test("Capture still owns producer Items and ignores Intake Items on finish", () => {
  const db = mem();
  const intake = commitIntakeItem(db, { libraryId: "local", actor: "user" }, { url: "https://example.com/manual" });
  const tok = lookupToken(db, issueToken(db, "x", null).token)!;
  const started = startSession(db, tok, session);
  ingestBatch(db, {
    sessionId: started.sessionId,
    sequence: 1,
    idempotencyKey: "k1",
    changes: [
      {
        kind: "upsert",
        externalId: "1",
        item: { contentType: "post", body: "hello", url: "https://x.com/i/status/1" },
      },
    ],
  });
  const captured = listItems(db, { source: "x" });
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.source, "x");
  assert.equal(getItem(db, intake.item.id)?.source, null);
  finishSession(db, { sessionId: started.sessionId, coverage: "complete" }, tok);
  assert.equal(getItem(db, intake.item.id)?.id, intake.item.id);
  assert.equal(getItem(db, captured[0]!.id)?.source, "x");
});

test("preview shows sanitized fields, missing optionals, and selected organization", () => {
  const db = mem();
  const collection = createCollection(db, "Research", "Deep reading");
  db.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-food', 'food', NULL)`).run();
  const preview = previewIntakeItem(db, { libraryId: "local", actor: "user" }, {
    url: "https://example.com/essay",
    title: " Essay ",
    collectionIds: [collection.id],
    tagIds: ["tag-food"],
    newTags: ["Local First"],
  }, "2026-08-23T12:00:00.000Z");
  assert.equal(preview.item.url, "https://example.com/essay");
  assert.equal(preview.item.title, "Essay");
  assert.equal(preview.item.body, null);
  assert.equal(preview.item.authorName, null);
  assert.equal(preview.item.publishedAt, "2026-08-23T00:00:00.000Z");
  assert.deepEqual(preview.missing, ["source text", "author", "media"]);
  assert.equal(preview.collections.length, 1);
  assert.equal(preview.collections[0]?.id, collection.id);
  assert.equal(preview.collections[0]?.name, "Research");
  assert.equal(preview.collections[0]?.description, "Deep reading");
  assert.deepEqual(preview.tags.map((tag) => ({ id: tag.id, name: tag.name })), [
    { id: "tag-food", name: "food" },
    { id: null, name: "Local First" },
  ]);
  assert.equal(listItems(db).length, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM tags`).get() as { n: number }).n, 1);
});

test("intake context lists Library tags and Collections with Food consequences", () => {
  const db = mem();
  const collection = createCollection(db, "Research", "Deep reading");
  db.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-food', 'food', NULL), ('tag-tech', 'tech', NULL)`).run();
  db.prepare(`UPDATE tags SET color = '#c45' WHERE id = 'tag-food'`).run();
  const context = getIntakeContext(db, { libraryId: "local" });
  assert.deepEqual(context.collections, [{ id: collection.id, name: "Research", description: "Deep reading" }]);
  assert.equal(context.tags.find((tag) => tag.id === "tag-food")?.consequence, "Appears in Recipe Box");
  assert.equal(context.tags.find((tag) => tag.id === "tag-food")?.color, "#c45");
  assert.equal(context.tags.find((tag) => tag.id === "tag-tech")?.consequence, null);
  assert.equal(context.tags.find((tag) => tag.id === "tag-tech")?.color, null);
  assert.equal(context.version.length, 64);
  const renamed = getIntakeContext(db, { libraryId: "local" });
  assert.equal(renamed.version, context.version);
  db.prepare(`UPDATE tags SET name = 'tech-2' WHERE id = 'tag-tech'`).run();
  assert.notEqual(getIntakeContext(db, { libraryId: "local" }).version, context.version);
  assert.throws(
    () => getIntakeContext(db, { libraryId: "" }),
    (error: unknown) => error instanceof RejectedPayload && /library is required/.test(error.message),
  );
});

test("commit applies existing and new organization without changing workflow state", () => {
  const db = mem();
  const collection = createCollection(db, "Research", "Deep reading");
  db.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-food', 'food', NULL)`).run();
  const result = commitIntakeItem(db, { libraryId: "local", actor: "user" }, {
    url: "https://example.com/essay",
    title: "Essay",
    collectionIds: [collection.id],
    tagIds: ["tag-food"],
    newTags: ["Local First"],
  });
  assert.equal(result.item.status, "inbox");
  assert.equal(result.item.snoozedUntil, null);
  assert.deepEqual(result.item.notes, []);
  assert.deepEqual(result.item.collections.map((entry) => entry.name).sort(), ["Research"]);
  assert.deepEqual(result.item.tags.map((entry) => entry.name).sort(), ["Local First", "food"]);
  const actors = db.prepare(`SELECT actor FROM memberships WHERE item_id = ?`).all(result.item.id) as { actor: string }[];
  assert.ok(actors.length > 0 && actors.every((row) => row.actor === "user"));
  assert.equal(listItems(db, { collectionId: collection.id }).map((item) => item.id).join(), result.item.id);
  assert.equal(listItems(db, { q: "Local First" }).map((item) => item.id).join(), result.item.id);
  assert.equal(getItem(db, result.item.id)?.tags.map((tag) => tag.name).sort().join(), "Local First,food");
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM reading_progress`).get() as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM notes`).get() as { n: number }).n, 0);
});

test("new tags reuse existing names case-insensitively", () => {
  const db = mem();
  db.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-food', 'Food', NULL)`).run();
  const result = commitIntakeItem(db, { libraryId: "local", actor: "user" }, {
    url: "https://example.com/food",
    newTags: ["FOOD"],
  });
  assert.equal(result.item.tags.length, 1);
  assert.equal(result.item.tags[0]?.id, "tag-food");
  assert.equal(result.item.tags[0]?.name, "Food");
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM tags`).get() as { n: number }).n, 1);
});

test("unknown, deleted, or cross-Library targets reject without a partial Item", () => {
  const db = mem();
  const other = mem();
  const foreign = createCollection(other, "Other");
  other.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-other', 'other', NULL)`).run();
  db.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-gone', 'gone', NULL)`).run();
  db.prepare(`DELETE FROM tags WHERE id = 'tag-gone'`).run();

  assert.throws(
    () => commitIntakeItem(db, { libraryId: "local", actor: "user" }, {
      url: "https://example.com/missing-tag",
      tagIds: ["missing"],
    }),
    (error: unknown) => error instanceof RejectedPayload && /unknown tag/.test(error.message),
  );
  assert.throws(
    () => commitIntakeItem(db, { libraryId: "local", actor: "user" }, {
      url: "https://example.com/deleted-tag",
      tagIds: ["tag-gone"],
    }),
    (error: unknown) => error instanceof RejectedPayload && /unknown tag/.test(error.message),
  );
  assert.throws(
    () => commitIntakeItem(db, { libraryId: "local", actor: "user" }, {
      url: "https://example.com/foreign-tag",
      tagIds: ["tag-other"],
    }),
    (error: unknown) => error instanceof RejectedPayload && /unknown tag/.test(error.message),
  );
  assert.throws(
    () => commitIntakeItem(db, { libraryId: "local", actor: "user" }, {
      url: "https://example.com/foreign-collection",
      collectionIds: [foreign.id],
    }),
    (error: unknown) => error instanceof RejectedPayload && /unknown collection/.test(error.message),
  );
  assert.equal(listItems(db).length, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM memberships`).get() as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM tags`).get() as { n: number }).n, 0);
});

test("organization rolls back with the Item when reconciliation fails", () => {
  const db = mem();
  const collection = createCollection(db, "Research");
  db.exec(`CREATE TRIGGER intake_fail_atlas BEFORE INSERT ON atlas_screenings
    BEGIN SELECT RAISE(ABORT, 'atlas failed'); END;`);
  assert.throws(
    () => commitIntakeItem(db, { libraryId: "local", actor: "user" }, {
      url: "https://example.com/rollback-org",
      collectionIds: [collection.id],
      newTags: ["Essay"],
    }),
    (error: unknown) => error instanceof Error && /atlas failed/.test(error.message),
  );
  assert.equal(listItems(db).length, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM memberships`).get() as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM tags`).get() as { n: number }).n, 0);
});

test("normalized URL equivalents reuse the existing Item and do not merge similar titles", () => {
  const db = mem();
  const first = commitIntakeItem(db, { libraryId: "local", actor: "user" }, {
    url: "https://example.com",
    title: "Essay",
    body: "Original",
  });
  const reused = commitIntakeItem(db, { libraryId: "local", actor: "user" }, {
    url: "HTTPS://EXAMPLE.COM:443",
    title: "Other",
    body: "Changed",
    authorName: "Ada",
  });
  assert.equal(reused.outcome, "reused");
  assert.equal(reused.item.id, first.item.id);
  assert.equal(reused.item.url, "https://example.com/");
  assert.equal(reused.item.title, "Essay");
  assert.equal(reused.item.body, "Original");
  assert.equal(reused.item.authorName, null);
  assert.equal(listItems(db).length, 1);

  const other = commitIntakeItem(db, { libraryId: "local", actor: "user" }, {
    url: "https://example.com/other",
    title: "Essay",
  });
  assert.equal(other.outcome, "created");
  assert.equal(listItems(db).length, 2);
  assert.notEqual(other.item.id, first.item.id);
});

test("reuse adds only missing memberships and preserves the original actor", () => {
  const db = mem();
  const collection = createCollection(db, "Research");
  db.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-a', 'alpha', NULL), ('tag-b', 'beta', NULL)`).run();
  const first = commitIntakeItem(db, { libraryId: "local", actor: "user" }, {
    url: "https://example.com/essay",
    tagIds: ["tag-a"],
    collectionIds: [collection.id],
  });
  const reused = commitIntakeItem(db, { libraryId: "local", actor: "agent" }, {
    url: "https://example.com/essay",
    tagIds: ["tag-a", "tag-b"],
    collectionIds: [collection.id],
    classifications: [{
      tagId: "tag-b",
      rationale: "Adds the missing beta topic",
      evidence: [{ field: "url", text: "https://example.com/essay" }],
    }],
  });
  assert.equal(reused.outcome, "reused");
  assert.deepEqual(reused.added, { tagIds: ["tag-b"], collectionIds: [] });
  assert.deepEqual(reused.alreadyPresent, { tagIds: ["tag-a"], collectionIds: [collection.id] });
  assert.deepEqual(reused.item.tags.map((tag) => tag.name).sort(), ["alpha", "beta"]);
  const actors = db.prepare(`SELECT target_id, actor FROM memberships WHERE item_id = ?`).all(first.item.id) as {
    target_id: string;
    actor: string;
  }[];
  assert.equal(actors.find((row) => row.target_id === "tag-a")?.actor, "user");
  assert.equal(actors.find((row) => row.target_id === collection.id)?.actor, "user");
  assert.equal(actors.find((row) => row.target_id === "tag-b")?.actor, "agent");
  assert.equal(first.item.intakeActor, "user");
  assert.equal(getItem(db, first.item.id)?.intakeActor, "user");
});

test("duplicate intake against a producer Item leaves source records and capture history unchanged", () => {
  const db = mem();
  const tok = lookupToken(db, issueToken(db, "x", null).token)!;
  const started = startSession(db, tok, session);
  ingestBatch(db, {
    sessionId: started.sessionId,
    sequence: 1,
    idempotencyKey: "k1",
    changes: [
      {
        kind: "upsert",
        externalId: "1",
        item: { contentType: "post", body: "hello", url: "https://x.com/i/status/1", title: "Captured" },
      },
    ],
  });
  const captured = listItems(db, { source: "x" })[0]!;
  const before = db.prepare(`SELECT * FROM source_records`).all();
  const activitiesBefore = db.prepare(`SELECT COUNT(*) AS n FROM activities WHERE item_id = ?`).get(captured.id) as { n: number };

  const reused = commitIntakeItem(db, { libraryId: "local", actor: "user" }, {
    url: "HTTPS://X.COM/i/status/1",
    title: "Hacked",
    body: "overwrite",
    newTags: ["keep"],
  });
  assert.equal(reused.outcome, "reused");
  assert.equal(reused.item.id, captured.id);
  assert.equal(reused.item.title, "Captured");
  assert.equal(reused.item.body, "hello");
  assert.equal(reused.item.source, "x");
  assert.equal(reused.item.intakeActor, null);
  assert.deepEqual(db.prepare(`SELECT * FROM source_records`).all(), before);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM activities WHERE item_id = ?`).get(captured.id) as { n: number }).n,
    activitiesBefore.n,
  );
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM item_intake WHERE item_id = ?`).get(captured.id) as { n: number }).n, 0);
  assert.equal(reused.item.tags.map((tag) => tag.name).join(), "keep");

  const intake = commitIntakeItem(db, { libraryId: "local", actor: "user" }, { url: "https://example.com/manual" });
  finishSession(db, { sessionId: started.sessionId, coverage: "complete" }, tok);
  assert.equal(getItem(db, intake.item.id)?.id, intake.item.id);
  assert.equal(getItem(db, captured.id)?.source, "x");
});

test("an Intake batch is atomic, retry-safe, and records history", () => {
  const db = mem();
  const collection = createCollection(db, "Research");
  db.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-a', 'alpha', NULL)`).run();
  const now = "2026-08-23T12:00:00.000Z";
  const context = getIntakeContext(db, { libraryId: "local" });
  const payload = {
    clientMutationId: "m1",
    instruction: "tag by topic",
    contextVersion: context.version,
    drafts: [
      {
        url: "https://example.com/a",
        title: "A",
        observedFields: ["title"],
        collectionIds: [collection.id],
      },
      {
        url: "HTTPS://EXAMPLE.COM:443/a",
        title: "Ignored",
        observedFields: ["title"],
        tagIds: ["tag-a"],
        classifications: [{
          tagId: "tag-a",
          rationale: "Matches the requested topic",
          evidence: [{ field: "instruction", text: "tag by topic" }],
        }],
      },
    ],
  };
  const first = commitIntakeBatch(db, { libraryId: "local", actor: "agent" }, payload, now);
  assert.equal(first.clientMutationId, "m1");
  assert.equal(first.instruction, "tag by topic");
  assert.equal(first.contextVersion, context.version);
  assert.equal(first.createdAt, now);
  assert.equal(first.actor, "agent");
  assert.equal(first.drafts[0]?.outcome, "created");
  assert.equal(first.drafts[1]?.outcome, "reused");
  assert.equal(first.drafts[0]?.item.id, first.drafts[1]?.item.id);
  assert.equal(listItems(db).length, 1);
  assert.deepEqual(first.drafts[1]?.item.tags.map((tag) => tag.name), ["alpha"]);
  assert.deepEqual(first.drafts[1]?.item.collections.map((entry) => entry.name), ["Research"]);

  const replay = commitIntakeBatch(db, { libraryId: "local", actor: "agent" }, payload, now);
  assert.equal(JSON.stringify(replay), JSON.stringify(first));
  assert.equal(listItems(db).length, 1);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM intake_batches`).get() as { n: number }).n, 1);

  assert.throws(
    () => commitIntakeBatch(db, { libraryId: "local", actor: "agent" }, {
      ...payload,
      drafts: [{ url: "https://example.com/changed" }],
    }),
    (error: unknown) => error instanceof RejectedPayload && /different change/.test(error.message),
  );
  assert.equal(listItems(db).length, 1);

  assert.throws(
    () => commitIntakeBatch(db, { libraryId: "local", actor: "user" }, {
      clientMutationId: "m2",
      drafts: [
        { url: "https://example.com/keep", newTags: ["Keep"] },
        { url: "https://example.com/bad", tagIds: ["missing"] },
      ],
    }),
    (error: unknown) => error instanceof RejectedPayload && /unknown tag/.test(error.message),
  );
  assert.equal(listItems(db).length, 1);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM tags`).get() as { n: number }).n, 1);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM intake_batches`).get() as { n: number }).n, 1);

  const afterFailure = commitIntakeBatch(db, { libraryId: "local", actor: "user" }, {
    clientMutationId: "m2",
    drafts: [{ url: "https://example.com/keep", title: "Keep" }],
  });
  assert.equal(afterFailure.drafts[0]?.outcome, "created");
  assert.equal(listItems(db).length, 2);

  assert.throws(
    () => commitIntakeBatch(db, { libraryId: "local", actor: "user" }, {
      clientMutationId: "m3",
      drafts: Array.from({ length: 26 }, (_, i) => ({ url: `https://example.com/n/${i}` })),
    }),
    (error: unknown) => error instanceof RejectedPayload && /drafts exceeds 25/.test(error.message),
  );
});

test("agent batches require observed fields, tag evidence, and a current context", () => {
  const db = mem();
  const collection = createCollection(db, "Research");
  db.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-a', 'alpha', NULL)`).run();
  const context = getIntakeContext(db, { libraryId: "local" });
  const draft = {
    url: "https://example.com/essay",
    title: "Local-first software",
    observedFields: ["title"],
    collectionIds: [collection.id],
    tagIds: ["tag-a"],
    classifications: [{
      tagId: "tag-a",
      rationale: "The title names the topic",
      evidence: [{ field: "title", text: "Local-first" }],
    }],
  };
  const created = commitIntakeBatch(db, { libraryId: "local", actor: "agent" }, {
    clientMutationId: "exact-1",
    instruction: "save to Research and tag alpha",
    contextVersion: context.version,
    drafts: [draft],
  });
  assert.equal(created.actor, "agent");
  assert.equal(created.drafts[0]?.outcome, "created");
  assert.equal(created.drafts[0]?.item.intakeActor, "agent");
  assert.equal(created.drafts[0]?.item.publishedAt, null);
  assert.deepEqual(getIntakeProvenance(db, created.drafts[0]!.item.id), {
    actor: "agent",
    observedFields: ["title"],
    classifications: [{
      tagId: "tag-a",
      rationale: "The title names the topic",
      evidence: [{ field: "title", text: "Local-first" }],
    }],
  });

  const replay = commitIntakeBatch(db, { libraryId: "local", actor: "agent" }, {
    clientMutationId: "exact-1",
    instruction: "save to Research and tag alpha",
    contextVersion: context.version,
    drafts: [draft],
  });
  assert.equal(JSON.stringify(replay), JSON.stringify(created));

  assert.throws(
    () => commitIntakeBatch(db, { libraryId: "local", actor: "agent" }, {
      clientMutationId: "exact-2",
      contextVersion: "not-the-current-version",
      drafts: [{ url: "https://example.com/stale" }],
    }),
    (error: unknown) => error instanceof RejectedPayload && /stale context/.test(error.message),
  );
  assert.throws(
    () => commitIntakeItem(db, { libraryId: "local", actor: "agent" }, {
      url: "https://example.com/observed",
      title: "Seen",
    }),
    (error: unknown) => error instanceof RejectedPayload && /observedFields/.test(error.message),
  );
  assert.throws(
    () => commitIntakeItem(db, { libraryId: "local", actor: "agent" }, {
      url: "https://example.com/tag",
      tagIds: ["tag-a"],
    }),
    (error: unknown) => error instanceof RejectedPayload && /classification required/.test(error.message),
  );
  assert.throws(
    () => commitIntakeItem(db, { libraryId: "local", actor: "agent" }, {
      url: "https://example.com/bad-evidence",
      title: "Hello",
      observedFields: ["title"],
      tagIds: ["tag-a"],
      classifications: [{
        tagId: "tag-a",
        rationale: "Guess",
        evidence: [{ field: "title", text: "not in the title" }],
      }],
    }),
    (error: unknown) => error instanceof RejectedPayload && /invalid evidence/.test(error.message),
  );
  assert.throws(
    () => commitIntakeItem(db, { libraryId: "local", actor: "agent" }, {
      url: "https://example.com/new-tag",
      newTags: ["Invented"],
    }),
    (error: unknown) => error instanceof RejectedPayload && /unsupported field/.test(error.message),
  );
  assert.equal(listItems(db).length, 1);

  db.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-b', 'beta', NULL)`).run();
  assert.throws(
    () => commitIntakeBatch(db, { libraryId: "local", actor: "agent" }, {
      clientMutationId: "exact-3",
      contextVersion: context.version,
      drafts: [{ url: "https://example.com/after-tag" }],
    }),
    (error: unknown) => error instanceof RejectedPayload && /stale context/.test(error.message),
  );
  assert.equal(listItems(db).length, 1);

  const reused = commitIntakeItem(db, { libraryId: "local", actor: "agent" }, {
    url: "https://example.com/essay",
    title: "Overwrite attempt",
    observedFields: ["title"],
    tagIds: ["tag-a"],
    classifications: [{
      tagId: "tag-a",
      rationale: "Rewrite the why",
      evidence: [{ field: "title", text: "Overwrite" }],
    }],
  });
  assert.equal(reused.outcome, "reused");
  assert.equal(reused.item.title, "Local-first software");
  assert.deepEqual(reused.alreadyPresent.tagIds, ["tag-a"]);
  assert.equal(getIntakeProvenance(db, created.drafts[0]!.item.id).classifications[0]?.rationale, "The title names the topic");
});

test("removing a tag retires its agent evidence without erasing the batch", () => {
  const db = mem();
  db.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-a', 'alpha', NULL)`).run();
  const context = getIntakeContext(db, { libraryId: "local" });
  const created = commitIntakeBatch(db, { libraryId: "local", actor: "agent" }, {
    clientMutationId: "exact-evidence",
    instruction: "tag alpha",
    contextVersion: context.version,
    drafts: [{
      url: "https://example.com/essay",
      title: "Local-first software",
      observedFields: ["title"],
      tagIds: ["tag-a"],
      classifications: [{
        tagId: "tag-a",
        rationale: "The title names the topic",
        evidence: [{ field: "title", text: "Local-first" }],
      }],
    }],
  });
  const itemId = created.drafts[0]!.item.id;
  removeTag(db, itemId, "tag-a");
  assert.deepEqual(getIntakeProvenance(db, itemId).classifications, []);
  assert.deepEqual(exportIntakeRecords(db).records[0]?.classifications, []);
  addTag(db, itemId, "alpha");
  assert.deepEqual(getIntakeProvenance(db, itemId).classifications, []);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM intake_batches`).get() as { n: number }).n, 1);
});

test("a Food tag is visible through Kitchen without Recipe Documents or Tonight entries", () => {
  const db = mem();
  const result = commitIntakeItem(db, { libraryId: "local", actor: "user" }, {
    url: "https://example.com/soup",
    title: "Soup",
    newTags: ["food"],
  });
  assert.equal(itemMatchesFilter(db, result.item.id, { view: "recent", shelf: "food" }), true);
  const kitchen = getKitchenIndex(db, "local");
  assert.equal(kitchen.items.map((entry) => entry.item.id).join(), result.item.id);
  assert.equal(kitchen.counts.structuredRecipes, 0);
  assert.equal(kitchen.counts.tonight, 0);
  assert.equal(getTonight(db, "local").length, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM kitchen_recipe_documents`).get() as { n: number }).n, 0);
});

test("searchLibrary matches normalized URLs and title/url text without bodies or notes", () => {
  const db = mem();
  const first = commitIntakeItem(db, { libraryId: "local", actor: "user" }, {
    url: "https://Example.com:443/essay",
    title: "Local-first software",
    body: "SECRET-BODY",
  });
  db.prepare(`INSERT INTO notes (id, item_id, body, created_at, updated_at) VALUES ('n1', ?, 'SECRET-NOTE', ?, ?)`).run(
    first.item.id,
    "2026-08-23T12:00:00.000Z",
    "2026-08-23T12:00:00.000Z",
  );
  commitIntakeItem(db, { libraryId: "local", actor: "user" }, {
    url: "https://example.com/other",
    title: "Unrelated",
  });
  const byUrl = searchLibrary(db, { libraryId: "local" }, { url: "https://example.com/essay" });
  assert.equal(byUrl.items.length, 1);
  assert.equal(byUrl.items[0]?.id, first.item.id);
  assert.equal(byUrl.items[0]?.title, "Local-first software");
  assert.equal(byUrl.items[0]?.url, "https://example.com/essay");
  assert.equal(JSON.stringify(byUrl).includes("SECRET"), false);
  const byQ = searchLibrary(db, { libraryId: "local" }, { q: "local-first" });
  assert.deepEqual(byQ.items.map((item) => item.id), [first.item.id]);
  const bodyLeak = searchLibrary(db, { libraryId: "local" }, { q: "SECRET-BODY" });
  assert.deepEqual(bodyLeak.items, []);
  assert.deepEqual(searchLibrary(db, { libraryId: "other" }, { q: "local-first" }).items, []);
  assert.deepEqual(searchLibrary(db, { libraryId: "local" }, {}).items, []);
  assert.throws(
    () => searchLibrary(db, { libraryId: "local" }, { q: "x", raw: "SELECT 1" }),
    (error: unknown) => error instanceof RejectedPayload && /unsupported field/.test(error.message),
  );
});

test("preparePresentedDrafts validates agent drafts without writing", () => {
  const db = mem();
  const collection = createCollection(db, "Research", "Deep reading");
  db.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-tech', 'tech', NULL)`).run();
  const drafts = preparePresentedDrafts(db, { libraryId: "local" }, {
    drafts: [{
      url: "https://example.com/essay",
      title: "Essay",
      collectionIds: [collection.id],
      tagIds: ["tag-tech"],
      proposedNewTags: ["Local First"],
      rationale: "About local-first software",
      evidenceBasis: "title",
      uncertainty: "Author is unknown",
    }],
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.item.url, "https://example.com/essay");
  assert.equal(drafts[0]?.item.title, "Essay");
  assert.equal(drafts[0]?.item.publishedAt, null);
  assert.deepEqual(drafts[0]?.missing, ["source text", "author", "publication date", "media"]);
  assert.equal(drafts[0]?.collections[0]?.name, "Research");
  assert.deepEqual(drafts[0]?.tags.map((tag) => ({ name: tag.name, proposed: tag.proposed })), [
    { name: "tech", proposed: false },
    { name: "Local First", proposed: true },
  ]);
  assert.equal(drafts[0]?.rationale, "About local-first software");
  assert.equal(listItems(db).length, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM tags`).get() as { n: number }).n, 1);
  assert.throws(
    () => preparePresentedDrafts(db, { libraryId: "local" }, {
      drafts: Array.from({ length: 21 }, (_, i) => ({ url: `https://example.com/${i}` })),
    }),
    (error: unknown) => error instanceof RejectedPayload && /drafts exceeds 20/.test(error.message),
  );
  assert.throws(
    () => preparePresentedDrafts(db, { libraryId: "local" }, {
      drafts: [{ url: "https://example.com/x", tagIds: ["missing"] }],
    }),
    (error: unknown) => error instanceof RejectedPayload && /unknown tag/.test(error.message),
  );
  assert.throws(
    () => preparePresentedDrafts(db, { libraryId: "local" }, {
      drafts: [{ url: "https://example.com/x", newTags: ["sneaky"] }],
    }),
    (error: unknown) => error instanceof RejectedPayload && /unsupported field/.test(error.message),
  );
});

test("reviewed sheet save commits without evidence and createIntakeTag refreshes context", () => {
  const db = mem();
  const collection = createCollection(db, "Research");
  db.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-tech', 'tech', NULL)`).run();
  const presented = preparePresentedDrafts(db, { libraryId: "local" }, {
    drafts: [{
      url: "https://example.com/keep",
      title: "Keep me",
      collectionIds: [collection.id],
      tagIds: ["tag-tech"],
      proposedNewTags: ["Local First"],
      rationale: "About local-first software",
    }, {
      url: "https://example.com/skip",
      title: "Skip me",
    }],
  });
  assert.equal(presented.length, 2);
  const before = getIntakeContext(db, { libraryId: "local" });
  const created = createIntakeTag(db, { libraryId: "local" }, { name: "Local First" });
  assert.equal(created.tag.name, "Local First");
  assert.notEqual(created.context.version, before.version);
  const saved = commitReviewedDrafts(db, { libraryId: "local" }, {
    clientMutationId: "reviewed-1",
    contextVersion: created.context.version,
    drafts: [{
      url: "https://example.com/keep",
      title: "Keep me",
      tagIds: ["tag-tech", created.tag.id],
      collectionIds: [collection.id],
    }],
  });
  assert.equal(saved.actor, "agent");
  assert.equal(saved.drafts.length, 1);
  assert.equal(saved.drafts[0]?.outcome, "created");
  assert.equal(saved.drafts[0]?.item.url, "https://example.com/keep");
  assert.equal(saved.drafts[0]?.item.intakeActor, "agent");
  assert.deepEqual(listItems(db).map((item) => item.url), ["https://example.com/keep"]);
  const provenance = getIntakeProvenance(db, saved.drafts[0]!.item.id);
  assert.deepEqual(provenance.observedFields, ["title"]);
  assert.deepEqual(provenance.classifications, []);
  assert.throws(
    () => commitReviewedDrafts(db, { libraryId: "local" }, {
      clientMutationId: "reviewed-stale",
      contextVersion: before.version,
      drafts: [{ url: "https://example.com/stale" }],
    }),
    (error: unknown) => error instanceof RejectedPayload && /stale context/.test(error.message),
  );
  assert.equal(listItems(db).length, 1);
  const reused = commitReviewedDrafts(db, { libraryId: "local" }, {
    clientMutationId: "reviewed-2",
    contextVersion: getIntakeContext(db, { libraryId: "local" }).version,
    drafts: [{ url: "https://example.com/keep", title: "Keep me", tagIds: ["tag-tech"] }],
  });
  assert.equal(reused.drafts[0]?.outcome, "reused");
  assert.equal(listItems(db).length, 1);
  assert.throws(
    () => commitIntakeBatch(db, { libraryId: "local", actor: "agent" }, {
      clientMutationId: "exact-1",
      contextVersion: getIntakeContext(db, { libraryId: "local" }).version,
      drafts: [{ url: "https://example.com/exact", title: "Exact", observedFields: ["title"], tagIds: ["tag-tech"] }],
    }),
    (error: unknown) => error instanceof RejectedPayload && /classification required/.test(error.message),
  );
});
