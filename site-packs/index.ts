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

export { xPack, youtubePack, redditPack, instagramPack };
export type { SitePack } from "./shared.ts";
