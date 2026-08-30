export const AUTHENTICATED_LIBRARY_CHANGED_EVENT = "locus-authenticated-library-changed";

export function notifyAuthenticatedLibraryChanged(libraryId: string): void {
  const normalized = libraryId.trim();
  if (!normalized) return;
  window.dispatchEvent(new CustomEvent(AUTHENTICATED_LIBRARY_CHANGED_EVENT, { detail: { libraryId: normalized } }));
}

export function authenticatedLibraryFromEvent(event: Event): string | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail = event.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const libraryId = (detail as { libraryId?: unknown }).libraryId;
  if (typeof libraryId !== "string" || !libraryId.trim()) return null;
  return libraryId.trim();
}
