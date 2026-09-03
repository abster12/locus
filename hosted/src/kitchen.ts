import { createHash } from "node:crypto";
import { tagsForShelf } from "../../core/categories.ts";
import { RejectedPayload } from "../../core/sanitize.ts";
import {
  MAX_KITCHEN_SEARCH,
  MAX_TONIGHT_ENTRIES,
  canWatchItem,
  captionDuplicatesTitle,
  displayCaption,
  displayTitle,
  kitchenAvailability,
  normalizeCaption,
  projectRecipeScore,
  recipeEvidenceKinds,
  validateRecipeDraft,
  validateTonightChanges,
  type RecipeActor,
  type RecipeDraftV1,
  type RecipeScore,
  type RecipeStatus,
  type RecipeWriteInput,
  type TonightChangesInput,
} from "../../server/kitchen/policy.ts";
import { MissingResource, getLibraryItem, listItemsPage, nowIso, type ItemCard } from "./desk.ts";
import { all, first, inMarks, run } from "./sql.ts";

export class KitchenConflict extends Error {
  readonly code = "conflict";
  constructor(message: string) {
    super(message);
    this.name = "KitchenConflict";
  }
}

export type KitchenQuery = {
  q?: string;
  source?: string;
  cursor?: string;
  limit?: number;
};

export type RecipeDocument = {
  id: string;
  itemId: string;
  status: RecipeStatus;
  sourceRevision: string;
  sourceCaption: string;
  sourceChanged: boolean;
  updatedBy: RecipeActor;
  provenance: "caption" | "generated" | "user";
  draft: RecipeDraftV1;
  score: RecipeScore;
  createdAt: string;
  updatedAt: string;
};

export type RecipeSummary = {
  id: string;
  itemId: string;
  status: RecipeStatus;
  sourceChanged: boolean;
  title: string | null;
  servings: string | null;
  totalTime: string | null;
};

export type KitchenItem = {
  item: ItemCard;
  availability: ReturnType<typeof kitchenAvailability>;
  caption: string | null;
  canWatch: boolean;
  displayTitle: string;
  showCaptionPreview: boolean;
  recipe: RecipeDocument | RecipeSummary | null;
};

export type TonightEntry = {
  id: string;
  itemId: string;
  order: number;
  createdAt: string;
  item: KitchenItem | null;
};

export type TonightView = {
  revision: number;
  entries: TonightEntry[];
};

export type TonightMutationResult = TonightView & { replayed: boolean };

type RecipeRow = {
  id: string;
  item_id: string;
  status: RecipeStatus;
  source_revision: string;
  source_caption: string;
  updated_by: RecipeActor;
  draft_json: string;
  created_at: string;
  updated_at: string;
};

type TonightRow = {
  id: string;
  item_id: string;
  position: number;
  created_at: string;
};

const FOOD_FILTER = { view: "recent" as const, shelf: "food" };

export function captionRevision(caption: string): string {
  return createHash("sha256").update(caption).digest("hex");
}

export function kitchenAiStatus(): { available: boolean; detail: string } {
  return {
    available: false,
    detail: "Locus AI isn't available on this deployment yet.",
  };
}

export async function getKitchenIndex(
  db: D1Database,
  libraryId: string,
  query: KitchenQuery = {},
): Promise<{
  items: KitchenItem[];
  nextCursor: string | null;
  counts: { foodSaves: number; structuredRecipes: number; tonight: number };
  sources: string[];
}> {
  const q = boundSearch(query.q);
  const page = await listItemsPage(
    db,
    libraryId,
    {
      ...FOOD_FILTER,
      source: query.source?.trim() || undefined,
      q,
    },
    { cursor: query.cursor, limit: query.limit },
  );
  const recipes = await recipeMap(db, libraryId, page.items);
  return {
    items: page.items.map((item) => presentKitchenItem(item, recipes.get(item.id), false)),
    nextCursor: page.nextCursor,
    counts: {
      foodSaves: page.counts.total,
      structuredRecipes: await recipeDocumentCount(db, libraryId),
      tonight: await tonightCount(db, libraryId),
    },
    sources: [],
  };
}

export async function getKitchenItem(db: D1Database, libraryId: string, itemId: string): Promise<KitchenItem | null> {
  if (!itemId) return null;
  const item = await getLibraryItem(db, libraryId, itemId);
  if (!item) return null;
  if (!(await itemIsFood(db, libraryId, itemId)) && !(await tonightHasItem(db, libraryId, itemId))) return null;
  return presentKitchenItem(item, await loadRecipe(db, libraryId, itemId), true);
}

export async function putRecipeDocument(
  db: D1Database,
  libraryId: string,
  itemId: string,
  input: RecipeWriteInput,
  actor: RecipeActor,
  now = nowIso(),
): Promise<RecipeDocument> {
  await requireWritableItem(db, libraryId, itemId);
  if (typeof input.expectedSourceRevision !== "string" || !input.expectedSourceRevision) {
    throw new RejectedPayload("expectedSourceRevision required");
  }
  const item = await getLibraryItem(db, libraryId, itemId);
  if (!item) throw new MissingResource("item");
  const sourceCaption = normalizeCaption(item.body);
  const sourceRevision = captionRevision(sourceCaption);
  if (input.expectedSourceRevision !== sourceRevision) throw new KitchenConflict("source revision mismatch");
  const status: RecipeStatus = actor === "agent" ? "draft" : input.status;
  if (status !== "draft" && status !== "reviewed") throw new RejectedPayload("invalid recipe status");
  const draft = validateRecipeDraft(input.draft, sourceCaption, actor);
  if (actor === "agent" && recipeEvidenceKinds(draft).has("generated") && !input.allowGenerate) {
    throw new RejectedPayload("generation requires explicit consent");
  }
  const existing = await loadRecipeRow(db, libraryId, itemId);
  const id = existing?.id ?? crypto.randomUUID();
  const createdAt = existing?.created_at ?? now;
  await run(
    db,
    `INSERT INTO kitchen_recipe_documents (
       id, library_id, item_id, schema_version, status, source_revision, source_caption,
       updated_by, draft_json, created_at, updated_at
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(library_id, item_id) DO UPDATE SET
       status = excluded.status,
       source_revision = excluded.source_revision,
       source_caption = excluded.source_caption,
       updated_by = excluded.updated_by,
       draft_json = excluded.draft_json,
       updated_at = excluded.updated_at`,
    id,
    libraryId,
    itemId,
    status,
    sourceRevision,
    sourceCaption,
    actor,
    JSON.stringify(draft),
    createdAt,
    now,
  );
  return presentRecipe((await loadRecipeRow(db, libraryId, itemId))!, sourceCaption);
}

export async function removeRecipeDocument(db: D1Database, libraryId: string, itemId: string): Promise<boolean> {
  const result = await run(db, `DELETE FROM kitchen_recipe_documents WHERE library_id = ? AND item_id = ?`, libraryId, itemId);
  return Number(result.meta.changes ?? 0) > 0;
}

export async function getTonight(db: D1Database, libraryId: string): Promise<TonightEntry[]> {
  const rows = await all<TonightRow>(
    db,
    `SELECT id, item_id, position, created_at FROM kitchen_tonight_entries
      WHERE library_id = ? ORDER BY position ASC, id ASC`,
    libraryId,
  );
  return Promise.all(rows.map((row) => hydrateTonight(db, libraryId, row)));
}

export async function addTonight(db: D1Database, libraryId: string, itemId: string, now = nowIso()): Promise<TonightEntry> {
  const item = await getLibraryItem(db, libraryId, itemId);
  if (!item) throw new MissingResource("item");
  if (!(await itemIsFood(db, libraryId, itemId))) throw new KitchenConflict("item is not eligible for Tonight");
  const existing = await first<TonightRow>(
    db,
    `SELECT id, item_id, position, created_at FROM kitchen_tonight_entries WHERE library_id = ? AND item_id = ?`,
    libraryId,
    itemId,
  );
  if (existing) return hydrateTonight(db, libraryId, existing);
  const count = await tonightCount(db, libraryId);
  if (count >= MAX_TONIGHT_ENTRIES) throw new KitchenConflict("Tonight is full");
  const id = crypto.randomUUID();
  await run(
    db,
    `INSERT INTO kitchen_tonight_entries (id, library_id, item_id, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    libraryId,
    itemId,
    count,
    now,
    now,
  );
  await bumpTonightRevision(db, libraryId);
  return hydrateTonight(db, libraryId, { id, item_id: itemId, position: count, created_at: now });
}

export async function reorderTonight(
  db: D1Database,
  libraryId: string,
  orderedEntryIds: string[],
  now = nowIso(),
): Promise<TonightEntry[]> {
  if (!Array.isArray(orderedEntryIds) || orderedEntryIds.length > MAX_TONIGHT_ENTRIES) {
    throw new RejectedPayload("invalid Tonight order");
  }
  const current = await all<{ id: string }>(
    db,
    `SELECT id FROM kitchen_tonight_entries WHERE library_id = ? ORDER BY position ASC, id ASC`,
    libraryId,
  );
  if (orderedEntryIds.length !== current.length) throw new KitchenConflict("Tonight order is stale");
  if (new Set(orderedEntryIds).size !== orderedEntryIds.length) throw new KitchenConflict("Tonight order is stale");
  const currentIds = new Set(current.map((row) => row.id));
  for (const id of orderedEntryIds) {
    if (!currentIds.has(id)) throw new KitchenConflict("Tonight order is stale");
  }
  await run(db, `UPDATE kitchen_tonight_entries SET position = -1 - position WHERE library_id = ?`, libraryId);
  for (const [index, id] of orderedEntryIds.entries()) {
    await run(
      db,
      `UPDATE kitchen_tonight_entries SET position = ?, updated_at = ? WHERE library_id = ? AND id = ?`,
      index,
      now,
      libraryId,
      id,
    );
  }
  await bumpTonightRevision(db, libraryId);
  return getTonight(db, libraryId);
}

export async function removeTonight(db: D1Database, libraryId: string, entryId: string): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM kitchen_tonight_entries WHERE library_id = ? AND id = ?`,
    libraryId,
    entryId,
  );
  if (!row) return false;
  await run(db, `DELETE FROM kitchen_tonight_entries WHERE library_id = ? AND id = ?`, libraryId, entryId);
  await densifyTonight(db, libraryId);
  await bumpTonightRevision(db, libraryId);
  return true;
}

export async function clearTonight(db: D1Database, libraryId: string): Promise<number> {
  const result = await run(db, `DELETE FROM kitchen_tonight_entries WHERE library_id = ?`, libraryId);
  const removed = Number(result.meta.changes ?? 0);
  if (removed > 0) await bumpTonightRevision(db, libraryId);
  return removed;
}

export async function getTonightView(db: D1Database, libraryId: string): Promise<TonightView> {
  return { revision: await tonightRevision(db, libraryId), entries: await getTonight(db, libraryId) };
}

export async function applyTonightChanges(
  db: D1Database,
  libraryId: string,
  input: unknown,
  now = nowIso(),
): Promise<TonightMutationResult> {
  const parsed = validateTonightChanges(input);
  const hash = tonightPayloadHash(parsed);
  const existing = await first<{ payload_hash: string; result_json: string }>(
    db,
    `SELECT payload_hash, result_json FROM kitchen_tonight_mutations
      WHERE library_id = ? AND client_mutation_id = ?`,
    libraryId,
    parsed.clientMutationId,
  );
  if (existing) {
    if (existing.payload_hash !== hash) throw new KitchenConflict("clientMutationId was already used for a different change");
    return { ...(JSON.parse(existing.result_json) as TonightView), replayed: true };
  }
  if (parsed.expectedRevision !== (await tonightRevision(db, libraryId))) throw new KitchenConflict("Tonight revision is stale");
  const rows = await all<TonightRow>(
    db,
    `SELECT id, item_id, position, created_at FROM kitchen_tonight_entries
      WHERE library_id = ? ORDER BY position ASC, id ASC`,
    libraryId,
  );
  let working = rows.map((row) => ({ id: row.id, itemId: row.item_id, createdAt: row.created_at }));
  for (const op of parsed.operations) {
    if (op.op === "add") {
      if (working.some((entry) => entry.itemId === op.itemId)) throw new KitchenConflict("duplicate Tonight item");
      const item = await getLibraryItem(db, libraryId, op.itemId);
      if (!item) throw new MissingResource("item");
      if (!(await itemIsFood(db, libraryId, op.itemId))) throw new KitchenConflict("item is not eligible for Tonight");
      if (working.length >= MAX_TONIGHT_ENTRIES) throw new KitchenConflict("Tonight is full");
      working = [...working, { id: crypto.randomUUID(), itemId: op.itemId, createdAt: now }];
    } else if (op.op === "remove") {
      const next = working.filter((entry) => entry.itemId !== op.itemId);
      if (next.length === working.length) throw new RejectedPayload("Tonight entry not found");
      working = next;
    } else {
      if (op.itemIds.length !== working.length) throw new KitchenConflict("Tonight order is stale");
      const byItem = new Map(working.map((entry) => [entry.itemId, entry]));
      working = op.itemIds.map((itemId) => {
        const entry = byItem.get(itemId);
        if (!entry) throw new KitchenConflict("Tonight order is stale");
        return entry;
      });
    }
  }
  await run(db, `DELETE FROM kitchen_tonight_entries WHERE library_id = ?`, libraryId);
  for (const [index, entry] of working.entries()) {
    await run(
      db,
      `INSERT INTO kitchen_tonight_entries (id, library_id, item_id, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      entry.id,
      libraryId,
      entry.itemId,
      index,
      entry.createdAt,
      now,
    );
  }
  const revision = await bumpTonightRevision(db, libraryId);
  const view: TonightView = { revision, entries: await getTonight(db, libraryId) };
  await run(
    db,
    `INSERT INTO kitchen_tonight_mutations (
       library_id, client_mutation_id, payload_hash, result_json, result_revision, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    libraryId,
    parsed.clientMutationId,
    hash,
    JSON.stringify(view),
    revision,
    now,
  );
  return { ...view, replayed: false };
}

export async function makeCookable(
  db: D1Database,
  libraryId: string,
  itemId: string,
): Promise<{ outcome: "created"; document: RecipeDocument } | never> {
  const item = await getKitchenItem(db, libraryId, itemId);
  if (!item) throw new MissingResource("item");
  if (item.recipe && "draft" in item.recipe) return { outcome: "created", document: item.recipe };
  throw new KitchenUnavailable(kitchenAiStatus().detail);
}

export class KitchenUnavailable extends Error {
  readonly code = "unavailable";
  constructor(message: string) {
    super(message);
    this.name = "KitchenUnavailable";
  }
}

async function requireWritableItem(db: D1Database, libraryId: string, itemId: string): Promise<void> {
  if (!(await getLibraryItem(db, libraryId, itemId))) throw new MissingResource("item");
  if (!(await itemIsFood(db, libraryId, itemId)) && !(await tonightHasItem(db, libraryId, itemId))) {
    throw new MissingResource("item");
  }
}

function presentKitchenItem(item: ItemCard, recipe: RecipeDocument | undefined, includeDocument: boolean): KitchenItem {
  const caption = displayCaption(item.body);
  const watchable = canWatchItem(item);
  const title = displayTitle(item, caption);
  let recipeView: KitchenItem["recipe"] = null;
  if (recipe) {
    recipeView = includeDocument
      ? recipe
      : {
          id: recipe.id,
          itemId: recipe.itemId,
          status: recipe.status,
          sourceChanged: recipe.sourceChanged,
          title: recipe.draft.title ?? null,
          servings: recipe.draft.servings ?? null,
          totalTime: recipe.draft.totalTime ?? null,
        };
  }
  return {
    item: includeDocument ? item : { ...item, body: null, notes: [], collections: [] },
    availability: kitchenAvailability(recipe?.status ?? null, caption, watchable),
    caption: includeDocument ? caption : caption ? boundPreview(caption) : null,
    canWatch: watchable,
    displayTitle: title,
    showCaptionPreview: Boolean(caption) && !captionDuplicatesTitle(title, caption),
    recipe: recipeView,
  };
}

function boundPreview(caption: string): string {
  const lines = caption.split("\n").filter((line) => line.trim()).slice(0, 2).join("\n");
  return lines.length <= 240 ? lines : `${lines.slice(0, 239).trimEnd()}…`;
}

function presentRecipe(row: RecipeRow, currentCaption: string): RecipeDocument {
  const draft = JSON.parse(row.draft_json) as RecipeDraftV1;
  const evidenceKinds = recipeEvidenceKinds(draft);
  return {
    id: row.id,
    itemId: row.item_id,
    status: row.status,
    sourceRevision: row.source_revision,
    sourceCaption: row.source_caption,
    sourceChanged: captionRevision(normalizeCaption(currentCaption)) !== row.source_revision,
    updatedBy: row.updated_by,
    provenance: evidenceKinds.has("user") ? "user" : evidenceKinds.has("generated") ? "generated" : "caption",
    draft,
    score: projectRecipeScore(draft),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadRecipe(db: D1Database, libraryId: string, itemId: string): Promise<RecipeDocument | undefined> {
  const row = await loadRecipeRow(db, libraryId, itemId);
  if (!row) return undefined;
  const item = await getLibraryItem(db, libraryId, itemId);
  return presentRecipe(row, item?.body ?? row.source_caption);
}

async function loadRecipeRow(db: D1Database, libraryId: string, itemId: string): Promise<RecipeRow | null> {
  return first<RecipeRow>(
    db,
    `SELECT id, item_id, status, source_revision, source_caption, updated_by, draft_json, created_at, updated_at
       FROM kitchen_recipe_documents WHERE library_id = ? AND item_id = ?`,
    libraryId,
    itemId,
  );
}

async function recipeMap(db: D1Database, libraryId: string, items: ItemCard[]): Promise<Map<string, RecipeDocument>> {
  const out = new Map<string, RecipeDocument>();
  if (items.length === 0) return out;
  const bodies = new Map(items.map((item) => [item.id, item.body]));
  const rows = await all<RecipeRow>(
    db,
    `SELECT id, item_id, status, source_revision, source_caption, updated_by, draft_json, created_at, updated_at
       FROM kitchen_recipe_documents WHERE library_id = ? AND item_id IN (${inMarks(items.length)})`,
    libraryId,
    ...items.map((item) => item.id),
  );
  for (const row of rows) {
    out.set(row.item_id, presentRecipe(row, bodies.get(row.item_id) ?? row.source_caption));
  }
  return out;
}

async function hydrateTonight(db: D1Database, libraryId: string, row: TonightRow): Promise<TonightEntry> {
  const item = await getLibraryItem(db, libraryId, row.item_id);
  return {
    id: row.id,
    itemId: row.item_id,
    order: row.position,
    createdAt: row.created_at,
    item: item ? presentKitchenItem(item, await loadRecipe(db, libraryId, row.item_id), true) : null,
  };
}

async function tonightHasItem(db: D1Database, libraryId: string, itemId: string): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM kitchen_tonight_entries WHERE library_id = ? AND item_id = ?`,
    libraryId,
    itemId,
  );
  return Boolean(row);
}

async function tonightCount(db: D1Database, libraryId: string): Promise<number> {
  const row = await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM kitchen_tonight_entries WHERE library_id = ?`, libraryId);
  return Number(row?.n ?? 0);
}

async function tonightRevision(db: D1Database, libraryId: string): Promise<number> {
  const row = await first<{ revision: number }>(db, `SELECT revision FROM kitchen_tonight_state WHERE library_id = ?`, libraryId);
  return row?.revision ?? 1;
}

async function bumpTonightRevision(db: D1Database, libraryId: string): Promise<number> {
  const next = (await tonightRevision(db, libraryId)) + 1;
  await run(
    db,
    `INSERT INTO kitchen_tonight_state (library_id, revision) VALUES (?, ?)
     ON CONFLICT(library_id) DO UPDATE SET revision = excluded.revision`,
    libraryId,
    next,
  );
  return next;
}

function tonightPayloadHash(input: TonightChangesInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        expectedRevision: input.expectedRevision,
        instruction: input.instruction,
        operations: input.operations,
      }),
    )
    .digest("hex");
}

async function recipeDocumentCount(db: D1Database, libraryId: string): Promise<number> {
  const row = await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM kitchen_recipe_documents WHERE library_id = ?`, libraryId);
  return Number(row?.n ?? 0);
}

async function densifyTonight(db: D1Database, libraryId: string): Promise<void> {
  const rows = await all<{ id: string }>(
    db,
    `SELECT id FROM kitchen_tonight_entries WHERE library_id = ? ORDER BY position ASC, id ASC`,
    libraryId,
  );
  await run(db, `UPDATE kitchen_tonight_entries SET position = -1 - position WHERE library_id = ?`, libraryId);
  for (const [index, row] of rows.entries()) {
    await run(db, `UPDATE kitchen_tonight_entries SET position = ? WHERE library_id = ? AND id = ?`, index, libraryId, row.id);
  }
}

async function itemIsFood(db: D1Database, libraryId: string, itemId: string): Promise<boolean> {
  const tags = tagsForShelf("food");
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM items i
      WHERE i.id = ? AND i.library_id = ?
        AND EXISTS (
          SELECT 1 FROM memberships ms JOIN tags ts ON ts.id = ms.target_id
          WHERE ms.item_id = i.id AND ms.target_kind = 'tag' AND lower(ts.name) IN (${inMarks(tags.length)})
        )`,
    itemId,
    libraryId,
    ...tags,
  );
  return Boolean(row);
}

function boundSearch(raw: string | undefined): string | undefined {
  const q = raw?.trim().slice(0, MAX_KITCHEN_SEARCH);
  return q || undefined;
}
