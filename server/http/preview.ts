import { lookup } from "node:dns/promises";
import type { Db } from "../../db/open.ts";
import { nowIso } from "../../db/open.ts";
import { absorbPreviewedUrl } from "../reading/module.ts";
import {
  framePermission as framePermissionOf,
  PREVIEW_MAX_BYTES,
  parsePreview,
  type LinkPreview,
} from "../../core/link-preview.ts";

export { allowsIframe, framePermission, parsePreview } from "../../core/link-preview.ts";
export type { LinkPreview } from "../../core/link-preview.ts";

const ERROR_TTL_MS = 24 * 60 * 60 * 1000;

interface PreviewRow {
  url: string;
  status: string;
  title: string | null;
  description: string | null;
  image: string | null;
  site_name: string | null;
  fetched_at: string;
}

export async function linkPreview(db: Db, rawUrl: string): Promise<LinkPreview> {
  const cached = db.prepare(`SELECT * FROM link_previews WHERE url = ?`).get(rawUrl) as PreviewRow | undefined;
  if (cached && (cached.status === "ok" || Date.now() - Date.parse(cached.fetched_at) < ERROR_TTL_MS)) {
    return rowToPreview(cached);
  }
  const base: LinkPreview = {
    url: rawUrl,
    status: "error",
    title: null,
    description: null,
    image: null,
    siteName: null,
    fetchedAt: nowIso(),
  };
  try {
    const { html, finalUrl } = await fetchHtml(rawUrl);
    const found = parsePreview(html, finalUrl);
    const ok: LinkPreview = { ...base, status: "ok", ...found };
    save(db, ok);
    return ok;
  } catch {
    save(db, base);
    return base;
  }
}

function save(db: Db, p: LinkPreview): void {
  db.prepare(
    `INSERT OR REPLACE INTO link_previews (url, status, title, description, image, site_name, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(p.url, p.status, p.title, p.description, p.image, p.siteName, p.fetchedAt);
  if (p.status === "ok" && (p.title || p.description)) {
    try {
      absorbPreviewedUrl(db, p.url, p.title);
    } catch {
      // Preview must not fail the Desk card if Reading discovery throws.
    }
  }
}

function rowToPreview(r: PreviewRow): LinkPreview {
  return {
    url: r.url,
    status: r.status === "ok" ? "ok" : "error",
    title: r.title,
    description: r.description,
    image: r.image,
    siteName: r.site_name,
    fetchedAt: r.fetched_at,
  };
}

// --- fetching ------------------------------------------------------------
// Captured content is untrusted: only http(s), only public hosts (resolved via
// node DNS and checked against private ranges), bounded redirects, bounded
// bytes, hard timeout.

async function fetchHtml(raw: string): Promise<{ html: string; finalUrl: string }> {
  let current = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertFetchable(current);
    const res = await fetch(u, {
      redirect: "manual",
      signal: AbortSignal.timeout(6000),
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; LocusDesk/0.1; local bookmark preview)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      void res.body?.cancel();
      if (!loc) throw new Error(`redirect ${res.status} without location`);
      current = new URL(loc, u).toString();
      continue;
    }
    if (!res.ok) throw new Error(`http ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("application/xhtml")) throw new Error("not html");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < PREVIEW_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    void reader.cancel();
    return { html: Buffer.concat(chunks).toString("utf8"), finalUrl: u.toString() };
  }
  throw new Error("too many redirects");
}

async function assertFetchable(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("bad url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s)");
  const host = u.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("blocked host");
  }
  let address: string;
  try {
    address = (await lookup(host)).address;
  } catch {
    throw new Error("dns failed");
  }
  if (isPrivateIp(address)) throw new Error("blocked address");
  return u;
}

export async function frameCheck(rawUrl: string): Promise<"yes" | "no" | "unknown"> {
  try {
    let current = rawUrl;
    for (let hop = 0; hop < 4; hop++) {
      const u = await assertFetchable(current);
      const res = await fetch(u, {
        redirect: "manual",
        signal: AbortSignal.timeout(6000),
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; LocusDesk/0.1; local bookmark preview)",
          accept: "text/html,application/xhtml+xml",
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        void res.body?.cancel();
        if (!loc) return "unknown";
        current = new URL(loc, u).toString();
        continue;
      }
      void res.body?.cancel();
      return framePermissionOf(res.status, res.headers.get("x-frame-options"), res.headers.get("content-security-policy"));
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function isPrivateIp(ip: string): boolean {
  let h = ip.toLowerCase();
  if (h.startsWith("::ffff:")) h = h.slice(7);
  if (h.includes(":")) {
    return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
  }
  const p = h.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}
