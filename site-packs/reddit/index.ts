import type { CaptureBatchV1 } from "../../packages/protocol/types.ts";
import { cardsToBatch, type CaptureContext, type SitePack } from "../shared.ts";

export function parseRedditTime(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    const ms = raw.length <= 10 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function rdState(): "logged-out" | "challenge" | "empty" | "ready" | "loading" | "wrong-page" | "unknown" {
  const url = location.href;
  const text = document.body?.innerText?.slice(0, 8000) ?? "";
  if (/reddit\.com\/login|reddit\.com\/auth/.test(url)) return "logged-out";
  if (/log in to continue|sign up/.test(text) && document.querySelector('a[href*="/login"]') && !document.querySelector("shreddit-post, .thing")) {
    return "logged-out";
  }
  if (/reddit.com\/challenge|are you a human/i.test(url + text) && document.querySelector("iframe[src*='captcha']")) return "challenge";
  if (/looks like you haven.t saved anything/i.test(text)) return "empty";
  if (document.querySelector("shreddit-post, shreddit-profile-comment, shreddit-comment, .thing.link, .thing.comment, article")) {
    return "ready";
  }
  if (/\/saved/.test(url)) return "loading";
  return "unknown";
}

function rdAccount(): string | null {
  const a = document.querySelector('a[href^="/user/"][href$="/"]');
  const href = a?.getAttribute("href") || "";
  const m = href.match(/^\/user\/([^/]+)/);
  if (m?.[1] && m[1] !== "me") return m[1];
  const faceplate = document.querySelector("[username]");
  const name = faceplate?.getAttribute("username");
  return name || null;
}

function extractRdCards(): {
  externalId: string;
  contentType: "post" | "comment";
  url: string;
  title?: string;
  body?: string;
  authorName?: string;
  authorHandle?: string;
  publishedAt?: string;
}[] {
  const cards: {
    externalId: string;
    contentType: "post" | "comment";
    url: string;
    title?: string;
    body?: string;
    authorName?: string;
    authorHandle?: string;
    publishedAt?: string;
  }[] = [];

  const parseRedditTime = (raw: string | null | undefined) => {
    if (!raw) return undefined;
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      const ms = raw.length <= 10 ? n * 1000 : n;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    }
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  };
  const whenOf = (el: Element) =>
    parseRedditTime(
      el.getAttribute("created-timestamp") ||
        el.getAttribute("created") ||
        el.querySelector("faceplate-time-ago")?.getAttribute("ts") ||
        el.querySelector("faceplate-time-ago")?.getAttribute("seconds") ||
        el.querySelector("time")?.getAttribute("datetime"),
    );
  const outboundOf = (el: Element, permalink: string) => {
    const candidates = [
      el.getAttribute("content-href"),
      el.getAttribute("src"),
      el.getAttribute("data-url"),
      (el.querySelector("a[data-testid='outbound-link']") as HTMLAnchorElement | null)?.href,
    ];
    for (const raw of candidates) {
      if (!raw || !/^https?:\/\//.test(raw)) continue;
      if (raw.split("?")[0] === permalink.split("?")[0]) continue;
      if (/reddit\.com\//i.test(raw) && /\/comments\//.test(raw)) continue;
      return raw;
    }
    return undefined;
  };

  for (const el of document.querySelectorAll("shreddit-post")) {
    const id = el.getAttribute("id") || el.getAttribute("thingid") || "";
    const full = id.startsWith("t3_") ? id : id ? `t3_${id.replace(/^t3_/, "")}` : "";
    const permalink = el.getAttribute("permalink") || el.querySelector("a[href*='/comments/']")?.getAttribute("href") || "";
    if (!full && !permalink) continue;
    const ext = full || permalink;
    const url = permalink.startsWith("http") ? permalink : `https://www.reddit.com${permalink}`;
    const author = el.getAttribute("author") || undefined;
    const outbound = outboundOf(el, url);
    const text = (el.querySelector("[slot='text']") as HTMLElement | null)?.innerText?.trim();
    cards.push({
      externalId: ext,
      contentType: "post",
      url,
      title: el.getAttribute("post-title") || (el.querySelector("[slot='title']") as HTMLElement | null)?.innerText,
      body: [text, outbound].filter(Boolean).join("\n\n") || undefined,
      authorHandle: author,
      authorName: author,
      publishedAt: whenOf(el),
    });
  }

  for (const el of document.querySelectorAll("shreddit-profile-comment, shreddit-comment")) {
    const id = el.getAttribute("thingid") || el.getAttribute("comment-id") || el.getAttribute("id") || "";
    if (!id) continue;
    const full = id.startsWith("t1_") ? id : `t1_${id.replace(/^t1_/, "")}`;
    const permalink = el.getAttribute("permalink") || el.querySelector("a[href*='/comment/']")?.getAttribute("href") || "";
    cards.push({
      externalId: full,
      contentType: "comment",
      url: permalink
        ? permalink.startsWith("http")
          ? permalink
          : `https://www.reddit.com${permalink}`
        : `https://www.reddit.com/${full}`,
      title: "Comment",
      body: (el.querySelector("[slot='comment']") as HTMLElement | null)?.innerText || (el as HTMLElement).innerText?.slice(0, 500),
      authorHandle: el.getAttribute("author") || undefined,
      authorName: el.getAttribute("author") || undefined,
      publishedAt: whenOf(el),
    });
  }

  for (const el of document.querySelectorAll(".thing.link, .thing.comment")) {
    const id = el.getAttribute("data-fullname") || "";
    if (!id) continue;
    const permalink = el.getAttribute("data-permalink") || "";
    const isComment = el.classList.contains("comment") || id.startsWith("t1_");
    const url = permalink ? `https://www.reddit.com${permalink}` : `https://www.reddit.com/${id}`;
    const text = (el.querySelector(".md") as HTMLElement | null)?.innerText;
    const outbound = outboundOf(el, url);
    cards.push({
      externalId: id,
      contentType: isComment ? "comment" : "post",
      url,
      title: (el.querySelector("a.title") as HTMLElement | null)?.innerText || (isComment ? "Comment" : undefined),
      body: [text, outbound].filter(Boolean).join("\n") || undefined,
      authorHandle: el.getAttribute("data-author") || undefined,
      authorName: el.getAttribute("data-author") || undefined,
      publishedAt: whenOf(el) || parseRedditTime(el.getAttribute("data-timestamp")),
    });
  }

  return cards;
}

function extractRdOpened(): {
  title?: string;
  body?: string;
  authorName?: string;
  authorHandle?: string;
  publishedAt?: string;
  media?: { kind: string; url: string }[];
} {
  const parseRedditTime = (raw: string | null | undefined) => {
    if (!raw) return undefined;
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      const ms = raw.length <= 10 ? n * 1000 : n;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    }
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  };
  const comment = location.href.match(/comment\/([a-z0-9]+)/i);
  if (comment) {
    const el = document.querySelector("shreddit-profile-comment, shreddit-comment");
    return {
      title: "Comment",
      body: ((el?.querySelector("[slot='comment']") as HTMLElement | null)?.innerText || (el as HTMLElement | null)?.innerText || "")
        .trim()
        .slice(0, 800) || undefined,
      authorHandle: el?.getAttribute("author") || undefined,
      authorName: el?.getAttribute("author") || undefined,
      publishedAt: parseRedditTime(el?.getAttribute("created-timestamp") || el?.getAttribute("created")),
    };
  }
  const el = document.querySelector("shreddit-post");
  const text = ((el?.querySelector("[slot='text']") as HTMLElement | null)?.innerText || "").trim();
  const outbound = el?.getAttribute("content-href") || undefined;
  const media: { kind: string; url: string }[] = [];
  for (const img of document.querySelectorAll("shreddit-post img, shreddit-aspect-ratio img, gallery-carousel img")) {
    const src = (img as HTMLImageElement).currentSrc || img.getAttribute("src") || "";
    if (!/^https?:\/\//.test(src) || /emoji|avatar|icon|snoo|award/i.test(src)) continue;
    if (media.some((x) => x.url === src)) continue;
    media.push({ kind: "image", url: src });
    if (media.length >= 6) break;
  }
  return {
    title: el?.getAttribute("post-title") || undefined,
    body: [text, outbound].filter(Boolean).join("\n\n") || undefined,
    authorHandle: el?.getAttribute("author") || undefined,
    authorName: el?.getAttribute("author") || undefined,
    publishedAt: parseRedditTime(
      el?.getAttribute("created-timestamp") || el?.getAttribute("created") || document.querySelector("time")?.getAttribute("datetime"),
    ),
    media: media.length ? media : undefined,
  };
}

function rdEmpty(): boolean {
  return /looks like you haven.t saved anything/i.test(document.body?.innerText ?? "");
}

export const redditPack: SitePack = {
  manifest: {
    id: "reddit",
    version: "1.0.0",
    protocolVersion: 1,
    hostPermissions: ["https://www.reddit.com/*", "https://old.reddit.com/*"],
    collectionUrl: "https://www.reddit.com/user/me/saved/",
    collectionExternalId: "saved",
    collectionName: "Saved",
  },
  detect(page) {
    if (/reddit\.com\/user\/[^/]+\/saved|reddit\.com\/saved/.test(page.url)) {
      return { kind: "collection", collectionExternalId: "saved", collectionName: "Saved", collectionUrl: page.url };
    }
    if (/reddit\.com\/r\/[^/]+\/comments\//.test(page.url)) {
      return { kind: "item", collectionExternalId: "saved", collectionName: "Saved", collectionUrl: page.url };
    }
    return null;
  },
  pageState: (ctx) => ctx.evaluate(rdState),
  accountId: (ctx) => ctx.evaluate(rdAccount),
  async *capture(request, ctx: CaptureContext): AsyncGenerator<CaptureBatchV1> {
    const maxItems = request.maxItems ?? 300;
    const found: ReturnType<typeof extractRdCards> = [];
    const seen = new Set<string>();
    let stagnant = 0;
    let ticks = 0;
    while (!ctx.cancelled() && seen.size < maxItems && stagnant < 6 && ticks < 80) {
      ticks += 1;
      const batch = await ctx.evaluate(extractRdCards);
      const fresh = batch.filter((c) => !seen.has(c.externalId));
      for (const c of fresh) {
        seen.add(c.externalId);
        found.push(c);
      }
      if (fresh.length === 0) stagnant += 1;
      else stagnant = 0;
      if (await ctx.evaluate(rdEmpty)) break;
      await ctx.scrollBy(1600);
      await ctx.wait(800);
    }
    let sequence = 0;
    for (const card of found) {
      if (ctx.cancelled()) break;
      await ctx.goto(card.url);
      await ctx.wait(800);
      const rich = await ctx.evaluate(extractRdOpened);
      sequence += 1;
      yield cardsToBatch("pending", sequence, [{ ...card, ...rich, url: card.url, externalId: card.externalId }], sequence - 1);
    }
  },
};
