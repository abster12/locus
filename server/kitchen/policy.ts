import { instagramEmbedUrl, youtubeEmbedUrl, youtubeVideoId } from "../../core/sanitize.ts";
import { RejectedPayload } from "../../core/sanitize.ts";
import type { ItemCard } from "../../core/library.ts";

export type KitchenAvailability = "reviewed" | "draft" | "caption" | "watch" | "source_only";
export type RecipeActor = "user" | "agent";
export type RecipeStatus = "draft" | "reviewed";

export type CaptionSpan = { start: number; end: number; text: string };
export type RecipeEvidence = { kind: "caption"; spans: CaptionSpan[] } | { kind: "user" } | { kind: "generated" };

export type RecipeIngredientV1 = {
  id: string;
  raw: string;
  quantity?: string;
  unit?: string;
  name: string;
  preparation?: string;
  group?: string;
  evidence: RecipeEvidence;
};

export type RecipeStepV1 = {
  id: string;
  instruction: string;
  ingredientIds: string[];
  duration?: string;
  temperature?: string;
  evidence: RecipeEvidence;
};

export type RecipeDraftV1 = {
  version: 1;
  title?: string;
  titleEvidence?: RecipeEvidence;
  servings?: string;
  servingsEvidence?: RecipeEvidence;
  totalTime?: string;
  totalTimeEvidence?: RecipeEvidence;
  ingredients: RecipeIngredientV1[];
  steps: RecipeStepV1[];
};

export type RecipeWriteInput = {
  expectedSourceRevision: string;
  status: RecipeStatus;
  draft: unknown;
};

export type RecipeScore = {
  placed: { ingredient: RecipeIngredientV1; firstStepId: string }[];
  unreferenced: RecipeIngredientV1[];
  steps: { step: RecipeStepV1; ingredients: RecipeIngredientV1[] }[];
};

const RECIPE_ID = /^[A-Za-z0-9._:-]{1,80}$/;
const DRAFT_KEYS = new Set([
  "version",
  "title",
  "titleEvidence",
  "servings",
  "servingsEvidence",
  "totalTime",
  "totalTimeEvidence",
  "ingredients",
  "steps",
]);
const INGREDIENT_KEYS = new Set(["id", "raw", "quantity", "unit", "name", "preparation", "group", "evidence"]);
const STEP_KEYS = new Set(["id", "instruction", "ingredientIds", "duration", "temperature", "evidence"]);
const SPAN_KEYS = new Set(["start", "end", "text"]);
export const MAX_RECIPE_JSON_BYTES = 256 * 1024;
export const MAX_TONIGHT_ENTRIES = 100;
export const MAX_KITCHEN_SEARCH = 200;

export function normalizeCaption(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\r\n/g, "\n").trim();
}

export function displayCaption(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  return text ? text : null;
}

export function canWatchItem(item: { url: string; media: { kind: string }[] }): boolean {
  return Boolean(watchEmbedUrl(item.url) || item.media.some((entry) => entry.kind === "video"));
}

export function watchEmbedUrl(url: string): string | null {
  return instagramEmbedUrl(url) || youtubeEmbedUrl(url);
}

export function kitchenAvailability(
  recipeStatus: RecipeStatus | null,
  caption: string | null,
  watchable: boolean,
): KitchenAvailability {
  if (recipeStatus === "reviewed") return "reviewed";
  if (recipeStatus === "draft") return "draft";
  if (caption) return "caption";
  if (watchable) return "watch";
  return "source_only";
}

export function captionDuplicatesTitle(title: string | null | undefined, caption: string | null): boolean {
  if (!title || !caption) return false;
  const trimmedTitle = title.trim();
  const trimmedCaption = caption.trim();
  if (!trimmedTitle) return false;
  return trimmedCaption === trimmedTitle || trimmedCaption.startsWith(trimmedTitle);
}

export function displayTitle(item: ItemCard, caption: string | null): string {
  const title = item.title?.trim() ?? "";
  if (title && !captionDuplicatesTitle(title, caption)) return boundLine(title, 80);
  const line = firstMeaningfulLine(caption);
  if (line) return boundLine(line, 80);
  const who = (item.authorHandle || item.authorName || "").replace(/^@/, "").trim();
  const kind = sourceKindLabel(item);
  if (who && kind) return `@${who}’s ${kind}`;
  return "Saved food Item";
}

export function projectRecipeScore(draft: RecipeDraftV1): RecipeScore {
  const byId = new Map(draft.ingredients.map((ingredient) => [ingredient.id, ingredient]));
  const firstStep = new Map<string, string>();
  const steps = draft.steps.map((step) => {
    const ingredients: RecipeIngredientV1[] = [];
    for (const id of step.ingredientIds) {
      const ingredient = byId.get(id);
      if (!ingredient) continue;
      ingredients.push(ingredient);
      if (!firstStep.has(id)) firstStep.set(id, step.id);
    }
    return { step, ingredients };
  });
  const placed: RecipeScore["placed"] = [];
  const unreferenced: RecipeIngredientV1[] = [];
  for (const ingredient of draft.ingredients) {
    const stepId = firstStep.get(ingredient.id);
    if (stepId) placed.push({ ingredient, firstStepId: stepId });
    else unreferenced.push(ingredient);
  }
  return { placed, unreferenced, steps };
}

export function validateRecipeDraft(raw: unknown, caption: string, actor: RecipeActor): RecipeDraftV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RejectedPayload("invalid recipe draft");
  const rec = raw as Record<string, unknown>;
  rejectUnknown(rec, DRAFT_KEYS);
  if (rec.version !== 1) throw new RejectedPayload("unsupported recipe version");
  const title = optionalBounded(rec, "title", 200);
  const servings = optionalBounded(rec, "servings", 80);
  const totalTime = optionalBounded(rec, "totalTime", 80);
  const titleEvidence = optionalEvidence(rec, "titleEvidence", caption, actor);
  const servingsEvidence = optionalEvidence(rec, "servingsEvidence", caption, actor);
  const totalTimeEvidence = optionalEvidence(rec, "totalTimeEvidence", caption, actor);
  requirePair(title, titleEvidence, "title");
  requirePair(servings, servingsEvidence, "servings");
  requirePair(totalTime, totalTimeEvidence, "totalTime");
  if (!Array.isArray(rec.ingredients) || !Array.isArray(rec.steps)) throw new RejectedPayload("invalid recipe draft");
  if (rec.ingredients.length > 200 || rec.steps.length > 100) throw new RejectedPayload("recipe exceeds bounds");
  const ids = new Set<string>();
  const ingredients = rec.ingredients.map((entry) => readIngredient(entry, caption, actor, ids));
  const steps = rec.steps.map((entry) => readStep(entry, caption, actor, ids, ingredients));
  if (ingredients.length === 0 && steps.length === 0) throw new RejectedPayload("recipe needs an ingredient or step");
  const draft: RecipeDraftV1 = { version: 1, ingredients, steps };
  if (title !== undefined) {
    draft.title = title;
    draft.titleEvidence = titleEvidence;
  }
  if (servings !== undefined) {
    draft.servings = servings;
    draft.servingsEvidence = servingsEvidence;
  }
  if (totalTime !== undefined) {
    draft.totalTime = totalTime;
    draft.totalTimeEvidence = totalTimeEvidence;
  }
  const encoded = JSON.stringify(draft);
  if (Buffer.byteLength(encoded, "utf8") > MAX_RECIPE_JSON_BYTES) throw new RejectedPayload("recipe exceeds 256 KiB");
  if (actor === "agent") {
    const kinds = recipeEvidenceKinds(draft);
    if (kinds.has("caption") && kinds.has("generated")) {
      throw new RejectedPayload("agent recipe cannot mix caption and generated evidence");
    }
    if (kinds.has("user")) throw new RejectedPayload("agent cannot store user evidence");
  }
  return draft;
}

export function recipeEvidenceKinds(draft: RecipeDraftV1): Set<RecipeEvidence["kind"]> {
  const evidence = [
    draft.titleEvidence,
    draft.servingsEvidence,
    draft.totalTimeEvidence,
    ...draft.ingredients.map((row) => row.evidence),
    ...draft.steps.map((row) => row.evidence),
  ];
  return new Set(evidence.flatMap((entry) => (entry ? [entry.kind] : [])));
}

function readIngredient(raw: unknown, caption: string, actor: RecipeActor, ids: Set<string>): RecipeIngredientV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RejectedPayload("invalid ingredient");
  const rec = raw as Record<string, unknown>;
  rejectUnknown(rec, INGREDIENT_KEYS);
  const id = opaqueId(rec.id);
  if (ids.has(id)) throw new RejectedPayload("duplicate recipe id");
  ids.add(id);
  const name = requiredBounded(rec, "name", 200);
  const rawText = requiredBounded(rec, "raw", 500);
  const ingredient: RecipeIngredientV1 = {
    id,
    raw: rawText,
    name,
    evidence: requiredEvidence(rec.evidence, caption, actor),
  };
  const quantity = optionalBounded(rec, "quantity", 200);
  const unit = optionalBounded(rec, "unit", 200);
  const preparation = optionalBounded(rec, "preparation", 200);
  const group = optionalBounded(rec, "group", 200);
  if (quantity !== undefined) ingredient.quantity = quantity;
  if (unit !== undefined) ingredient.unit = unit;
  if (preparation !== undefined) ingredient.preparation = preparation;
  if (group !== undefined) ingredient.group = group;
  return ingredient;
}

function readStep(
  raw: unknown,
  caption: string,
  actor: RecipeActor,
  ids: Set<string>,
  ingredients: RecipeIngredientV1[],
): RecipeStepV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RejectedPayload("invalid step");
  const rec = raw as Record<string, unknown>;
  rejectUnknown(rec, STEP_KEYS);
  const id = opaqueId(rec.id);
  if (ids.has(id)) throw new RejectedPayload("duplicate recipe id");
  ids.add(id);
  if (!Array.isArray(rec.ingredientIds) || rec.ingredientIds.length > 50) throw new RejectedPayload("invalid step ingredients");
  const seen = new Set<string>();
  const ingredientIds: string[] = [];
  for (const value of rec.ingredientIds) {
    if (typeof value !== "string" || !RECIPE_ID.test(value)) throw new RejectedPayload("invalid ingredient reference");
    if (seen.has(value)) throw new RejectedPayload("duplicate ingredient reference");
    if (!ingredients.some((ingredient) => ingredient.id === value)) throw new RejectedPayload("unknown ingredient reference");
    seen.add(value);
    ingredientIds.push(value);
  }
  const step: RecipeStepV1 = {
    id,
    instruction: requiredBounded(rec, "instruction", 2000),
    ingredientIds,
    evidence: requiredEvidence(rec.evidence, caption, actor),
  };
  const duration = optionalBounded(rec, "duration", 200);
  const temperature = optionalBounded(rec, "temperature", 200);
  if (duration !== undefined) step.duration = duration;
  if (temperature !== undefined) step.temperature = temperature;
  return step;
}

function requiredEvidence(raw: unknown, caption: string, actor: RecipeActor): RecipeEvidence {
  const evidence = readEvidence(raw, caption, actor);
  if (!evidence) throw new RejectedPayload("missing evidence");
  return evidence;
}

function optionalEvidence(rec: Record<string, unknown>, key: string, caption: string, actor: RecipeActor): RecipeEvidence | undefined {
  if (rec[key] === undefined) return undefined;
  return requiredEvidence(rec[key], caption, actor);
}

function readEvidence(raw: unknown, caption: string, actor: RecipeActor): RecipeEvidence | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RejectedPayload("invalid evidence");
  const rec = raw as Record<string, unknown>;
  if (rec.kind === "user") {
    if (Object.keys(rec).some((key) => key !== "kind")) throw new RejectedPayload("unknown field");
    if (actor === "agent") throw new RejectedPayload("agent cannot store user evidence");
    return { kind: "user" };
  }
  if (rec.kind === "generated") {
    if (Object.keys(rec).some((key) => key !== "kind")) throw new RejectedPayload("unknown field");
    return { kind: "generated" };
  }
  if (rec.kind !== "caption") throw new RejectedPayload("invalid evidence");
  if (Object.keys(rec).some((key) => key !== "kind" && key !== "spans")) throw new RejectedPayload("unknown field");
  if (!Array.isArray(rec.spans) || rec.spans.length === 0) throw new RejectedPayload("invalid caption spans");
  const spans = rec.spans.map((span) => readSpan(span, caption));
  const ordered = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i]!.start < ordered[i - 1]!.end) throw new RejectedPayload("overlapping caption spans");
  }
  return { kind: "caption", spans: ordered };
}

function readSpan(raw: unknown, caption: string): CaptionSpan {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RejectedPayload("invalid caption span");
  const rec = raw as Record<string, unknown>;
  rejectUnknown(rec, SPAN_KEYS);
  if (!Number.isInteger(rec.start) || !Number.isInteger(rec.end)) throw new RejectedPayload("invalid caption span");
  const start = rec.start as number;
  const end = rec.end as number;
  if (typeof rec.text !== "string" || rec.text.length === 0) throw new RejectedPayload("invalid caption span");
  if (start < 0 || end > caption.length || start >= end) throw new RejectedPayload("caption span out of bounds");
  if (caption.slice(start, end) !== rec.text) throw new RejectedPayload("caption span mismatch");
  return { start, end, text: rec.text };
}

function optionalBounded(rec: Record<string, unknown>, key: string, max: number): string | undefined {
  if (rec[key] === undefined) return undefined;
  return requiredBounded(rec, key, max);
}

function requiredBounded(rec: Record<string, unknown>, key: string, max: number): string {
  const value = rec[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new RejectedPayload(`invalid ${key}`);
  return value;
}

function opaqueId(value: unknown): string {
  if (typeof value !== "string" || !RECIPE_ID.test(value)) throw new RejectedPayload("invalid recipe id");
  return value;
}

function requirePair(value: string | undefined, evidence: RecipeEvidence | undefined, name: string): void {
  if ((value === undefined) !== (evidence === undefined)) throw new RejectedPayload(`${name} evidence mismatch`);
}

function rejectUnknown(rec: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) throw new RejectedPayload("unknown field");
  }
}

function firstMeaningfulLine(caption: string | null): string | null {
  if (!caption) return null;
  for (const line of caption.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function boundLine(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function sourceKindLabel(item: ItemCard): string | null {
  if (/instagram\.com\/reel\//i.test(item.url) || item.contentType === "reel") return "Reel";
  if (/instagram\.com\/tv\//i.test(item.url)) return "video";
  if (/instagram\.com\/p\//i.test(item.url)) return "Post";
  if (youtubeVideoId(item.url) || item.contentType === "video") return "video";
  return "save";
}
