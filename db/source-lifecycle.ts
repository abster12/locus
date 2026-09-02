import type { Db } from "./open.ts";

export type SourceCleanupLeftover = { id: string; source: string; reason: string };

export function isPendingExternalId(externalId: string): boolean {
  return externalId.startsWith("pending:") || externalId === "pending";
}

const PLACEHOLDER_DISPLAY_NAMES = new Set(["x", "instagram", "youtube", "reddit", "pending", "unknown", "extension"]);

export function isPlaceholderDisplayName(value: string | null | undefined): boolean {
  if (value == null) return true;
  const name = value.trim();
  if (!name) return true;
  if (isPendingExternalId(name)) return true;
  return PLACEHOLDER_DISPLAY_NAMES.has(name.toLowerCase());
}

export function resolvedAccountDisplayName(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  const current = existing?.trim() || null;
  const next = incoming?.trim() || null;
  if (isPlaceholderDisplayName(next)) return current;
  if (isPlaceholderDisplayName(current)) return next;
  return current;
}

export function mergeSourceAccount(db: Db, fromId: string, toId: string, tokens: "repoint" | "revoke" = "repoint"): void {
  if (fromId === toId) return;

  const fromCollections = db
    .prepare(`SELECT id, external_id AS externalId FROM source_collections WHERE source_account_id = ?`)
    .all(fromId) as { id: string; externalId: string }[];
  for (const collection of fromCollections) {
    const existing = db
      .prepare(`SELECT id FROM source_collections WHERE source_account_id = ? AND external_id = ?`)
      .get(toId, collection.externalId) as { id: string } | undefined;
    if (!existing) {
      db.prepare(`UPDATE source_collections SET source_account_id = ? WHERE id = ?`).run(toId, collection.id);
      continue;
    }
    db.prepare(`UPDATE capture_runs SET source_collection_id = ? WHERE source_collection_id = ?`).run(existing.id, collection.id);
    db.prepare(`UPDATE capture_sessions SET source_collection_id = ? WHERE source_collection_id = ?`).run(existing.id, collection.id);
    db.prepare(
      `INSERT OR IGNORE INTO source_memberships (source_collection_id, source_record_id, source_position)
       SELECT ?, source_record_id, source_position FROM source_memberships WHERE source_collection_id = ?`,
    ).run(existing.id, collection.id);
    db.prepare(`DELETE FROM source_memberships WHERE source_collection_id = ?`).run(collection.id);
    db.prepare(`DELETE FROM source_collections WHERE id = ?`).run(collection.id);
  }

  const fromRecords = db
    .prepare(
      `SELECT id, external_id AS externalId, revision, item_id AS itemId, first_observed_at AS firstObservedAt,
              last_observed_at AS lastObservedAt, source_position AS sourcePosition, metadata
         FROM source_records WHERE source_account_id = ?`,
    )
    .all(fromId) as {
    id: string;
    externalId: string;
    revision: string | null;
    itemId: string | null;
    firstObservedAt: string;
    lastObservedAt: string;
    sourcePosition: number | null;
    metadata: string | null;
  }[];
  for (const record of fromRecords) {
    const existing = db
      .prepare(
        `SELECT id, revision, item_id AS itemId, first_observed_at AS firstObservedAt,
                last_observed_at AS lastObservedAt, source_position AS sourcePosition, metadata
           FROM source_records WHERE source_account_id = ? AND external_id = ?`,
      )
      .get(toId, record.externalId) as {
      id: string;
      revision: string | null;
      itemId: string | null;
      firstObservedAt: string;
      lastObservedAt: string;
      sourcePosition: number | null;
      metadata: string | null;
    } | undefined;
    if (!existing) {
      db.prepare(`UPDATE source_records SET source_account_id = ? WHERE id = ?`).run(toId, record.id);
      continue;
    }
    const fromWins = recordWins(record, existing);
    if (fromWins) {
      db.prepare(
        `UPDATE source_records SET revision = ?, item_id = ?, first_observed_at = ?, last_observed_at = ?,
                source_position = ?, metadata = ? WHERE id = ?`,
      ).run(
        record.revision,
        record.itemId,
        record.firstObservedAt < existing.firstObservedAt ? record.firstObservedAt : existing.firstObservedAt,
        record.lastObservedAt,
        record.sourcePosition,
        record.metadata,
        existing.id,
      );
    }
    db.prepare(
      `INSERT OR IGNORE INTO source_memberships (source_collection_id, source_record_id, source_position)
       SELECT source_collection_id, ?, source_position FROM source_memberships WHERE source_record_id = ?`,
    ).run(existing.id, record.id);
    db.prepare(`DELETE FROM source_memberships WHERE source_record_id = ?`).run(record.id);
    db.prepare(`DELETE FROM source_records WHERE id = ?`).run(record.id);
  }

  db.prepare(`UPDATE capture_sessions SET source_account_id = ? WHERE source_account_id = ?`).run(toId, fromId);
  if (tokens === "repoint") {
    db.prepare(`UPDATE capture_tokens SET source_account_id = ? WHERE source_account_id = ?`).run(toId, fromId);
  }
}

export function cleanupSourceConnections(db: Db, opts?: { inTransaction?: boolean }): { leftovers: SourceCleanupLeftover[] } {
  if (opts?.inTransaction) return { leftovers: cleanupAll(db) };
  db.exec("BEGIN IMMEDIATE");
  try {
    const leftovers = cleanupAll(db);
    db.exec("COMMIT");
    return { leftovers };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // keep the original error
    }
    throw error;
  }
}

export function releaseSourceConnection(db: Db, accountId: string): { leftover: SourceCleanupLeftover | null } {
  const account = db
    .prepare(`SELECT id, source, account_kind AS accountKind FROM source_accounts WHERE id = ?`)
    .get(accountId) as { id: string; source: string; accountKind: string } | undefined;
  if (!account || account.accountKind === "imported") return { leftover: { id: accountId, source: account?.source ?? "", reason: "unknown source account" } };
  revokeAccountTokens(db, accountId);
  if (hasSourceRecords(db, accountId)) {
    db.prepare(`UPDATE source_accounts SET account_kind = 'disconnected' WHERE id = ?`).run(accountId);
    return { leftover: null };
  }
  deleteEmptyAccount(db, accountId);
  return { leftover: null };
}

function cleanupAll(db: Db): SourceCleanupLeftover[] {
  const sources = db.prepare(`SELECT DISTINCT source FROM source_accounts`).all() as { source: string }[];
  const leftovers: SourceCleanupLeftover[] = [];
  for (const row of sources) leftovers.push(...cleanupSource(db, row.source));
  return leftovers;
}

function cleanupSource(db: Db, source: string): SourceCleanupLeftover[] {
  const live = db
    .prepare(
      `SELECT id, source, external_id AS externalId, created_at AS createdAt FROM source_accounts
        WHERE source = ? AND account_kind = 'live'`,
    )
    .all(source) as { id: string; source: string; externalId: string; createdAt: string }[];
  if (live.length <= 1) return [];
  const canonical = pickCanonical(db, source, live);
  const leftovers: SourceCleanupLeftover[] = [];
  for (const account of live) {
    if (account.id === canonical.id) continue;
    const compatible =
      isPendingExternalId(account.externalId) ||
      isPendingExternalId(canonical.externalId) ||
      account.externalId === canonical.externalId;
    if (!compatible) {
      leftovers.push({ id: account.id, source, reason: "incompatible live identity" });
      continue;
    }
    mergeSourceAccount(db, account.id, canonical.id, "revoke");
    revokeAccountTokens(db, account.id);
    if (hasSourceRecords(db, account.id) || hasCollections(db, account.id) || hasSessions(db, account.id)) {
      leftovers.push({ id: account.id, source, reason: "irreplaceable provenance" });
      continue;
    }
    db.prepare(`DELETE FROM source_accounts WHERE id = ?`).run(account.id);
  }
  return leftovers;
}

function pickCanonical(
  db: Db,
  source: string,
  live: { id: string; externalId: string; createdAt: string }[],
): { id: string; externalId: string; createdAt: string } {
  const running = db
    .prepare(
      `SELECT c.source_account_id AS id
         FROM capture_runs r
         JOIN source_collections c ON c.id = r.source_collection_id
         JOIN source_accounts a ON a.id = c.source_account_id
        WHERE a.source = ? AND a.account_kind = 'live' AND r.status = 'running' AND r.finished_at IS NULL
        ORDER BY r.started_at DESC LIMIT 1`,
    )
    .get(source) as { id: string } | undefined;
  if (running) {
    const match = live.find((account) => account.id === running.id);
    if (match) return match;
  }
  const resolved = live.filter((account) => !isPendingExternalId(account.externalId));
  const pool = resolved.length > 0 ? resolved : live;
  return pool.reduce((newest, account) => (account.createdAt > newest.createdAt ? account : newest));
}

function recordWins(
  from: { lastObservedAt: string; revision: string | null; id: string },
  existing: { lastObservedAt: string; revision: string | null; id: string },
): boolean {
  if (from.lastObservedAt !== existing.lastObservedAt) return from.lastObservedAt > existing.lastObservedAt;
  const fromRev = from.revision ?? "";
  const existingRev = existing.revision ?? "";
  if (fromRev !== existingRev) return fromRev > existingRev;
  return from.id > existing.id;
}

function revokeAccountTokens(db: Db, accountId: string): void {
  db.prepare(`UPDATE capture_tokens SET revoked_at = ? WHERE source_account_id = ? AND revoked_at IS NULL`).run(
    new Date().toISOString(),
    accountId,
  );
}

function hasSourceRecords(db: Db, accountId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM source_records WHERE source_account_id = ? LIMIT 1`).get(accountId));
}

function hasCollections(db: Db, accountId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM source_collections WHERE source_account_id = ? LIMIT 1`).get(accountId));
}

function hasSessions(db: Db, accountId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM capture_sessions WHERE source_account_id = ? LIMIT 1`).get(accountId));
}

function deleteEmptyAccount(db: Db, accountId: string): void {
  db.prepare(
    `DELETE FROM capture_batches WHERE session_id IN (SELECT id FROM capture_sessions WHERE source_account_id = ?)`,
  ).run(accountId);
  db.prepare(`DELETE FROM capture_sessions WHERE source_account_id = ?`).run(accountId);
  db.prepare(
    `DELETE FROM capture_seen WHERE capture_run_id IN (
       SELECT r.id FROM capture_runs r JOIN source_collections c ON c.id = r.source_collection_id WHERE c.source_account_id = ?
     )`,
  ).run(accountId);
  db.prepare(
    `DELETE FROM capture_runs WHERE source_collection_id IN (SELECT id FROM source_collections WHERE source_account_id = ?)`,
  ).run(accountId);
  db.prepare(
    `DELETE FROM source_memberships WHERE source_collection_id IN (SELECT id FROM source_collections WHERE source_account_id = ?)`,
  ).run(accountId);
  db.prepare(`DELETE FROM source_collections WHERE source_account_id = ?`).run(accountId);
  db.prepare(`DELETE FROM source_accounts WHERE id = ?`).run(accountId);
}
