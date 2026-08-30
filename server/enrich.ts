import type { Db } from "../db/open.ts";
import { nowIso, tx } from "../db/open.ts";
import { LOCAL_LIBRARY_ID, reconcileItem } from "./reading/module.ts";
import { enqueueAtlasItem } from "./atlas/module.ts";
import { wakeAtlasWorker } from "./atlas/ai.ts";

const URL_RE = /https?:\/\/[^\s]+/g;
const FX = "https://api.fxtwitter.com/status/";

export function statusId(url: string): string | null {
  return url.match(/\/status\/(\d+)/)?.[1] ?? null;
}

export function keepLink(u: string, selfUrl: string): boolean {
  if (u === selfUrl || u.startsWith("https://t.co/")) return false;
  try {
    const parsed = new URL(u);
    if (parsed.hostname === "t.co") return false;
    if (/(^|\.)(x|twitter)\.com$/i.test(parsed.hostname) && parsed.pathname.includes("/status/")) {
      return !selfUrl.includes(parsed.pathname.match(/\/status\/\d+/)?.[0] ?? "\u0000");
    }
    return true;
  } catch {
    return false;
  }
}

export function needsEnrich(row: { url: string; body: string | null; published_at: string | null }): boolean {
  if (!statusId(row.url)) return false;
  const hasLink = (row.body?.match(URL_RE) ?? []).some((u) => keepLink(u, row.url));
  return !hasLink || !row.published_at;
}

export function applyLinks(body: string | null, links: string[]): string | null {
  let out = body ?? "";
  for (const u of links) {
    if (!out.includes(u)) out = out ? `${out}\n${u}` : u;
  }
  return out || body;
}

async function fetchTweet(id: string, selfUrl: string): Promise<{ publishedAt: string | null; links: string[] } | null> {
  const res = await fetch(`${FX}${id}`, {
    headers: { "user-agent": "LocusDesk/0.1" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    tweet?: {
      created_timestamp?: number;
      text?: string;
      card?: { url?: string };
      quote?: { url?: string };
    };
  };
  const t = data.tweet;
  if (!t) return null;
  const publishedAt = typeof t.created_timestamp === "number" ? new Date(t.created_timestamp * 1000).toISOString() : null;
  const links: string[] = [];
  for (const u of [t.card?.url, t.quote?.url, ...(t.text?.match(URL_RE) ?? [])]) {
    if (u && keepLink(u, selfUrl) && !links.includes(u)) links.push(u);
  }
  return { publishedAt, links };
}

export async function enrichXItems(db: Db, urls?: string[]): Promise<number> {
  const rows = (
    urls
      ? urls.map((url) => db.prepare(`SELECT id, url, body, published_at FROM items WHERE url = ?`).get(url))
      : db.prepare(`SELECT id, url, body, published_at FROM items WHERE url LIKE '%/status/%'`).all()
  ).filter(Boolean) as { id: string; url: string; body: string | null; published_at: string | null }[];

  let filled = 0;
  for (const row of rows) {
    if (!needsEnrich(row)) continue;
    const id = statusId(row.url);
    if (!id) continue;
    try {
      const got = await fetchTweet(id, row.url);
      if (!got) continue;
      const body = applyLinks(row.body, got.links);
      tx(db, () => {
        db.prepare(`UPDATE items SET body = ?, published_at = COALESCE(?, published_at), updated_at = ? WHERE id = ?`).run(
          body,
          got.publishedAt,
          nowIso(),
          row.id,
        );
        // Keep Reading discovery in the same commit as the enriched Item body.
        reconcileItem(db, LOCAL_LIBRARY_ID, row.id);
        enqueueAtlasItem(db, LOCAL_LIBRARY_ID, row.id);
      });
      wakeAtlasWorker(db);
      filled += 1;
    } catch {
      // fxtwitter down — leave the save as captured
    }
  }
  return filled;
}

let chain: Promise<void> = Promise.resolve();

export function videoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (/(^|\.)youtu\.be$/i.test(u.hostname)) return u.pathname.replace(/^\//, "").split("/")[0] || null;
    if (!/(^|\.)youtube\.com$/i.test(u.hostname)) return null;
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

export function parseYtDate(html: string): string | null {
  const raw =
    html.match(/itemprop="(?:datePublished|uploadDate)"[^>]*content="([^"]+)"/)?.[1] ||
    html.match(/content="([^"]+)"[^>]*itemprop="(?:datePublished|uploadDate)"/)?.[1] ||
    html.match(/"(?:uploadDate|publishDate|datePublished)":"([^"]+)"/)?.[1];
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function enrichYtDates(db: Db, urls?: string[]): Promise<number> {
  const rows = (
    urls
      ? urls.map((url) => db.prepare(`SELECT id, url, published_at FROM items WHERE url = ?`).get(url))
      : db.prepare(`SELECT id, url, published_at FROM items WHERE published_at IS NULL AND (url LIKE '%youtube.com/watch%' OR url LIKE '%youtu.be/%')`).all()
  ).filter(Boolean) as { id: string; url: string; published_at: string | null }[];

  let filled = 0;
  for (const row of rows) {
    if (row.published_at) continue;
    const id = videoId(row.url);
    if (!id) continue;
    try {
      const res = await fetch(`https://www.youtube.com/watch?v=${id}`, {
        headers: { "user-agent": "Mozilla/5.0", accept: "text/html" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const publishedAt = parseYtDate(await res.text());
      if (!publishedAt) continue;
      db.prepare(`UPDATE items SET published_at = ?, updated_at = ? WHERE id = ?`).run(publishedAt, nowIso(), row.id);
      filled += 1;
    } catch {
      // watch page blocked — leave undated
    }
  }
  return filled;
}

export function scheduleXEnrich(db: Db, urls?: string[]): void {
  chain = chain
    .then(async () => {
      await enrichXItems(db, urls);
      await enrichYtDates(db, urls);
    })
    .then(() => {})
    .catch(() => {});
}
