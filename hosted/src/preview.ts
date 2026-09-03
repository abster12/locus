import { framePermission, parsePreview, type LinkPreview } from "../../core/link-preview.ts";
import { fetchReadingPage, publicHttpUrl, ReadingFetchError } from "./reading-fetch.ts";
import { first, run } from "./sql.ts";

// Link preview + frame-check for the hosted Worker. Both fetch arbitrary
// URLs, so both go through the reading-fetch SSRF policy (`publicHttpUrl`):
// only http(s), no credentials in the URL, only public hostnames, and every
// redirect hop is revalidated before the next fetch. Bytes and time are
// bounded. Workers cannot resolve DNS, so the check is hostname-level; see
// docs/adr/0005 for the full policy.

const ERROR_TTL_MS = 24 * 60 * 60 * 1000;
const PREVIEW_TIMEOUT_MS = 6_000;
const PREVIEW_MAX_BYTES = 256 * 1024;
const FRAME_TIMEOUT_MS = 6_000;
const MAX_REDIRECTS = 4;

interface PreviewRow {
  url: string;
  status: string;
  title: string | null;
  description: string | null;
  image: string | null;
  site_name: string | null;
  fetched_at: string;
}

function rowToPreview(url: string, r: PreviewRow | null): LinkPreview {
  if (!r) {
    return { url, status: "error", title: null, description: null, image: null, siteName: null, fetchedAt: "" };
  }
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

export async function getLinkPreview(db: D1Database, libraryId: string, rawUrl: string): Promise<LinkPreview> {
  const url = rawUrl.trim();
  if (!url) return { url, status: "error", title: null, description: null, image: null, siteName: null, fetchedAt: "" };

  const cached = await first<PreviewRow>(
    db,
    `SELECT * FROM link_previews WHERE library_id = ? AND url = ?`,
    libraryId,
    url,
  );
  if (cached && (cached.status === "ok" || Date.now() - Date.parse(cached.fetched_at) < ERROR_TTL_MS)) {
    return rowToPreview(url, cached);
  }

  const base: LinkPreview = {
    url,
    status: "error",
    title: null,
    description: null,
    image: null,
    siteName: null,
    fetchedAt: new Date().toISOString(),
  };
  try {
    // SSRF policy before the fetch: publicHttpUrl runs inside fetchReadingPage
    // and on every redirect hop; bytes and time are bounded there too.
    const page = await fetchReadingPage(url, {
      accept: "text/html,application/xhtml+xml",
      maxBytes: PREVIEW_MAX_BYTES,
      timeoutMs: PREVIEW_TIMEOUT_MS,
    });
    const contentType = page.contentType.toLowerCase();
    if (page.status < 200 || page.status >= 300) throw new ReadingFetchError("network_error", `http ${page.status}`);
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      throw new ReadingFetchError("network_error", "not html");
    }
    const found = parsePreview(page.body, page.url.toString());
    const ok: LinkPreview = { ...base, status: "ok", ...found };
    await save(db, libraryId, ok);
    return ok;
  } catch {
    await save(db, libraryId, base);
    return base;
  }
}

async function save(db: D1Database, libraryId: string, p: LinkPreview): Promise<void> {
  await run(
    db,
    `INSERT INTO link_previews (library_id, url, status, title, description, image, site_name, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (library_id, url) DO UPDATE SET
       status = excluded.status, title = excluded.title, description = excluded.description,
       image = excluded.image, site_name = excluded.site_name, fetched_at = excluded.fetched_at`,
    libraryId,
    p.url,
    p.status,
    p.title,
    p.description,
    p.image,
    p.siteName,
    p.fetchedAt,
  );
}

/** Frameability check: headers only, no cache, body never read. */
export async function frameCheck(rawUrl: string): Promise<"yes" | "no" | "unknown"> {
  try {
    let current = publicHttpUrl(rawUrl.trim());
    for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
      const response = await fetch(current.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(FRAME_TIMEOUT_MS),
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "LocusDesk/0.1 (frame check)",
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        void response.body?.cancel();
        if (!location) return "unknown";
        current = publicHttpUrl(new URL(location, current).toString());
        continue;
      }
      void response.body?.cancel();
      return framePermission(
        response.status,
        response.headers.get("x-frame-options"),
        response.headers.get("content-security-policy"),
      );
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

// allowsIframe stays in core/link-preview.ts; the Worker imports framePermission only.
