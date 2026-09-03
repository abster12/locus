import { tagsForShelf, type ShelfKey } from "../../core/categories.ts";
import type {
  AtlasAssignment,
  AtlasCard,
  AtlasPlace,
  AtlasProjection,
  ItemCard,
  ItemCounts,
  KitchenItem,
  ReadingPage,
  ReadingSummary,
  RecipeDocument,
  RecipeSummary,
  TonightEntry,
  TripDocument,
  TripSources,
  TripSummary,
} from "./api.ts";
import { cloneExampleStore, type ExampleStore } from "./example-seed.ts";

export const EXAMPLE_LIBRARY_ID = "example";
export const EXAMPLE_CSRF = "example";

let store: ExampleStore | null = null;
let generation = 0;

export function isExampleActive(): boolean {
  return store !== null;
}

export function exampleGeneration(): number {
  return generation;
}

export function enterExample(room?: string): void {
  store = cloneExampleStore();
  generation += 1;
  const hash = roomHash(room);
  if (typeof location !== "undefined") location.hash = hash;
}

export function resetExample(): void {
  store = cloneExampleStore();
  generation += 1;
  if (typeof window !== "undefined") window.dispatchEvent(new Event("locus:example-reset"));
}

export function exitExample(): void {
  store = null;
  generation += 1;
}

function roomHash(room?: string): string {
  if (room === "kitchen") return "#/kitchen";
  if (room === "reading") return "#/reading";
  if (room === "atlas") return "#/atlas";
  if (room === "trips") return "#/trips";
  return "#/recent";
}

function requireStore(): ExampleStore {
  if (!store) throw fail(404, "example library is not open");
  return store;
}

function fail(status: number, error: string): Error {
  const err = new Error(error) as Error & { status: number };
  err.status = status;
  return err;
}

function readBody(init?: RequestInit): Record<string, unknown> {
  if (!init?.body || typeof init.body !== "string") return {};
  try {
    const value = JSON.parse(init.body) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function itemOf(current: ExampleStore, id: string): ItemCard | null {
  return current.items.find((item) => item.id === id) ?? null;
}

function recipeSummary(recipe: RecipeDocument): RecipeSummary {
  return {
    id: recipe.id,
    itemId: recipe.itemId,
    status: recipe.status,
    sourceChanged: recipe.sourceChanged,
    title: recipe.title,
    servings: recipe.servings,
    totalTime: recipe.totalTime,
  };
}

function asKitchen(current: ExampleStore, item: ItemCard, fullRecipe: boolean): KitchenItem | null {
  const meta = current.meta[item.id];
  if (!meta?.food) return null;
  const recipe = meta.recipe;
  return {
    item,
    availability: recipe?.status === "reviewed" ? "reviewed" : recipe?.status === "draft" ? "draft" : meta.caption ? "caption" : "source_only",
    caption: meta.caption,
    canWatch: item.source === "instagram" || item.source === "youtube",
    displayTitle: item.title || "Untitled",
    showCaptionPreview: Boolean(meta.caption),
    recipe: recipe ? (fullRecipe ? recipe : recipeSummary(recipe)) : null,
  };
}

function tonightEntries(current: ExampleStore): TonightEntry[] {
  return current.tonight.map((row) => {
    const item = itemOf(current, row.itemId);
    return {
      id: row.id,
      itemId: row.itemId,
      order: row.order,
      createdAt: row.createdAt,
      item: item ? asKitchen(current, item, false) : null,
    };
  });
}

function countsOf(current: ExampleStore, view?: string): ItemCounts {
  const visible = current.items.filter((item) => (view === "inbox" ? item.status === "inbox" : item.status !== "archived" && item.status !== "rejected"));
  const shelves: Record<string, number> = {};
  for (const item of visible) {
    const keys = new Set(item.tags.map((tag) => {
      const name = tag.name.toLowerCase();
      if (name === "food") return "food";
      if (name === "travel") return "travel";
      if (name === "books") return "culture";
      return "else";
    }));
    for (const key of keys) shelves[key] = (shelves[key] ?? 0) + 1;
  }
  return {
    total: visible.length,
    inbox: current.items.filter((item) => item.status === "inbox").length,
    shelves,
  };
}

function filterItems(current: ExampleStore, params: URLSearchParams): ItemCard[] {
  const view = params.get("view") ?? "";
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const source = params.get("source") ?? "";
  const shelf = params.get("shelf") ?? "";
  const collectionId = params.get("collectionId") ?? "";
  let items = current.items.slice();
  if (view === "inbox") items = items.filter((item) => item.status === "inbox");
  else items = items.filter((item) => item.status !== "archived" && item.status !== "rejected");
  if (source) items = items.filter((item) => item.source === source);
  if (collectionId) items = items.filter((item) => item.collections.some((row) => row.id === collectionId));
  if (q) {
    items = items.filter((item) => `${item.title ?? ""} ${item.body ?? ""} ${item.authorName ?? ""}`.toLowerCase().includes(q));
  }
  if (shelf) {
    const tags = new Set(tagsForShelf(shelf as ShelfKey).map((name) => name.toLowerCase()));
    items = items.filter((item) => item.tags.some((tag) => tags.has(tag.name.toLowerCase())));
  }
  return items;
}

function placeOf(current: ExampleStore, id: string | null): AtlasPlace | null {
  if (!id) return null;
  return current.places.find((place) => place.id === id) ?? null;
}

function assignment(current: ExampleStore, item: ItemCard): AtlasAssignment | null {
  const meta = current.meta[item.id];
  if (!meta?.atlas) return null;
  const primary = placeOf(current, meta.placeId);
  return {
    id: `assign-${item.id}`,
    itemId: item.id,
    outcome: primary ? "placed" : "needs_place",
    actor: "user",
    version: 1,
    primary,
    contained: [],
    mentioned: [],
    peers: [],
    suggestions: [],
  };
}

function atlasCard(current: ExampleStore, item: ItemCard): AtlasCard | null {
  const row = assignment(current, item);
  if (!row || !row.primary) return null;
  return { item, assignment: row };
}

function projectAtlas(current: ExampleStore): AtlasProjection {
  const atlasItems = current.items.filter((item) => current.meta[item.id]?.atlas);
  const needs = atlasItems.filter((item) => !current.meta[item.id]?.placeId);
  const placed = atlasItems.filter((item) => current.meta[item.id]?.placeId);
  const byPlace = new Map<string, ItemCard[]>();
  for (const item of placed) {
    const id = current.meta[item.id]!.placeId!;
    const list = byPlace.get(id) ?? [];
    list.push(item);
    byPlace.set(id, list);
  }
  const home = placeOf(current, current.homePlaceId);
  const destinations = [...byPlace.entries()].map(([placeId, rows]) => {
    const place = placeOf(current, placeId)!;
    const around = placeId === current.homePlaceId;
    return {
      id: placeId,
      title: place.name,
      kind: around ? ("around_home" as const) : ("destination" as const),
      placeId,
      count: rows.length,
      contained: [],
      items: rows.map((item) => atlasCard(current, item)!),
    };
  }).sort((a, b) => {
    if (a.kind === "around_home") return -1;
    if (b.kind === "around_home") return 1;
    return a.title.localeCompare(b.title);
  });
  return {
    home: { place: home },
    analysis: { available: false, detail: "Example library", queued: 0, failed: 0, backfillDone: true },
    needsPlace: {
      count: needs.length,
      preview: needs.map((item) => ({ item, assignment: assignment(current, item) })),
      items: needs.map((item) => ({ item, assignment: assignment(current, item) })),
    },
    multiple: [],
    destinations,
    counts: { items: atlasItems.length, destinations: destinations.length },
  };
}

function readingSummary(item: ItemCard, reading: NonNullable<ExampleStore["meta"][string]["reading"]>): ReadingSummary {
  return {
    id: item.id,
    canonicalUrl: item.url,
    title: item.title || "Untitled",
    subtitle: null,
    byline: item.authorHandle,
    publication: reading.pub,
    host: "example.invalid",
    kind: "article",
    availability: "ready",
    failureCode: null,
    originalStatus: "ok",
    excerpt: item.body,
    wordCount: (item.body ?? "").split(/\s+/).length,
    readingMinutes: reading.minutes,
    lastSavedAt: item.firstObservedAt,
    sources: item.source ? [item.source] : [],
    savedCount: 1,
    heroAssetId: null,
    progress: reading.state === "finished" ? { state: "finished", progress: 1 } : null,
  };
}

function readingPage(current: ExampleStore, params: URLSearchParams): ReadingPage {
  const view = params.get("view") === "finished" ? "finished" : "queue";
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const source = params.get("source") ?? "";
  const rows = current.items
    .map((item) => {
      const reading = current.meta[item.id]?.reading;
      if (!reading || reading.removed) return null;
      if (q && !`${item.title ?? ""} ${item.body ?? ""}`.toLowerCase().includes(q)) return null;
      if (source && item.source !== source) return null;
      return { item, reading };
    })
    .filter((row): row is { item: ItemCard; reading: NonNullable<ExampleStore["meta"][string]["reading"]> } => row !== null);
  const unread = rows.filter((row) => row.reading.state !== "finished").map((row) => readingSummary(row.item, row.reading));
  const finished = rows.filter((row) => row.reading.state === "finished").map((row) => readingSummary(row.item, row.reading));
  return {
    view,
    preparing: { count: 0, preview: [] },
    unread: { items: unread, nextCursor: null },
    items: view === "finished" ? finished : unread,
    nextCursor: null,
    counts: { unread: unread.length, reading: 0, preparing: 0, finished: finished.length },
  };
}

function tripSummary(trip: TripDocument): TripSummary {
  const stops = [...trip.days.flatMap((day) => day.stops), ...trip.unscheduled];
  return {
    id: trip.id,
    title: trip.title,
    destination: trip.destination,
    startDate: trip.startDate,
    endDate: trip.endDate,
    durationDays: trip.durationDays,
    revision: trip.revision,
    archivedAt: trip.archivedAt,
    updatedAt: trip.updatedAt,
    draftCount: stops.filter((stop) => stop.state === "draft").length,
    holeCount: stops.filter((stop) => stop.content.kind === "hole").length,
  };
}

function tripSources(current: ExampleStore, q: string): TripSources {
  const needle = q.trim().toLowerCase();
  const items = current.items
    .filter((item) => !needle || `${item.title ?? ""} ${item.body ?? ""}`.toLowerCase().includes(needle))
    .slice(0, 12)
    .map((item) => ({ id: item.id, title: item.title || "Untitled", source: item.source }));
  const places = current.places
    .filter((place) => !needle || place.name.toLowerCase().includes(needle))
    .map((place) => ({ id: place.id, name: place.name, kind: place.kind }));
  return { items, places };
}

function addTonight(current: ExampleStore, itemId: string): TonightEntry {
  const existing = current.tonight.find((row) => row.itemId === itemId);
  if (existing) {
    const item = itemOf(current, itemId);
    return {
      id: existing.id,
      itemId,
      order: existing.order,
      createdAt: existing.createdAt,
      item: item ? asKitchen(current, item, false) : null,
    };
  }
  const item = itemOf(current, itemId);
  if (!item || !current.meta[itemId]?.food) throw fail(404, "item not found");
  const row = {
    id: `tonight-${itemId}`,
    itemId,
    order: current.tonight.length,
    createdAt: new Date().toISOString(),
  };
  current.tonight.push(row);
  current.tonightRevision += 1;
  return tonightEntries(current).find((entry) => entry.id === row.id)!;
}

export async function exampleRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const current = requireStore();
  const url = new URL(path, "https://example.invalid");
  const method = (init?.method ?? "GET").toUpperCase();
  const body = readBody(init);
  const parts = url.pathname.split("/").filter(Boolean);
  const data = dispatch(current, method, parts, url.searchParams, body);
  return data as T;
}

function dispatch(
  current: ExampleStore,
  method: string,
  parts: string[],
  params: URLSearchParams,
  body: Record<string, unknown>,
): unknown {
  if (parts[0] !== "api") throw fail(404, "Not found");
  const a = parts[1];
  const b = parts[2];
  const c = parts[3];
  const d = parts[4];

  if (a === "items" && !b && method === "GET") {
    const items = filterItems(current, params);
    return { items, nextCursor: null, counts: countsOf(current, params.get("view") ?? "") };
  }
  if (a === "items" && b === "counts" && method === "GET") {
    return { counts: countsOf(current, params.get("view") ?? "") };
  }
  if (a === "items" && b && !c && method === "GET") {
    const item = itemOf(current, b);
    if (!item) throw fail(404, "item not found");
    return { item };
  }
  if (a === "items" && b && c === "status" && method === "POST") {
    const item = itemOf(current, b);
    if (!item) throw fail(404, "item not found");
    item.status = String(body.status ?? item.status);
    item.snoozedUntil = typeof body.snoozedUntil === "string" ? body.snoozedUntil : null;
    return { item };
  }
  if (a === "items" && b === "auto-tag" && method === "POST") {
    return { tagged: 0, applied: 0 };
  }

  if (a === "collections" && method === "GET") {
    return { collections: [], tags: uniqueTags(current) };
  }

  if (a === "intake" && b === "context" && method === "GET") {
    return { version: "example-1", collections: [], tags: uniqueTags(current).map((tag) => ({ ...tag, consequence: null })) };
  }
  if (a === "intake" && b === "search" && method === "GET") {
    const q = (params.get("q") ?? params.get("url") ?? "").toLowerCase();
    const items = current.items
      .filter((item) => !q || `${item.title ?? ""} ${item.url}`.toLowerCase().includes(q))
      .slice(0, 20)
      .map((item) => ({ id: item.id, title: item.title || item.url, url: item.url, source: item.source }));
    return { items };
  }

  if (a === "kitchen" && !b && method === "GET") {
    const q = (params.get("q") ?? "").trim().toLowerCase();
    const source = params.get("source") ?? "";
    const food = current.items
      .map((item) => asKitchen(current, item, false))
      .filter((row): row is KitchenItem => row !== null)
      .filter((row) => !q || `${row.displayTitle} ${row.item.body ?? ""}`.toLowerCase().includes(q))
      .filter((row) => !source || row.item.source === source);
    return {
      items: food,
      nextCursor: null,
      counts: {
        foodSaves: food.length,
        structuredRecipes: food.filter((row) => row.recipe).length,
        tonight: current.tonight.length,
      },
      sources: [...new Set(food.map((row) => row.item.source).filter(Boolean))],
    };
  }
  if (a === "kitchen" && b === "ai" && method === "GET") {
    return { available: false, detail: "Example library" };
  }
  if (a === "kitchen" && b === "items" && c && !d && method === "GET") {
    const item = itemOf(current, c);
    const row = item ? asKitchen(current, item, true) : null;
    if (!row) throw fail(404, "item not found");
    return row;
  }
  if (a === "kitchen" && b === "tonight" && !c && method === "GET") {
    return tonightEntries(current);
  }
  if (a === "kitchen" && b === "tonight" && c === "state" && method === "GET") {
    return { revision: current.tonightRevision, entries: tonightEntries(current) };
  }
  if (a === "kitchen" && b === "tonight" && !c && method === "POST") {
    return addTonight(current, String(body.itemId ?? ""));
  }
  if (a === "kitchen" && b === "tonight" && c === "reorder" && method === "POST") {
    const ids = Array.isArray(body.entryIds) ? body.entryIds.map(String) : [];
    current.tonight = ids.map((id, order) => {
      const row = current.tonight.find((entry) => entry.id === id);
      if (!row) throw fail(400, "unknown tonight entry");
      return { ...row, order };
    });
    current.tonightRevision += 1;
    return tonightEntries(current);
  }
  if (a === "kitchen" && b === "tonight" && c === "clear" && method === "POST") {
    const removed = current.tonight.length;
    current.tonight = [];
    current.tonightRevision += 1;
    return { removed };
  }
  if (a === "kitchen" && b === "tonight" && c && d === "remove" && method === "POST") {
    const before = current.tonight.length;
    current.tonight = current.tonight.filter((row) => row.id !== c).map((row, order) => ({ ...row, order }));
    if (current.tonight.length === before) throw fail(404, "not found");
    current.tonightRevision += 1;
    return { removed: true };
  }
  if (a === "kitchen" && b === "tonight" && c === "apply" && method === "POST") {
    const expected = Number(body.expectedRevision);
    const mutationId = String(body.clientMutationId ?? "");
    if (mutationId && mutationId === current.tonightMutationId) {
      return { revision: current.tonightRevision, entries: tonightEntries(current), replayed: true };
    }
    if (expected !== current.tonightRevision) throw fail(409, "stale");
    const operations = Array.isArray(body.operations) ? body.operations : [];
    for (const raw of operations) {
      if (!raw || typeof raw !== "object") continue;
      const op = raw as { op?: string; itemId?: string; itemIds?: string[] };
      if (op.op === "add" && op.itemId) addTonight(current, op.itemId);
      else if (op.op === "remove" && op.itemId) {
        current.tonight = current.tonight.filter((row) => row.itemId !== op.itemId).map((row, order) => ({ ...row, order }));
        current.tonightRevision += 1;
      } else if (op.op === "reorder" && Array.isArray(op.itemIds)) {
        current.tonight = op.itemIds.map((itemId, order) => {
          const row = current.tonight.find((entry) => entry.itemId === itemId);
          if (!row) throw fail(400, "unknown tonight item");
          return { ...row, order };
        });
        current.tonightRevision += 1;
      }
    }
    current.tonightMutationId = mutationId || current.tonightMutationId;
    return { revision: current.tonightRevision, entries: tonightEntries(current), replayed: false };
  }
  if (a === "kitchen" && b === "items" && c && (d === "propose-recipe" || d === "recipe") && method === "POST") {
    const meta = current.meta[c];
    const item = itemOf(current, c);
    if (!item || !meta?.food) throw fail(404, "item not found");
    const caption = meta.caption || item.body || "";
    meta.recipe = {
      id: `recipe-${c}`,
      itemId: c,
      status: d === "recipe" && body.status === "reviewed" ? "reviewed" : "draft",
      sourceChanged: false,
      title: item.title,
      servings: null,
      totalTime: null,
      sourceRevision: "seed",
      sourceCaption: caption,
      updatedBy: d === "propose-recipe" ? "agent" : "user",
      provenance: "caption",
      draft: {
        version: 1,
        title: item.title ?? undefined,
        ingredients: [],
        steps: [{ id: "step-1", instruction: caption || "From the caption.", ingredientIds: [], evidence: { kind: "caption", spans: [] } }],
      },
      score: { placed: [], unreferenced: [], steps: [] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return { document: meta.recipe };
  }

  if (a === "reading" && !b && method === "GET") {
    const page = readingPage(current, params);
    if (params.get("audience") === "agent") {
      return {
        items: page.items.map((row) => ({
          id: row.id,
          title: row.title,
          publication: row.publication,
          host: row.host,
          excerpt: row.excerpt,
          kind: row.kind,
          availability: row.availability,
          hasStoredText: true,
          readingMinutes: row.readingMinutes,
          lastSavedAt: row.lastSavedAt,
          sources: row.sources,
          readingState: row.progress?.state === "finished" ? "finished" : "unread",
          canonicalUrl: row.canonicalUrl,
        })),
        nextCursor: null,
        counts: page.counts,
      };
    }
    return page;
  }
  if (a === "reading" && b && !c && method === "GET") {
    const item = itemOf(current, b);
    const reading = item ? current.meta[item.id]?.reading : null;
    if (!item || !reading || reading.removed) throw fail(404, "document not found");
    const summary = readingSummary(item, reading);
    if (params.get("audience") === "agent") {
      return {
        document: {
          id: item.id,
          title: summary.title,
          byline: summary.byline,
          publication: summary.publication,
          host: summary.host,
          excerpt: summary.excerpt,
          kind: summary.kind,
          availability: summary.availability,
          hasStoredText: true,
          readingMinutes: summary.readingMinutes,
          lastSavedAt: summary.lastSavedAt,
          readingState: reading.state,
          canonicalUrl: summary.canonicalUrl,
          provenance: [{ source: item.source ?? "x", savedAt: item.firstObservedAt, tags: item.tags.map((tag) => tag.name), notes: [] }],
          text: item.body,
          truncated: false,
          totalTextLength: (item.body ?? "").length,
        },
      };
    }
    return {
      document: {
        ...summary,
        observedUrl: item.url,
        finalUrl: item.url,
        originalCheckedAt: item.firstObservedAt,
        publishedAt: item.publishedAt,
        language: "en",
        contentBlocks: { version: 1, blocks: [{ type: "p", text: item.body ?? "" }] },
        toc: [],
        fetchedAt: item.capturedAt,
        updatedAt: item.firstObservedAt,
        progress: reading.state === "finished" ? { state: "finished", progress: 1, anchor: null } : null,
        provenance: [{
          itemId: item.id,
          observedUrl: item.url,
          title: item.title,
          body: item.body,
          source: item.source ?? "x",
          authorName: item.authorName,
          authorHandle: item.authorHandle,
          permalink: item.url,
          firstObservedAt: item.firstObservedAt,
          sourceSavedAt: item.sourceSavedAt,
          capturedAt: item.capturedAt,
          tags: item.tags.map((tag) => ({ id: tag.id, name: tag.name })),
          notes: [],
        }],
        actions: { openOriginal: true, retry: false, remove: true },
      },
    };
  }
  if (a === "reading" && b && c === "progress" && method === "POST") {
    const reading = current.meta[b]?.reading;
    if (!reading) throw fail(404, "document not found");
    if (body.op === "finished") reading.state = "finished";
    if (body.op === "unread") reading.state = "unread";
    return { progress: { state: reading.state, progress: reading.state === "finished" ? 1 : 0, anchor: null } };
  }
  if (a === "reading" && b && c === "remove" && method === "POST") {
    const reading = current.meta[b]?.reading;
    if (!reading) throw fail(404, "document not found");
    reading.removed = true;
    const token = `undo-${b}`;
    current.readingUndo = { token, itemId: b };
    return { undoToken: token, undoExpiresAt: new Date(Date.now() + 60_000).toISOString() };
  }
  if (a === "reading" && b === "undo-remove" && method === "POST") {
    const token = String(body.token ?? "");
    if (!current.readingUndo || current.readingUndo.token !== token) throw fail(404, "undo expired");
    const reading = current.meta[current.readingUndo.itemId]?.reading;
    if (reading) reading.removed = false;
    const item = itemOf(current, current.readingUndo.itemId);
    current.readingUndo = null;
    if (!item || !reading) throw fail(404, "document not found");
    return { document: readingSummary(item, reading) };
  }

  if (a === "atlas" && !b && method === "GET") return projectAtlas(current);
  if (a === "atlas" && b === "places" && method === "GET") {
    const q = (params.get("q") ?? "").toLowerCase();
    const places = current.places.filter((place) => !q || place.name.toLowerCase().includes(q));
    return { places };
  }
  if (a === "atlas" && b === "home" && method === "POST") {
    if (typeof body.placeId === "string") current.homePlaceId = body.placeId;
    if (body.placeId === null) current.homePlaceId = null;
    return { home: placeOf(current, current.homePlaceId), atlas: projectAtlas(current) };
  }
  if (a === "atlas" && b === "items" && c && d === "place" && method === "POST") {
    const meta = current.meta[c];
    if (!meta) throw fail(404, "item not found");
    meta.atlas = true;
    meta.placeId = typeof body.placeId === "string" ? body.placeId : meta.placeId;
    const item = itemOf(current, c)!;
    return { assignment: assignment(current, item), atlas: projectAtlas(current) };
  }
  if (a === "atlas" && b === "items" && c && d === "leave" && method === "POST") {
    const meta = current.meta[c];
    if (!meta) throw fail(404, "item not found");
    meta.placeId = null;
    return { assignment: null, atlas: projectAtlas(current) };
  }
  if (a === "atlas" && b === "items" && c && (d === "not-atlas" || d === "accept" || d === "multiple" || d === "change") && method === "POST") {
    const item = itemOf(current, c);
    if (!item) throw fail(404, "item not found");
    if (d === "not-atlas" && current.meta[c]) current.meta[c]!.atlas = false;
    return { assignment: assignment(current, item), atlas: projectAtlas(current) };
  }

  if (a === "trips" && !b && method === "GET") {
    return { trips: current.trips.map(tripSummary) };
  }
  if (a === "trips" && b === "sources" && method === "GET") {
    return tripSources(current, params.get("q") ?? "");
  }
  if (a === "trips" && b && !c && method === "GET") {
    const trip = current.trips.find((row) => row.id === b);
    if (!trip) throw fail(404, "trip not found");
    return { trip };
  }
  if (a === "trips" && b && c === "history" && method === "GET") {
    return { changesets: [], canUndo: false, canRedo: false, dismissedAdvisories: [] };
  }
  if (a === "trips" && b && c === "share" && !d && method === "GET") {
    return { shared: null };
  }
  if (a === "trips" && b && c === "share" && d === "preview" && method === "POST") {
    const trip = current.trips.find((row) => row.id === b);
    if (!trip) throw fail(404, "trip not found");
    return {
      snapshot: {
        title: trip.title,
        destination: trip.destination,
        startDate: trip.startDate,
        endDate: trip.endDate,
        durationDays: trip.durationDays,
        timezone: trip.timezone,
        days: trip.days.map((day) => ({ label: day.label, date: day.date, stops: [] })),
        unscheduled: [],
      },
      digest: "example",
      revision: trip.revision,
      shared: null,
    };
  }
  if (a === "trips" && b && (c === "review-intent" || c === "agent") && method === "POST") {
    const trip = current.trips.find((row) => row.id === b);
    if (!trip) throw fail(404, "trip not found");
    if (c === "review-intent") return { ok: true, revision: trip.revision };
    return { trip, replayed: false };
  }

  if (a === "sources" && method === "GET") {
    return {
      account: { mode: "hosted" },
      extension: { state: "not_paired", lastSeenAt: null },
      connections: ["x", "instagram", "youtube", "reddit"].map((source) => ({
        source,
        label: source === "x" ? "X" : source[0]!.toUpperCase() + source.slice(1),
        state: "not_connected",
        liveAccount: null,
        progress: null,
        latestAttempt: null,
        lastSuccessfulCapture: null,
      })),
      imports: [],
      preferences: { captureOnOpen: false },
      pi: { available: false, detail: "" },
    };
  }
  if (a === "library-capabilities" && method === "GET") {
    return { capabilities: [], origin: "https://example.invalid", url: "https://example.invalid/mcp" };
  }
  if (a === "frame-check" && method === "GET") return { framed: "unknown" };
  if (a === "link-preview" && method === "GET") {
    return { preview: { url: params.get("url") ?? "", status: "error", title: null, description: null, image: null, siteName: null, fetchedAt: new Date().toISOString() } };
  }
  if (a === "summaries" && method === "GET") {
    return {
      snapshot: { scope: b ?? "day", scopeRef: c ?? "", generatedAt: new Date().toISOString(), blocks: [], items: [] },
      pi: { available: false, detail: "" },
    };
  }

  throw fail(404, "Not found");
}

function uniqueTags(current: ExampleStore): { id: string; name: string; color: string | null }[] {
  const seen = new Map<string, { id: string; name: string; color: string | null }>();
  for (const item of current.items) {
    for (const tag of item.tags) seen.set(tag.id, tag);
  }
  return [...seen.values()];
}
