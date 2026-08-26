// YouTube Watch Later / playlists. List page is enough — no per-video open.
import { scanList, type CaptureContext, type Post, type SitePack } from "../shared.ts";

function ytState(): "logged-out" | "challenge" | "empty" | "ready" | "loading" | "wrong-page" | "unknown" {
  const url = location.href;
  const text = document.body?.innerText?.slice(0, 8000) ?? "";
  if (/accounts\.google\.com|ServiceLogin|\/signin/i.test(url)) return "logged-out";
  if (/before you continue|sign in to youtube/i.test(text) && document.querySelector('a[href*="ServiceLogin"], a[href*="accounts.google"]')) {
    return "logged-out";
  }
  if (/unusual traffic|are you a robot|recaptcha/i.test(text) && document.querySelector("iframe[src*='recaptcha']")) return "challenge";
  // Home / watch also have video renderers — only a playlist page counts.
  if (!/youtube\.com\/playlist\?list=/.test(url)) return "wrong-page";
  if (/no videos in this playlist|watch later is empty/i.test(text)) return "empty";
  if (document.querySelector("ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-rich-item-renderer a#video-title-link")) {
    return "ready";
  }
  return "loading";
}

function ytAccount(): string | null {
  const link = document.querySelector('a[href^="/channel/"], ytd-guide-entry-renderer a[href^="/@"]');
  const href = link?.getAttribute("href") || "";
  if (href.startsWith("/@")) return href.slice(1);
  if (href.startsWith("/channel/")) return href.slice("/channel/".length);
  const avatar = document.querySelector("#avatar-btn, button#avatar-btn");
  return avatar ? "signed-in" : null;
}

// Runs inside the tab via evaluate(). Must stay self-contained (no module locals).
function extractYtCards(): Post[] {
  const pageV = new URL(location.href).searchParams.get("v");
  const pageDate =
    document.querySelector('meta[itemprop="datePublished"], meta[itemprop="uploadDate"]')?.getAttribute("content") ||
    undefined;
  const cards: Post[] = [];
  const rows = document.querySelectorAll("ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer");
  for (const row of rows) {
    const a = row.querySelector("a#video-title, a.yt-simple-endpoint[href*='watch']") as HTMLAnchorElement | null;
    const href = a?.href || a?.getAttribute("href") || "";
    const m = href.match(/[?&]v=([a-zA-Z0-9_-]{6,})/);
    if (!m?.[1]) continue;
    const title = (a?.textContent || "").trim() || undefined;
    const by = (row.querySelector("ytd-channel-name, .yt-simple-endpoint.yt-formatted-string") as HTMLElement | null)
      ?.innerText?.trim();
    cards.push({
      id: m[1],
      contentType: "video",
      url: `https://www.youtube.com/watch?v=${m[1]}`,
      title,
      authorName: by,
      authorHandle: by,
      publishedAt: pageV === m[1] ? pageDate : undefined,
    });
  }
  if (cards.length === 0) {
    for (const a of document.querySelectorAll("a#video-title-link, a#video-title")) {
      const href = (a as HTMLAnchorElement).href || "";
      const m = href.match(/[?&]v=([a-zA-Z0-9_-]{6,})/);
      if (!m?.[1]) continue;
      cards.push({
        id: m[1],
        contentType: "video",
        url: `https://www.youtube.com/watch?v=${m[1]}`,
        title: (a.textContent || "").trim() || undefined,
        publishedAt: pageV === m[1] ? pageDate : undefined,
      });
    }
  }
  return cards;
}

function extractPlaylists(): { id: string; name: string; url: string }[] {
  const out: { id: string; name: string; url: string }[] = [];
  for (const a of document.querySelectorAll("a[href*='list=']")) {
    const href = (a as HTMLAnchorElement).href || "";
    const m = href.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    if (!m?.[1] || m[1] === "WL" || m[1] === "LL") continue;
    const name = (a.textContent || "").trim();
    if (!name) continue;
    if (out.some((p) => p.id === m[1])) continue;
    out.push({ id: m[1], name, url: `https://www.youtube.com/playlist?list=${m[1]}` });
  }
  return out;
}

function extractYtCurrent(): Post | null {
  const id = new URL(location.href).searchParams.get("v");
  if (!id) return null;
  return {
    id,
    contentType: "video",
    url: `https://www.youtube.com/watch?v=${id}`,
    title: document.title.replace(/ - YouTube$/, "") || undefined,
    publishedAt:
      document.querySelector('meta[itemprop="datePublished"], meta[itemprop="uploadDate"]')?.getAttribute("content") ||
      undefined,
  };
}

function ytEmpty(): boolean {
  return /no videos in this playlist|watch later is empty/i.test(document.body?.innerText ?? "");
}

export const youtubePack: SitePack = {
  manifest: {
    id: "youtube",
    version: "1.0.0",
    protocolVersion: 1,
    hostPermissions: ["https://www.youtube.com/*", "https://youtube.com/*"],
    collectionUrl: "https://www.youtube.com/playlist?list=WL",
    collectionExternalId: "WL",
    collectionName: "Watch Later",
  },
  detect(page) {
    if (/youtube\.com\/playlist\?list=WL/.test(page.url)) {
      return { kind: "collection", collectionExternalId: "WL", collectionName: "Watch Later", collectionUrl: page.url };
    }
    const list = page.url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    if (list?.[1] && /youtube\.com\/playlist/.test(page.url)) {
      return { kind: "collection", collectionExternalId: list[1], collectionName: "Playlist", collectionUrl: page.url };
    }
    const video = page.url.match(/[?&]v=([a-zA-Z0-9_-]{6,})/);
    if (video?.[1] && /youtube\.com\/watch/.test(page.url)) {
      return { kind: "item", collectionExternalId: "WL", collectionName: "Watch Later", collectionUrl: page.url };
    }
    return null;
  },
  pageState: (ctx) => ctx.evaluate(ytState),
  accountId: (ctx) => ctx.evaluate(ytAccount),
  async *readList(ctx: CaptureContext, knownIds: string[] = []) {
    yield* scanList(ctx, extractYtCards, { empty: ytEmpty, known: new Set(knownIds) });
  },
  readPage: (ctx) => ctx.evaluate(extractYtCurrent),
};

export async function listYoutubePlaylists(ctx: CaptureContext): Promise<{ id: string; name: string; url: string }[]> {
  await ctx.goto("https://www.youtube.com/feed/playlists");
  await ctx.wait(1500);
  return ctx.evaluate(extractPlaylists);
}
