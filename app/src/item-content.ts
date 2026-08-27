import type { ItemCard } from "./api.ts";

export function who(item: ItemCard): string {
  const h = item.authorHandle?.replace(/^@/, "");
  if (h) return h.includes("/") ? h : `@${h}`;
  return item.authorName || "";
}

export function firstVisual(item: ItemCard): { kind: string; url: string } | null {
  let pics = (item.media || []).filter((m) => m.kind === "image" || m.kind === "video");
  pics = pics.filter((m) => !/t51\.2885-19|s150x150|s206x206|s50x50|cdn\.fbsbx\.com/i.test(m.url));
  if (item.source === "instagram") pics = pics.slice(0, 1);
  return pics[0] ?? null;
}

export function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

export function pathOf(u: string): string {
  try {
    const p = new URL(u).pathname.replace(/\/$/, "");
    return p.length > 46 ? p.slice(0, 46) + "…" : p;
  } catch {
    return "";
  }
}

export const URL_RE = /https?:\/\/[^\s)>"']+/g;

export function extractLinks(body: string | null): { text: string; links: string[] } {
  if (!body) return { text: "", links: [] };
  const norm = body.replace(/(https?:\/\/)\s+/g, "$1");
  const links = [...new Set(norm.match(URL_RE) ?? [])].slice(0, 3);
  const text = norm
    .replace(URL_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { text, links };
}

export function cardTitle(item: ItemCard): string | null {
  if (item.title) return item.title;
  if (/instagram\.com\/reel\//i.test(item.url)) return "Reel";
  if (/instagram\.com\/p\//i.test(item.url)) return "Post";
  return null;
}

export function pubLabel(iso: string | null): string {
  if (!iso) return "Undated";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
