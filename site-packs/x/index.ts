// X Bookmarks. extract* is injected into the tab; readList / readPage run in the producer.
import { scanList, type CaptureContext, type PageContext, type Post, type SitePack } from "../shared.ts";

// Runs inside the tab via evaluate(). Must stay self-contained (no module locals).
function extractXCards(): Post[] {
  const asUrl = (raw: string) => {
    const t = (raw || "").trim();
    if (/^https?:\/\//i.test(t)) return t;
    if (/^www\./i.test(t)) return `https://${t}`;
    if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\//i.test(t)) return `https://${t}`;
    return "";
  };
  const anchorUrl = (node: Element) => {
    const titled = asUrl(node.getAttribute("title") || "");
    if (titled) return titled;
    const href = node.getAttribute("href") || "";
    const fromHref = asUrl(href);
    if (fromHref && !/t\.co\//i.test(href)) return fromHref;
    let visible = "";
    const walkA = (n: Node) => {
      if (n.nodeType === 3) {
        visible += n.textContent ?? "";
        return;
      }
      if (n.nodeType !== 1) return;
      const el = n as Element;
      if (el.nodeName === "BR") return;
      if (el.nodeName === "IMG") {
        visible += el.getAttribute("alt") || "";
        return;
      }
      for (const c of el.childNodes ?? []) walkA(c);
    };
    walkA(node);
    return asUrl(visible.replace(/\s+/g, ""));
  };
  const joinWrappedUrls = (text: string) => {
    let out = text;
    let prev = "";
    while (out !== prev) {
      prev = out;
      out = out.replace(/(https?:\/\/[^\s\n]+)\n([a-z0-9./?#&=_%~+-]+)/g, "$1$2");
    }
    return out;
  };
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
        out += anchorUrl(node) || (node as HTMLElement).innerText || "";
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
    const body = joinWrappedUrls(out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
    return body || undefined;
  };
  const tweetLinks = (el: Element, selfId: string) => {
    const found: string[] = [];
    const add = (raw: string) => {
      const u = asUrl(raw) || raw.trim();
      if (!/^https?:\/\//.test(u)) return;
      if (/(x|twitter)\.com\/(i|intent|share)\//i.test(u)) return;
      const quoted = u.match(/\/status\/(\d+)/)?.[1];
      if (quoted === selfId) return;
      if (!found.includes(u)) found.push(u);
    };
    for (const a of el.querySelectorAll("a")) {
      const resolved = anchorUrl(a);
      if (resolved) add(resolved);
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
  const cards: Post[] = [];
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
      id: status,
      contentType: "post",
      url,
      text: body,
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
  // Homepage has tweets too — URL must be Bookmarks / History.
  if (!/\/i\/(bookmarks|history)(\?|$|\/)/.test(url)) return "wrong-page";
  if (/you haven.t added any posts to your bookmarks|save posts for later|you haven.t (bookmarked|saved) any/i.test(text)) {
    return "empty";
  }
  if (document.querySelector('article[data-testid="tweet"]')) return "ready";
  if (document.querySelector('[data-testid="AppTabBar_Home_Link"]')) return "loading";
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

function xLoading(): boolean {
  const root =
    document.querySelector('[aria-label^="Timeline:"], [data-testid="primaryColumn"]') ?? document;
  return Boolean(root.querySelector('[role="progressbar"]'));
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
  async *readList(ctx: CaptureContext, knownIds: string[] = []) {
    yield* scanList(ctx, extractXCards, { empty: xEmpty, known: new Set(knownIds), loading: xLoading });
  },
  async readPage(ctx: CaptureContext): Promise<Post | null> {
    const url = await ctx.url();
    const id = url.match(/status\/(\d+)/)?.[1];
    if (!id) return null;
    const cards = await ctx.evaluate(extractXCards);
    return cards.find((c) => c.id === id) ?? cards[0] ?? null;
  },
};
