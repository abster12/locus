import type { CaptureBatchV1 } from "../packages/protocol/types.ts";
import type { SourceId } from "../core/types.ts";

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

export interface CaptureRequest {
  mode: "incremental" | "snapshot";
  maxItems?: number;
}

export interface CaptureContext {
  url(): Promise<string>;
  title(): Promise<string>;
  evaluate<T>(fn: () => T): Promise<T>;
  goto(url: string): Promise<void>;
  scrollBy(y: number): Promise<void>;
  wait(ms: number): Promise<void>;
  cancelled(): boolean;
}

export interface ExtractedCard {
  externalId: string;
  contentType: "post" | "thread" | "reel" | "video" | "comment" | "link";
  url: string;
  title?: string;
  body?: string;
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
  capture(request: CaptureRequest, context: CaptureContext): AsyncIterable<CaptureBatchV1>;
}

export async function collectCards(
  ctx: CaptureContext,
  extract: () => ExtractedCard[],
  args: { emptyText: () => boolean; maxItems: number; sessionId: string },
): Promise<{ cards: ExtractedCard[]; coverage: "complete" | "partial"; empty: boolean }> {
  const seen = new Map<string, ExtractedCard>();
  let stagnant = 0;
  let ticks = 0;
  while (!ctx.cancelled() && seen.size < args.maxItems && stagnant < 6 && ticks < 80) {
    ticks += 1;
    const batch = await ctx.evaluate(extract);
    let added = 0;
    for (const card of batch) {
      if (!card.externalId || seen.has(card.externalId)) continue;
      seen.set(card.externalId, card);
      added += 1;
      if (seen.size >= args.maxItems) break;
    }
    if (added === 0) stagnant += 1;
    else stagnant = 0;
    if (seen.size >= args.maxItems) break;
    const empty = await ctx.evaluate(args.emptyText);
    if (empty && seen.size === 0) return { cards: [], coverage: "complete", empty: true };
    await ctx.scrollBy(1400);
    await ctx.wait(700);
  }
  const coverage = ctx.cancelled() || seen.size >= args.maxItems || stagnant >= 6 ? (stagnant >= 6 ? "complete" : "partial") : "partial";
  return { cards: [...seen.values()], coverage, empty: false };
}

export function cardsToBatch(
  sessionId: string,
  sequence: number,
  cards: ExtractedCard[],
  startPosition: number,
): CaptureBatchV1 {
  return {
    sessionId,
    sequence,
    idempotencyKey: `${sessionId}:${sequence}`,
    changes: cards.map((card, i) => ({
      kind: "upsert" as const,
      externalId: card.externalId,
      sourcePosition: startPosition + i,
      item: {
        contentType: card.contentType,
        title: card.title,
        body: card.body,
        url: card.url,
        authorName: card.authorName,
        authorHandle: card.authorHandle,
        publishedAt: card.publishedAt,
        media: card.media,
      },
    })),
  };
}
