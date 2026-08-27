import type { ItemCard } from "./api.ts";

export const LIBRARY_CHANGED_EVENT = "locus-library-changed";

export function notifyLibraryChanged(item?: ItemCard): void {
  window.dispatchEvent(new CustomEvent(LIBRARY_CHANGED_EVENT, { detail: item }));
}
