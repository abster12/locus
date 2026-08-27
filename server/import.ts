import type { Db } from "../db/open.ts";
import { parseJsonl } from "../packages/import-format/index.ts";
import { finishSession, ingestBatch, issueToken, lookupToken, startSession } from "./capture/ingest.ts";
import { isSourceId } from "../core/types.ts";
import { RejectedPayload } from "../core/sanitize.ts";

export interface ImportResult {
  sessions: number;
  batches: number;
  changes: number;
  inserted: number;
  updated: number;
  removed: number;
  replayed: number;
  errors: string[];
}

export function importJsonl(
  db: Db,
  text: string,
  opts: { dryRun: boolean },
): ImportResult {
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
  let tokenValue: string | null = null;
  for (const rec of records) {
    if (rec.type === "session") {
      const source = rec.source;
      if (!isSourceId(source)) throw new RejectedPayload("custom sources must be imported with a paired token");
      const issued = issueToken(db, source, null);
      tokenValue = issued.token;
      const token = lookupToken(db, issued.token);
      if (!token) throw new RejectedPayload("failed to issue import token");
      current = startSession(db, token, rec, { accountKind: "imported" });
      sessions += 1;
    } else if (rec.type === "batch") {
      if (!current) throw new RejectedPayload("batch without session");
      const token = tokenValue ? lookupToken(db, tokenValue) : null;
      if (!token) throw new RejectedPayload("failed to issue import token");
      const result = ingestBatch(db, { ...rec, sessionId: current.sessionId }, { activityKind: "imported", token });
      if (result.replayed) replayed += 1;
      inserted += result.inserted;
      updated += result.updated;
      removed += result.removed;
      batches += 1;
    } else {
      if (!current) throw new RejectedPayload("finish without session");
      const token = tokenValue ? lookupToken(db, tokenValue) : null;
      if (!token) throw new RejectedPayload("failed to issue import token");
      removed += finishSession(db, { ...rec, sessionId: current.sessionId }, token).removed;
    }
  }
  changes = inserted + updated + removed;
  return { sessions, batches, changes, inserted, updated, removed, replayed, errors };
}
