// Source of truth. `npm run build:extension` copies this tree into extension/shell/pack.js.
import type { SourceId } from "../core/types.ts";
import type { SitePack } from "./shared.ts";
import { xPack } from "./x/index.ts";
import { youtubePack } from "./youtube/index.ts";
import { redditPack } from "./reddit/index.ts";
import { instagramPack } from "./instagram/index.ts";

const packs: Record<SourceId, SitePack> = {
  x: xPack,
  youtube: youtubePack,
  reddit: redditPack,
  instagram: instagramPack,
};

export function packFor(source: SourceId): SitePack {
  return packs[source];
}

/** First pack whose detect() accepts this URL. Used by the extension on the active tab. */
export function packForUrl(url: string): SitePack | null {
  for (const pack of Object.values(packs)) {
    if (pack.detect({ url, title: "" })) return pack;
  }
  return null;
}

export { xPack, youtubePack, redditPack, instagramPack };
export type { SitePack, Post, CaptureContext, PageState } from "./shared.ts";
