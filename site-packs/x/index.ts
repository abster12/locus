import type { CaptureBatchV1 } from "../../packages/protocol/types.ts";
import { cardsToBatch, type CaptureContext, type CaptureRequest, type PageContext, type SitePack } from "../shared.ts";

function extractXCards(): {
  externalId: string;
  contentType: "post" | "thread";
  url: string;
  title?: string;
  body?: string;
  authorName?: string;
  authorHandle?: string;
  publishedAt?: string;
  media?: { kind: string; url: string }[];
}[] {
  const tweetBody = (el: Element) => {
    const textEl = el.querySelector('[data-testid="tweetText"]');
    if (!textEl) return undefined;
    let out = "";
    const walk = (n: Node) => {
      if (n.nodeType === 3) {
        out += n.textContent ?? "";
        return;
      }
      if (n.nodeType !== 1) return;
      const node = n as Element;
      const tag = node.nodeName;
      if (tag === "A") {
        const title = node.getAttribute("title") || "";
        const href = node.getAttribute("href") || "";
        if (/^https?:\/\//.test(title)) {
          out += title;
          return;
        }
        if (/^https?:\/\//.test(href) && !/t\.co\//.test(href)) {
          out += href;
          return;
        }
        out += (node as HTMLElement).innerText || "";
        return;
      }
      if (tag === "IMG") {
        out += node.getAttribute("alt") || "";
        return;
      }
      if (tag === "BR") {
        out += "\n";
        return;
      }
      for (const c of node.childNodes) walk(c);
    };
    walk(textEl);
    const body = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return body || undefined;
  };
  const tweetLinks = (el: Element, selfId: string) => {
    const found: string[] = [];
    const add = (raw: string) => {
      const u = raw.trim();
      if (!/^https?:\/\//.test(u)) return;
      if (/(x|twitter)\.com\/(i|intent|share)\//i.test(u)) return;
      const quoted = u.match(/\/status\/(\d+)/)?.[1];
      if (quoted === selfId) return;
      if (!found.includes(u)) found.push(u);
    };
    for (const a of el.querySelectorAll("a")) {
      const title = a.getAttribute("title") || "";
      const href = a.getAttribute("href") || "";
      if (/^https?:\/\//.test(title)) add(title);
      if (/^https?:\/\//.test(href) && !/t\.co\//.test(href)) add(href);
    }
    if (found.length === 0) {
      const card = el.querySelector('[data-testid="card.wrapper"]');
      for (const a of card?.querySelectorAll("a[href]") ?? []) {
        const href = a.getAttribute("href") || "";
        if (/t\.co\//.test(href)) add(href.startsWith("http") ? href : `https://${href.replace(/^\/+/, "")}`);
      }
    }
    return found;
  };
  const tweetName = (el: Element) => {
    const user = el.querySelector('[data-testid="User-Name"]') as HTMLElement | null;
    return user?.innerText?.split("\n").map((s) => s.trim()).find((s) => s && !s.startsWith("@") && s !== "·");
  };
  const tweetHandle = (el: Element, url: string) => {
    const user = el.querySelector('[data-testid="User-Name"]');
    for (const a of user?.querySelectorAll("a[href^='/']") ?? []) {
      const path = (a.getAttribute("href") || "").split("?")[0] ?? "";
      if (/^\/[A-Za-z0-9_]{1,15}$/.test(path) && !/^\/(i|home|explore|search)$/.test(path)) return path.slice(1);
    }
    const m = url.match(/\/([^/?#]+)\/status\/\d+/);
    return m && m[1] !== "i" ? m[1] : undefined;
  };
  const tweetMedia = (el: Element) => {
    const media: { kind: string; url: string }[] = [];
    const seen = new Set<string>();
    for (const img of el.querySelectorAll(
      'img[src*="pbs.twimg.com/media"], img[src*="pbs.twimg.com/ext_tw_video"], img[src*="pbs.twimg.com/amplify_video"]',
    )) {
      let src = img.getAttribute("src") || "";
      if (!src || seen.has(src)) continue;
      seen.add(src);
      src = src.replace(/([?&])name=\w+/, "$1name=small");
      media.push({ kind: "image", url: src });
    }
    return media.slice(0, 8);
  };
  const cards: ReturnType<typeof extractXCards> = [];
  const articles = document.querySelectorAll('article[data-testid="tweet"], article[data-testid="cellInnerDiv"] article');
  for (const el of articles) {
    const links = [...el.querySelectorAll("a[href*='/status/']")];
    let status: string | null = null;
    let href = "";
    for (const a of links) {
      const h = a.getAttribute("href") || "";
      const m = h.match(/\/([^/?#]+)\/status\/(\d+)/);
      if (m?.[2]) {
        status = m[2];
        href = h.split("?")[0] ?? h;
        break;
      }
    }
    if (!status) continue;
    const url = href.startsWith("http") ? href : `https://x.com${href}`;
    const text = tweetBody(el);
    const extras = tweetLinks(el, status);
    let body = text;
    for (const u of extras) {
      if (body?.includes(u)) continue;
      body = body ? `${body}\n${u}` : u;
    }
    cards.push({
      externalId: status,
      contentType: "post",
      url,
      body,
      authorName: tweetName(el),
      authorHandle: tweetHandle(el, url),
      publishedAt: el.querySelector("time")?.getAttribute("datetime") || undefined,
      media: tweetMedia(el),
    });
  }
  return cards;
}

function xState(): "logged-out" | "challenge" | "empty" | "ready" | "loading" | "wrong-page" | "unknown" {
  const url = location.href;
  const text = document.body?.innerText?.slice(0, 8000) ?? "";
  if (/\/i\/flow\/login|\/login(\?|$)|\/i\/jf\/onboarding|redirect_after_login/.test(url)) return "logged-out";
  if (
    /verify you are (a )?human|confirm you.re not a bot|something went wrong/i.test(text) &&
    (document.querySelector('iframe[src*="arkose"], iframe[title*="challenge"], iframe[src*="captcha"]') ||
      /unusual (activity|traffic)/i.test(text))
  ) {
    return "challenge";
  }
  if (document.querySelector('[data-testid="loginButton"], a[href="/login"]') && !document.querySelector('[data-testid="AppTabBar_Home_Link"]')) {
    return "logged-out";
  }
  if (/you haven.t added any posts to your bookmarks|save posts for later|you haven.t (bookmarked|saved) any/i.test(text)) {
    return "empty";
  }
  if (document.querySelector('article[data-testid="tweet"]')) return "ready";
  if (document.querySelector('[data-testid="AppTabBar_Home_Link"]')) {
    if (!/\/i\/(bookmarks|history)/.test(url)) return "wrong-page";
    return "loading";
  }
  return "unknown";
}

function xAccount(): string | null {
  const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  const href = profile?.getAttribute("href") || "";
  const handle = href.replace(/^\//, "").split("/")[0];
  return handle || null;
}

export function isXCollectionUrl(url: string): boolean {
  return /\/i\/(bookmarks|history)(\?|$|\/)/.test(url) || /\/i\/bookmarks/.test(url) || /\/i\/history/.test(url);
}

function xEmpty(): boolean {
  const text = document.body?.innerText ?? "";
  return /you haven.t added any posts to your bookmarks|save posts for later|you haven.t (bookmarked|saved) any/i.test(text);
}

export const xPack: SitePack = {
  manifest: {
    id: "x",
    version: "1.0.0",
    protocolVersion: 1,
    hostPermissions: ["https://x.com/*", "https://twitter.com/*"],
    collectionUrl: "https://x.com/i/bookmarks",
    collectionExternalId: "bookmarks",
    collectionName: "Bookmarks",
  },
  detect(page: PageContext) {
    if (isXCollectionUrl(page.url)) {
      return {
        kind: "collection",
        collectionExternalId: "bookmarks",
        collectionName: "Bookmarks",
        collectionUrl: page.url,
      };
    }
    const item = page.url.match(/https?:\/\/(x|twitter)\.com\/[^/]+\/status\/(\d+)/);
    if (item?.[2]) {
      return {
        kind: "item",
        collectionExternalId: "bookmarks",
        collectionName: "Bookmarks",
        collectionUrl: page.url,
      };
    }
    return null;
  },
  async pageState(ctx) {
    return ctx.evaluate(xState);
  },
  async accountId(ctx) {
    return ctx.evaluate(xAccount);
  },
  async *capture(request: CaptureRequest, ctx: CaptureContext): AsyncGenerator<CaptureBatchV1> {
    const maxItems = request.maxItems ?? 60;
    const seen = new Map<string, ReturnType<typeof extractXCards>[number]>();
    let stagnant = 0;
    let sequence = 0;
    let ticks = 0;
    while (!ctx.cancelled() && seen.size < maxItems && stagnant < 6 && ticks < 80) {
      ticks += 1;
      const batch = await ctx.evaluate(extractXCards);
      const fresh = [];
      for (const card of batch) {
        if (seen.has(card.externalId)) continue;
        seen.set(card.externalId, card);
        fresh.push(card);
        if (seen.size >= maxItems) break;
      }
      if (fresh.length === 0) stagnant += 1;
      else {
        stagnant = 0;
        sequence += 1;
        yield cardsToBatch("pending", sequence, fresh, seen.size - fresh.length);
      }
      if (seen.size >= maxItems) break;
      if (await ctx.evaluate(xEmpty)) break;
      await ctx.scrollBy(1600);
      await ctx.wait(800);
    }
  },
};
