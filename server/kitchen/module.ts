import { createHash } from "node:crypto";
import type { Db } from "../../db/open.ts";
import { ownedLibraryId } from "../../db/library-id.ts";
import { newId, tx } from "../../db/open.ts";
import { MissingResource } from "../../core/commands.ts";
import { getItem, itemMatchesFilter, listItemsPage, listMatchingSources, type ItemCard } from "../../core/library.ts";
import { RejectedPayload } from "../../core/sanitize.ts";
import { LOCAL_LIBRARY_ID } from "../reading/policy.ts";
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
  type KitchenAvailability,
  type RecipeActor,
  type RecipeDraftV1,
  type RecipeScore,
  type RecipeStatus,
  type RecipeWriteInput,
  type TonightChangesInput,
  type TonightOp,
} from "./policy.ts";

export { LOCAL_LIBRARY_ID } from "../reading/policy.ts";
export {
  MAX_KITCHEN_SEARCH,
  MAX_TONIGHT_ENTRIES,
  canWatchItem,
  displayCaption,
  displayTitle,
  kitchenAvailability,
  normalizeCaption,
  projectRecipeScore,
  validateRecipeDraft,
  validateTonightChanges,
  watchEmbedUrl,
} from "./policy.ts";
export type {
  CaptionSpan,
  KitchenAvailability,
  RecipeActor,
  RecipeDraftV1,
  RecipeEvidence,
  RecipeIngredientV1,
  RecipeScore,
  RecipeStatus,
  RecipeStepV1,
  RecipeWriteInput,
  TonightChangesInput,
  TonightOp,
} from "./policy.ts";

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
  availability: KitchenAvailability;
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
  return createHash("sha256").update(caption, "utf8").digest("hex");
}

export function getKitchenIndex(db: Db, libraryId: string, query: KitchenQuery = {}): {
  items: KitchenItem[];
  nextCursor: string | null;
  counts: { foodSaves: number; structuredRecipes: number; tonight: number };
  sources: string[];
} {
  libraryId = ownedLibraryId(libraryId);
  const q = boundSearch(query.q);
  const page = listItemsPage(
    db,
    {
      ...FOOD_FILTER,
      source: query.source?.trim() || undefined,
      q,
      searchRecipeDocuments: Boolean(q),
      searchRecipeLibraryId: libraryId,
    },
    { cursor: query.cursor, limit: query.limit },
  );
  const recipes = recipeMap(db, libraryId, page.items);
  return {
    items: page.items.map((item) => presentKitchenItem(item, recipes.get(item.id), false)),
    nextCursor: page.nextCursor,
    counts: {
      foodSaves: page.counts.total,
      structuredRecipes: recipeDocumentCount(db, libraryId),
      tonight: tonightCount(db, libraryId),
    },
    sources: listMatchingSources(db, FOOD_FILTER),
  };
}

export function getKitchenItem(db: Db, libraryId: string, itemId: string): KitchenItem | null {
  if (!itemId) return null;
  const item = getItem(db, itemId);
  if (!item) return null;
  if (!itemMatchesFilter(db, itemId, FOOD_FILTER) && !tonightHasItem(db, libraryId, itemId)) return null;
  return presentKitchenItem(item, loadRecipe(db, libraryId, itemId), true);
}

export function putRecipeDocument(
  db: Db,
  libraryId: string,
  itemId: string,
  input: RecipeWriteInput,
  actor: RecipeActor,
  now: string,
): RecipeDocument {
  return tx(db, () => {
    requireWritableItem(db, libraryId, itemId);
    if (typeof input.expectedSourceRevision !== "string" || !input.expectedSourceRevision) {
      throw new RejectedPayload("expectedSourceRevision required");
    }
    const item = getItem(db, itemId);
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
    const existing = loadRecipeRow(db, libraryId, itemId);
    const id = existing?.id ?? newId();
    const createdAt = existing?.created_at ?? now;
    db.prepare(
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
    ).run(id, libraryId, itemId, status, sourceRevision, sourceCaption, actor, JSON.stringify(draft), createdAt, now);
    return presentRecipe(loadRecipeRow(db, libraryId, itemId)!, sourceCaption);
  });
}

export function removeRecipeDocument(db: Db, libraryId: string, itemId: string): boolean {
  const result = db.prepare(`DELETE FROM kitchen_recipe_documents WHERE library_id = ? AND item_id = ?`).run(libraryId, itemId);
  return Number(result.changes ?? 0) > 0;
}

export function getTonight(db: Db, libraryId: string): TonightEntry[] {
  const rows = db
    .prepare(
      `SELECT id, item_id, position, created_at FROM kitchen_tonight_entries
        WHERE library_id = ? ORDER BY position ASC, id ASC`,
    )
    .all(libraryId) as TonightRow[];
  return rows.map((row) => hydrateTonight(db, libraryId, row));
}

export function addTonight(db: Db, libraryId: string, itemId: string, now: string): TonightEntry {
  return tx(db, () => {
    const item = getItem(db, itemId);
    if (!item) throw new MissingResource("item");
    if (!itemMatchesFilter(db, itemId, FOOD_FILTER)) throw new KitchenConflict("item is not eligible for Tonight");
    const existing = db
      .prepare(`SELECT id, item_id, position, created_at FROM kitchen_tonight_entries WHERE library_id = ? AND item_id = ?`)
      .get(libraryId, itemId) as TonightRow | undefined;
    if (existing) return hydrateTonight(db, libraryId, existing);
    const count = tonightCount(db, libraryId);
    if (count >= MAX_TONIGHT_ENTRIES) throw new KitchenConflict("Tonight is full");
    const id = newId();
    db.prepare(
      `INSERT INTO kitchen_tonight_entries (id, library_id, item_id, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, libraryId, itemId, count, now, now);
    bumpTonightRevision(db, libraryId);
    return hydrateTonight(db, libraryId, { id, item_id: itemId, position: count, created_at: now });
  });
}

export function reorderTonight(db: Db, libraryId: string, orderedEntryIds: string[], now: string): TonightEntry[] {
  return tx(db, () => {
    if (!Array.isArray(orderedEntryIds) || orderedEntryIds.length > MAX_TONIGHT_ENTRIES) {
      throw new RejectedPayload("invalid Tonight order");
    }
    const current = db
      .prepare(`SELECT id FROM kitchen_tonight_entries WHERE library_id = ? ORDER BY position ASC, id ASC`)
      .all(libraryId) as { id: string }[];
    if (orderedEntryIds.length !== current.length) throw new KitchenConflict("Tonight order is stale");
    if (new Set(orderedEntryIds).size !== orderedEntryIds.length) throw new KitchenConflict("Tonight order is stale");
    const currentIds = new Set(current.map((row) => row.id));
    for (const id of orderedEntryIds) {
      if (!currentIds.has(id)) throw new KitchenConflict("Tonight order is stale");
    }
    db.prepare(`UPDATE kitchen_tonight_entries SET position = -1 - position WHERE library_id = ?`).run(libraryId);
    const update = db.prepare(
      `UPDATE kitchen_tonight_entries SET position = ?, updated_at = ? WHERE library_id = ? AND id = ?`,
    );
    orderedEntryIds.forEach((id, index) => update.run(index, now, libraryId, id));
    bumpTonightRevision(db, libraryId);
    return getTonight(db, libraryId);
  });
}

export function removeTonight(db: Db, libraryId: string, entryId: string): boolean {
  return tx(db, () => {
    const row = db
      .prepare(`SELECT id FROM kitchen_tonight_entries WHERE library_id = ? AND id = ?`)
      .get(libraryId, entryId) as { id: string } | undefined;
    if (!row) return false;
    db.prepare(`DELETE FROM kitchen_tonight_entries WHERE library_id = ? AND id = ?`).run(libraryId, entryId);
    densifyTonight(db, libraryId);
    bumpTonightRevision(db, libraryId);
    return true;
  });
}

export function clearTonight(db: Db, libraryId: string): number {
  return tx(db, () => {
    const result = db.prepare(`DELETE FROM kitchen_tonight_entries WHERE library_id = ?`).run(libraryId);
    const removed = Number(result.changes ?? 0);
    if (removed > 0) bumpTonightRevision(db, libraryId);
    return removed;
  });
}

export function getTonightView(db: Db, libraryId: string): TonightView {
  return { revision: tonightRevision(db, libraryId), entries: getTonight(db, libraryId) };
}

export function applyTonightChanges(db: Db, libraryId: string, input: unknown, now: string): TonightMutationResult {
  const parsed = validateTonightChanges(input);
  const hash = tonightPayloadHash(parsed);
  return tx(db, () => {
    const existing = db
      .prepare(
        `SELECT payload_hash, result_json FROM kitchen_tonight_mutations
          WHERE library_id = ? AND client_mutation_id = ?`,
      )
      .get(libraryId, parsed.clientMutationId) as { payload_hash: string; result_json: string } | undefined;
    if (existing) {
      if (existing.payload_hash !== hash) throw new KitchenConflict("clientMutationId was already used for a different change");
      return { ...(JSON.parse(existing.result_json) as TonightView), replayed: true };
    }
    if (parsed.expectedRevision !== tonightRevision(db, libraryId)) throw new KitchenConflict("Tonight revision is stale");
    const rows = db
      .prepare(
        `SELECT id, item_id, position, created_at FROM kitchen_tonight_entries
          WHERE library_id = ? ORDER BY position ASC, id ASC`,
      )
      .all(libraryId) as TonightRow[];
    let working = rows.map((row) => ({ id: row.id, itemId: row.item_id, createdAt: row.created_at }));
    for (const op of parsed.operations) {
      if (op.op === "add") {
        if (working.some((entry) => entry.itemId === op.itemId)) throw new KitchenConflict("duplicate Tonight item");
        const item = getItem(db, op.itemId);
        if (!item) throw new MissingResource("item");
        if (!itemMatchesFilter(db, op.itemId, FOOD_FILTER)) throw new KitchenConflict("item is not eligible for Tonight");
        if (working.length >= MAX_TONIGHT_ENTRIES) throw new KitchenConflict("Tonight is full");
        working = [...working, { id: newId(), itemId: op.itemId, createdAt: now }];
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
    db.prepare(`DELETE FROM kitchen_tonight_entries WHERE library_id = ?`).run(libraryId);
    const insert = db.prepare(
      `INSERT INTO kitchen_tonight_entries (id, library_id, item_id, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    working.forEach((entry, index) => insert.run(entry.id, libraryId, entry.itemId, index, entry.createdAt, now));
    const revision = bumpTonightRevision(db, libraryId);
    const view: TonightView = { revision, entries: getTonight(db, libraryId) };
    db.prepare(
      `INSERT INTO kitchen_tonight_mutations (
         library_id, client_mutation_id, payload_hash, result_json, result_revision, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(libraryId, parsed.clientMutationId, hash, JSON.stringify(view), revision, now);
    return { ...view, replayed: false };
  });
}

export type KitchenArchiveRecord = Record<string, unknown>;

export function kitchenLibraryIsEmpty(db: Db, libraryId = LOCAL_LIBRARY_ID): boolean {
  const recipes = db.prepare(`SELECT COUNT(*) AS n FROM kitchen_recipe_documents WHERE library_id = ?`).get(libraryId) as { n: number };
  const tonight = db.prepare(`SELECT COUNT(*) AS n FROM kitchen_tonight_entries WHERE library_id = ?`).get(libraryId) as { n: number };
  return Number(recipes.n) === 0 && Number(tonight.n) === 0;
}

export function exportKitchenRecords(db: Db, libraryId = LOCAL_LIBRARY_ID): {
  counts: { kitchenRecipeDocument: number; kitchenTonightEntry: number };
  records: KitchenArchiveRecord[];
} {
  const recipes = db
    .prepare(
      `SELECT id, item_id, schema_version, status, source_revision, source_caption, updated_by, draft_json, created_at, updated_at
         FROM kitchen_recipe_documents WHERE library_id = ?`,
    )
    .all(libraryId) as (RecipeRow & { schema_version: number })[];
  const tonight = db
    .prepare(
      `SELECT id, item_id, position, created_at, updated_at FROM kitchen_tonight_entries WHERE library_id = ? ORDER BY position ASC`,
    )
    .all(libraryId) as (TonightRow & { updated_at: string })[];
  const records: KitchenArchiveRecord[] = [
    ...recipes.map((row) => ({
      kind: "kitchenRecipeDocument",
      id: row.id,
      itemId: row.item_id,
      schemaVersion: row.schema_version,
      status: row.status,
      sourceRevision: row.source_revision,
      sourceCaption: row.source_caption,
      updatedBy: row.updated_by,
      draft: JSON.parse(row.draft_json) as RecipeDraftV1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    ...tonight.map((row) => ({
      kind: "kitchenTonightEntry",
      id: row.id,
      itemId: row.item_id,
      position: row.position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  ];
  return {
    counts: { kitchenRecipeDocument: recipes.length, kitchenTonightEntry: tonight.length },
    records,
  };
}

export function importKitchenRecords(
  db: Db,
  input: {
    recipes: readonly KitchenArchiveRecord[];
    tonight: readonly KitchenArchiveRecord[];
    itemIds: ReadonlySet<string>;
    libraryId?: string;
  },
): void {
  const libraryId = input.libraryId ?? LOCAL_LIBRARY_ID;
  const recipeIds = new Set<string>();
  const insRecipe = db.prepare(
    `INSERT INTO kitchen_recipe_documents (
       id, library_id, item_id, schema_version, status, source_revision, source_caption,
       updated_by, draft_json, created_at, updated_at
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const rec of input.recipes) {
    const id = reqString(rec.id, 80);
    const itemId = reqString(rec.itemId, 128);
    if (recipeIds.has(id)) throw new RejectedPayload("duplicate recipe document");
    recipeIds.add(id);
    if (!input.itemIds.has(itemId)) throw new RejectedPayload("orphan recipe document");
    if (rec.schemaVersion !== 1) throw new RejectedPayload("unsupported recipe version");
    const status = rec.status;
    const updatedBy = rec.updatedBy;
    if (status !== "draft" && status !== "reviewed") throw new RejectedPayload("invalid recipe status");
    if (updatedBy !== "user" && updatedBy !== "agent") throw new RejectedPayload("invalid recipe actor");
    if (updatedBy === "agent" && status === "reviewed") throw new RejectedPayload("agent cannot mark reviewed");
    const sourceCaption = typeof rec.sourceCaption === "string" ? rec.sourceCaption : "";
    if (normalizeCaption(sourceCaption) !== sourceCaption) throw new RejectedPayload("invalid source caption");
    const sourceRevision = reqString(rec.sourceRevision, 64);
    if (captionRevision(sourceCaption) !== sourceRevision) throw new RejectedPayload("source revision mismatch");
    const actor: RecipeActor = updatedBy;
    const draft = validateRecipeDraft(rec.draft, sourceCaption, actor);
    insRecipe.run(
      id,
      libraryId,
      itemId,
      status,
      sourceRevision,
      sourceCaption,
      updatedBy,
      JSON.stringify(draft),
      reqString(rec.createdAt, 40),
      reqString(rec.updatedAt, 40),
    );
  }
  const tonightIds = new Set<string>();
  const positions = new Set<number>();
  const insTonight = db.prepare(
    `INSERT INTO kitchen_tonight_entries (id, library_id, item_id, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const sorted = [...input.tonight].sort((a, b) => Number(a.position) - Number(b.position));
  sorted.forEach((rec, index) => {
    const id = reqString(rec.id, 80);
    if (tonightIds.has(id)) throw new RejectedPayload("duplicate Tonight entry");
    tonightIds.add(id);
    const position = rec.position;
    if (!Number.isInteger(position) || (position as number) < 0) throw new RejectedPayload("invalid Tonight position");
    if (positions.has(position as number)) throw new RejectedPayload("duplicate Tonight position");
    positions.add(position as number);
    insTonight.run(
      id,
      libraryId,
      reqString(rec.itemId, 128),
      index,
      reqString(rec.createdAt, 40),
      reqString(rec.updatedAt, 40),
    );
  });
}

function requireWritableItem(db: Db, libraryId: string, itemId: string): void {
  if (!getItem(db, itemId)) throw new MissingResource("item");
  if (!itemMatchesFilter(db, itemId, FOOD_FILTER) && !tonightHasItem(db, libraryId, itemId)) {
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

function loadRecipe(db: Db, libraryId: string, itemId: string): RecipeDocument | undefined {
  const row = loadRecipeRow(db, libraryId, itemId);
  if (!row) return undefined;
  const item = getItem(db, itemId);
  return presentRecipe(row, item?.body ?? row.source_caption);
}

function loadRecipeRow(db: Db, libraryId: string, itemId: string): RecipeRow | undefined {
  return db
    .prepare(
      `SELECT id, item_id, status, source_revision, source_caption, updated_by, draft_json, created_at, updated_at
         FROM kitchen_recipe_documents WHERE library_id = ? AND item_id = ?`,
    )
    .get(libraryId, itemId) as RecipeRow | undefined;
}

function recipeMap(db: Db, libraryId: string, items: ItemCard[]): Map<string, RecipeDocument> {
  const out = new Map<string, RecipeDocument>();
  if (items.length === 0) return out;
  const bodies = new Map(items.map((item) => [item.id, item.body]));
  const marks = items.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, item_id, status, source_revision, source_caption, updated_by, draft_json, created_at, updated_at
         FROM kitchen_recipe_documents WHERE library_id = ? AND item_id IN (${marks})`,
    )
    .all(libraryId, ...items.map((item) => item.id)) as RecipeRow[];
  for (const row of rows) {
    out.set(row.item_id, presentRecipe(row, bodies.get(row.item_id) ?? row.source_caption));
  }
  return out;
}

function hydrateTonight(db: Db, libraryId: string, row: TonightRow): TonightEntry {
  const item = getItem(db, row.item_id);
  return {
    id: row.id,
    itemId: row.item_id,
    order: row.position,
    createdAt: row.created_at,
    item: item ? presentKitchenItem(item, loadRecipe(db, libraryId, row.item_id), true) : null,
  };
}

function tonightHasItem(db: Db, libraryId: string, itemId: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM kitchen_tonight_entries WHERE library_id = ? AND item_id = ?`)
    .get(libraryId, itemId) as { ok: number } | undefined;
  return Boolean(row);
}

function tonightCount(db: Db, libraryId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM kitchen_tonight_entries WHERE library_id = ?`).get(libraryId) as { n: number };
  return Number(row?.n ?? 0);
}

function tonightRevision(db: Db, libraryId: string): number {
  const row = db.prepare(`SELECT revision FROM kitchen_tonight_state WHERE library_id = ?`).get(libraryId) as { revision: number } | undefined;
  return row?.revision ?? 1;
}

function bumpTonightRevision(db: Db, libraryId: string): number {
  const next = tonightRevision(db, libraryId) + 1;
  db.prepare(
    `INSERT INTO kitchen_tonight_state (library_id, revision) VALUES (?, ?)
     ON CONFLICT(library_id) DO UPDATE SET revision = excluded.revision`,
  ).run(libraryId, next);
  return next;
}

function tonightPayloadHash(input: TonightChangesInput): string {
  return createHash("sha256")
    .update(JSON.stringify({
      expectedRevision: input.expectedRevision,
      instruction: input.instruction,
      operations: input.operations,
    }))
    .digest("hex");
}

function recipeDocumentCount(db: Db, libraryId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM kitchen_recipe_documents WHERE library_id = ?`).get(libraryId) as { n: number };
  return Number(row?.n ?? 0);
}

function densifyTonight(db: Db, libraryId: string): void {
  const rows = db
    .prepare(`SELECT id FROM kitchen_tonight_entries WHERE library_id = ? ORDER BY position ASC, id ASC`)
    .all(libraryId) as { id: string }[];
  db.prepare(`UPDATE kitchen_tonight_entries SET position = -1 - position WHERE library_id = ?`).run(libraryId);
  const update = db.prepare(`UPDATE kitchen_tonight_entries SET position = ? WHERE library_id = ? AND id = ?`);
  rows.forEach((row, index) => update.run(index, libraryId, row.id));
}

function boundSearch(raw: string | undefined): string | undefined {
  const q = raw?.trim().slice(0, MAX_KITCHEN_SEARCH);
  return q || undefined;
}

function reqString(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new RejectedPayload("invalid archive field");
  return value;
}
