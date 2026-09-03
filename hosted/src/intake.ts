import { createHash } from "node:crypto";
import { shelfOfTag } from "../../core/categories.ts";
import {
  MAX_BODY,
  MAX_HANDLE,
  MAX_MEDIA,
  MAX_TITLE,
  MAX_URL,
  RejectedPayload,
  sanitizeItemDraft,
  sanitizeText,
  sanitizeUrl,
} from "../../core/sanitize.ts";
import {
  applyMemberships,
  ensureTag,
  findExistingItemId,
  getLibraryItem,
  insertItem,
  nowIso,
  resolveOrg,
  type ItemCard,
} from "./desk.ts";
import { reconcileItem } from "./reading.ts";
import { all, first, run } from "./sql.ts";

export type IntakeActor = "user" | "agent";

export type IntakeMemberships = {
  tagIds: string[];
  collectionIds: string[];
};

export type IntakeCommitResult = {
  outcome: "created" | "reused";
  item: ItemCard;
  actor: IntakeActor;
  added: IntakeMemberships;
  alreadyPresent: IntakeMemberships;
};

export type IntakeBatchResult = {
  actor: IntakeActor;
  createdAt: string;
  clientMutationId: string;
  contextVersion: string | null;
  instruction: string | null;
  drafts: IntakeCommitResult[];
};

export type IntakeContext = {
  version: string;
  collections: { id: string; name: string; description: string | null }[];
  tags: { id: string; name: string; color: string | null; consequence: string | null }[];
};

export type LibrarySearchHit = {
  id: string;
  title: string;
  url: string;
  source: string | null;
};

export type IntakeEvidence = {
  field: "title" | "body" | "authorName" | "url" | "instruction";
  text: string;
};

export type IntakeClassification = {
  tagId: string;
  rationale: string;
  evidence: IntakeEvidence[];
};

export type PresentedIntakeDraft = {
  item: {
    url: string;
    title: string | null;
    body: string | null;
    authorName: string | null;
    publishedAt: string | null;
    media: { kind: string; url: string }[];
  };
  missing: string[];
  collections: { id: string; name: string; description: string | null }[];
  tags: { id: string | null; name: string; proposed: boolean }[];
  rationale: string | null;
  evidenceBasis: string | null;
  uncertainty: string | null;
};

const ALLOWED_FIELDS = new Set([
  "url",
  "title",
  "body",
  "authorName",
  "publishedAt",
  "media",
  "tagIds",
  "collectionIds",
  "newTags",
]);
const ALLOWED_AGENT_FIELDS = new Set([
  "url",
  "title",
  "body",
  "authorName",
  "publishedAt",
  "media",
  "tagIds",
  "collectionIds",
  "observedFields",
  "classifications",
]);
const ALLOWED_BATCH_FIELDS = new Set(["clientMutationId", "drafts", "instruction", "contextVersion"]);
const ALLOWED_SEARCH_FIELDS = new Set(["url", "q"]);
const ALLOWED_PRESENT_FIELDS = new Set(["drafts"]);
const ALLOWED_TAG_CREATE_FIELDS = new Set(["name"]);
const ALLOWED_PRESENT_DRAFT_FIELDS = new Set([
  "url",
  "title",
  "body",
  "authorName",
  "publishedAt",
  "media",
  "tagIds",
  "collectionIds",
  "proposedNewTags",
  "rationale",
  "evidenceBasis",
  "uncertainty",
]);
const MAX_INTAKE_TAGS = 12;
const MAX_INTAKE_COLLECTIONS = 5;
const MAX_INTAKE_BATCH = 25;
const MAX_PRESENT_DRAFTS = 20;
const MAX_MUTATION_ID = 100;
const MAX_INSTRUCTION = 500;
const MAX_CONTEXT_VERSION = 100;
const MAX_SEARCH_Q = 80;
const MAX_RATIONALE = 280;
const MAX_EVIDENCE = 4;
const OBSERVED_FIELDS = ["title", "body", "authorName", "publishedAt", "media"] as const;
const EVIDENCE_FIELDS = new Set(["title", "body", "authorName", "url", "instruction"]);
const MUTATION_REUSE_ERROR = "clientMutationId was already used for a different change";

type IntakeCommitTrusted = { libraryId: string; actor: IntakeActor; reviewed?: boolean };

export async function getIntakeContext(db: D1Database, libraryId: string): Promise<IntakeContext> {
  const collections = await all<{ id: string; name: string; description: string | null }>(
    db,
    `SELECT id, name, description FROM collections WHERE library_id = ? ORDER BY name`,
    libraryId,
  );
  const tags = await all<{ id: string; name: string; color: string | null }>(
    db,
    `SELECT id, name, color FROM tags WHERE library_id = ? ORDER BY name`,
    libraryId,
  );
  return {
    version: hashContextVersion(collections, tags),
    collections,
    tags: tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      consequence: shelfOfTag(tag.name).key === "food" ? "Appears in Recipe Box" : null,
    })),
  };
}

export async function searchLibrary(
  db: D1Database,
  libraryId: string,
  input: unknown,
): Promise<{ items: LibrarySearchHit[] }> {
  const rec = record(input ?? {}, ALLOWED_SEARCH_FIELDS);
  const url = optionalBounded(rec.url, "url", MAX_URL);
  const q = optionalBounded(rec.q, "q", MAX_SEARCH_Q);
  if (!url && !q) return { items: [] };
  const items: LibrarySearchHit[] = [];
  const seen = new Set<string>();
  if (url) {
    const match = await findExistingItemId(db, libraryId, sanitizeUrl(url));
    if (match) {
      const hit = await searchHit(db, libraryId, match);
      if (hit) {
        items.push(hit);
        seen.add(hit.id);
      }
    }
  }
  if (q) {
    const needle = `%${q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    const rows = await all<{
      id: string;
      title: string | null;
      url: string;
      source: string | null;
    }>(
      db,
      `SELECT i.id, i.title, i.url,
              (SELECT a.source FROM source_records r JOIN source_accounts a ON a.id = r.source_account_id
                WHERE r.item_id = i.id LIMIT 1) AS source
         FROM items i
        WHERE i.library_id = ? AND (i.title LIKE ? ESCAPE '\\' OR i.url LIKE ? ESCAPE '\\')
        ORDER BY i.first_observed_at DESC, i.id
        LIMIT ?`,
      libraryId,
      needle,
      needle,
      MAX_PRESENT_DRAFTS,
    );
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      items.push({
        id: row.id,
        title: row.title?.trim() || "Saved item",
        url: row.url,
        source: row.source,
      });
      if (items.length >= MAX_PRESENT_DRAFTS) break;
    }
  }
  return { items };
}

export async function preparePresentedDrafts(
  db: D1Database,
  libraryId: string,
  input: unknown,
  now = nowIso(),
): Promise<PresentedIntakeDraft[]> {
  const rec = record(input, ALLOWED_PRESENT_FIELDS);
  if (!Array.isArray(rec.drafts)) throw new RejectedPayload("drafts must be an array");
  if (rec.drafts.length === 0) throw new RejectedPayload("drafts required");
  if (rec.drafts.length > MAX_PRESENT_DRAFTS) throw new RejectedPayload(`drafts exceeds ${MAX_PRESENT_DRAFTS}`);
  const drafts: PresentedIntakeDraft[] = [];
  for (const draft of rec.drafts) drafts.push(await presentOne(db, libraryId, draft, now));
  return drafts;
}

export async function createIntakeTag(
  db: D1Database,
  libraryId: string,
  input: unknown,
): Promise<{ tag: { id: string; name: string }; context: IntakeContext }> {
  const rec = record(input, ALLOWED_TAG_CREATE_FIELDS);
  const tag = await ensureTag(db, libraryId, requiredString(rec.name, "name", 40));
  return { tag, context: await getIntakeContext(db, libraryId) };
}

export async function commitIntakeBatch(
  db: D1Database,
  libraryId: string,
  actor: IntakeActor,
  input: unknown,
  now = nowIso(),
): Promise<IntakeBatchResult> {
  return commitDrafts(db, { libraryId, actor }, parseBatch(input), now);
}

export async function commitReviewedDrafts(
  db: D1Database,
  libraryId: string,
  input: unknown,
  now = nowIso(),
): Promise<IntakeBatchResult> {
  return commitDrafts(db, { libraryId, actor: "agent", reviewed: true }, parseBatch(input), now);
}

async function commitDrafts(
  db: D1Database,
  trusted: IntakeCommitTrusted,
  batch: {
    clientMutationId: string | null;
    instruction: string | null;
    contextVersion: string | null;
    drafts: unknown[];
  },
  now: string,
): Promise<IntakeBatchResult> {
  if (trusted.actor !== "user" && trusted.actor !== "agent") {
    throw new RejectedPayload("actor must be user or agent");
  }
  if (batch.drafts.length === 0) throw new RejectedPayload("drafts required");
  if (batch.drafts.length > MAX_INTAKE_BATCH) throw new RejectedPayload(`drafts exceeds ${MAX_INTAKE_BATCH}`);
  const parsed = batch.drafts.map((input) => parseSource(trusted, input, now));
  const hash = batch.clientMutationId ? payloadHash(parsed, batch.instruction, batch.contextVersion) : null;
  if (batch.clientMutationId && hash) {
    const existing = await first<{ payload_hash: string; result_json: string }>(
      db,
      `SELECT payload_hash, result_json FROM intake_batches WHERE library_id = ? AND client_mutation_id = ?`,
      trusted.libraryId,
      batch.clientMutationId,
    );
    if (existing) {
      if (existing.payload_hash !== hash) throw new RejectedPayload(MUTATION_REUSE_ERROR);
      return JSON.parse(existing.result_json) as IntakeBatchResult;
    }
  }
  if (trusted.actor === "agent" && batch.clientMutationId) {
    if (!batch.contextVersion) throw new RejectedPayload("contextVersion is required");
    const context = await getIntakeContext(db, trusted.libraryId);
    if (batch.contextVersion !== context.version) throw new RejectedPayload("stale context");
  }
  for (const entry of parsed) {
    await resolveOrg(db, trusted.libraryId, entry.rec, false);
    await assertClassificationsReady(db, trusted, entry, batch.instruction);
  }
  const drafts: IntakeCommitResult[] = [];
  for (const entry of parsed) {
    drafts.push(await writeDraft(db, trusted, entry, now, batch.instruction));
  }
  const result: IntakeBatchResult = {
    actor: trusted.actor,
    createdAt: now,
    clientMutationId: batch.clientMutationId ?? "",
    contextVersion: batch.contextVersion,
    instruction: batch.instruction,
    drafts,
  };
  if (batch.clientMutationId && hash) {
    try {
      await run(
        db,
        `INSERT INTO intake_batches (
          library_id, client_mutation_id, payload_hash, actor, created_at, context_version, instruction, result_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        trusted.libraryId,
        batch.clientMutationId,
        hash,
        trusted.actor,
        now,
        batch.contextVersion,
        batch.instruction,
        JSON.stringify(result),
      );
    } catch {
      const existing = await first<{ payload_hash: string; result_json: string }>(
        db,
        `SELECT payload_hash, result_json FROM intake_batches WHERE library_id = ? AND client_mutation_id = ?`,
        trusted.libraryId,
        batch.clientMutationId,
      );
      if (existing) {
        if (existing.payload_hash !== hash) throw new RejectedPayload(MUTATION_REUSE_ERROR);
        return JSON.parse(existing.result_json) as IntakeBatchResult;
      }
      throw new Error("Could not record Intake batch");
    }
  }
  return result;
}

async function writeDraft(
  db: D1Database,
  trusted: IntakeCommitTrusted,
  entry: {
    rec: Record<string, unknown>;
    draft: ReturnType<typeof sanitizeItemDraft>;
    observedFields: string[];
    classifications: IntakeClassification[];
  },
  now: string,
  instruction: string | null,
): Promise<IntakeCommitResult> {
  if (trusted.actor === "agent") assertObservedFields(entry.draft, entry.observedFields);
  const org = await resolveOrg(db, trusted.libraryId, entry.rec, true);
  const existingId = await findExistingItemId(db, trusted.libraryId, entry.draft.url);
  let itemId: string;
  let outcome: "created" | "reused";
  if (existingId) {
    itemId = existingId;
    outcome = "reused";
  } else {
    const created = await insertItem(db, trusted.libraryId, entry.draft, now, {
      actor: trusted.actor,
      observedJson: JSON.stringify(entry.observedFields),
    });
    itemId = created.id;
    outcome = created.outcome;
    if (outcome === "created") await reconcileItem(db, trusted.libraryId, itemId);
  }
  const memberships = await applyMemberships(db, itemId, org, now, trusted.actor);
  if (trusted.actor === "agent" && !trusted.reviewed) {
    await persistClassifications(db, itemId, memberships.added.tagIds, entry.classifications, entry.draft, instruction);
  }
  const item = await getLibraryItem(db, trusted.libraryId, itemId);
  if (!item) throw new RejectedPayload("intake item was not persisted");
  return { outcome, item, actor: trusted.actor, ...memberships };
}

async function presentOne(db: D1Database, libraryId: string, input: unknown, now: string): Promise<PresentedIntakeDraft> {
  const rec = record(input, ALLOWED_PRESENT_DRAFT_FIELDS);
  const { draft } = parseSource({ libraryId, actor: "agent", reviewed: true }, {
    url: rec.url,
    title: rec.title,
    body: rec.body,
    authorName: rec.authorName,
    publishedAt: rec.publishedAt,
    media: rec.media,
    tagIds: rec.tagIds,
    collectionIds: rec.collectionIds,
  }, now);
  const org = await resolveOrg(
    db,
    libraryId,
    { tagIds: rec.tagIds, collectionIds: rec.collectionIds, newTags: rec.proposedNewTags },
    false,
  );
  const missing: string[] = [];
  if (!draft.title) missing.push("title");
  if (!draft.body) missing.push("source text");
  if (!draft.authorName) missing.push("author");
  if (!draft.publishedAt) missing.push("publication date");
  if (draft.media.length === 0) missing.push("media");
  return {
    item: {
      url: draft.url,
      title: draft.title ?? null,
      body: draft.body ?? null,
      authorName: draft.authorName ?? null,
      publishedAt: draft.publishedAt ?? null,
      media: draft.media,
    },
    missing,
    collections: org.collections,
    tags: org.tags.map((tag) => ({ id: tag.id, name: tag.name, proposed: tag.id === null })),
    rationale: optionalBounded(rec.rationale, "rationale", MAX_RATIONALE),
    evidenceBasis: optionalBounded(rec.evidenceBasis, "evidenceBasis", MAX_RATIONALE),
    uncertainty: optionalBounded(rec.uncertainty, "uncertainty", MAX_RATIONALE),
  };
}

async function searchHit(db: D1Database, libraryId: string, id: string): Promise<LibrarySearchHit | undefined> {
  const row = await first<{ id: string; title: string | null; url: string; source: string | null }>(
    db,
    `SELECT i.id, i.title, i.url,
            (SELECT a.source FROM source_records r JOIN source_accounts a ON a.id = r.source_account_id
              WHERE r.item_id = i.id LIMIT 1) AS source
       FROM items i WHERE i.id = ? AND i.library_id = ?`,
    id,
    libraryId,
  );
  if (!row) return undefined;
  return {
    id: row.id,
    title: row.title?.trim() || "Saved item",
    url: row.url,
    source: row.source,
  };
}

function hashContextVersion(
  collections: { id: string; name: string }[],
  tags: { id: string; name: string }[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        collections: collections
          .map((collection) => ({ id: collection.id, name: collection.name }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        tags: tags.map((tag) => ({ id: tag.id, name: tag.name })).sort((a, b) => a.id.localeCompare(b.id)),
      }),
    )
    .digest("hex");
}

function payloadHash(
  parsed: {
    rec: Record<string, unknown>;
    draft: ReturnType<typeof sanitizeItemDraft>;
    observedFields: string[];
    classifications: IntakeClassification[];
  }[],
  instruction: string | null,
  contextVersion: string | null,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        instruction,
        contextVersion,
        drafts: parsed.map((entry) => ({
          url: entry.draft.url,
          title: entry.draft.title ?? null,
          body: entry.draft.body ?? null,
          authorName: entry.draft.authorName ?? null,
          publishedAt: submittedPublishedAt(entry.rec),
          media: entry.draft.media,
          observedFields: [...entry.observedFields].sort(),
          tagIds: [...idList(entry.rec.tagIds, "tagIds", MAX_INTAKE_TAGS)].sort(),
          collectionIds: [...idList(entry.rec.collectionIds, "collectionIds", MAX_INTAKE_COLLECTIONS)].sort(),
          newTags: [...stringList(entry.rec.newTags, "newTags", MAX_INTAKE_TAGS)].sort(),
          classifications: entry.classifications,
        })),
      }),
    )
    .digest("hex");
}

function submittedPublishedAt(rec: Record<string, unknown>): string | null {
  if (rec.publishedAt === undefined || rec.publishedAt === null || rec.publishedAt === "") return null;
  return typeof rec.publishedAt === "string" ? rec.publishedAt : null;
}

function parseBatch(input: unknown): {
  clientMutationId: string;
  instruction: string | null;
  contextVersion: string | null;
  drafts: unknown[];
} {
  const rec = record(input, ALLOWED_BATCH_FIELDS);
  const clientMutationId = requiredString(rec.clientMutationId, "clientMutationId", MAX_MUTATION_ID).trim();
  if (!clientMutationId) throw new RejectedPayload("clientMutationId is required");
  if (!Array.isArray(rec.drafts)) throw new RejectedPayload("drafts must be an array");
  return {
    clientMutationId,
    instruction: optionalBounded(rec.instruction, "instruction", MAX_INSTRUCTION),
    contextVersion: optionalBounded(rec.contextVersion, "contextVersion", MAX_CONTEXT_VERSION),
    drafts: rec.drafts,
  };
}

function optionalBounded(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  const text = optionalString(value, field, max)?.trim() ?? "";
  return text || null;
}

function parseSource(
  trusted: IntakeCommitTrusted,
  input: unknown,
  now: string,
): {
  rec: Record<string, unknown>;
  draft: ReturnType<typeof sanitizeItemDraft>;
  observedFields: string[];
  classifications: IntakeClassification[];
} {
  if (trusted.actor !== "user" && trusted.actor !== "agent") {
    throw new RejectedPayload("actor must be user or agent");
  }
  const rec = record(input, trusted.actor === "agent" ? ALLOWED_AGENT_FIELDS : ALLOWED_FIELDS);
  const draft = sanitizeItemDraft({
    contentType: "link",
    url: requiredString(rec.url, "url", MAX_URL),
    title: optionalString(rec.title, "title", MAX_TITLE),
    body: optionalString(rec.body, "body", MAX_BODY),
    authorName: optionalString(rec.authorName, "authorName", MAX_HANDLE),
    publishedAt: optionalString(rec.publishedAt, "publishedAt", 40) || (trusted.actor === "user" ? now.slice(0, 10) : undefined),
    media: media(rec.media),
  });
  let observedFields = trusted.actor === "agent" ? parseObservedFields(rec) : [];
  if (trusted.reviewed && trusted.actor === "agent" && observedFields.length === 0) {
    observedFields = observedFromDraft(draft);
  }
  return {
    rec,
    draft,
    observedFields,
    classifications: trusted.actor === "agent" ? parseClassifications(rec) : [],
  };
}

function parseObservedFields(rec: Record<string, unknown>): string[] {
  const listed = rec.observedFields === undefined || rec.observedFields === null
    ? []
    : stringList(rec.observedFields, "observedFields", OBSERVED_FIELDS.length);
  const seen = new Set<string>();
  for (const field of listed) {
    if (!(OBSERVED_FIELDS as readonly string[]).includes(field)) {
      throw new RejectedPayload(`observedFields ${field} is invalid`);
    }
    if (seen.has(field)) throw new RejectedPayload("observedFields has duplicates");
    seen.add(field);
  }
  return listed;
}

function observedFromDraft(draft: ReturnType<typeof sanitizeItemDraft>): string[] {
  const supplied: string[] = [];
  if (draft.title) supplied.push("title");
  if (draft.body) supplied.push("body");
  if (draft.authorName) supplied.push("authorName");
  if (draft.publishedAt) supplied.push("publishedAt");
  if (draft.media.length > 0) supplied.push("media");
  return supplied;
}

function assertObservedFields(
  draft: ReturnType<typeof sanitizeItemDraft>,
  observedFields: string[],
): void {
  if (observedFromDraft(draft).sort().join() !== [...observedFields].sort().join()) {
    throw new RejectedPayload("observedFields must match submitted source fields");
  }
}

function parseClassifications(rec: Record<string, unknown>): IntakeClassification[] {
  if (rec.classifications === undefined || rec.classifications === null) return [];
  if (!Array.isArray(rec.classifications)) throw new RejectedPayload("classifications must be an array");
  if (rec.classifications.length > MAX_INTAKE_TAGS) {
    throw new RejectedPayload(`classifications exceeds ${MAX_INTAKE_TAGS}`);
  }
  const seen = new Set<string>();
  return rec.classifications.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new RejectedPayload(`classifications ${index} is invalid`);
    }
    const row = entry as Record<string, unknown>;
    for (const key of Object.keys(row)) {
      if (key !== "tagId" && key !== "rationale" && key !== "evidence") {
        throw new RejectedPayload(`unsupported field: classifications.${key}`);
      }
    }
    const tagId = requiredString(row.tagId, "classifications tagId", 80).trim();
    if (!tagId) throw new RejectedPayload(`classifications ${index} tagId is invalid`);
    if (seen.has(tagId)) throw new RejectedPayload("classifications has duplicates");
    seen.add(tagId);
    const rationale = requiredString(row.rationale, "rationale", MAX_RATIONALE).trim();
    if (!rationale) throw new RejectedPayload("rationale is required");
    if (!Array.isArray(row.evidence)) throw new RejectedPayload("evidence must be an array");
    if (row.evidence.length === 0) throw new RejectedPayload("evidence required");
    if (row.evidence.length > MAX_EVIDENCE) throw new RejectedPayload(`evidence exceeds ${MAX_EVIDENCE}`);
    const evidence = row.evidence.map((item, evidenceIndex) => parseEvidence(item, evidenceIndex));
    return { tagId, rationale, evidence };
  });
}

function parseEvidence(input: unknown, index: number): IntakeEvidence {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RejectedPayload(`evidence ${index} is invalid`);
  }
  const rec = input as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (key !== "field" && key !== "text") throw new RejectedPayload(`unsupported field: evidence.${key}`);
  }
  const field = requiredString(rec.field, "evidence field", 20);
  if (!EVIDENCE_FIELDS.has(field)) throw new RejectedPayload(`evidence ${index} field is invalid`);
  const text = requiredString(rec.text, "evidence text", MAX_RATIONALE).trim();
  if (!text) throw new RejectedPayload(`evidence ${index} text is required`);
  return { field: field as IntakeEvidence["field"], text };
}

async function assertClassificationsReady(
  db: D1Database,
  trusted: IntakeCommitTrusted,
  entry: {
    rec: Record<string, unknown>;
    draft: ReturnType<typeof sanitizeItemDraft>;
    classifications: IntakeClassification[];
  },
  instruction: string | null,
): Promise<void> {
  if (trusted.actor !== "agent" || trusted.reviewed) return;
  const org = await resolveOrg(db, trusted.libraryId, entry.rec, false);
  const existingId = await findExistingItemId(db, trusted.libraryId, entry.draft.url);
  const addedTagIds: string[] = [];
  for (const tag of org.tags) {
    if (!tag.id) throw new RejectedPayload("unknown tag");
    if (existingId && (await tagMembershipExists(db, existingId, tag.id))) continue;
    addedTagIds.push(tag.id);
  }
  validateClassifications(addedTagIds, entry.classifications, entry.draft, instruction);
  for (const classification of entry.classifications) {
    if (!addedTagIds.includes(classification.tagId) && !(existingId && (await tagMembershipExists(db, existingId, classification.tagId)))) {
      throw new RejectedPayload("classification for unrequested tag");
    }
  }
}

function validateClassifications(
  addedTagIds: string[],
  classifications: IntakeClassification[],
  draft: ReturnType<typeof sanitizeItemDraft>,
  instruction: string | null,
): void {
  const byTag = new Map(classifications.map((entry) => [entry.tagId, entry]));
  for (const tagId of addedTagIds) {
    const classification = byTag.get(tagId);
    if (!classification) throw new RejectedPayload("classification required");
    for (const evidence of classification.evidence) {
      const source = evidence.field === "instruction"
        ? instruction
        : evidence.field === "url"
          ? draft.url
          : evidence.field === "title"
            ? draft.title ?? null
            : evidence.field === "body"
              ? draft.body ?? null
              : draft.authorName ?? null;
      if (!source || !source.includes(evidence.text)) throw new RejectedPayload("invalid evidence");
    }
  }
}

async function persistClassifications(
  db: D1Database,
  itemId: string,
  addedTagIds: string[],
  classifications: IntakeClassification[],
  draft: ReturnType<typeof sanitizeItemDraft>,
  instruction: string | null,
): Promise<void> {
  validateClassifications(addedTagIds, classifications, draft, instruction);
  const added = new Set(addedTagIds);
  for (const tagId of added) {
    const classification = classifications.find((entry) => entry.tagId === tagId);
    if (!classification) continue;
    await run(
      db,
      `INSERT INTO intake_tag_evidence (item_id, tag_id, rationale, evidence_json) VALUES (?, ?, ?, ?)`,
      itemId,
      tagId,
      classification.rationale,
      JSON.stringify(classification.evidence),
    );
  }
  for (const classification of classifications) {
    if (!added.has(classification.tagId) && !(await tagMembershipExists(db, itemId, classification.tagId))) {
      throw new RejectedPayload("classification for unrequested tag");
    }
  }
}

async function tagMembershipExists(db: D1Database, itemId: string, tagId: string): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM memberships WHERE item_id = ? AND target_id = ? AND target_kind = 'tag'`,
    itemId,
    tagId,
  );
  return Boolean(row);
}

function record(input: unknown, allowed: Set<string>): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RejectedPayload("invalid payload");
  const rec = input as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) throw new RejectedPayload(`unsupported field: ${key}`);
  }
  return rec;
}

function requiredString(value: unknown, field: string, max: number): string {
  const text = optionalString(value, field, max);
  if (!text) throw new RejectedPayload(`${field} is required`);
  return text;
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new RejectedPayload(`${field} must be a string`);
  if (value.length > max) throw new RejectedPayload(`${field} is too long`);
  assertSafeDisplay(field, value);
  return value;
}

function stringList(value: unknown, field: string, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RejectedPayload(`${field} must be an array`);
  if (value.length > max) throw new RejectedPayload(`${field} exceeds ${max}`);
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new RejectedPayload(`${field} ${index} must be a string`);
    assertSafeDisplay(`${field} ${index}`, entry);
    return entry;
  });
}

function idList(value: unknown, field: string, max: number): string[] {
  return stringList(value, field, max).map((entry, index) => {
    const id = entry.trim();
    if (!id || id.length > 80) throw new RejectedPayload(`${field} ${index} is invalid`);
    return id;
  });
}

function media(value: unknown): { kind: string; url: string }[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new RejectedPayload("media must be an array");
  if (value.length > MAX_MEDIA) throw new RejectedPayload("media exceeds 8 items");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new RejectedPayload(`media[${index}] is invalid`);
    const rec = entry as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (key !== "kind" && key !== "url") throw new RejectedPayload(`unsupported field: media.${key}`);
    }
    if (typeof rec.url !== "string") throw new RejectedPayload(`media[${index}].url is required`);
    if (rec.url.length > MAX_URL) throw new RejectedPayload(`media[${index}].url is too long`);
    assertSafeDisplay(`media[${index}].url`, rec.url);
    if (rec.kind !== undefined && typeof rec.kind !== "string") {
      throw new RejectedPayload(`media[${index}].kind must be a string`);
    }
    return { kind: typeof rec.kind === "string" ? rec.kind : "unknown", url: rec.url };
  });
}

function assertSafeDisplay(field: string, value: string): void {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/.test(value)) {
    throw new RejectedPayload(`${field} contains control characters`);
  }
}
