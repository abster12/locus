import type { Db } from "../db/open.ts";
import { parseJsonl } from "../packages/import-format/index.ts";
import { finishSession, ingestBatch, issueToken, lookupToken, startSession } from "./capture/ingest.ts";
import { isSourceId } from "../core/types.ts";
import { RejectedPayload } from "../core/sanitize.ts";

export function importJsonl(
  db: Db,
  text: string,
  opts: { dryRun: boolean },
): { sessions: number; batches: number; changes: number; errors: string[] } {
  const records = parseJsonl(text);
  const errors: string[] = [];
  let sessions = 0;
  let batches = 0;
  let changes = 0;
  if (opts.dryRun) {
    for (const rec of records) {
      if (rec.type === "session") sessions += 1;
      else if (rec.type === "batch") {
        batches += 1;
        changes += rec.changes.length;
      }
    }
    return { sessions, batches, changes, errors };
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
      current = startSession(db, token, rec);
      sessions += 1;
    } else if (rec.type === "batch") {
      if (!current) throw new RejectedPayload("batch without session");
      ingestBatch(db, { ...rec, sessionId: current.sessionId });
      batches += 1;
      changes += rec.changes.length;
    } else {
      if (!current) throw new RejectedPayload("finish without session");
      finishSession(db, { ...rec, sessionId: current.sessionId });
    }
  }
  void tokenValue;
  return { sessions, batches, changes, errors };
}
