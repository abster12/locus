import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { createCollection } from "../core/commands.ts";
import { getItem, listItems } from "../core/library.ts";
import { RejectedPayload } from "../core/sanitize.ts";
import { finishSession, ingestBatch, issueToken, lookupToken, startSession } from "../server/capture/ingest.ts";
import { issueLibraryCapability } from "../server/intake/capabilities.ts";
import {
  commitIntakeBatch,
  commitIntakeItem,
  getIntakeContext,
  getIntakeProvenance,
  preparePresentedDrafts,
} from "../server/intake/module.ts";
import { importLibraryArchive, writeLibraryArchive } from "../server/library-archive.ts";

const NOW = "2026-08-23T12:00:00.000Z";
const session = {
  protocolVersion: 1 as const,
  source: "x" as const,
  producer: { id: "test", version: "1" },
  accountExternalId: "acct",
  collection: { externalId: "bookmarks", name: "Bookmarks" },
  mode: "snapshot" as const,
  observedAt: NOW,
};

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-intake-archive-")), "t.db"));
}

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "locus-intake-archive-file-")), name);
}

test("library archive round-trips Intake origin and tag explanations, not retries or secrets", async () => {
  const source = mem();
  const collection = createCollection(source, "Research");
  source.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-a', 'alpha', NULL)`).run();
  const manual = commitIntakeItem(source, { libraryId: "local", actor: "user" }, {
    url: "https://example.com/manual",
    title: "Manual",
    collectionIds: [collection.id],
  }, NOW);
  const context = getIntakeContext(source, { libraryId: "local" });
  const agent = commitIntakeBatch(source, { libraryId: "local", actor: "agent" }, {
    clientMutationId: "exact-1",
    instruction: "save to Research and tag alpha",
    contextVersion: context.version,
    drafts: [{
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
    }],
  }, NOW);
  const tok = lookupToken(source, issueToken(source, "x", null).token)!;
  const started = startSession(source, tok, session);
  ingestBatch(source, {
    sessionId: started.sessionId,
    sequence: 1,
    idempotencyKey: "k1",
    changes: [{
      kind: "upsert",
      externalId: "1",
      item: { contentType: "post", body: "hello", url: "https://x.com/i/status/1", title: "Captured" },
    }],
  });
  const captured = listItems(source, { source: "x" })[0]!;
  const reused = commitIntakeItem(source, { libraryId: "local", actor: "agent" }, {
    url: "https://x.com/i/status/1",
    title: "Captured",
    observedFields: ["title"],
    tagIds: ["tag-a"],
    classifications: [{
      tagId: "tag-a",
      rationale: "Captured post matches the topic",
      evidence: [{ field: "title", text: "Captured" }],
    }],
  }, NOW);
  assert.equal(reused.outcome, "reused");
  assert.equal(reused.item.intakeActor, null);
  preparePresentedDrafts(source, { libraryId: "local" }, {
    drafts: [{ url: "https://example.com/abandoned", title: "Draft only" }],
  });
  const issued = issueLibraryCapability(source, { libraryId: "local", scope: "library:read", label: "Claude" });

  const dest = tmpFile("intake.ndjson");
  writeLibraryArchive(source, dest);
  const archive = readFileSync(dest, "utf8");
  assert.match(archive, /"kind":"itemIntake"/);
  assert.match(archive, /"excluded":\[[^\]]*intake_batches/);
  assert.equal(archive.includes(issued.token), false);
  assert.equal(archive.includes("exact-1"), false);
  assert.equal(archive.includes("save to Research and tag alpha"), false);
  assert.equal(archive.includes("https://example.com/abandoned"), false);
  source.close();

  const target = mem();
  const result = await importLibraryArchive(target, dest);
  assert.ok(result.ok);
  assert.equal(getItem(target, manual.item.id)?.intakeActor, "user");
  assert.equal(listItems(target, { source: "you" }).map((item) => item.id).join(), manual.item.id);
  assert.deepEqual(getIntakeProvenance(target, agent.drafts[0]!.item.id), {
    actor: "agent",
    observedFields: ["title"],
    classifications: [{
      tagId: "tag-a",
      rationale: "The title names the topic",
      evidence: [{ field: "title", text: "Local-first" }],
    }],
  });
  assert.equal(getItem(target, captured.id)?.source, "x");
  assert.equal(getItem(target, captured.id)?.intakeActor, null);
  assert.equal(getItem(target, captured.id)?.title, "Captured");
  assert.deepEqual(getIntakeProvenance(target, captured.id), {
    actor: null,
    observedFields: [],
    classifications: [{
      tagId: "tag-a",
      rationale: "Captured post matches the topic",
      evidence: [{ field: "title", text: "Captured" }],
    }],
  });
  const memberships = target.prepare(
    `SELECT target_id, actor FROM memberships WHERE item_id = ? AND target_kind = 'tag'`,
  ).all(agent.drafts[0]!.item.id) as { target_id: string; actor: string }[];
  assert.equal(memberships[0]?.actor, "agent");
  assert.equal((target.prepare(`SELECT COUNT(*) AS n FROM intake_batches`).get() as { n: number }).n, 0);
  assert.equal((target.prepare(`SELECT COUNT(*) AS n FROM kitchen_recipe_documents`).get() as { n: number }).n, 0);
  target.close();
});

test("orphan Intake records roll back the whole import", async () => {
  const target = mem();
  const orphan = tmpFile("orphan.ndjson");
  writeFileSync(
    orphan,
    [
      JSON.stringify({
        kind: "manifest",
        format: "locus-library",
        version: 1,
        counts: { item: 1, itemIntake: 1 },
      }),
      JSON.stringify({
        kind: "item",
        id: "item-1",
        contentType: "post",
        url: "https://example.com/a",
        firstObservedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      }),
      JSON.stringify({
        kind: "itemIntake",
        itemId: "missing",
        actor: "user",
        createdAt: NOW,
        observedFields: [],
        classifications: [],
      }),
    ].join("\n") + "\n",
  );
  await assert.rejects(() => importLibraryArchive(target, orphan), RejectedPayload);
  assert.equal((target.prepare(`SELECT COUNT(*) AS n FROM items`).get() as { n: number }).n, 0);
  assert.equal((target.prepare(`SELECT COUNT(*) AS n FROM item_intake`).get() as { n: number }).n, 0);
  target.close();
});

test("Capture finish still ignores restored Intake Items", async () => {
  const source = mem();
  const intake = commitIntakeItem(source, { libraryId: "local", actor: "user" }, {
    url: "https://example.com/manual",
  }, NOW);
  const tok = lookupToken(source, issueToken(source, "x", null).token)!;
  const started = startSession(source, tok, session);
  ingestBatch(source, {
    sessionId: started.sessionId,
    sequence: 1,
    idempotencyKey: "k1",
    changes: [{
      kind: "upsert",
      externalId: "1",
      item: { contentType: "post", body: "hello", url: "https://x.com/i/status/1", title: "Captured" },
    }],
  });
  const captured = listItems(source, { source: "x" })[0]!;
  const dest = tmpFile("capture.ndjson");
  writeLibraryArchive(source, dest);
  source.close();

  const target = mem();
  await importLibraryArchive(target, dest);
  const restoredTok = lookupToken(target, issueToken(target, "x", null).token)!;
  const restoredSession = startSession(target, restoredTok, session);
  ingestBatch(target, {
    sessionId: restoredSession.sessionId,
    sequence: 1,
    idempotencyKey: "k2",
    changes: [{
      kind: "upsert",
      externalId: "1",
      item: { contentType: "post", body: "hello", url: "https://x.com/i/status/1", title: "Captured" },
    }],
  });
  finishSession(target, { sessionId: restoredSession.sessionId, coverage: "complete" }, restoredTok);
  assert.equal(getItem(target, intake.item.id)?.id, intake.item.id);
  assert.equal(getItem(target, intake.item.id)?.intakeActor, "user");
  assert.equal(getItem(target, captured.id)?.source, "x");
  target.close();
});
