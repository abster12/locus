import { createHash } from "node:crypto";
import type { Db } from "../../db/open.ts";
import { newId, nowIso, tx } from "../../db/open.ts";
import { mergeSourceAccount, resolvedAccountDisplayName } from "../../db/source-lifecycle.ts";
import { RejectedPayload } from "../../core/sanitize.ts";
import type { SourceId } from "../../core/types.ts";
import type { CaptureBatchV1, CaptureFinishV1, CaptureSessionV1 } from "../../packages/protocol/types.ts";
import { LOCAL_LIBRARY_ID, reconcileItem, wakeReadingWorker } from "../reading/module.ts";
import { enqueueAtlasItem } from "../atlas/module.ts";
import { wakeAtlasWorker } from "../atlas/ai.ts";
import { persistNewItem } from "../item-persist.ts";

export interface CaptureToken {
  id: string;
  source: string;
  sourceAccountId: string | null;
  revokedAt: string | null;
}

export type SourceAccountKind = "live" | "imported";

export class CaptureAuthorizationError extends Error {
  constructor(
    readonly statusCode: 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = "CaptureAuthorizationError";
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function issueToken(db: Db, source: SourceId | "*", accountId: string | null): { token: string; tokenId: string } {
  const token = `loc_${crypto.randomUUID().replaceAll("-", "")}`;
  const tokenId = newId();
  db.prepare(
    `INSERT INTO capture_tokens (id, token_hash, source, source_account_id, capabilities, created_at)
     VALUES (?, ?, ?, ?, 'ingest', ?)`,
  ).run(tokenId, hashToken(token), source, accountId, nowIso());
  return { token, tokenId };
}

export function isThinBody(body: string | null | undefined): boolean {
  if (!body) return true;
  const t = body.trim();
  return t.length === 0 || /^https?:\/\/\S+$/i.test(t);
}

export function knownCompleteIds(db: Db, source: string, accountId: string | null): string[] {
  const rows = (
    accountId
      ? db
          .prepare(
            `SELECT sr.external_id as id, i.body as body FROM source_records sr
             JOIN items i ON i.id = sr.item_id WHERE sr.source_account_id = ?`,
          )
          .all(accountId)
      : source === "*"
        ? db
            .prepare(
              `SELECT sr.external_id as id, i.body as body FROM source_records sr
               JOIN items i ON i.id = sr.item_id`,
            )
            .all()
        : db
            .prepare(
              `SELECT sr.external_id as id, i.body as body FROM source_records sr
               JOIN source_accounts sa ON sa.id = sr.source_account_id
               JOIN items i ON i.id = sr.item_id WHERE sa.source = ?`,
            )
            .all(source)
  ) as { id: string; body: string | null }[];
  return rows.filter((r) => !isThinBody(r.body)).map((r) => r.id);
}

export function lookupToken(
  db: Db,
  token: string,
): CaptureToken | null {
  const row = db.prepare(`SELECT id, source, source_account_id as sourceAccountId, revoked_at as revokedAt FROM capture_tokens WHERE token_hash = ?`).get(
    hashToken(token),
  ) as { id: string; source: string; sourceAccountId: string | null; revokedAt: string | null } | undefined;
  return row ?? null;
}

export function revokeTokensForAccount(db: Db, accountId: string): void {
  db.prepare(`UPDATE capture_tokens SET revoked_at = ? WHERE source_account_id = ? AND revoked_at IS NULL`).run(
    nowIso(),
    accountId,
  );
}

export function revokeTokenById(db: Db, tokenId: string): void {
  db.prepare(`UPDATE capture_tokens SET revoked_at = ? WHERE id = ?`).run(nowIso(), tokenId);
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

function ensureAccount(
  db: Db,
  source: string,
  externalId: string,
  boundAccountId: string | null,
  accountKind: SourceAccountKind,
): string {
  if (boundAccountId) {
    const existing = db.prepare(`SELECT id, source, external_id, display_name AS displayName, account_kind FROM source_accounts WHERE id = ?`).get(boundAccountId) as
      | { id: string; source: string; external_id: string; displayName: string | null; account_kind: SourceAccountKind }
      | undefined;
    if (!existing) throw new CaptureAuthorizationError(403, "token is bound to a missing account");
    if (existing.source !== source) throw new CaptureAuthorizationError(403, "token is not valid for this source account");
    if (existing.account_kind !== accountKind) throw new CaptureAuthorizationError(403, "token is not valid for this source account kind");
    if (isPlaceholderAccount(existing.external_id)) {
      if (!isPlaceholderAccount(externalId)) {
        const collision = db
          .prepare(
            `SELECT id, account_kind AS accountKind, display_name AS displayName FROM source_accounts
              WHERE source = ? AND external_id = ? AND id != ? AND account_kind != 'imported'`,
          )
          .get(source, externalId, existing.id) as { id: string; accountKind: string; displayName: string | null } | undefined;
        if (collision) {
          if (collision.accountKind === "disconnected") {
            db.prepare(`UPDATE source_accounts SET account_kind = 'live' WHERE id = ?`).run(collision.id);
          }
          mergeSourceAccount(db, existing.id, collision.id, "repoint");
          db.prepare(`UPDATE source_accounts SET display_name = ? WHERE id = ?`).run(
            resolvedAccountDisplayName(collision.displayName, externalId),
            collision.id,
          );
          db.prepare(`DELETE FROM source_accounts WHERE id = ?`).run(existing.id);
          return collision.id;
        }
        db.prepare(`UPDATE source_accounts SET external_id = ?, display_name = ? WHERE id = ?`).run(
          externalId,
          resolvedAccountDisplayName(existing.displayName, externalId),
          existing.id,
        );
      }
      return existing.id;
    }
    // Token already names the account. Ignore producer-supplied ids like "extension".
    return existing.id;
  }
  const found = db.prepare(`SELECT id FROM source_accounts WHERE source = ? AND external_id = ? AND account_kind = ?`).get(source, externalId, accountKind) as
    | { id: string }
    | undefined;
  if (found) return found.id;
  const id = newId();
  db.prepare(`INSERT INTO source_accounts (id, source, external_id, display_name, created_at, account_kind) VALUES (?, ?, ?, ?, ?, ?)`).run(
    id,
    source,
    externalId,
    resolvedAccountDisplayName(null, externalId),
    nowIso(),
    accountKind,
  );
  return id;
}

function ensureCollection(
  db: Db,
  accountId: string,
  externalId: string,
  name: string | undefined,
  url: string | undefined,
): string {
  const found = db
    .prepare(`SELECT id FROM source_collections WHERE source_account_id = ? AND external_id = ?`)
    .get(accountId, externalId) as { id: string } | undefined;
  if (found) {
    if (name) db.prepare(`UPDATE source_collections SET name = COALESCE(?, name), url = COALESCE(?, url) WHERE id = ?`).run(name, url ?? null, found.id);
    return found.id;
  }
  const id = newId();
  db.prepare(
    `INSERT INTO source_collections (id, source_account_id, external_id, name, url, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, accountId, externalId, name || externalId, url ?? null, nowIso());
  return id;
}

export function startSession(
  db: Db,
  token: Pick<CaptureToken, "id" | "source" | "sourceAccountId">,
  session: CaptureSessionV1,
  opts?: { accountKind?: SourceAccountKind },
): { sessionId: string; captureRunId: string; sourceAccountId: string } {
  const sessionSource = session.source.startsWith("custom:") ? session.source : session.source;
  if (token.source !== "*" && token.source !== sessionSource) {
    throw new CaptureAuthorizationError(403, "token is not valid for this source");
  }
  const source = token.source === "*" ? sessionSource : token.source;
  return tx(db, () => {
    const accountKind = opts?.accountKind ?? "live";
    const accountId = ensureAccount(db, source, session.accountExternalId, token.sourceAccountId, accountKind);
    const collectionId = ensureCollection(
      db,
      accountId,
      session.collection.externalId,
      session.collection.name,
      session.collection.url,
    );
    const captureRunId = newId();
    const sessionId = newId();
    db.prepare(
      `INSERT INTO capture_runs (
        id, source_collection_id, producer_id, producer_version, started_at, status
      ) VALUES (?, ?, ?, ?, ?, 'running')`,
    ).run(captureRunId, collectionId, session.producer.id, session.producer.version, nowIso());
    db.prepare(
      `INSERT INTO capture_sessions (
        id, token_id, source, source_account_id, source_collection_id, producer_id, producer_version,
        mode, observed_at, capture_run_id, account_external_id, collection_external_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
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
    );
    return { sessionId, captureRunId, sourceAccountId: accountId };
  });
}

function upsertItem(
  db: Db,
  args: {
    accountId: string;
    collectionId: string;
    captureRunId: string;
    observedAt: string;
    change: Extract<CaptureBatchV1["changes"][number], { kind: "upsert" }>;
    activityKind: "detected" | "captured" | "imported";
  },
): "inserted" | "updated" {
  const { change } = args;
  const existing = db
    .prepare(`SELECT id, item_id FROM source_records WHERE source_account_id = ? AND external_id = ?`)
    .get(args.accountId, change.externalId) as { id: string; item_id: string | null } | undefined;

  const draft = change.item;
  const publishedAt = draft.publishedAt?.trim() || null;
  const sourceSavedAt = draft.sourceSavedAt?.trim() || null;
  if (existing?.item_id) {
    const prev = db.prepare(`SELECT body FROM items WHERE id = ?`).get(existing.item_id) as { body: string | null } | undefined;
    db.prepare(
      `UPDATE items SET content_type = ?, title = ?, body = ?, url = ?, author_name = ?, author_handle = ?,
        published_at = COALESCE(?, published_at), source_saved_at = COALESCE(?, source_saved_at),
        captured_at = ?, media = ?, updated_at = ? WHERE id = ?`,
    ).run(
      draft.contentType,
      draft.title ?? null,
      preferCompleteBody(draft.body ?? null, prev?.body ?? null),
      draft.url,
      draft.authorName ?? null,
      draft.authorHandle ?? null,
      publishedAt,
      sourceSavedAt,
      args.observedAt,
      JSON.stringify(draft.media ?? []),
      nowIso(),
      existing.item_id,
    );
    db.prepare(
      `UPDATE source_records SET revision = ?, last_observed_at = ?, source_position = ?, metadata = ?, item_id = ? WHERE id = ?`,
    ).run(
      change.revision ?? null,
      args.observedAt,
      change.sourcePosition ?? null,
      change.metadata ? JSON.stringify(change.metadata) : null,
      existing.item_id,
      existing.id,
    );
    db.prepare(
      `INSERT OR IGNORE INTO source_memberships (source_collection_id, source_record_id, source_position) VALUES (?, ?, ?)`,
    ).run(args.collectionId, existing.id, change.sourcePosition ?? null);
    db.prepare(`INSERT INTO activities (id, item_id, kind, occurred_at, timestamp_source, capture_run_id) VALUES (?, ?, 'updated', ?, 'locus', ?)`).run(
      newId(),
      existing.item_id,
      args.observedAt,
      args.captureRunId,
    );
    // Same SQLite transaction as the Item write: a crash cannot keep the post without Reading rows.
    reconcileItem(db, LOCAL_LIBRARY_ID, existing.item_id);
    enqueueAtlasItem(db, LOCAL_LIBRARY_ID, existing.item_id);
    return "updated";
  }

  const recordId = existing?.id ?? newId();
  const itemId = persistNewItem(db, {
    libraryId: LOCAL_LIBRARY_ID,
    draft: {
      contentType: draft.contentType,
      title: draft.title,
      body: draft.body,
      url: draft.url,
      authorName: draft.authorName,
      authorHandle: draft.authorHandle,
      publishedAt,
      sourceSavedAt,
      media: draft.media,
    },
    firstObservedAt: args.observedAt,
    capturedAt: args.observedAt,
    activityKind: args.activityKind,
    captureRunId: args.captureRunId,
  });
  if (existing) {
    db.prepare(`UPDATE source_records SET item_id = ?, last_observed_at = ?, revision = ?, source_position = ? WHERE id = ?`).run(
      itemId,
      args.observedAt,
      change.revision ?? null,
      change.sourcePosition ?? null,
      existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO source_records (
        id, source_account_id, external_id, revision, item_id, first_observed_at, last_observed_at, source_position, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      recordId,
      args.accountId,
      change.externalId,
      change.revision ?? null,
      itemId,
      args.observedAt,
      args.observedAt,
      change.sourcePosition ?? null,
      change.metadata ? JSON.stringify(change.metadata) : null,
    );
  }
  db.prepare(
    `INSERT OR IGNORE INTO source_memberships (source_collection_id, source_record_id, source_position) VALUES (?, ?, ?)`,
  ).run(args.collectionId, recordId, change.sourcePosition ?? null);
  return "inserted";
}

export function ingestBatch(
  db: Db,
  batch: CaptureBatchV1,
  opts?: { activityKind?: "detected" | "captured" | "imported"; token?: Pick<CaptureToken, "id" | "source" | "sourceAccountId"> },
): { replayed: boolean; inserted: number; updated: number; upserted: number; removed: number } {
  return tx(db, () => {
    const session = db
      .prepare(
        `SELECT * FROM capture_sessions WHERE id = ?`,
      )
      .get(batch.sessionId) as
      | {
          id: string;
          token_id: string;
          source: string;
          source_account_id: string;
          source_collection_id: string;
          capture_run_id: string;
          last_sequence: number;
          finished_at: string | null;
          observed_at: string;
      }
      | undefined;
    if (!session) throw new CaptureAuthorizationError(404, "unknown session");
    if (opts?.token) assertSessionAccess(session, opts.token);
    if (session.finished_at) throw new RejectedPayload("session already finished");

    const prior = db
      .prepare(`SELECT sequence FROM capture_batches WHERE session_id = ? AND idempotency_key = ?`)
      .get(batch.sessionId, batch.idempotencyKey) as { sequence: number } | undefined;
    if (prior) {
      return { replayed: true, inserted: 0, updated: 0, upserted: 0, removed: 0 };
    }

    if (batch.sequence !== session.last_sequence + 1) {
      throw new RejectedPayload(`unexpected sequence ${batch.sequence}, expected ${session.last_sequence + 1}`);
    }

    let inserted = 0;
    let updated = 0;
    let removed = 0;
    for (const change of batch.changes) {
      if (change.kind === "upsert") {
        const result = upsertItem(db, {
          accountId: session.source_account_id,
          collectionId: session.source_collection_id,
          captureRunId: session.capture_run_id,
          observedAt: session.observed_at,
          change,
          activityKind: opts?.activityKind ?? "captured",
        });
        if (result === "inserted") inserted += 1;
        else updated += 1;
        db.prepare(`INSERT OR IGNORE INTO capture_seen (capture_run_id, external_id) VALUES (?, ?)`).run(
          session.capture_run_id,
          change.externalId,
        );
      } else {
        db.prepare(`INSERT OR IGNORE INTO capture_seen (capture_run_id, external_id) VALUES (?, ?)`).run(
          session.capture_run_id,
          change.externalId,
        );
        removed += applyRemove(db, session, change.externalId, change.observedAt);
      }
    }

    db.prepare(`INSERT INTO capture_batches (session_id, sequence, idempotency_key) VALUES (?, ?, ?)`).run(
      batch.sessionId,
      batch.sequence,
      batch.idempotencyKey,
    );
    db.prepare(`UPDATE capture_sessions SET last_sequence = ? WHERE id = ?`).run(batch.sequence, batch.sessionId);
    db.prepare(
      `UPDATE capture_runs SET last_sequence = ?, seen_count = seen_count + ?, upserted_count = upserted_count + ?,
        removed_count = removed_count + ?, checkpoint = ? WHERE id = ?`,
    ).run(
      batch.sequence,
      batch.changes.length,
      inserted + updated,
      removed,
      JSON.stringify({ sequence: batch.sequence, idempotencyKey: batch.idempotencyKey }),
      session.capture_run_id,
    );
    return { replayed: false, inserted, updated, upserted: inserted + updated, removed };
  });
}

function applyRemove(
  db: Db,
  session: { source_account_id: string; source_collection_id: string; capture_run_id: string },
  externalId: string,
  observedAt: string,
): number {
  const record = db
    .prepare(`SELECT id, item_id FROM source_records WHERE source_account_id = ? AND external_id = ?`)
    .get(session.source_account_id, externalId) as { id: string; item_id: string | null } | undefined;
  if (!record) return 0;
  const deletion = db.prepare(`DELETE FROM source_memberships WHERE source_collection_id = ? AND source_record_id = ?`).run(
    session.source_collection_id,
    record.id,
  );
  if (Number(deletion.changes) === 0) return 0;
  if (record.item_id) {
    db.prepare(
      `INSERT INTO activities (id, item_id, kind, occurred_at, timestamp_source, capture_run_id) VALUES (?, ?, 'source_removed', ?, 'source', ?)`,
    ).run(newId(), record.item_id, observedAt, session.capture_run_id);
  }
  return 1;
}

export function finishSession(
  db: Db,
  finish: CaptureFinishV1,
  token?: Pick<CaptureToken, "id" | "source" | "sourceAccountId">,
): { removed: number } {
  const result = tx(db, () => {
    const session = db.prepare(`SELECT * FROM capture_sessions WHERE id = ?`).get(finish.sessionId) as
      | {
          id: string;
          token_id: string;
          source: string;
          source_account_id: string;
          source_collection_id: string;
          capture_run_id: string;
          finished_at: string | null;
      }
      | undefined;
    if (!session) throw new CaptureAuthorizationError(404, "unknown session");
    if (token) assertSessionAccess(session, token);
    if (session.finished_at) return { removed: 0 };

    let removed = 0;
    if (finish.coverage === "complete") {
      const stale = db
        .prepare(
          `SELECT sm.source_record_id, sr.external_id, sr.item_id
           FROM source_memberships sm
           JOIN source_records sr ON sr.id = sm.source_record_id
           WHERE sm.source_collection_id = ?
             AND sr.external_id NOT IN (SELECT external_id FROM capture_seen WHERE capture_run_id = ?)`,
        )
        .all(session.source_collection_id, session.capture_run_id) as {
        source_record_id: string;
        external_id: string;
        item_id: string | null;
      }[];
      for (const row of stale) {
        removed += applyRemove(
          db,
          session,
          row.external_id,
          nowIso(),
        );
      }
    }

    db.prepare(`UPDATE capture_sessions SET finished_at = ?, coverage = ? WHERE id = ?`).run(
      nowIso(),
      finish.coverage,
      finish.sessionId,
    );
    db.prepare(
      `UPDATE capture_runs SET finished_at = ?, coverage = ?, status = 'ok', removed_count = removed_count + ?, checkpoint = ? WHERE id = ?`,
    ).run(
      nowIso(),
      finish.coverage,
      removed,
      finish.cursor ? JSON.stringify(finish.cursor) : null,
      session.capture_run_id,
    );
    return { removed };
  });
  wakeReadingWorker(db);
  wakeAtlasWorker(db);
  return result;
}

export function failRun(db: Db, captureRunId: string, code: string, detail: string): void {
  db.prepare(
    `UPDATE capture_runs SET finished_at = ?, status = 'error', coverage = COALESCE(coverage, 'partial'), error_code = ?, error_detail = ? WHERE id = ?`,
  ).run(nowIso(), code, detail, captureRunId);
}

function preferCompleteBody(incoming: string | null, previous: string | null): string | null {
  if (!isThinBody(incoming)) return incoming?.trim() || null;
  if (!isThinBody(previous)) return previous?.trim() || null;
  return incoming?.trim() || previous?.trim() || null;
}

export function cancelRun(db: Db, captureRunId: string): void {
  db.prepare(
    `UPDATE capture_runs SET finished_at = ?, status = 'cancelled', coverage = 'partial', error_code = 'interrupted', error_detail = 'stopped by user' WHERE id = ? AND finished_at IS NULL`,
  ).run(nowIso(), captureRunId);
}

function assertSessionAccess(
  session: { token_id: string; source: string; source_account_id: string },
  token: Pick<CaptureToken, "id" | "source" | "sourceAccountId">,
): void {
  if (session.token_id !== token.id) throw new CaptureAuthorizationError(403, "token cannot access this session");
  if (token.source !== "*" && token.source !== session.source) {
    throw new CaptureAuthorizationError(403, "token is not valid for this session source");
  }
  if (token.sourceAccountId !== null && token.sourceAccountId !== session.source_account_id) {
    throw new CaptureAuthorizationError(403, "token is not valid for this session account");
  }
}
