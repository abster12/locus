import { closeSync, createReadStream, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "../db/open.ts";
import { nowIso, tx } from "../db/open.ts";
import { setSetting } from "../core/commands.ts";
import { RejectedPayload, sanitizeUrl } from "../core/sanitize.ts";
import {
  exportReadingRecords,
  importReadingRecords,
  LOCAL_LIBRARY_ID,
  readingArchiveExcluded,
  readingBackfillSettingKey,
  readingLibraryIsEmpty,
  type ReadingArchiveCounts,
  type ReadingArchiveRecord,
} from "./reading/module.ts";
import {
  exportKitchenRecords,
  importKitchenRecords,
  kitchenLibraryIsEmpty,
  type KitchenArchiveRecord,
} from "./kitchen/module.ts";
import {
  atlasBackfillSettingKey,
  atlasBackfillVersionSettingKey,
  atlasLibraryIsEmpty,
  exportAtlasRecords,
  importAtlasRecords,
  type AtlasArchiveRecord,
} from "./atlas/module.ts";
import {
  exportIntakeRecords,
  importIntakeRecords,
  type IntakeArchiveRecord,
} from "./intake/module.ts";

export const ARCHIVE_FORMAT = "locus-library";
export const ARCHIVE_VERSION = 1;
export const MAX_LIBRARY_ARCHIVE_BYTES = Math.max(1, Number(process.env.LOCUS_MAX_LIBRARY_ARCHIVE_BYTES) || 1024 * 1024 * 1024);
export const MAX_ARCHIVE_LINE_BYTES = 2 * 1024 * 1024;

const MAX_ID = 128;
const MAX_TITLE = 500;
const MAX_BODY = 20_000;
const MAX_URL = 2_000;
const MAX_HANDLE = 200;
const MAX_NAME = 200;
const MAX_SETTING = 8_192;
const MAX_METADATA = 8_192;

const EXCLUDED = [
  "meta",
  "capture_tokens",
  "library_capabilities",
  "capture_sessions",
  "capture_batches",
  "capture_runs",
  "capture_seen",
  "link_previews",
  "intake_batches",
] as const;

const KINDS = [
  "sourceAccount",
  "sourceCollection",
  "item",
  "itemState",
  "activity",
  "collection",
  "tag",
  "membership",
  "note",
  "summary",
  "setting",
  "sourceRecord",
  "sourceMembership",
  "readingDocument",
  "readingProvenance",
  "readingProgress",
  "kitchenRecipeDocument",
  "kitchenTonightEntry",
  "atlasPlace",
  "atlasAssignment",
  "itemIntake",
] as const;

type Kind = (typeof KINDS)[number];

export class LibraryConflict extends Error {
  constructor(message = "Delete Library before restoring an archive") {
    super(message);
    this.name = "LibraryConflict";
  }
}

export class ArchiveTooLarge extends Error {
  constructor(message = "archive exceeds configured size limit") {
    super(message);
    this.name = "ArchiveTooLarge";
  }
}

type Rec = Record<string, unknown>;

export function libraryIsEmpty(db: Db): boolean {
  const tables = [
    "items",
    "collections",
    "tags",
    "notes",
    "memberships",
    "activities",
    "item_state",
    "source_accounts",
    "source_collections",
    "source_records",
    "source_memberships",
    "summaries",
    "capture_tokens",
    "library_capabilities",
    "capture_sessions",
    "capture_runs",
    "capture_batches",
    "capture_seen",
    "link_previews",
  ];
  for (const table of tables) {
    if (count(db, `SELECT COUNT(*) AS n FROM ${table}`) > 0) return false;
  }
  return readingLibraryIsEmpty(db) && kitchenLibraryIsEmpty(db) && atlasLibraryIsEmpty(db);
}

export function writeLibraryArchive(
  db: Db,
  dest: string,
  limit = MAX_LIBRARY_ARCHIVE_BYTES,
  libraryId = LOCAL_LIBRARY_ID,
): number {
  const reading = exportReadingRecords(db, libraryId);
  const kitchen = exportKitchenRecords(db, libraryId);
  const atlas = exportAtlasRecords(db, libraryId);
  const intake = exportIntakeRecords(db, libraryId);
  const counts = archiveCounts(db, reading.counts, kitchen.counts, atlas.counts, intake.counts);
  const fd = openSync(dest, "w");
  let bytes = 0;
  try {
    const write = (record: Rec) => {
      const line = `${JSON.stringify(record)}\n`;
      const buf = Buffer.from(line, "utf8");
      if (buf.length > MAX_ARCHIVE_LINE_BYTES) throw new RejectedPayload("archive line too large");
      bytes += buf.length;
      if (bytes > limit) throw new ArchiveTooLarge();
      writeSync(fd, buf);
    };
    write({
      kind: "manifest",
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      exportedAt: nowIso(),
      byteLimit: limit,
      counts,
      excluded: [...EXCLUDED, ...readingArchiveExcluded()],
    });
    for (const record of iterateRecords(db, reading.records, kitchen.records, atlas.records, intake.records)) write(record);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export async function importLibraryArchive(db: Db, path: string): Promise<{ ok: true; records: number }> {
  const dir = mkdtempSync(join(tmpdir(), "locus-archive-stage-"));
  const stage = new DatabaseSync(join(dir, "stage.db"));
  stage.exec(`CREATE TABLE rec (kind TEXT NOT NULL, payload TEXT NOT NULL)`);
  let manifest: Rec | null = null;
  let lineNo = 0;
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    try {
      for await (const rawLine of rl) {
        lineNo += 1;
        const line = lineNo === 1 ? rawLine.replace(/^\uFEFF/, "") : rawLine;
        if (!line.trim()) continue;
        if (Buffer.byteLength(line, "utf8") > MAX_ARCHIVE_LINE_BYTES) throw new RejectedPayload("archive line too large");
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new RejectedPayload("invalid archive JSON");
        }
        if (!parsed || typeof parsed !== "object") throw new RejectedPayload("invalid archive record");
        const rec = parsed as Rec;
        if (lineNo === 1 || (!manifest && rec.kind === "manifest")) {
          manifest = rec;
          if (rec.format !== ARCHIVE_FORMAT) throw new RejectedPayload("unsupported archive format");
          if (rec.version !== ARCHIVE_VERSION) throw new RejectedPayload("unsupported archive version");
          continue;
        }
        if (!manifest) throw new RejectedPayload("archive manifest must be first");
        stageRecord(stage, rec);
      }
    } finally {
      rl.close();
    }
    if (!manifest) throw new RejectedPayload("archive manifest must be first");
    assertCounts(manifest.counts, stage);
    validateGraph(stage);
    const records = count(stage, `SELECT COUNT(*) AS n FROM rec`);
    tx(db, () => {
      if (!libraryIsEmpty(db)) throw new LibraryConflict();
      insertStaged(db, stage);
    });
    return { ok: true, records };
  } finally {
    try {
      stage.close();
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function archiveCounts(
  db: Db,
  reading: ReadingArchiveCounts,
  kitchen: { kitchenRecipeDocument: number; kitchenTonightEntry: number },
  atlas: { atlasPlace: number; atlasAssignment: number },
  intake: { itemIntake: number },
): Record<Kind, number> {
  return {
    sourceAccount: count(db, `SELECT COUNT(*) AS n FROM source_accounts`),
    sourceCollection: count(db, `SELECT COUNT(*) AS n FROM source_collections`),
    item: count(db, `SELECT COUNT(*) AS n FROM items`),
    itemState: count(db, `SELECT COUNT(*) AS n FROM item_state`),
    activity: count(db, `SELECT COUNT(*) AS n FROM activities`),
    collection: count(db, `SELECT COUNT(*) AS n FROM collections`),
    tag: count(db, `SELECT COUNT(*) AS n FROM tags`),
    membership: count(db, `SELECT COUNT(*) AS n FROM memberships`),
    note: count(db, `SELECT COUNT(*) AS n FROM notes`),
    summary: count(db, `SELECT COUNT(*) AS n FROM summaries`),
    setting: count(
      db,
      `SELECT COUNT(*) AS n FROM settings WHERE key != ? AND key != ? AND key != ?`,
      readingBackfillSettingKey(),
      atlasBackfillSettingKey(),
      atlasBackfillVersionSettingKey(),
    ),
    sourceRecord: count(db, `SELECT COUNT(*) AS n FROM source_records`),
    sourceMembership: count(db, `SELECT COUNT(*) AS n FROM source_memberships`),
    ...reading,
    ...kitchen,
    ...atlas,
    ...intake,
  };
}

function* iterateRecords(
  db: Db,
  readingRecords: Iterable<ReadingArchiveRecord>,
  kitchenRecords: readonly KitchenArchiveRecord[],
  atlasRecords: readonly AtlasArchiveRecord[],
  intakeRecords: readonly IntakeArchiveRecord[],
): Generator<Rec> {
  for (const row of all(db, `SELECT id, source, external_id, display_name, created_at FROM source_accounts`)) {
    yield {
      kind: "sourceAccount",
      id: row.id,
      source: row.source,
      externalId: row.external_id,
      displayName: row.display_name,
      createdAt: row.created_at,
    };
  }
  for (const row of all(db, `SELECT id, source_account_id, external_id, name, url, created_at FROM source_collections`)) {
    yield {
      kind: "sourceCollection",
      id: row.id,
      sourceAccountId: row.source_account_id,
      externalId: row.external_id,
      name: row.name,
      url: row.url,
      createdAt: row.created_at,
    };
  }
  for (const row of all(db, `SELECT * FROM items`)) {
    yield {
      kind: "item",
      id: row.id,
      contentType: row.content_type,
      title: row.title,
      body: row.body,
      url: row.url,
      authorName: row.author_name,
      authorHandle: row.author_handle,
      publishedAt: row.published_at,
      sourceSavedAt: row.source_saved_at,
      firstObservedAt: row.first_observed_at,
      capturedAt: row.captured_at,
      media: parseJson(row.media, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  for (const row of all(db, `SELECT item_id, status, snoozed_until, updated_at FROM item_state`)) {
    yield { kind: "itemState", itemId: row.item_id, status: row.status, snoozedUntil: row.snoozed_until, updatedAt: row.updated_at };
  }
  for (const row of all(db, `SELECT id, item_id, kind, occurred_at, timestamp_source FROM activities`)) {
    yield {
      kind: "activity",
      id: row.id,
      itemId: row.item_id,
      activityKind: row.kind,
      occurredAt: row.occurred_at,
      timestampSource: row.timestamp_source,
    };
  }
  for (const row of all(db, `SELECT id, name, description, created_at FROM collections`)) {
    yield { kind: "collection", id: row.id, name: row.name, description: row.description, createdAt: row.created_at };
  }
  for (const row of all(db, `SELECT id, name, color FROM tags`)) {
    yield { kind: "tag", id: row.id, name: row.name, color: row.color };
  }
  for (const row of all(db, `SELECT item_id, target_id, target_kind, actor, created_at FROM memberships`)) {
    yield {
      kind: "membership",
      itemId: row.item_id,
      targetId: row.target_id,
      targetKind: row.target_kind,
      actor: row.actor,
      createdAt: row.created_at,
    };
  }
  for (const row of all(db, `SELECT id, item_id, body, created_at, updated_at FROM notes`)) {
    yield { kind: "note", id: row.id, itemId: row.item_id, body: row.body, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  for (const row of all(db, `SELECT * FROM summaries`)) {
    yield {
      kind: "summary",
      id: row.id,
      scope: row.scope,
      scopeRef: row.scope_ref,
      itemRevisions: row.item_revisions,
      generatorId: row.generator_id,
      generatorVersion: row.generator_version,
      content: row.content,
      citations: row.citations,
      createdAt: row.created_at,
    };
  }
  for (const row of all(
    db,
    `SELECT key, value FROM settings WHERE key != ? AND key != ? AND key != ?`,
    readingBackfillSettingKey(),
    atlasBackfillSettingKey(),
    atlasBackfillVersionSettingKey(),
  )) {
    if (/token|secret|password|cookie/i.test(String(row.key))) continue;
    yield { kind: "setting", key: row.key, value: row.value };
  }
  for (const row of all(db, `SELECT * FROM source_records`)) {
    yield {
      kind: "sourceRecord",
      id: row.id,
      sourceAccountId: row.source_account_id,
      externalId: row.external_id,
      revision: row.revision,
      itemId: row.item_id,
      firstObservedAt: row.first_observed_at,
      lastObservedAt: row.last_observed_at,
      sourcePosition: row.source_position,
      metadata: parseJson(row.metadata, null),
    };
  }
  for (const row of all(db, `SELECT source_collection_id, source_record_id, source_position FROM source_memberships`)) {
    yield {
      kind: "sourceMembership",
      sourceCollectionId: row.source_collection_id,
      sourceRecordId: row.source_record_id,
      sourcePosition: row.source_position,
    };
  }
  // Kitchen records reference Items, so they are written after them. Recipe
  // Documents cannot survive their Item; broken Tonight pins can.
  yield* kitchenRecords;
  yield* atlasRecords;
  yield* readingRecords;
  yield* intakeRecords;
}

type Stage = DatabaseSync;

function stageRecord(staged: Stage, rec: Rec): void {
  const kind = rec.kind;
  if (kind === "manifest") throw new RejectedPayload("duplicate archive manifest");
  if (!isKind(kind)) throw new RejectedPayload("unknown archive record kind");
  validateRecord(rec);
  staged.prepare(`INSERT INTO rec (kind, payload) VALUES (?, ?)`).run(kind, JSON.stringify(rec));
}

function kindRows(staged: Stage, kind: Kind): Rec[] {
  return (staged.prepare(`SELECT payload FROM rec WHERE kind = ?`).all(kind) as { payload: string }[]).map(
    (row) => JSON.parse(row.payload) as Rec,
  );
}

function kindCount(staged: Stage, kind: Kind): number {
  return count(staged, `SELECT COUNT(*) AS n FROM rec WHERE kind = ?`, kind);
}

function isKind(value: unknown): value is Kind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

function assertCounts(raw: unknown, staged: Stage): void {
  const counts = raw && typeof raw === "object" ? (raw as Rec) : {};
  for (const kind of KINDS) {
    const declared = counts[kind];
    const actual = kindCount(staged, kind);
    if (declared == null) {
      if (actual !== 0) throw new RejectedPayload("archive record count mismatch");
      continue;
    }
    if (declared !== actual) throw new RejectedPayload("archive record count mismatch");
  }
}

function validateGraph(staged: Stage): void {
  const itemIds = uniqueIds(kindRows(staged, "item"), "id");
  const accountIds = uniqueIds(kindRows(staged, "sourceAccount"), "id");
  const collectionIds = uniqueIds(kindRows(staged, "sourceCollection"), "id");
  const recordIds = uniqueIds(kindRows(staged, "sourceRecord"), "id");
  const tagIds = uniqueIds(kindRows(staged, "tag"), "id");
  const folderIds = uniqueIds(kindRows(staged, "collection"), "id");
  const noteIds = uniqueIds(kindRows(staged, "note"), "id");
  const activityIds = uniqueIds(kindRows(staged, "activity"), "id");
  const summaryIds = uniqueIds(kindRows(staged, "summary"), "id");
  uniqueKeys(kindRows(staged, "itemState"), (row) => req(row.itemId, MAX_ID));
  uniqueKeys(kindRows(staged, "membership"), (row) => `${req(row.itemId, MAX_ID)}\0${req(row.targetId, MAX_ID)}\0${req(row.targetKind, 40)}`);
  uniqueKeys(kindRows(staged, "sourceMembership"), (row) => `${req(row.sourceCollectionId, MAX_ID)}\0${req(row.sourceRecordId, MAX_ID)}`);
  uniqueKeys(kindRows(staged, "setting"), (row) => req(row.key, 200));
  void noteIds;
  void activityIds;
  void summaryIds;

  for (const row of kindRows(staged, "sourceCollection")) if (!accountIds.has(req(row.sourceAccountId, MAX_ID))) missing("sourceCollection");
  for (const row of kindRows(staged, "itemState")) if (!itemIds.has(req(row.itemId, MAX_ID))) missing("itemState");
  for (const row of kindRows(staged, "activity")) if (!itemIds.has(req(row.itemId, MAX_ID))) missing("activity");
  for (const row of kindRows(staged, "note")) if (!itemIds.has(req(row.itemId, MAX_ID))) missing("note");
  for (const row of kindRows(staged, "membership")) {
    if (!itemIds.has(req(row.itemId, MAX_ID))) missing("membership");
    const target = req(row.targetId, MAX_ID);
    const kind = req(row.targetKind, 40);
    if (kind === "tag" && !tagIds.has(target)) missing("membership");
    if (kind === "collection" && !folderIds.has(target)) missing("membership");
  }
  for (const row of kindRows(staged, "sourceRecord")) {
    if (!accountIds.has(req(row.sourceAccountId, MAX_ID))) missing("sourceRecord");
    if (row.itemId != null && !itemIds.has(req(row.itemId, MAX_ID))) missing("sourceRecord");
  }
  for (const row of kindRows(staged, "sourceMembership")) {
    if (!collectionIds.has(req(row.sourceCollectionId, MAX_ID))) missing("sourceMembership");
    if (!recordIds.has(req(row.sourceRecordId, MAX_ID))) missing("sourceMembership");
  }
}

function insertStaged(db: Db, staged: Stage): void {
  const insAccount = db.prepare(
    `INSERT INTO source_accounts (id, source, external_id, display_name, created_at, account_kind) VALUES (?, ?, ?, ?, ?, 'imported')`,
  );
  for (const row of kindRows(staged, "sourceAccount")) {
    insAccount.run(req(row.id, MAX_ID), req(row.source, 40), req(row.externalId, 400), opt(row.displayName, MAX_HANDLE), req(row.createdAt, 40));
  }
  const insCol = db.prepare(
    `INSERT INTO source_collections (id, source_account_id, external_id, name, url, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const row of kindRows(staged, "sourceCollection")) {
    insCol.run(
      req(row.id, MAX_ID),
      req(row.sourceAccountId, MAX_ID),
      req(row.externalId, 400),
      req(row.name, MAX_NAME),
      optHttpUrl(row.url),
      req(row.createdAt, 40),
    );
  }
  const insItem = db.prepare(
    `INSERT INTO items (
      id, content_type, title, body, url, author_name, author_handle, published_at, source_saved_at,
      first_observed_at, captured_at, media, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of kindRows(staged, "item")) {
    insItem.run(
      req(row.id, MAX_ID),
      req(row.contentType, 40),
      opt(row.title, MAX_TITLE),
      opt(row.body, MAX_BODY),
      reqHttpUrl(row.url),
      opt(row.authorName, MAX_HANDLE),
      opt(row.authorHandle, MAX_HANDLE),
      opt(row.publishedAt, 40),
      opt(row.sourceSavedAt, 40),
      req(row.firstObservedAt, 40),
      opt(row.capturedAt, 40),
      JSON.stringify(asMedia(row.media)),
      req(row.createdAt, 40),
      req(row.updatedAt, 40),
    );
  }
  const insState = db.prepare(`INSERT INTO item_state (item_id, status, snoozed_until, updated_at) VALUES (?, ?, ?, ?)`);
  for (const row of kindRows(staged, "itemState")) {
    insState.run(req(row.itemId, MAX_ID), req(row.status, 40), opt(row.snoozedUntil, 40), req(row.updatedAt, 40));
  }
  const insAct = db.prepare(
    `INSERT INTO activities (id, item_id, kind, occurred_at, timestamp_source, capture_run_id) VALUES (?, ?, ?, ?, ?, NULL)`,
  );
  for (const row of kindRows(staged, "activity")) {
    insAct.run(req(row.id, MAX_ID), req(row.itemId, MAX_ID), req(row.activityKind, 40), req(row.occurredAt, 40), req(row.timestampSource, 40));
  }
  const insFolder = db.prepare(`INSERT INTO collections (id, name, description, created_at) VALUES (?, ?, ?, ?)`);
  for (const row of kindRows(staged, "collection")) {
    insFolder.run(req(row.id, MAX_ID), req(row.name, MAX_NAME), opt(row.description, MAX_BODY), req(row.createdAt, 40));
  }
  const insTag = db.prepare(`INSERT INTO tags (id, name, color) VALUES (?, ?, ?)`);
  for (const row of kindRows(staged, "tag")) insTag.run(req(row.id, MAX_ID), req(row.name, MAX_NAME), opt(row.color, 40));
  const insMem = db.prepare(
    `INSERT INTO memberships (item_id, target_id, target_kind, actor, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const row of kindRows(staged, "membership")) {
    insMem.run(req(row.itemId, MAX_ID), req(row.targetId, MAX_ID), req(row.targetKind, 40), opt(row.actor, 40) ?? "user", req(row.createdAt, 40));
  }
  const insNote = db.prepare(`INSERT INTO notes (id, item_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`);
  for (const row of kindRows(staged, "note")) {
    insNote.run(req(row.id, MAX_ID), req(row.itemId, MAX_ID), req(row.body, MAX_BODY), req(row.createdAt, 40), req(row.updatedAt, 40));
  }
  const insSum = db.prepare(
    `INSERT INTO summaries (id, scope, scope_ref, item_revisions, generator_id, generator_version, content, citations, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of kindRows(staged, "summary")) {
    insSum.run(
      req(row.id, MAX_ID),
      req(row.scope, 40),
      req(row.scopeRef, 400),
      req(row.itemRevisions, MAX_BODY),
      req(row.generatorId, 200),
      req(row.generatorVersion, 80),
      req(row.content, MAX_BODY),
      req(row.citations, MAX_BODY),
      req(row.createdAt, 40),
    );
  }
  const insSetting = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  for (const row of kindRows(staged, "setting")) {
    const key = req(row.key, 200);
    if (key === readingBackfillSettingKey() || key === atlasBackfillSettingKey() || key === atlasBackfillVersionSettingKey() || /token|secret|password|cookie/i.test(key)) continue;
    insSetting.run(key, req(row.value, MAX_SETTING));
  }
  const insRecord = db.prepare(
    `INSERT INTO source_records (
      id, source_account_id, external_id, revision, item_id, first_observed_at, last_observed_at, source_position, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of kindRows(staged, "sourceRecord")) {
    insRecord.run(
      req(row.id, MAX_ID),
      req(row.sourceAccountId, MAX_ID),
      req(row.externalId, 400),
      opt(row.revision, 200),
      opt(row.itemId, MAX_ID),
      req(row.firstObservedAt, 40),
      req(row.lastObservedAt, 40),
      typeof row.sourcePosition === "number" ? row.sourcePosition : null,
      metadataJson(row.metadata),
    );
  }
  const insSrcMem = db.prepare(
    `INSERT INTO source_memberships (source_collection_id, source_record_id, source_position) VALUES (?, ?, ?)`,
  );
  for (const row of kindRows(staged, "sourceMembership")) {
    insSrcMem.run(
      req(row.sourceCollectionId, MAX_ID),
      req(row.sourceRecordId, MAX_ID),
      typeof row.sourcePosition === "number" ? row.sourcePosition : null,
    );
  }
  importIntakeRecords(db, {
    records: kindRows(staged, "itemIntake"),
    itemIds: uniqueIds(kindRows(staged, "item"), "id"),
    tagIds: uniqueIds(kindRows(staged, "tag"), "id"),
  });
  importKitchenRecords(db, {
    recipes: kindRows(staged, "kitchenRecipeDocument"),
    tonight: kindRows(staged, "kitchenTonightEntry"),
    itemIds: uniqueIds(kindRows(staged, "item"), "id"),
  });
  importAtlasRecords(db, {
    places: kindRows(staged, "atlasPlace"),
    assignments: kindRows(staged, "atlasAssignment"),
    itemIds: uniqueIds(kindRows(staged, "item"), "id"),
  });
  importReadingRecords(db, {
    documents: kindRows(staged, "readingDocument"),
    provenance: kindRows(staged, "readingProvenance"),
    progress: kindRows(staged, "readingProgress"),
    itemIds: uniqueIds(kindRows(staged, "item"), "id"),
  });
}

function asMedia(raw: unknown): { kind: string; url: string }[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new RejectedPayload("invalid media");
  return raw.slice(0, 8).map((entry) => {
    if (!entry || typeof entry !== "object") throw new RejectedPayload("invalid media");
    const rec = entry as Rec;
    return { kind: req(rec.kind, 40), url: reqHttpUrl(rec.url) };
  });
}

function metadataJson(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new RejectedPayload("metadata must be an object");
  const json = JSON.stringify(raw);
  if (json.length > MAX_METADATA) throw new RejectedPayload("metadata exceeds 8KB");
  return json;
}

function uniqueIds(rows: Rec[], field: string): Set<string> {
  return uniqueKeys(rows, (row) => req(row[field], MAX_ID));
}

function uniqueKeys(rows: Rec[], keyOf: (row: Rec) => string): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    const id = keyOf(row);
    if (ids.has(id)) throw new RejectedPayload("duplicate archive record");
    ids.add(id);
  }
  return ids;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function validateRecord(rec: Rec): void {
  switch (rec.kind) {
    case "item":
      reqHttpUrl(rec.url);
      reqIso(rec.firstObservedAt);
      reqIso(rec.createdAt);
      reqIso(rec.updatedAt);
      optIso(rec.publishedAt);
      optIso(rec.sourceSavedAt);
      optIso(rec.capturedAt);
      return;
    case "sourceCollection":
      optHttpUrl(rec.url);
      reqIso(rec.createdAt);
      return;
    default:
      return;
  }
}

function reqHttpUrl(value: unknown): string {
  const raw = req(value, MAX_URL);
  try {
    return sanitizeUrl(raw);
  } catch {
    throw new RejectedPayload("invalid archive url");
  }
}

function optHttpUrl(value: unknown): string | null {
  if (value == null || value === "") return null;
  return reqHttpUrl(value);
}

function reqIso(value: unknown): string {
  const raw = req(value, 40);
  if (!ISO.test(raw) || Number.isNaN(Date.parse(raw))) throw new RejectedPayload("invalid archive timestamp");
  return raw;
}

function optIso(value: unknown): string | null {
  if (value == null || value === "") return null;
  return reqIso(value);
}

function req(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new RejectedPayload("invalid archive field");
  return value;
}

function opt(value: unknown, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > max) throw new RejectedPayload("invalid archive field");
  return value;
}

function intOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new RejectedPayload("invalid archive field");
  return Math.floor(value);
}

function missing(kind: string): never {
  throw new RejectedPayload(`missing related ${kind} record`);
}

function count(db: Db, sql: string, ...params: (string | number | null)[]): number {
  return Number((db.prepare(sql).get(...params) as { n: number }).n);
}

function all(db: Db, sql: string, ...params: (string | number | null)[]): Rec[] {
  return db.prepare(sql).all(...params) as Rec[];
}

function parseJson(raw: unknown, fallback: unknown): unknown {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
