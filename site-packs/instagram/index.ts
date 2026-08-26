// Instagram Saved. After the grid, readList opens each *new* post for the caption.
import { scanList, type CaptureContext, type Post, type SitePack } from "../shared.ts";

function igState(): "logged-out" | "challenge" | "empty" | "ready" | "loading" | "wrong-page" | "unknown" {
  const url = location.href;
  const text = document.body?.innerText?.slice(0, 8000) ?? "";
  if (/accounts\/login|accounts\/emailsignup/.test(url)) return "logged-out";
  if (/challenge|checkpoint|suspicious/i.test(url)) return "challenge";
  if (/we suspect automated behavior|confirm it.s you|help us confirm/i.test(text)) return "challenge";
  if (/log in to instagram|sign up/i.test(text) && document.querySelector('input[name="username"], input[name="password"]')) {
    return "logged-out";
  }
  // Feed also has /p/ and /reel/ links — only Saved counts.
  if (!/instagram\.com\/(saves|[^/]+\/saved)/.test(url)) return "wrong-page";
  if (/only you can see what you.ve saved|no saved posts/i.test(text)) return "empty";
  if (document.querySelector("a[href*='/p/'], a[href*='/reel/']")) return "ready";
  return "loading";
}

function igAccount(): string | null {
  const link = document.querySelector('a[href^="/"][role="link"] img[alt$="profile picture"]') as HTMLImageElement | null;
  const alt = link?.alt || "";
  const m = alt.match(/^(.+?)'s profile picture/);
  if (m?.[1]) return m[1];
  const canonical = document.querySelector('meta[property="og:url"]')?.getAttribute("content") || "";
  const u = canonical.match(/instagram\.com\/([^/]+)/);
  if (u?.[1] && u[1] !== "p" && u[1] !== "reel" && u[1] !== "saves") return u[1];
  return null;
}

// Runs inside the tab via evaluate(). Must stay self-contained (no module locals).
function extractIgCards(): Post[] {
  const pageCode = location.pathname.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/)?.[2];
  const pageDate = document.querySelector("time[datetime]")?.getAttribute("datetime") || undefined;
  const cards: Post[] = [];
  for (const a of document.querySelectorAll("a[href*='/p/'], a[href*='/reel/']")) {
    const href = (a as HTMLAnchorElement).href || a.getAttribute("href") || "";
    const post = href.match(/\/p\/([A-Za-z0-9_-]+)/);
    const reel = href.match(/\/reel\/([A-Za-z0-9_-]+)/);
    const code = post?.[1] ?? reel?.[1];
    if (!code) continue;
    if (cards.some((c) => c.id === code)) continue;
    const img = a.querySelector("img");
    const src = img?.currentSrc || img?.getAttribute("src") || "";
    const alt = (img?.getAttribute("alt") || "").trim();
    const by = alt.match(/^(?:Photo|Video)(?: shared)? by (.+?) on /i)?.[1]?.trim();
    cards.push({
      id: code,
      contentType: reel ? "reel" : "post",
      url: post ? `https://www.instagram.com/p/${code}/` : `https://www.instagram.com/reel/${code}/`,
      title: alt && !/^instagram$/i.test(alt) ? alt.slice(0, 200) : undefined,
      authorName: by,
      authorHandle: by,
      publishedAt: pageCode === code ? pageDate : undefined,
      media: /^https?:\/\//.test(src) ? [{ kind: "image", url: src }] : undefined,
    });
  }
  return cards;
}

function extractIgOpened(): {
  title?: string;
  text?: string;
  authorName?: string;
  authorHandle?: string;
  publishedAt?: string;
  media?: { kind: string; url: string }[];
} {
  const root = document.querySelector("div[role='dialog']") || document.querySelector("main") || document.body;
  let user: string | undefined;
  for (const a of root.querySelectorAll("a[href^='/']")) {
    const path = ((a.getAttribute("href") || "").split("?")[0] || "").replace(/\/$/, "");
    const name = path.startsWith("/") ? path.slice(1) : path;
    if (name && !name.includes("/") && !/^(p|reel|reels|stories|explore|direct|saves|accounts|about|tv)$/i.test(name)) {
      user = name;
      break;
    }
  }
  const caption = (
    (root.querySelector("h1") as HTMLElement | null)?.innerText ||
    document.querySelector("meta[property='og:description']")?.getAttribute("content") ||
    document.querySelector("meta[name='description']")?.getAttribute("content") ||
    ""
  ).trim();
  const bad = /t51\.2885-19|s150x150|s50x50|s206x206|s320x320|profile|emoji|cdn\.fbsbx\.com/i;
  const article = root.querySelector("article") || root;
  const header = article.querySelector("header");
  const cands: { url: string; area: number }[] = [];
  for (const img of article.querySelectorAll("img")) {
    const el = img as HTMLImageElement;
    if (header && header.contains(el)) continue;
    const src = el.currentSrc || el.getAttribute("src") || "";
    if (!/^https?:\/\//.test(src) || bad.test(src)) continue;
    const w = el.naturalWidth || el.width || 0;
    const h = el.naturalHeight || el.height || 0;
    if (w && h && (w < 180 || h < 180)) continue;
    cands.push({ url: src, area: (w || 800) * (h || 800) });
  }
  cands.sort((a, b) => b.area - a.area);
  const media: { kind: string; url: string }[] = [];
  const top = cands[0];
  if (top) {
    media.push({ kind: "image", url: top.url });
    for (const c of cands.slice(1)) {
      if (c.url === top.url || c.area < top.area * 0.45) continue;
      media.push({ kind: "image", url: c.url });
      if (media.length >= 4) break;
    }
  }
  const raw = root.querySelector("time")?.getAttribute("datetime") || undefined;
  const publishedAt = raw && !Number.isNaN(new Date(raw).getTime()) ? new Date(raw).toISOString() : undefined;
  return {
    title: caption ? caption.slice(0, 200) : undefined,
    text: caption || undefined,
    authorName: user,
    authorHandle: user,
    publishedAt,
    media: media.length ? media : undefined,
  };
}

function igEmpty(): boolean {
  return /only you can see what you.ve saved|no saved posts/i.test(document.body?.innerText ?? "");
}

export const instagramPack: SitePack = {
  manifest: {
    id: "instagram",
    version: "1.0.0",
    protocolVersion: 1,
    hostPermissions: ["https://www.instagram.com/*"],
    collectionUrl: "https://www.instagram.com/saves/all-posts/",
    collectionExternalId: "saved",
    collectionName: "Saved",
  },
  detect(page) {
    if (/instagram\.com\/(saves|[^/]+\/saved)/.test(page.url)) {
      return { kind: "collection", collectionExternalId: "saved", collectionName: "Saved", collectionUrl: page.url };
    }
    const p = page.url.match(/instagram\.com\/(p|reel)\/([A-Za-z0-9_-]+)/);
    if (p?.[2]) {
      return { kind: "item", collectionExternalId: "saved", collectionName: "Saved", collectionUrl: page.url };
    }
    return null;
  },
  pageState: (ctx) => ctx.evaluate(igState),
  accountId: (ctx) => ctx.evaluate(igAccount),
  async *readList(ctx: CaptureContext, knownIds: string[] = []) {
    const found: Post[] = [];
    for await (const card of scanList(ctx, extractIgCards, { empty: igEmpty, known: new Set(knownIds) })) {
      found.push(card);
    }
    for (const card of found) {
      if (ctx.cancelled()) break;
      await ctx.goto(card.url);
      await ctx.wait(800);
      const rich = await ctx.evaluate(extractIgOpened);
      yield { ...card, ...rich, url: card.url, id: card.id };
    }
  },
  async readPage(ctx: CaptureContext): Promise<Post | null> {
    const url = await ctx.url();
    const m = url.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
    if (!m?.[2]) return null;
    const rich = await ctx.evaluate(extractIgOpened);
    return {
      id: m[2],
      contentType: m[1] === "reel" ? "reel" : "post",
      url: m[1] === "reel" ? `https://www.instagram.com/reel/${m[2]}/` : `https://www.instagram.com/p/${m[2]}/`,
      ...rich,
    };
  },
};
