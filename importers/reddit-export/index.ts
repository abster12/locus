import type { Db } from "../../db/open.ts";
import { importJsonl, type ImportResult } from "../../server/import.ts";

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const headerLine = lines[0];
  if (!headerLine) return [];
  const headers = splitCsvLine(headerLine).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else q = !q;
    } else if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function permalinkUrl(permalink: string, id: string): string {
  if (permalink.startsWith("http")) return permalink;
  if (permalink.startsWith("/")) return `https://www.reddit.com${permalink}`;
  return `https://www.reddit.com/${id}`;
}

function maybeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const asNum = Number(value);
  if (Number.isFinite(asNum) && asNum > 1_000_000_000) {
    const ms = asNum > 10_000_000_000 ? asNum : asNum * 1000;
    return new Date(ms).toISOString();
  }
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return undefined;
}

export function redditExportToJsonl(postsCsv: string, commentsCsv: string): string {
  const posts = parseCsv(postsCsv);
  const comments = parseCsv(commentsCsv);
  const session = {
    type: "session",
    protocolVersion: 1,
    source: "reddit",
    producer: { id: "locus.importer.reddit-export", version: "1.0.0" },
    accountExternalId: "reddit-export",
    collection: { externalId: "saved", name: "Saved (export)", url: "https://www.reddit.com/user/me/saved/" },
    mode: "snapshot",
    observedAt: new Date().toISOString(),
  };
  const changes: unknown[] = [];
  let pos = 0;
  for (const row of posts) {
    const id = (row.id || row.fullname || "").trim();
    if (!id) continue;
    const full = id.startsWith("t3_") ? id : `t3_${id}`;
    const permalink = row.permalink || row.url || "";
    changes.push({
      kind: "upsert",
      externalId: full,
      sourcePosition: pos,
      item: {
        contentType: "post",
        title: row.title || undefined,
        body: row.body || row.selftext || undefined,
        url: permalinkUrl(permalink, full),
        sourceSavedAt: maybeDate(row.date || row.created_utc),
      },
    });
    pos += 1;
  }
  for (const row of comments) {
    const id = (row.id || row.fullname || "").trim();
    if (!id) continue;
    const full = id.startsWith("t1_") ? id : `t1_${id}`;
    const permalink = row.permalink || "";
    changes.push({
      kind: "upsert",
      externalId: full,
      sourcePosition: pos,
      item: {
        contentType: "comment",
        title: row.title || "Comment",
        body: row.body || undefined,
        url: permalinkUrl(permalink, full),
        sourceSavedAt: maybeDate(row.date || row.created_utc),
      },
    });
    pos += 1;
  }
  const sessionKey = crypto.randomUUID().replaceAll("-", "");
  const batch = {
    type: "batch",
    sessionId: "import",
    sequence: 1,
    idempotencyKey: `reddit-export:${sessionKey}:1`,
    changes,
  };
  const finish = { type: "finish", sessionId: "import", coverage: "complete" };
  return [JSON.stringify(session), JSON.stringify(batch), JSON.stringify(finish)].join("\n");
}

export function importRedditExport(
  db: Db,
  postsCsv: string,
  commentsCsv: string,
  opts: { dryRun: boolean },
): ImportResult {
  return importJsonl(db, redditExportToJsonl(postsCsv, commentsCsv), opts);
}
