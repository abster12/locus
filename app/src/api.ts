export type SourceId = "x" | "instagram" | "youtube" | "reddit";

export interface ItemCard {
  id: string;
  contentType: string;
  title: string | null;
  body: string | null;
  url: string;
  authorName: string | null;
  authorHandle: string | null;
  publishedAt: string | null;
  sourceSavedAt: string | null;
  firstObservedAt: string;
  capturedAt: string | null;
  source: string;
  status: string;
  snoozedUntil: string | null;
  tags: { id: string; name: string; color: string | null }[];
  collections: { id: string; name: string }[];
  notes: { id: string; body: string; createdAt: string }[];
  dateLabel: { kind: string; at: string; text: string };
  media: { kind: string; url: string }[];
}

export interface ItemCounts {
  total: number;
  inbox: number;
  shelves: Record<string, number>;
}

export interface ItemPage {
  items: ItemCard[];
  nextCursor: string | null;
  counts: ItemCounts;
}

export interface ImportResult {
  sessions: number;
  batches: number;
  changes: number;
  inserted: number;
  updated: number;
  removed: number;
  replayed: number;
  errors: string[];
}

async function allItemPages(q: string, signal?: AbortSignal): Promise<ItemCard[]> {
  const items: ItemCard[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams(q);
    params.set("limit", "100");
    if (cursor) params.set("cursor", cursor);
    const page = await req<ItemPage>(`/api/items?${params.toString()}`, { signal });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

export interface Collection {
  id: string;
  name: string;
  description: string | null;
  count: number;
}

export interface LinkPreview {
  url: string;
  status: "ok" | "error";
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  fetchedAt: string;
}

let csrf = "";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (csrf && init?.method && init.method !== "GET") headers.set("x-csrf-token", csrf);
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(res.ok ? "Invalid server response" : res.statusText || "Request failed");
    }
  }
  const message = data && typeof data === "object" && "error" in data ? String((data as { error?: unknown }).error) : res.statusText;
  if (!res.ok) throw new Error(message);
  return data as T;
}

export async function boot(): Promise<void> {
  const s = await req<{ csrf: string }>("/api/session");
  csrf = s.csrf;
}

export const api = {
  items: (q: string, signal?: AbortSignal) => req<ItemPage>(`/api/items${q ? `?${q}` : ""}`, { signal }),
  allItems: (q = "", signal?: AbortSignal) => allItemPages(q, signal),
  itemCounts: (q = "") => req<{ counts: ItemCounts }>(`/api/items/counts${q ? `?${q}` : ""}`),
  item: (id: string) => req<{ item: ItemCard }>(`/api/items/${id}`),
  status: (id: string, status: string, snoozedUntil?: string) =>
    req<{ item: ItemCard }>(`/api/items/${id}/status`, { method: "POST", body: JSON.stringify({ status, snoozedUntil }) }),
  addTag: (id: string, name: string) =>
    req<{ item: ItemCard }>(`/api/items/${id}/tags`, { method: "POST", body: JSON.stringify({ name }) }),
  removeTag: (id: string, tagId: string) =>
    req<{ item: ItemCard }>(`/api/items/${id}/tags/remove`, { method: "POST", body: JSON.stringify({ tagId }) }),
  addNote: (id: string, body: string) =>
    req<{ item: ItemCard }>(`/api/items/${id}/notes`, { method: "POST", body: JSON.stringify({ body }) }),
  addToCollection: (id: string, collectionId: string) =>
    req<{ item: ItemCard }>(`/api/items/${id}/collections`, { method: "POST", body: JSON.stringify({ collectionId }) }),
  removeFromCollection: (id: string, collectionId: string) =>
    req<{ item: ItemCard }>(`/api/items/${id}/collections/remove`, { method: "POST", body: JSON.stringify({ collectionId }) }),
  collections: () => req<{ collections: Collection[]; tags: { id: string; name: string }[] }>("/api/collections"),
  linkPreview: (url: string) => req<{ preview: LinkPreview }>(`/api/link-preview?url=${encodeURIComponent(url)}`),
  frameCheck: (url: string) => req<{ framed: "yes" | "no" | "unknown" }>(`/api/frame-check?url=${encodeURIComponent(url)}`),
  autoTag: () => req<{ tagged: number; applied: number }>("/api/items/auto-tag", { method: "POST", body: "{}" }),
  createCollection: (name: string) =>
    req<{ collection: Collection; collections: Collection[] }>("/api/collections", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  summary: (scope: string, ref: string) => req<{ snapshot: SummarySnapshot; pi: { available: boolean; detail: string } }>(`/api/summaries/${scope}/${encodeURIComponent(ref)}`),
  prose: (scope: string, ref: string) =>
    req<{ prose: { prose: string; citations: string[] }; snapshot: SummarySnapshot; error?: string }>(
      `/api/summaries/${scope}/${encodeURIComponent(ref)}/prose`,
      { method: "POST", body: "{}" },
    ),
  sources: () =>
    req<{
      sources: SourceGroup[];
      settings: { refreshOnOpen: boolean };
      pi: { available: boolean; detail: string };
      extension: { alive: boolean };
    }>("/api/sources"),
  connect: (source: SourceId, accountId?: string) =>
    req<{ copy: string; via?: string }>(`/api/sources/${source}/connect`, { method: "POST", body: JSON.stringify({ accountId }) }),
  cancel: (source: SourceId, accountId: string) =>
    req(`/api/sources/${source}/cancel`, { method: "POST", body: JSON.stringify({ accountId }) }),
  resume: (source: SourceId, accountId: string) =>
    req(`/api/sources/${source}/resume`, { method: "POST", body: JSON.stringify({ accountId }) }),
  disconnect: (source: SourceId, accountId: string) =>
    req(`/api/sources/${source}/disconnect`, { method: "POST", body: JSON.stringify({ accountId }) }),
  pairExtension: (source: SourceId) =>
    req<{ token: string; origin: string }>(`/api/sources/${source}/pair-extension`, { method: "POST", body: "{}" }),
  settings: (refreshOnOpen: boolean) =>
    req("/api/settings", { method: "POST", body: JSON.stringify({ refreshOnOpen }) }),
  exportLibrary: () => req<unknown>("/api/export"),
  deleteLibrary: () => req("/api/library/delete", { method: "POST", body: JSON.stringify({ confirm: "DELETE" }) }),
  importJsonl: (text: string, dryRun: boolean) =>
    req<ImportResult>("/api/import/jsonl", { method: "POST", body: JSON.stringify({ text, dryRun }) }),
  importReddit: (postsCsv: string, commentsCsv: string, dryRun: boolean) =>
    req<ImportResult>("/api/import/reddit-export", { method: "POST", body: JSON.stringify({ postsCsv, commentsCsv, dryRun }) }),
};

export interface SummarySnapshot {
  scope: string;
  scopeRef: string;
  generatedAt: string;
  blocks: { kind: string; title: string; count?: number; itemIds?: string[]; rows?: Record<string, unknown>[] }[];
  items: { id: string; title: string | null; url: string; source: string; authorHandle: string | null }[];
}

export interface SourceGroup {
  source: SourceId;
  label: string;
  accounts: SourceHealth[];
}

export interface SourceHealth {
  source: SourceId;
  account: { id: string; externalId: string; displayName: string | null; state?: "imported" | "pending" | "runner" | "extension" | "connected" } | null;
  running: boolean;
  progress: {
    phase: string;
    seen: number;
    upserted: number;
    message: string;
    errorCode?: string;
    coverage?: string;
    previewJpeg?: string;
    pageUrl?: string;
  } | null;
  lastRun: {
    coverage: string | null;
    status: string;
    seenCount: number;
    upsertedCount: number;
    errorCode: string | null;
    recovery: string | null;
    coverageLabel: string;
  } | null;
}
