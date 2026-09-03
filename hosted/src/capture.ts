import { createHash } from "node:crypto";
import { parseJsonl } from "../../packages/import-format/index.ts";
import type {
  CaptureBatchV1,
  CaptureFinishV1,
  CaptureSessionV1,
  ItemDraftWireV1,
} from "../../packages/protocol/types.ts";
import { RejectedPayload } from "../../core/sanitize.ts";
import { isSourceId, type SourceId } from "../../core/types.ts";
import { resolvedAccountDisplayName } from "./source-helpers.ts";
import { nowIso } from "./desk.ts";
import { reconcileItem } from "./reading.ts";
import { all, first, run } from "./sql.ts";

export class CaptureAuthorizationError extends Error {
  constructor(
    readonly statusCode: 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = "CaptureAuthorizationError";
  }
}

export type SourceAccountKind = "live" | "imported" | "disconnected";

export type CaptureToken = {
  id: string;
  libraryId: string;
  source: string;
  sourceAccountId: string | null;
  revokedAt: string | null;
};

type SessionRow = {
  id: string;
  library_id: string;
  token_id: string;
  source: string;
  source_account_id: string;
  source_collection_id: string;
  capture_run_id: string;
  last_sequence: number;
  finished_at: string | null;
  observed_at: string;
};

type AccountRow = {
  id: string;
  library_id: string;
  source: string;
  external_id: string;
  display_name: string | null;
  account_kind: SourceAccountKind;
};

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isThinBody(body: string | null | undefined): boolean {
  if (!body) return true;
  const t = body.trim();
  return t.length === 0 || /^https?:\/\/\S+$/i.test(t);
}

export async function issueToken(
  db: D1Database,
  libraryId: string,
  source: SourceId | "*",
  accountId: string | null,
): Promise<{ token: string; tokenId: string }> {
  const token = `loc_${crypto.randomUUID().replaceAll("-", "")}`;
  const tokenId = crypto.randomUUID();
  await run(
    db,
    `INSERT INTO capture_tokens (id, library_id, token_hash, source, source_account_id, capabilities, created_at)
     VALUES (?, ?, ?, ?, ?, 'ingest', ?)`,
    tokenId,
    libraryId,
    hashToken(token),
    source,
    accountId,
    nowIso(),
  );
  return { token, tokenId };
}

export async function lookupToken(db: D1Database, token: string): Promise<CaptureToken | null> {
  if (!token) return null;
  const row = await first<{
    id: string;
    library_id: string;
    source: string;
    source_account_id: string | null;
    revoked_at: string | null;
  }>(
    db,
    `SELECT id, library_id, source, source_account_id, revoked_at FROM capture_tokens WHERE token_hash = ?`,
    hashToken(token),
  );
  if (!row) return null;
  return {
    id: row.id,
    libraryId: row.library_id,
    source: row.source,
    sourceAccountId: row.source_account_id,
    revokedAt: row.revoked_at,
  };
}

export async function revokeTokenById(db: D1Database, tokenId: string): Promise<void> {
  await run(db, `UPDATE capture_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, nowIso(), tokenId);
}

export async function revokeTokensForAccount(db: D1Database, accountId: string): Promise<void> {
  await run(
    db,
    `UPDATE capture_tokens SET revoked_at = ? WHERE source_account_id = ? AND revoked_at IS NULL`,
    nowIso(),
    accountId,
  );
}

function isPlaceholderAccount(externalId: string): boolean {
  return (
    !externalId ||
    externalId === "extension" ||
    externalId === "pending" ||
    externalId.startsWith("pending:") ||
    externalId === "unknown"
  );
}

async function loadAccount(db: D1Database, accountId: string): Promise<AccountRow | null> {
  return first<AccountRow>(
    db,
    `SELECT id, library_id, source, external_id, display_name, account_kind FROM source_accounts WHERE id = ?`,
    accountId,
  );
}

async function mergeAccount(db: D1Database, fromId: string, toId: string): Promise<void> {
  if (fromId === toId) return;
  await run(db, `UPDATE capture_tokens SET source_account_id = ? WHERE source_account_id = ?`, toId, fromId);
  await run(db, `UPDATE capture_jobs SET source_account_id = ? WHERE source_account_id = ?`, toId, fromId);
  await run(db, `UPDATE capture_sessions SET source_account_id = ? WHERE source_account_id = ?`, toId, fromId);
  const fromCollections = await all<{ id: string; external_id: string }>(
    db,
    `SELECT id, external_id FROM source_collections WHERE source_account_id = ?`,
    fromId,
  );
  for (const collection of fromCollections) {
    const existing = await first<{ id: string }>(
      db,
      `SELECT id FROM source_collections WHERE source_account_id = ? AND external_id = ?`,
      toId,
      collection.external_id,
    );
    if (!existing) {
      await run(db, `UPDATE source_collections SET source_account_id = ? WHERE id = ?`, toId, collection.id);
      continue;
    }
    await run(db, `UPDATE capture_runs SET source_collection_id = ? WHERE source_collection_id = ?`, existing.id, collection.id);
    await run(db, `UPDATE capture_sessions SET source_collection_id = ? WHERE source_collection_id = ?`, existing.id, collection.id);
    await run(
      db,
      `INSERT OR IGNORE INTO source_memberships (source_collection_id, source_record_id, source_position)
       SELECT ?, source_record_id, source_position FROM source_memberships WHERE source_collection_id = ?`,
      existing.id,
      collection.id,
    );
    await run(db, `DELETE FROM source_memberships WHERE source_collection_id = ?`, collection.id);
    await run(db, `DELETE FROM source_collections WHERE id = ?`, collection.id);
  }
  const fromRecords = await all<{ id: string; external_id: string }>(
    db,
    `SELECT id, external_id FROM source_records WHERE source_account_id = ?`,
    fromId,
  );
  for (const record of fromRecords) {
    const existing = await first<{ id: string }>(
      db,
      `SELECT id FROM source_records WHERE source_account_id = ? AND external_id = ?`,
      toId,
      record.external_id,
    );
    if (!existing) {
      await run(db, `UPDATE source_records SET source_account_id = ? WHERE id = ?`, toId, record.id);
      continue;
    }
    await run(
      db,
      `INSERT OR IGNORE INTO source_memberships (source_collection_id, source_record_id, source_position)
       SELECT source_collection_id, ?, source_position FROM source_memberships WHERE source_record_id = ?`,
      existing.id,
      record.id,
    );
    await run(db, `DELETE FROM source_memberships WHERE source_record_id = ?`, record.id);
    await run(db, `DELETE FROM source_records WHERE id = ?`, record.id);
  }
  await run(db, `DELETE FROM source_accounts WHERE id = ?`, fromId);
}

async function ensureAccount(
  db: D1Database,
  libraryId: string,
  source: string,
  externalId: string,
  boundAccountId: string | null,
  accountKind: SourceAccountKind,
): Promise<string> {
  if (boundAccountId) {
    const existing = await loadAccount(db, boundAccountId);
    if (!existing || existing.library_id !== libraryId) {
      throw new CaptureAuthorizationError(403, "token is bound to a missing account");
    }
    if (existing.source !== source) {
      throw new CaptureAuthorizationError(403, "token is not valid for this source account");
    }
    if (existing.account_kind !== accountKind && existing.account_kind !== "disconnected") {
      throw new CaptureAuthorizationError(403, "token is not valid for this source account kind");
    }
    if (isPlaceholderAccount(existing.external_id) && !isPlaceholderAccount(externalId)) {
      const collision = await first<{ id: string; account_kind: SourceAccountKind; display_name: string | null }>(
        db,
        `SELECT id, account_kind, display_name FROM source_accounts
          WHERE library_id = ? AND source = ? AND external_id = ? AND id != ? AND account_kind != 'imported'`,
        libraryId,
        source,
        externalId,
        existing.id,
      );
      if (collision) {
        if (collision.account_kind === "disconnected") {
          await run(db, `UPDATE source_accounts SET account_kind = 'live' WHERE id = ?`, collision.id);
        }
        await run(
          db,
          `UPDATE source_accounts SET display_name = ? WHERE id = ?`,
          resolvedAccountDisplayName(collision.display_name, externalId),
          collision.id,
        );
        await mergeAccount(db, existing.id, collision.id);
        return collision.id;
      }
      await run(
        db,
        `UPDATE source_accounts SET external_id = ?, display_name = ? WHERE id = ?`,
        externalId,
        resolvedAccountDisplayName(existing.display_name, externalId),
        existing.id,
      );
    }
    if (existing.account_kind === "disconnected") {
      await run(db, `UPDATE source_accounts SET account_kind = 'live' WHERE id = ?`, existing.id);
    }
    return existing.id;
  }
  const found = await first<{ id: string }>(
    db,
    `SELECT id FROM source_accounts WHERE library_id = ? AND source = ? AND external_id = ? AND account_kind = ?`,
    libraryId,
    source,
    externalId,
    accountKind,
  );
  if (found) return found.id;
  const id = crypto.randomUUID();
  await run(
    db,
    `INSERT INTO source_accounts (id, library_id, source, external_id, display_name, created_at, account_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    libraryId,
    source,
    externalId,
    resolvedAccountDisplayName(null, externalId),
    nowIso(),
    accountKind,
  );
  return id;
}

async function ensureCollection(
  db: D1Database,
  libraryId: string,
  accountId: string,
  externalId: string,
  name: string | undefined,
  url: string | undefined,
): Promise<string> {
  const found = await first<{ id: string }>(
    db,
    `SELECT id FROM source_collections WHERE source_account_id = ? AND external_id = ?`,
    accountId,
    externalId,
  );
  if (found) {
    if (name) {
      await run(
        db,
        `UPDATE source_collections SET name = COALESCE(?, name), url = COALESCE(?, url) WHERE id = ?`,
        name,
        url ?? null,
        found.id,
      );
    }
    return found.id;
  }
  const id = crypto.randomUUID();
  await run(
    db,
    `INSERT INTO source_collections (id, library_id, source_account_id, external_id, name, url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    libraryId,
    accountId,
    externalId,
    name || externalId,
    url ?? null,
    nowIso(),
  );
  return id;
}

export async function startSession(
  db: D1Database,
  token: CaptureToken,
  session: CaptureSessionV1,
  opts?: { accountKind?: SourceAccountKind },
): Promise<{ sessionId: string; captureRunId: string; sourceAccountId: string }> {
  const sessionSource = session.source;
  if (token.source !== "*" && token.source !== sessionSource) {
    throw new CaptureAuthorizationError(403, "token is not valid for this source");
  }
  const source = token.source === "*" ? sessionSource : token.source;
  const accountKind = opts?.accountKind ?? "live";
  const accountId = await ensureAccount(
    db,
    token.libraryId,
    source,
    session.accountExternalId,
    token.sourceAccountId,
    accountKind,
  );
  const collectionId = await ensureCollection(
    db,
    token.libraryId,
    accountId,
    session.collection.externalId,
    session.collection.name,
    session.collection.url,
  );
  const captureRunId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `INSERT INTO capture_runs (
          id, library_id, source_collection_id, producer_id, producer_version, started_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'running')`,
      )
      .bind(captureRunId, token.libraryId, collectionId, session.producer.id, session.producer.version, now),
    db
      .prepare(
        `INSERT INTO capture_sessions (
          id, library_id, token_id, source, source_account_id, source_collection_id, producer_id, producer_version,
          mode, observed_at, capture_run_id, account_external_id, collection_external_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        sessionId,
        token.libraryId,
        token.id,
        source,
        accountId,
        collectionId,
        session.producer.id,
        session.producer.version,
        session.mode,
        session.observedAt,
        captureRunId,
        session.accountExternalId,
        session.collection.externalId,
      ),
  ]);
  return { sessionId, captureRunId, sourceAccountId: accountId };
}

async function loadSession(db: D1Database, sessionId: string): Promise<SessionRow | null> {
  return first<SessionRow>(
    db,
    `SELECT id, library_id, token_id, source, source_account_id, source_collection_id, capture_run_id,
            last_sequence, finished_at, observed_at
       FROM capture_sessions WHERE id = ?`,
    sessionId,
  );
}

function assertSessionAccess(session: SessionRow, token: CaptureToken): void {
  if (session.library_id !== token.libraryId) {
    throw new CaptureAuthorizationError(404, "unknown session");
  }
  if (session.token_id !== token.id) throw new CaptureAuthorizationError(403, "token cannot access this session");
  if (token.source !== "*" && token.source !== session.source) {
    throw new CaptureAuthorizationError(403, "token is not valid for this session source");
  }
  if (token.sourceAccountId !== null && token.sourceAccountId !== session.source_account_id) {
    throw new CaptureAuthorizationError(403, "token is not valid for this session account");
  }
}

function preferCompleteBody(incoming: string | null, previous: string | null): string | null {
  if (!isThinBody(incoming)) return incoming?.trim() || null;
  if (!isThinBody(previous)) return previous?.trim() || null;
  return incoming?.trim() || previous?.trim() || null;
}

async function persistCapturedItem(
  db: D1Database,
  libraryId: string,
  draft: ItemDraftWireV1,
  observedAt: string,
  activityKind: string,
  captureRunId: string,
): Promise<{ id: string; inserted: boolean }> {
  const existing = await first<{ id: string; body: string | null }>(
    db,
    `SELECT id, body FROM items WHERE library_id = ? AND url = ?`,
    libraryId,
    draft.url,
  );
  const now = nowIso();
  if (existing) {
    await db.batch([
      db
        .prepare(
          `UPDATE items SET content_type = ?, title = ?, body = ?, author_name = ?, author_handle = ?,
            published_at = COALESCE(?, published_at), source_saved_at = COALESCE(?, source_saved_at),
            captured_at = ?, media = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(
          draft.contentType,
          draft.title ?? null,
          preferCompleteBody(draft.body ?? null, existing.body),
          draft.authorName ?? null,
          draft.authorHandle ?? null,
          draft.publishedAt?.trim() || null,
          draft.sourceSavedAt?.trim() || null,
          observedAt,
          JSON.stringify(draft.media ?? []),
          now,
          existing.id,
        ),
      db
        .prepare(
          `INSERT INTO activities (id, item_id, kind, occurred_at, timestamp_source, capture_run_id)
           VALUES (?, ?, 'updated', ?, 'locus', ?)`,
        )
        .bind(crypto.randomUUID(), existing.id, observedAt, captureRunId),
    ]);
    return { id: existing.id, inserted: false };
  }
  const itemId = crypto.randomUUID();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO items (
            id, library_id, content_type, title, body, url, author_name, author_handle, published_at, source_saved_at,
            first_observed_at, captured_at, media, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          itemId,
          libraryId,
          draft.contentType,
          draft.title ?? null,
          draft.body ?? null,
          draft.url,
          draft.authorName ?? null,
          draft.authorHandle ?? null,
          draft.publishedAt?.trim() || null,
          draft.sourceSavedAt?.trim() || null,
          observedAt,
          observedAt,
          JSON.stringify(draft.media ?? []),
          now,
          now,
        ),
      db.prepare(`INSERT INTO item_state (item_id, status, snoozed_until, updated_at) VALUES (?, 'inbox', NULL, ?)`).bind(
        itemId,
        now,
      ),
      db
        .prepare(
          `INSERT INTO activities (id, item_id, kind, occurred_at, timestamp_source, capture_run_id)
           VALUES (?, ?, ?, ?, 'locus', ?)`,
        )
        .bind(crypto.randomUUID(), itemId, activityKind, observedAt, captureRunId),
    ]);
    return { id: itemId, inserted: true };
  } catch {
    const raced = await first<{ id: string }>(
      db,
      `SELECT id FROM items WHERE library_id = ? AND url = ?`,
      libraryId,
      draft.url,
    );
    if (!raced) throw new Error("Could not save captured Item");
    return { id: raced.id, inserted: false };
  }
}

async function upsertItem(
  db: D1Database,
  libraryId: string,
  args: {
    accountId: string;
    collectionId: string;
    captureRunId: string;
    observedAt: string;
    change: Extract<CaptureBatchV1["changes"][number], { kind: "upsert" }>;
    activityKind: "detected" | "captured" | "imported";
  },
): Promise<"inserted" | "updated"> {
  const existing = await first<{ id: string; item_id: string | null }>(
    db,
    `SELECT id, item_id FROM source_records WHERE source_account_id = ? AND external_id = ?`,
    args.accountId,
    args.change.externalId,
  );
  const persisted = await persistCapturedItem(
    db,
    libraryId,
    args.change.item,
    args.observedAt,
    existing?.item_id ? "updated" : args.activityKind,
    args.captureRunId,
  );
  const recordId = existing?.id ?? crypto.randomUUID();
  if (existing) {
    await run(
      db,
      `UPDATE source_records SET revision = ?, last_observed_at = ?, source_position = ?, metadata = ?, item_id = ? WHERE id = ?`,
      args.change.revision ?? null,
      args.observedAt,
      args.change.sourcePosition ?? null,
      args.change.metadata ? JSON.stringify(args.change.metadata) : null,
      persisted.id,
      existing.id,
    );
  } else {
    await run(
      db,
      `INSERT INTO source_records (
        id, library_id, source_account_id, external_id, revision, item_id, first_observed_at, last_observed_at, source_position, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      recordId,
      libraryId,
      args.accountId,
      args.change.externalId,
      args.change.revision ?? null,
      persisted.id,
      args.observedAt,
      args.observedAt,
      args.change.sourcePosition ?? null,
      args.change.metadata ? JSON.stringify(args.change.metadata) : null,
    );
  }
  await run(
    db,
    `INSERT OR IGNORE INTO source_memberships (source_collection_id, source_record_id, source_position) VALUES (?, ?, ?)`,
    args.collectionId,
    existing?.id ?? recordId,
    args.change.sourcePosition ?? null,
  );
  await reconcileItem(db, libraryId, persisted.id);
  return persisted.inserted && !existing?.item_id ? "inserted" : "updated";
}

async function applyRemove(
  db: D1Database,
  session: { source_account_id: string; source_collection_id: string; capture_run_id: string },
  externalId: string,
  observedAt: string,
): Promise<number> {
  const record = await first<{ id: string; item_id: string | null }>(
    db,
    `SELECT id, item_id FROM source_records WHERE source_account_id = ? AND external_id = ?`,
    session.source_account_id,
    externalId,
  );
  if (!record) return 0;
  const deleted = await run(
    db,
    `DELETE FROM source_memberships WHERE source_collection_id = ? AND source_record_id = ?`,
    session.source_collection_id,
    record.id,
  );
  if (!Number(deleted.meta.changes ?? 0)) return 0;
  if (record.item_id) {
    await run(
      db,
      `INSERT INTO activities (id, item_id, kind, occurred_at, timestamp_source, capture_run_id)
       VALUES (?, ?, 'source_removed', ?, 'source', ?)`,
      crypto.randomUUID(),
      record.item_id,
      observedAt,
      session.capture_run_id,
    );
  }
  return 1;
}

export async function ingestBatch(
  db: D1Database,
  batch: CaptureBatchV1,
  opts?: { activityKind?: "detected" | "captured" | "imported"; token?: CaptureToken },
): Promise<{ replayed: boolean; inserted: number; updated: number; upserted: number; removed: number }> {
  const session = await loadSession(db, batch.sessionId);
  if (!session) throw new CaptureAuthorizationError(404, "unknown session");
  if (opts?.token) assertSessionAccess(session, opts.token);
  if (session.finished_at) throw new RejectedPayload("session already finished");

  const prior = await first<{ sequence: number }>(
    db,
    `SELECT sequence FROM capture_batches WHERE session_id = ? AND idempotency_key = ?`,
    batch.sessionId,
    batch.idempotencyKey,
  );
  if (prior) return { replayed: true, inserted: 0, updated: 0, upserted: 0, removed: 0 };

  if (batch.sequence !== session.last_sequence + 1) {
    throw new RejectedPayload(`unexpected sequence ${batch.sequence}, expected ${session.last_sequence + 1}`);
  }

  let inserted = 0;
  let updated = 0;
  let removed = 0;
  for (const change of batch.changes) {
    await run(
      db,
      `INSERT OR IGNORE INTO capture_seen (capture_run_id, external_id) VALUES (?, ?)`,
      session.capture_run_id,
      change.externalId,
    );
    if (change.kind === "upsert") {
      const result = await upsertItem(db, session.library_id, {
        accountId: session.source_account_id,
        collectionId: session.source_collection_id,
        captureRunId: session.capture_run_id,
        observedAt: session.observed_at,
        change,
        activityKind: opts?.activityKind ?? "captured",
      });
      if (result === "inserted") inserted += 1;
      else updated += 1;
    } else {
      removed += await applyRemove(db, session, change.externalId, change.observedAt);
    }
  }

  await db.batch([
    db
      .prepare(`INSERT INTO capture_batches (session_id, sequence, idempotency_key) VALUES (?, ?, ?)`)
      .bind(batch.sessionId, batch.sequence, batch.idempotencyKey),
    db.prepare(`UPDATE capture_sessions SET last_sequence = ? WHERE id = ?`).bind(batch.sequence, batch.sessionId),
    db
      .prepare(
        `UPDATE capture_runs SET last_sequence = ?, seen_count = seen_count + ?, upserted_count = upserted_count + ?,
          removed_count = removed_count + ?, checkpoint = ? WHERE id = ?`,
      )
      .bind(
        batch.sequence,
        batch.changes.length,
        inserted + updated,
        removed,
        JSON.stringify({ sequence: batch.sequence, idempotencyKey: batch.idempotencyKey }),
        session.capture_run_id,
      ),
  ]);
  return { replayed: false, inserted, updated, upserted: inserted + updated, removed };
}

export async function finishSession(
  db: D1Database,
  finish: CaptureFinishV1,
  token?: CaptureToken,
): Promise<{ removed: number }> {
  const session = await loadSession(db, finish.sessionId);
  if (!session) throw new CaptureAuthorizationError(404, "unknown session");
  if (token) assertSessionAccess(session, token);
  if (session.finished_at) return { removed: 0 };

  let removed = 0;
  if (finish.coverage === "complete") {
    const stale = await all<{ external_id: string }>(
      db,
      `SELECT sr.external_id
         FROM source_memberships sm
         JOIN source_records sr ON sr.id = sm.source_record_id
        WHERE sm.source_collection_id = ?
          AND sr.external_id NOT IN (SELECT external_id FROM capture_seen WHERE capture_run_id = ?)`,
      session.source_collection_id,
      session.capture_run_id,
    );
    for (const row of stale) {
      removed += await applyRemove(db, session, row.external_id, nowIso());
    }
  }

  const now = nowIso();
  await db.batch([
    db
      .prepare(`UPDATE capture_sessions SET finished_at = ?, coverage = ? WHERE id = ?`)
      .bind(now, finish.coverage, finish.sessionId),
    db
      .prepare(
        `UPDATE capture_runs SET finished_at = ?, coverage = ?, status = 'ok', removed_count = removed_count + ?, checkpoint = ? WHERE id = ?`,
      )
      .bind(now, finish.coverage, removed, finish.cursor ? JSON.stringify(finish.cursor) : null, session.capture_run_id),
  ]);
  return { removed };
}

export async function cancelRun(db: D1Database, captureRunId: string): Promise<void> {
  await run(
    db,
    `UPDATE capture_runs SET finished_at = ?, status = 'cancelled', coverage = 'partial', error_code = 'interrupted', error_detail = 'stopped by user' WHERE id = ? AND finished_at IS NULL`,
    nowIso(),
    captureRunId,
  );
}

export async function knownCompleteIds(db: D1Database, token: CaptureToken, asked?: string | null): Promise<string[]> {
  const source = token.source === "*" && asked && isSourceId(asked) ? asked : token.source;
  const accountId = token.source === "*" ? null : token.sourceAccountId;
  const rows = accountId
    ? await all<{ id: string; body: string | null }>(
        db,
        `SELECT sr.external_id AS id, i.body AS body
           FROM source_records sr
           JOIN items i ON i.id = sr.item_id
          WHERE sr.library_id = ? AND sr.source_account_id = ?`,
        token.libraryId,
        accountId,
      )
    : source === "*"
      ? await all<{ id: string; body: string | null }>(
          db,
          `SELECT sr.external_id AS id, i.body AS body
             FROM source_records sr
             JOIN items i ON i.id = sr.item_id
            WHERE sr.library_id = ?`,
          token.libraryId,
        )
      : await all<{ id: string; body: string | null }>(
          db,
          `SELECT sr.external_id AS id, i.body AS body
             FROM source_records sr
             JOIN source_accounts sa ON sa.id = sr.source_account_id
             JOIN items i ON i.id = sr.item_id
            WHERE sr.library_id = ? AND sa.source = ?`,
          token.libraryId,
          source,
        );
  return rows.filter((row) => !isThinBody(row.body)).map((row) => row.id);
}

export type ImportResult = {
  sessions: number;
  batches: number;
  changes: number;
  inserted: number;
  updated: number;
  removed: number;
  replayed: number;
  errors: string[];
};

export async function importJsonl(
  db: D1Database,
  libraryId: string,
  text: string,
  opts: { dryRun: boolean },
): Promise<ImportResult> {
  const records = parseJsonl(text);
  const errors: string[] = [];
  let sessions = 0;
  let batches = 0;
  let changes = 0;
  let inserted = 0;
  let updated = 0;
  let removed = 0;
  let replayed = 0;
  if (opts.dryRun) {
    for (const rec of records) {
      if (rec.type === "session") sessions += 1;
      else if (rec.type === "batch") {
        batches += 1;
        changes += rec.changes.length;
      }
    }
    return { sessions, batches, changes, inserted, updated, removed, replayed, errors };
  }

  let current: { sessionId: string } | null = null;
  let token: CaptureToken | null = null;
  for (const rec of records) {
    if (rec.type === "session") {
      const source = rec.source;
      if (!isSourceId(source)) throw new RejectedPayload("custom sources must be imported with a paired token");
      const issued = await issueToken(db, libraryId, source, null);
      token = await lookupToken(db, issued.token);
      if (!token) throw new RejectedPayload("failed to issue import token");
      current = await startSession(db, token, rec, { accountKind: "imported" });
      sessions += 1;
    } else if (rec.type === "batch") {
      if (!current || !token) throw new RejectedPayload("batch without session");
      const result = await ingestBatch(db, { ...rec, sessionId: current.sessionId }, { activityKind: "imported", token });
      if (result.replayed) replayed += 1;
      inserted += result.inserted;
      updated += result.updated;
      removed += result.removed;
      batches += 1;
    } else {
      if (!current || !token) throw new RejectedPayload("finish without session");
      removed += (await finishSession(db, { ...rec, sessionId: current.sessionId }, token)).removed;
    }
  }
  changes = inserted + updated + removed;
  return { sessions, batches, changes, inserted, updated, removed, replayed, errors };
}


