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
  return records;
}
