/** Hosted staging Library this local install maps to. `"local"` is an alias. */
export const LOCAL_LIBRARY_ID = "9e121d58-36f2-4927-9a5c-4990834f4671";

export function ownedLibraryId(libraryId: string): string {
  const id = libraryId.trim();
  if (!id) throw new Error("library is required");
  return id === "local" ? LOCAL_LIBRARY_ID : id;
}
