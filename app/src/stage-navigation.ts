import type { ItemCard } from "./api.ts";
import { isPlatformPermalink, outboundUrls } from "../../core/sanitize.ts";

export type FrameCheckResult = "yes" | "no" | "unknown";

/** Cards lead with their first outbound destination; the saved-item view is the fallback. */
export function firstStageDestination(item: Pick<ItemCard, "body" | "url">): string | undefined {
  const bodyDestination = outboundUrls(item.body, item.url)[0];
  if (bodyDestination) return bodyDestination;
  if (isPlatformPermalink(item.url)) return undefined;
  try {
    const url = new URL(item.url);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Only mount a live iframe after the server positively verifies it is frameable. */
export function canMountLiveFrame(result: FrameCheckResult): boolean {
  return result === "yes";
}
