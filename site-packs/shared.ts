import type { ContentType, SourceId } from "../core/types.ts";

export type PageState =
  | "logged-out"
  | "challenge"
  | "wrong-page"
  | "empty"
  | "ready"
  | "loading"
  | "unknown"
  | "site-changed";

export interface PageContext {
  url: string;
  title: string;
}

export interface CaptureTarget {
  kind: "collection" | "item";
  collectionExternalId: string;
  collectionName: string;
  collectionUrl: string;
  accountExternalId?: string;
}

/**
 * What a producer (extension SW or runner) must give the pack.
 * The pack never talks to Chrome itself — it only calls these.
 */
export interface CaptureContext {
  url(): Promise<string>;
  title(): Promise<string>;
  evaluate<T>(fn: () => T): Promise<T>;
  goto(url: string): Promise<void>;
  scrollBy(y: number): Promise<void>;
  wait(ms: number): Promise<void>;
  cancelled(): boolean;
}

/** One saved post. Desk messages (sessions / batches) are the producer's job. */
export interface Post {
  id: string;
  url: string;
  text?: string;
  title?: string;
  contentType: ContentType;
  authorName?: string;
  authorHandle?: string;
  publishedAt?: string;
  media?: { kind: string; url: string }[];
}

export interface SitePack {
  manifest: {
    id: SourceId;
    version: string;
    protocolVersion: 1;
    hostPermissions: string[];
    collectionUrl: string;
    collectionExternalId: string;
    collectionName: string;
  };
  detect(page: PageContext): CaptureTarget | null;
  pageState(ctx: CaptureContext): Promise<PageState>;
  accountId(ctx: CaptureContext): Promise<string | null>;
  /** Connect — scroll the saved list. Skip ids the desk already has. */
  readList(ctx: CaptureContext, knownIds?: string[]): AsyncIterable<Post>;
  /** Save this item — read the current post page only. */
  readPage(ctx: CaptureContext): Promise<Post | null>;
}

/**
 * Runs inside the tab. Pages through the list's own scroll box (X/IG often
 * are not `window`). Jump-to-end is a no-op once we are already at the bottom
 * of the *loaded* virtual list, so we walk last-card + one viewport, and pull
 * up when that does not move so the next tick can retrigger load-more.
 *
 * Must stay self-contained — chrome.scripting serializes this function.
 */
export function scrollList(): void {
  const selector =
    'article[data-testid="tweet"], ytd-playlist-video-renderer, shreddit-post, shreddit-profile-comment, a[href*="/p/"], a[href*="/reel/"]';
  const cards = document.querySelectorAll(selector);
  const last = cards[cards.length - 1] as HTMLElement | undefined;
  last?.scrollIntoView?.({ block: "end", inline: "nearest" });

  const boxes: HTMLElement[] = [];
  let n: HTMLElement | null = last ?? (document.querySelector(selector) as HTMLElement | null);
  while (n && n !== document.body && n !== document.documentElement) {
    const s = getComputedStyle(n);
    if (/(auto|scroll|overlay)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 40) boxes.push(n);
    n = n.parentElement;
  }
  const page = (document.scrollingElement || document.documentElement) as HTMLElement | null;
  if (page) boxes.push(page);

  for (const box of boxes) {
    const before = box.scrollTop;
    const step = Math.max(480, Math.floor((box.clientHeight || 800) * 0.85));
    if (typeof box.scrollBy === "function") box.scrollBy(0, step);
    else box.scrollTo?.(0, before + step);
    if ((box.scrollTop || 0) <= before + 2) {
      box.scrollTop = Math.max(0, before - Math.max(240, Math.floor((box.clientHeight || 800) * 0.5)));
    }
  }
}

/** Scroll until the list stops growing. Yields only posts not in `known`. */
export async function* scanList(
  ctx: CaptureContext,
  extract: () => Post[],
  args: { empty: () => boolean; known?: Set<string>; loading?: () => boolean },
): AsyncGenerator<Post> {
  const seen = new Set<string>();
  const skip = args.known ?? new Set<string>();
  let stagnant = 0;
  let ticks = 0;
  // ponytail: tick ceiling so a broken scroller cannot loop forever
  while (!ctx.cancelled() && stagnant < 16 && ticks < 1000) {
    ticks += 1;
    const batch = await ctx.evaluate(extract);
    let added = 0;
    for (const post of batch) {
      if (!post.id || seen.has(post.id)) continue;
      seen.add(post.id);
      added += 1;
      if (!skip.has(post.id)) yield post;
    }
    const loading = args.loading ? await ctx.evaluate(args.loading) : false;
    if (added === 0 && !loading) stagnant += 1;
    else stagnant = 0;
    if ((await ctx.evaluate(args.empty)) && seen.size === 0) break;
    await ctx.evaluate(scrollList);
    await ctx.wait(added === 0 ? 1200 : 700);
  }
}
