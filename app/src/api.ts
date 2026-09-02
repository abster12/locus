// The setup contract is owned by the server codec; these are type-only
// imports so the browser bundle never executes server policy code.
import type { TripContext, TripSetupInput } from "../../server/trips/policy.ts";

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

export interface AgentReadingSummary {
  id: string;
  title: string;
  publication: string | null;
  host: string;
  excerpt: string | null;
  kind: string;
  availability: string;
  hasStoredText: boolean;
  readingMinutes: number | null;
  lastSavedAt: string;
  sources: string[];
  readingState: string;
  canonicalUrl: string | null;
}

export interface AgentReadingPage {
  items: AgentReadingSummary[];
  nextCursor: string | null;
  counts: { unread: number; reading: number; preparing: number; finished: number };
}

export interface AgentReadingDocument {
  id: string;
  title: string;
  byline: string | null;
  publication: string | null;
  host: string;
  excerpt: string | null;
  kind: string;
  availability: string;
  hasStoredText: boolean;
  readingMinutes: number | null;
  lastSavedAt: string;
  readingState: string;
  canonicalUrl: string | null;
  provenance: { source: string; savedAt: string; tags: string[]; notes: string[] }[];
  text: string | null;
  truncated: boolean;
  totalTextLength: number;
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
  const error = new Error(message || "Request failed");
  // Duck-typed status so callers (e.g. the WebMCP adapters) can distinguish
  // client-fixable 400s from server outages without importing HTTP plumbing.
  (error as { status?: number }).status = res.status;
  return error;
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

export interface SessionContext {
  csrf: string;
  libraryId: string;
}

export async function boot(): Promise<SessionContext> {
  const s = await req<SessionContext>("/api/session");
  csrf = s.csrf;
  return s;
}

function newMutationId(): string {
  // Every Trip mutation carries a fresh client mutation id so a retry can be
  // detected server-side without the caller tracking one.
  return crypto.randomUUID();
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
  readingForAgent: (q = "", signal?: AbortSignal) =>
    req<AgentReadingPage>(`/api/reading?audience=agent${q ? `&${q}` : ""}`, { signal }),
  readingDocumentForAgent: (id: string, signal?: AbortSignal) =>
    req<{ document: AgentReadingDocument }>(`/api/reading/${encodeURIComponent(id)}?audience=agent`, { signal }),
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
  sources: () => req<AccountSourcesOverview>("/api/sources"),
  connect: (source: SourceId, accountId?: string) =>
    req<{ copy: string; via?: string }>(`/api/sources/${source}/connect`, { method: "POST", body: JSON.stringify({ accountId }) }),
  cancel: (source: SourceId, accountId: string) =>
    req(`/api/sources/${source}/cancel`, { method: "POST", body: JSON.stringify({ accountId }) }),
  resume: (source: SourceId, accountId: string) =>
    req(`/api/sources/${source}/resume`, { method: "POST", body: JSON.stringify({ accountId }) }),
  disconnect: (source: SourceId, accountId: string) =>
    req(`/api/sources/${source}/disconnect`, { method: "POST", body: JSON.stringify({ accountId }) }),
  pairExtension: () =>
    req<{ token: string; origin: string }>("/api/extension/pair", { method: "POST", body: "{}" }),
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
  // Agent-proposal paths for the visible-route WebMCP adapter. The server
  // always applies actor "agent"; callers never send an actor field.
  proposeRecipe: (id: string, body: { expectedSourceRevision: string; draft: unknown; allowGenerate?: boolean }) =>
    req<{ document: RecipeDocument }>(`/api/kitchen/items/${encodeURIComponent(id)}/propose-recipe`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  tonightState: () => req<TonightState>("/api/kitchen/tonight/state"),
  // Caller owns clientMutationId for one logical composition. Retries of an
  // unchanged payload reuse that id; a changed payload must get a fresh one.
  applyTonightChanges: (body: {
    expectedRevision: number;
    clientMutationId: string;
    instruction?: string | null;
    operations: Array<{ op: "add"; itemId: string } | { op: "remove"; itemId: string } | { op: "reorder"; itemIds: string[] }>;
  }) => req<TonightMutationResult>("/api/kitchen/tonight/apply", { method: "POST", body: JSON.stringify(body) }),
  trips: (signal?: AbortSignal) => req<{ trips: TripSummary[] }>("/api/trips", { signal }),
  trip: (id: string, signal?: AbortSignal) => req<{ trip: TripDocument }>(`/api/trips/${encodeURIComponent(id)}`, { signal }),
  // Caller owns clientMutationId for one logical create. Retries of an
  // unchanged payload must reuse that id; a new or changed payload gets a
  // fresh one. This function forwards the body unchanged.
  createTrip: (body: TripSetupBody & { clientMutationId: string }) =>
    req<{ trip: TripDocument }>("/api/trips", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  // Existing-document Trip mutations carry { expectedRevision, clientMutationId, ...payload }.
  // Lifecycle helpers still mint a fresh id per call. Planner apply/undo/redo
  // (and create) leave clientMutationId to the caller so a lost-response retry
  // can replay instead of colliding on a new id at a stale revision.
  updateTrip: (id: string, body: TripSetupBody & { expectedRevision: number }) =>
    req<{ trip: TripDocument }>(`/api/trips/${encodeURIComponent(id)}/update`, {
      method: "POST",
      body: JSON.stringify({ ...body, clientMutationId: newMutationId() }),
    }),
  renameTrip: (id: string, title: string, expectedRevision: number) =>
    req<{ trip: TripDocument }>(`/api/trips/${encodeURIComponent(id)}/rename`, {
      method: "POST",
      body: JSON.stringify({ title, expectedRevision, clientMutationId: newMutationId() }),
    }),
  duplicateTrip: (id: string, expectedRevision: number) =>
    req<{ trip: TripDocument }>(`/api/trips/${encodeURIComponent(id)}/duplicate`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision, clientMutationId: newMutationId() }),
    }),
  archiveTrip: (id: string, expectedRevision: number) =>
    req<{ trip: TripDocument }>(`/api/trips/${encodeURIComponent(id)}/archive`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision, clientMutationId: newMutationId() }),
    }),
  restoreTrip: (id: string, expectedRevision: number) =>
    req<{ trip: TripDocument }>(`/api/trips/${encodeURIComponent(id)}/restore`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision, clientMutationId: newMutationId() }),
    }),
  deleteTrip: (id: string, expectedRevision: number) =>
    req<{ deleted: boolean }>(`/api/trips/${encodeURIComponent(id)}/delete`, {
      method: "POST",
      body: JSON.stringify({ confirm: "DELETE", expectedRevision, clientMutationId: newMutationId() }),
    }),
  applyTripChanges: (id: string, body: { expectedRevision: number; clientMutationId: string; instruction?: string; operations: TripChangeOp[] }) =>
    req<TripMutationResult>(`/api/trips/${encodeURIComponent(id)}/changes`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  // WebMCP adapter path: the agent supplies its own clientMutationId, and the
  // server derives actor "agent" from this trusted route (agent writes begin
  // Draft). Never used by the human Day Planner. Inferred preferences ride
  // the same atomic changeset when a base build supplies them.
  applyTripChangesAsAgent: (
    id: string,
    body: { expectedRevision: number; clientMutationId: string; instruction?: string | null; operations: unknown[]; inferredPreferences?: unknown[] },
  ) =>
    req<TripMutationResult>(`/api/trips/${encodeURIComponent(id)}/agent/changes`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  // WebMCP advisory path: the page's agent bridge calls this only after the
  // user asked for a review on the visible Trip Document.
  recordTripReviewAsAgent: (id: string, body: { expectedRevision: number; clientMutationId: string; flags: unknown[] }) =>
    req<{ trip: TripDocument; replayed: boolean }>(`/api/trips/${encodeURIComponent(id)}/agent/review`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  armTripReview: (id: string, expectedRevision: number) =>
    req<{ ok: true; revision: number }>(`/api/trips/${encodeURIComponent(id)}/review-intent`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
    }),
  // WebMCP build path: inferred preferences ride the same atomic changeset.
  removeTripInference: (id: string, inferenceId: string, expectedRevision: number) =>
    req<{ trip: TripDocument }>(`/api/trips/${encodeURIComponent(id)}/inferences/${encodeURIComponent(inferenceId)}/remove`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision, clientMutationId: newMutationId() }),
    }),
  dismissTripAdvisory: (id: string, advisoryId: string, expectedRevision: number) =>
    req<{ trip: TripDocument }>(`/api/trips/${encodeURIComponent(id)}/advisories/${encodeURIComponent(advisoryId)}/dismiss`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision, clientMutationId: newMutationId() }),
    }),
  undoTripChanges: (id: string, expectedRevision: number, clientMutationId: string) =>
    req<TripMutationResult>(`/api/trips/${encodeURIComponent(id)}/undo`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision, clientMutationId }),
    }),
  redoTripChanges: (id: string, expectedRevision: number, clientMutationId: string) =>
    req<TripMutationResult>(`/api/trips/${encodeURIComponent(id)}/redo`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision, clientMutationId }),
    }),
  tripHistory: (id: string, signal?: AbortSignal) =>
    req<{ changesets: TripChangesetView[]; canUndo: boolean; canRedo: boolean; dismissedAdvisories: TripAdvisory[] }>(
      `/api/trips/${encodeURIComponent(id)}/history`,
      { signal },
    ),
  tripSources: (q: string, signal?: AbortSignal) =>
    req<TripSources>(`/api/trips/sources?q=${encodeURIComponent(q)}`, { signal }),
  shareState: (id: string, signal?: AbortSignal) =>
    req<{ shared: TripShareState | null }>(`/api/trips/${encodeURIComponent(id)}/share`, { signal }),
  sharePreview: (id: string) =>
    req<{ snapshot: TripShareSnapshot; digest: string; revision: number; shared: TripShareState | null }>(`/api/trips/${encodeURIComponent(id)}/share/preview`, {
      method: "POST",
      body: "{}",
    }),
  sharePublish: (id: string, expectedRevision: number, digest: string) =>
    req<{ token: string | null; snapshot: TripShareSnapshot; revision: number; updatedAt: string }>(`/api/trips/${encodeURIComponent(id)}/share/publish`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision, clientMutationId: newMutationId(), digest }),
    }),
  shareRevoke: (id: string, expectedRevision: number) =>
    req<{ revoked: boolean }>(`/api/trips/${encodeURIComponent(id)}/share/revoke`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision, clientMutationId: newMutationId() }),
    }),
  atlas: (signal?: AbortSignal) => req<AtlasProjection>("/api/atlas", { signal }),
  atlasPlaces: (q: string, signal?: AbortSignal) =>
    req<{ places: AtlasPlace[] }>(`/api/atlas/places?q=${encodeURIComponent(q)}`, { signal }),
  atlasHome: (body: { placeId?: string | null; name?: string; kind?: string; parentId?: string | null }) =>
    req<{ home: AtlasPlace | null; atlas: AtlasProjection }>("/api/atlas/home", { method: "POST", body: JSON.stringify(body) }),
  atlasAccept: (id: string, index: number, expectedVersion: number) =>
    req<{ assignment: AtlasAssignment; atlas: AtlasProjection }>(`/api/atlas/items/${encodeURIComponent(id)}/accept`, {
      method: "POST",
      body: JSON.stringify({ index, expectedVersion }),
    }),
  atlasPlace: (id: string, body: { expectedVersion: number; placeId?: string; name?: string; kind?: string; parentId?: string | null }) =>
    req<{ assignment: AtlasAssignment; atlas: AtlasProjection }>(`/api/atlas/items/${encodeURIComponent(id)}/place`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  atlasMultiple: (id: string, expectedVersion: number) =>
    req<{ assignment: AtlasAssignment; atlas: AtlasProjection }>(`/api/atlas/items/${encodeURIComponent(id)}/multiple`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion }),
    }),
  atlasNotAtlas: (id: string, expectedVersion: number) =>
    req<{ assignment: AtlasAssignment; atlas: AtlasProjection }>(`/api/atlas/items/${encodeURIComponent(id)}/not-atlas`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion }),
    }),
  atlasLeave: (id: string, expectedVersion: number) =>
    req<{ assignment: AtlasAssignment | null; atlas: AtlasProjection }>(`/api/atlas/items/${encodeURIComponent(id)}/leave`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion }),
    }),
  atlasChange: (id: string, placeId: string, expectedVersion: number) =>
    req<{ assignment: AtlasAssignment; atlas: AtlasProjection }>(`/api/atlas/items/${encodeURIComponent(id)}/change`, {
      method: "POST",
      body: JSON.stringify({ placeId, expectedVersion }),
    }),
};

export interface AtlasPlace {
  id: string;
  name: string;
  kind: string;
  parentId: string | null;
  ancestors: { id: string; name: string }[];
  altNames: string[];
  accent: { color: string; ink: string };
}

export interface AtlasSuggestion {
  name: string;
  kind: string;
  parentName?: string;
  role: string;
  evidence: { field: string; start: number; end: number; text: string }[];
}

export interface AtlasAssignment {
  id: string;
  itemId: string;
  outcome: string;
  actor: "analyzer" | "user";
  version: number;
  primary: AtlasPlace | null;
  contained: AtlasPlace[];
  mentioned: AtlasPlace[];
  peers: AtlasPlace[];
  suggestions: AtlasSuggestion[];
}

export interface AtlasCard {
  item: ItemCard;
  assignment: AtlasAssignment;
}

export interface AtlasReviewRow {
  item: ItemCard;
  assignment: AtlasAssignment | null;
}

export interface AtlasProjection {
  home: { place: AtlasPlace | null };
  analysis: { available: boolean; detail: string; queued: number; failed: number; backfillDone: boolean };
  needsPlace: { count: number; preview: AtlasReviewRow[]; items: AtlasReviewRow[] };
  multiple: AtlasCard[];
  destinations: {
    id: string;
    title: string;
    kind: "around_home" | "destination";
    placeId: string | null;
    count: number;
    contained: string[];
    items: AtlasCard[];
  }[];
  counts: { items: number; destinations: number };
}

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

export interface TonightState {
  revision: number;
  entries: TonightEntry[];
}

export interface TonightMutationResult extends TonightState {
  replayed: boolean;
}

export interface KitchenIndex {
  items: KitchenItem[];
  nextCursor: string | null;
  counts: { foodSaves: number; structuredRecipes: number; tonight: number };
  sources?: string[];
}

export interface TripDay {
  id: string;
  position: number;
  date: string | null;
  label: string;
  theme: string | null;
  stops: TripStop[];
}

export type TripStopContent =
  | { kind: "item"; itemId: string }
  | { kind: "place"; placeId: string }
  | { kind: "outside"; title: string; notes: string | null; url: string | null }
  | { kind: "hole"; request: string };

export type TripStopResolved =
  | { kind: "item"; title: string; source: string | null; url: string | null }
  | { kind: "place"; name: string; kindLabel: string; location: string | null };

export interface TripStop {
  id: string;
  dayId: string | null;
  position: number;
  content: TripStopContent;
  resolved: TripStopResolved | null;
  broken: boolean;
  state: "confirmed" | "draft";
  provenance: { actor: string; via: string };
  publicNotes: string;
  privateNotes: string;
  timeWindow: string | null;
  durationMinutes: number | null;
  reservation: string | null;
  storedFacts: string[];
  alternatives: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TripChangesetView {
  id: string;
  tripId: string;
  kind: "change" | "undo" | "redo";
  actor: string;
  instruction: string | null;
  summary: string;
  baseRevision: number;
  resultRevision: number;
  reversesId: string | null;
  createdAt: string;
  undoneAt: string | null;
}

export interface TripMutationResult {
  trip: TripDocument;
  changeset: TripChangesetView;
  replayed: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

/** Client-facing placement ops: stops are identified by id only; the module
 * rejects absolute indexes from any adapter. */
export type TripChangeOp =
  | {
      type: "addStop";
      dayId: string | null;
      content: TripStopContent;
      beforeStopId?: string;
      afterStopId?: string;
      timeWindow?: string | null;
      durationMinutes?: number | null;
      publicNotes?: string | null;
      privateNotes?: string | null;
      state?: "confirmed" | "draft";
    }
  | {
      type: "updateStop";
      stopId: string;
      content?: TripStopContent;
      timeWindow?: string | null;
      durationMinutes?: number | null;
      publicNotes?: string | null;
      privateNotes?: string | null;
      reservation?: string | null;
      storedFacts?: string[];
      alternatives?: string[];
      state?: "confirmed" | "draft";
    }
  | { type: "moveStop"; stopId: string; dayId?: string | null; beforeStopId?: string; afterStopId?: string }
  | { type: "removeStop"; stopId: string }
  | { type: "updateDay"; dayId: string; theme: string | null };

export interface TripSourceItem {
  id: string;
  title: string;
  source: string | null;
}

export interface TripSourcePlace {
  id: string;
  name: string;
  kind: string;
}

export interface TripSources {
  items: TripSourceItem[];
  places: TripSourcePlace[];
}

// Mirror of the server's Share Snapshot allowlist (server/trips/share.ts).
// Only allowlisted fields exist here; the client never has to filter.
export interface TripShareStop {
  name: string;
  kind: "item" | "place" | "outside" | "hole";
  timeWindow: string | null;
  durationMinutes: number | null;
  notes: string | null;
  sourceUrl: string | null;
  location: string | null;
}

export interface TripShareSnapshot {
  title: string;
  destination: string;
  startDate: string | null;
  endDate: string | null;
  durationDays: number;
  timezone: string | null;
  days: { label: string; date: string | null; stops: TripShareStop[] }[];
  unscheduled: TripShareStop[];
}

export interface TripShareState {
  revision: number;
  updatedAt: string;
}

export type { TripContext };

export type TripAdvisoryCategory = "travel_feasibility" | "strain" | "missing_information";
export type TripAdvisorySeverity = "info" | "concern" | "urgent";

/** Agent-authored preference inference (ticket 10): a labelled document-level
 * annotation, never user-entered context. Removable by the human. */
export interface TripInference {
  id: string;
  text: string;
  basis: string;
}

export interface TripAdvisory {
  id: string;
  tripId: string;
  reviewedRevision: number;
  category: TripAdvisoryCategory;
  severity: TripAdvisorySeverity;
  opinion: string;
  rationale: string;
  dayRefs: string[];
  stopRefs: string[];
  actor: string;
  createdAt: string;
  dismissedAt: string | null;
}

export interface TripDocument {
  id: string;
  libraryId: string;
  title: string;
  destination: string;
  timezone: string | null;
  startDate: string | null;
  endDate: string | null;
  durationDays: number;
  travelers: string | null;
  context: TripContext;
  inferences: TripInference[];
  revision: number;
  archivedAt: string | null;
  days: TripDay[];
  unscheduled: TripStop[];
  advisories: TripAdvisory[];
  createdAt: string;
  updatedAt: string;
}

export interface TripSummary {
  id: string;
  title: string;
  destination: string;
  startDate: string | null;
  endDate: string | null;
  durationDays: number;
  revision: number;
  archivedAt: string | null;
  updatedAt: string;
  draftCount: number;
  holeCount: number;
}

// Same wire shape as the authoritative server setup codec input.
export type TripSetupBody = TripSetupInput;

export interface SummarySnapshot {
  scope: string;
  scopeRef: string;
  generatedAt: string;
  blocks: { kind: string; title: string; count?: number; itemIds?: string[]; rows?: Record<string, unknown>[] }[];
  items: { id: string; title: string | null; url: string; source: string; authorHandle: string | null }[];
}

export interface ImportSummary {
  id: string;
  source: SourceId;
  label: string;
  importedAt: string;
  itemCount: number;
}

export type SourceConnectionState =
  | "not_connected"
  | "connecting"
  | "connected"
  | "capturing"
  | "needs_attention";

export type ExtensionHealthState = "not_paired" | "paired" | "needs_attention";

export interface ExtensionHealth {
  state: ExtensionHealthState;
  lastSeenAt: string | null;
}

export interface SourceProgress {
  phase: string;
  seen: number;
  upserted: number;
  message: string;
  errorCode?: string;
  coverage?: string;
  previewJpeg?: string;
  pageUrl?: string;
}

export interface SourceRunSummary {
  id: string;
  status: string;
  coverage: string | null;
  startedAt: string;
  finishedAt: string | null;
  seenCount: number;
  upsertedCount: number;
  errorCode: string | null;
  recovery: string | null;
}

export interface SourceConnection {
  source: SourceId;
  label: string;
  state: SourceConnectionState;
  liveAccount: {
    id: string;
    externalId: string;
    displayName: string | null;
  } | null;
  progress: SourceProgress | null;
  latestAttempt: SourceRunSummary | null;
  lastSuccessfulCapture: SourceRunSummary | null;
}

export interface AccountSourcesOverview {
  account: { mode: "local" };
  extension: ExtensionHealth;
  connections: SourceConnection[];
  imports: ImportSummary[];
  preferences: { captureOnOpen: boolean };
  pi: { available: boolean; detail: string };
}
