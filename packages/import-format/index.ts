import { parseBatch, parseFinish, parseSession } from "../protocol/validate.ts";
import type { JsonlRecordV1 } from "../protocol/types.ts";
import { RejectedPayload } from "../../core/sanitize.ts";

export function parseJsonl(text: string): JsonlRecordV1[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const records: JsonlRecordV1[] = [];
  for (const [i, line] of lines.entries()) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new RejectedPayload(`line ${i + 1} is not JSON`);
    }
    if (!raw || typeof raw !== "object") throw new RejectedPayload(`line ${i + 1} is not an object`);
    const rec = raw as { type?: unknown };
    if (rec.type === "session") {
      const { type: _t, ...rest } = rec as { type: "session" };
      records.push({ type: "session", ...parseSession(rest) });
    } else if (rec.type === "batch") {
      const { type: _t, ...rest } = rec as { type: "batch" };
      records.push({ type: "batch", ...parseBatch(rest) });
    } else if (rec.type === "finish") {
      const { type: _t, ...rest } = rec as { type: "finish" };
      records.push({ type: "finish", ...parseFinish(rest) });
    } else {
      throw new RejectedPayload(`line ${i + 1} missing type session|batch|finish`);
    }
  }
  validateCaptureOrder(records);
  return records;
}

function validateCaptureOrder(records: JsonlRecordV1[]): void {
  if (records.length === 0) throw new RejectedPayload("import must contain a session and finish");
  if (records[0]?.type !== "session") throw new RejectedPayload("import must start with one session record");

  let finished = false;
  for (const [index, record] of records.entries()) {
    if (index === 0) continue;
    if (record.type === "session") throw new RejectedPayload("import may contain only one session record");
    if (finished) throw new RejectedPayload("finish must be the final import record");
    if (record.type === "finish") finished = true;
  }
  if (!finished) throw new RejectedPayload("import must end with one finish record");
}
