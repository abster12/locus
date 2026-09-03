// Link preview and frame-check logic that is pure: no I/O, no database, no
// node built-ins. Both the local server (node fetch + DNS lookups) and the
// hosted Worker (reading-fetch SSRF policy) parse with this module.

export interface LinkPreview {
  url: string;
  status: "ok" | "error";
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  fetchedAt: string;
}

export const PREVIEW_MAX_BYTES = 256 * 1024;

export function allowsIframe(xfo: string | null, csp: string | null): boolean | null {
  const fa = csp?.match(/frame-ancestors\s+([^;,]+)/i)?.[1];
  if (fa) {
    const srcs = fa.trim().split(/\s+/).filter(Boolean);
    if (srcs.includes("*")) return true;
    if (srcs.some((s) => /127\.0\.0\.1|localhost/i.test(s))) return true;
    return false;
  }
  if (xfo) {
    const v = xfo.trim().toLowerCase();
    if (v === "deny" || v === "sameorigin" || v.startsWith("allow-from")) return false;
  }
  return null;
}

export function framePermission(status: number, xfo: string | null, csp: string | null): "yes" | "no" {
  if (status < 200 || status >= 300) return "no";
  return allowsIframe(xfo, csp) === false ? "no" : "yes";
}

export function parsePreview(
  html: string,
  baseUrl: string,
): Pick<LinkPreview, "title" | "description" | "image" | "siteName"> {
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd > 0 ? html.slice(0, headEnd) : html.slice(0, PREVIEW_MAX_BYTES);
  const tags = head.match(/<meta\s[^>]*>/gi) ?? [];
  const meta = (names: string[]): string | null => {
    for (const tag of tags) {
      const key = (attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase();
      if (key && names.includes(key)) {
        const content = attr(tag, "content");
        if (content?.trim()) return decodeEntities(content.trim());
      }
    }
    return null;
  };
  const titleMatch = head.match(/<title[^>]*>([^<]*)<\/title>/i);
  const plainTitle = titleMatch?.[1]?.trim();
  const title = meta(["og:title", "twitter:title"]) ?? (plainTitle ? decodeEntities(plainTitle) : null);
  const description = meta(["og:description", "twitter:description", "description"]);
  const siteName = meta(["og:site_name", "application-name"]);
  const rawImage = meta(["og:image", "og:image:url", "twitter:image", "twitter:image:src"]);
  let image: string | null = null;
  if (rawImage) {
    try {
      const abs = new URL(rawImage, baseUrl);
      if (abs.protocol === "http:" || abs.protocol === "https:") image = abs.toString();
    } catch {
      image = null;
    }
  }
  return { title, description, image, siteName };
}

function attr(tag: string, name: string): string | null {
  const m =
    tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i")) ?? tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i"));
  return m?.[1] ?? null;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m, n: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[n] ?? m);
}
