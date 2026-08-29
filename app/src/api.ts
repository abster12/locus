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

export interface ReadingSummary {
  id: string;
  canonicalUrl: string;
  title: string;
  subtitle: string | null;
  byline: string | null;
  publication: string | null;
  host: string;
  kind: string;
  availability: string;
  failureCode: string | null;
  originalStatus: string;
  excerpt: string | null;
  wordCount: number | null;
  readingMinutes: number | null;
  lastSavedAt: string;
  sources: string[];
  savedCount: number;
  heroAssetId: string | null;
  progress: { state: string; progress: number } | null;
}

export interface ReadingPage {
  view: string;
  preparing: { count: number; preview: ReadingSummary[] };
  unread: { items: ReadingSummary[]; nextCursor: string | null };
  items: ReadingSummary[];
  nextCursor: string | null;
  counts: { unread: number; reading: number; preparing: number; finished: number };
}

export interface ReadingDocumentDetail {
  id: string;
  canonicalUrl: string;
  observedUrl: string;
  finalUrl: string | null;
  kind: string;
  availability: string;
  failureCode: string | null;
  originalStatus: string;
  originalCheckedAt: string | null;
  title: string;
  subtitle: string | null;
  byline: string | null;
  publication: string | null;
  publishedAt: string | null;
  language: string | null;
  excerpt: string | null;
  wordCount: number | null;
  readingMinutes: number | null;
  contentBlocks: { version: number; blocks: unknown[] } | null;
  toc: { id: string; level: number; text: string }[];
  heroAssetId: string | null;
  lastSavedAt: string;
  fetchedAt: string | null;
  updatedAt: string;
  progress: { state: string; progress: number; anchor: string | null } | null;
  provenance: {
    itemId: string;
    observedUrl: string;
    title: string | null;
    body: string | null;
    source: string;
    authorName: string | null;
    authorHandle: string | null;
    permalink: string;
    firstObservedAt: string;
    sourceSavedAt: string | null;
    capturedAt: string | null;
    tags: { id: string; name: string }[];
    notes: { id: string; body: string }[];
  }[];
  actions: { openOriginal: boolean; retry: boolean; remove: boolean };
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

function apiHeaders(init?: RequestInit): Headers {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (csrf && init?.method && init.method !== "GET") headers.set("x-csrf-token", csrf);
  return headers;
}

function errorFrom(res: Response, data: unknown): Error {
  const message =
    data && typeof data === "object" && "error" in data ? String((data as { error?: unknown }).error) : res.statusText;
  return new Error(message || "Request failed");
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: apiHeaders(init), credentials: "same-origin" });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(res.ok ? "Invalid server response" : res.statusText || "Request failed");
    }
  }
  if (!res.ok) throw errorFrom(res, data);
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
  reading: (q = "", signal?: AbortSignal) => req<ReadingPage>(`/api/reading${q ? `?${q}` : ""}`, { signal }),
  readingDocument: (id: string, signal?: AbortSignal) =>
    req<{ document: ReadingDocumentDetail }>(`/api/reading/${encodeURIComponent(id)}`, { signal }),
  retryReading: (id: string) =>
    req<{ document: ReadingDocumentDetail }>(`/api/reading/${encodeURIComponent(id)}/retry`, { method: "POST", body: "{}" }),
  readingProgress: (id: string, body: { op: "advance" | "unread" | "finished"; progress?: number; anchor?: { blockId: string; offset?: number } }) =>
    req<{ progress: { state: string; progress: number; anchor: string | null } | null }>(`/api/reading/${encodeURIComponent(id)}/progress`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  removeReading: (id: string) =>
    req<{ undoToken: string; undoExpiresAt: string }>(`/api/reading/${encodeURIComponent(id)}/remove`, { method: "POST", body: "{}" }),
  undoRemoveReading: (token: string) =>
    req<{ document: ReadingSummary }>(`/api/reading/undo-remove`, { method: "POST", body: JSON.stringify({ token }) }),
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
  exportLibrary: async () => {
    const res = await fetch("/api/export", { credentials: "same-origin", headers: apiHeaders() });
    if (!res.ok) {
      let data: unknown = null;
      try {
        data = JSON.parse(await res.text());
      } catch {
        /* use status text */
      }
      throw errorFrom(res, data);
    }
    const disp = res.headers.get("content-disposition") ?? "";
    const match = /filename="([^"]+)"/.exec(disp);
    return { blob: await res.blob(), filename: match?.[1] || "locus-library.locus.ndjson" };
  },
  importLibrary: async (body: Blob) => {
    const res = await fetch("/api/library/import", {
      method: "POST",
      credentials: "same-origin",
      headers: apiHeaders({ method: "POST", headers: { "content-type": "application/x-ndjson" } }),
      body,
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(res.ok ? "Invalid server response" : res.statusText || "Request failed");
      }
    }
    if (!res.ok) throw errorFrom(res, data);
    return data as { ok: true; records: number };
  },
  deleteLibrary: () => req("/api/library/delete", { method: "POST", body: JSON.stringify({ confirm: "DELETE" }) }),
  importJsonl: (text: string, dryRun: boolean) =>
    req<ImportResult>("/api/import/jsonl", { method: "POST", body: JSON.stringify({ text, dryRun }) }),
  importReddit: (postsCsv: string, commentsCsv: string, dryRun: boolean) =>
    req<ImportResult>("/api/import/reddit-export", { method: "POST", body: JSON.stringify({ postsCsv, commentsCsv, dryRun }) }),
  kitchen: (q: string, signal?: AbortSignal) => req<KitchenIndex>(`/api/kitchen${q ? `?${q}` : ""}`, { signal }),
  kitchenItem: (id: string, signal?: AbortSignal) =>
    req<KitchenItem>(`/api/kitchen/items/${encodeURIComponent(id)}`, { signal }),
  kitchenAi: () => req<{ available: boolean; detail: string }>("/api/kitchen/ai"),
  makeCookable: (id: string, allowGenerate: boolean) =>
    req<{ outcome: "created"; document: RecipeDocument } | { outcome: "needs_generation"; dish: string }>(
      `/api/kitchen/items/${encodeURIComponent(id)}/make-cookable`,
      { method: "POST", body: JSON.stringify({ allowGenerate }) },
    ),
  saveRecipe: (id: string, body: { expectedSourceRevision: string; status: "draft" | "reviewed"; draft: unknown }) =>
    req<{ document: RecipeDocument }>(`/api/kitchen/items/${encodeURIComponent(id)}/recipe`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  removeRecipe: (id: string) =>
    req<{ removed: boolean }>(`/api/kitchen/items/${encodeURIComponent(id)}/recipe/remove`, { method: "POST", body: "{}" }),
  tonight: (signal?: AbortSignal) => req<TonightEntry[]>("/api/kitchen/tonight", { signal }),
  addTonight: (itemId: string) =>
    req<TonightEntry>("/api/kitchen/tonight", { method: "POST", body: JSON.stringify({ itemId }) }),
  reorderTonight: (entryIds: string[]) =>
    req<TonightEntry[]>("/api/kitchen/tonight/reorder", { method: "POST", body: JSON.stringify({ entryIds }) }),
  removeTonight: (entryId: string) =>
    req<{ removed: boolean }>(`/api/kitchen/tonight/${encodeURIComponent(entryId)}/remove`, { method: "POST", body: "{}" }),
  clearTonight: () => req<{ removed: number }>("/api/kitchen/tonight/clear", { method: "POST", body: "{}" }),
};

export interface RecipeSummary {
  id: string;
  itemId: string;
  status: "draft" | "reviewed";
  sourceChanged: boolean;
  title: string | null;
  servings: string | null;
  totalTime: string | null;
}

export interface RecipeDocument extends RecipeSummary {
  sourceRevision: string;
  sourceCaption: string;
  updatedBy: "user" | "agent";
  provenance: "caption" | "generated" | "user";
  draft: {
    version: 1;
    title?: string;
    titleEvidence?: RecipeEvidence;
    servings?: string;
    servingsEvidence?: RecipeEvidence;
    totalTime?: string;
    totalTimeEvidence?: RecipeEvidence;
    ingredients: {
      id: string;
      raw: string;
      quantity?: string;
      unit?: string;
      name: string;
      preparation?: string;
      group?: string;
      evidence: RecipeEvidence;
    }[];
    steps: {
      id: string;
      instruction: string;
      ingredientIds: string[];
      duration?: string;
      temperature?: string;
      evidence: RecipeEvidence;
    }[];
  };
  score: RecipeScore;
  createdAt: string;
  updatedAt: string;
}

export type RecipeEvidence =
  | { kind: "caption"; spans: { start: number; end: number; text: string }[] }
  | { kind: "user" }
  | { kind: "generated" };

export interface RecipeScore {
  placed: { ingredient: RecipeDocument["draft"]["ingredients"][number]; firstStepId: string }[];
  unreferenced: RecipeDocument["draft"]["ingredients"][number][];
  steps: {
    step: RecipeDocument["draft"]["steps"][number];
    ingredients: RecipeDocument["draft"]["ingredients"][number][];
  }[];
}

export interface KitchenItem {
  item: ItemCard;
  availability: "reviewed" | "draft" | "caption" | "watch" | "source_only";
  caption: string | null;
  canWatch: boolean;
  displayTitle: string;
  showCaptionPreview: boolean;
  recipe: RecipeSummary | RecipeDocument | null;
}

export interface TonightEntry {
  id: string;
  itemId: string;
  order: number;
  createdAt: string;
  item: KitchenItem | null;
}

export interface KitchenIndex {
  items: KitchenItem[];
  nextCursor: string | null;
  counts: { foodSaves: number; structuredRecipes: number; tonight: number };
  sources?: string[];
}

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
