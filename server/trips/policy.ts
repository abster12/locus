import { RejectedPayload, sanitizeUrl } from "../../core/sanitize.ts";

// Bounds are product constants: every optional field is user-entered text, so
// the limits only have to stop runaway payloads, not model real-world trips.
export const MAX_TRIP_TEXT = 120;
export const MAX_TRIP_LIST_TEXT = 160;
export const MAX_TRIP_LIST_ITEMS = 12;
export const MAX_TRIP_DAYS = 365;
export const MAX_TRIP_NOTES = 400;
export const MAX_TRIP_INSTRUCTION = 500;
export const MAX_MUTATION_ID = 100;
export const MAX_ID_LENGTH = 64;
export const MAX_CHANGES_OPS = 50;
export const MAX_TRIP_INFERENCES = 8;
export const MAX_DURATION_MINUTES = 1440;
export const MAX_REVIEW_FLAGS = 8;
export const MAX_ADVISORY_OPINION = 240;
export const MAX_ADVISORY_RATIONALE = 600;
export const MAX_ADVISORY_REFS = 12;

export const TRIP_CONTEXT_FIELDS = [
  "lodgingAnchors",
  "pace",
  "mobility",
  "budget",
  "mealPreferences",
  "interests",
  "mustDos",
  "hardConstraints",
] as const;

export const TRIP_SETUP_FIELDS = [
  "destination",
  "startDate",
  "endDate",
  "durationDays",
  "title",
  "timezone",
  "travelers",
  "context",
] as const;

export type TripContext = {
  lodgingAnchors: string[];
  pace: string | null;
  mobility: string | null;
  budget: string | null;
  mealPreferences: string[];
  interests: string[];
  mustDos: string[];
  hardConstraints: string[];
};

export type TripSetupInput = {
  destination: string;
  startDate?: string | null;
  endDate?: string | null;
  durationDays?: number | null;
  title?: string | null;
  timezone?: string | null;
  travelers?: string | null;
  context?: Partial<TripContext>;
};

export type ValidatedTripSetup = {
  destination: string;
  title: string;
  timezone: string | null;
  startDate: string | null;
  endDate: string | null;
  durationDays: number;
  travelers: string | null;
  context: TripContext;
};

/** Mutation/session keys that travel with setup but are not setup fields. */
const SETUP_ENVELOPE_FIELDS = new Set(["libraryId", "library_id", "actor", "clientMutationId", "expectedRevision"]);

const TIMEZONES = new Set(Intl.supportedValuesOf("timeZone"));

function boundedText(value: unknown, field: string, max = MAX_TRIP_TEXT): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new RejectedPayload(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new RejectedPayload(`${field} must be at most ${max} characters`);
  return trimmed;
}

function boundedList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RejectedPayload(`${field} must be an array of strings`);
  if (value.length > MAX_TRIP_LIST_ITEMS) throw new RejectedPayload(`${field} must have at most ${MAX_TRIP_LIST_ITEMS} entries`);
  const items: string[] = [];
  for (const entry of value) {
    const text = boundedText(entry, field, MAX_TRIP_LIST_TEXT);
    if (text) items.push(text);
  }
  return items;
}

function isoDate(value: unknown, field: string): string | null {
  const text = boundedText(value, field, 10);
  if (!text) return null;
  // Round-trip check: Date.parse silently rolls impossible dates like
  // 2026-02-30 forward, so the parsed day must reproduce the input string.
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new RejectedPayload(`${field} must be a YYYY-MM-DD date`);
  }
  return text;
}

/** Rename reuses the same title bounds as setup, but the title is required. */
export function validateTripTitle(value: unknown): string {
  const text = boundedText(value, "title");
  if (!text) throw new RejectedPayload("title is required");
  return text;
}

// ---------- Trip Stops and Changeset operations ----------

/** A stop either references an authoritative Library entity by identity only
 * (Items and Places are never copied), carries bounded trip-owned outside
 * content the user typed in by hand, or holds a hole: a durable request at an
 * exact placement that stays open until it is filled or dismissed. Outside
 * content and holes never become an Item, Place, Collection, tag, or Place
 * Assignment. */
export type TripStopContent =
  | { kind: "item"; itemId: string }
  | { kind: "place"; placeId: string }
  | { kind: "outside"; title: string; notes: string | null; url: string | null }
  | { kind: "hole"; request: string };

export type TripStopProvenance = { actor: string; via: string };

export type TripStopSnapshot = {
  id: string;
  dayId: string | null;
  position: number;
  content: TripStopContent;
  state: "confirmed" | "draft";
  provenance: TripStopProvenance;
  publicNotes: string;
  privateNotes: string;
  timeWindow: string | null;
  durationMinutes: number | null;
  reservation: string | null;
  storedFacts: string[];
  alternatives: string[];
  createdAt: string;
  updatedAt: string;
};

/** Placement identifies stops by id, never by client-supplied array index.
 * `atPosition` is a module-internal absolute insertion index used only to
 * express exact inverses; parseTripOperations rejects it from adapters. */
export type TripStopOp =
  | {
      type: "addStop";
      dayId: string | null;
      content: TripStopContent;
      beforeStopId?: string;
      afterStopId?: string;
      atPosition?: number;
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
      /** Internal only: captured inverses restore the exact prior state and
       * provenance. parseTripOperations never maps it from adapter input. */
      provenance?: TripStopProvenance;
    }
  | { type: "moveStop"; stopId: string; dayId?: string | null; beforeStopId?: string; afterStopId?: string; atPosition?: number; provenance?: TripStopProvenance }
  | { type: "removeStop"; stopId: string }
  | { type: "updateDay"; dayId: string; theme: string | null }
  | { type: "restoreStop"; stop: TripStopSnapshot }
  | { type: "restoreInferences"; json: string };

function boundedId(value: unknown, field: string): string {
  const text = boundedText(value, field, MAX_ID_LENGTH);
  if (!text) throw new RejectedPayload(`${field} is required`);
  return text;
}

function optionalBoundedId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedId(value, field);
}

function validateStopContent(value: unknown, field: string): TripStopContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RejectedPayload(`${field} must be an object`);
  const rec = value as Record<string, unknown>;
  if (rec.kind === "item") return { kind: "item", itemId: boundedId(rec.itemId, `${field}.itemId`) };
  if (rec.kind === "place") return { kind: "place", placeId: boundedId(rec.placeId, `${field}.placeId`) };
  if (rec.kind === "outside") {
    const title = boundedText(rec.title, `${field}.title`);
    if (!title) throw new RejectedPayload(`${field}.title is required`);
    // sanitizeUrl throws RejectedPayload for non-http(s), credentials, and
    // oversized values; the stored form is always the normalized absolute URL.
    let url: string | null = null;
    if (rec.url !== undefined && rec.url !== null) {
      const text = boundedText(rec.url, `${field}.url`, 2000);
      if (text) url = sanitizeUrl(text);
    }
    return { kind: "outside", title, notes: boundedText(rec.notes, `${field}.notes`, MAX_TRIP_NOTES), url };
  }
  if (rec.kind === "hole") {
    const request = boundedText(rec.request, `${field}.request`);
    if (!request) throw new RejectedPayload(`${field}.request is required`);
    return { kind: "hole", request };
  }
  throw new RejectedPayload(`${field}.kind must be "item", "place", "outside", or "hole"`);
}

function validateDurationMinutes(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_DURATION_MINUTES) {
    throw new RejectedPayload(`${field} must be a whole number between 1 and ${MAX_DURATION_MINUTES}`);
  }
  return minutes;
}

function optionalNotes(value: unknown, field: string): string | null {
  if (value === undefined) return undefined as unknown as string | null;
  return boundedText(value, field, MAX_TRIP_NOTES);
}

function validateDayId(value: unknown): string | null {
  if (value === null) return null;
  return boundedId(value, "dayId");
}

function parsePlacement(raw: Record<string, unknown>): void {
  if ("atPosition" in raw) throw new RejectedPayload("atPosition is not accepted from clients");
  if (raw.beforeStopId !== undefined && raw.afterStopId !== undefined) {
    throw new RejectedPayload("use either beforeStopId or afterStopId, not both");
  }
}

function optionalStopState(value: unknown, field: string): "confirmed" | "draft" | undefined {
  if (value === undefined) return undefined;
  if (value !== "confirmed" && value !== "draft") throw new RejectedPayload(`${field} must be "confirmed" or "draft"`);
  return value;
}

/** Structural validation only: ids are checked against the document by the
 * module engine, which also owns the internal inverse operations. */
export function parseTripOperations(value: unknown): TripStopOp[] {
  if (!Array.isArray(value)) throw new RejectedPayload("operations must be an array");
  if (value.length === 0) throw new RejectedPayload("operations must not be empty");
  if (value.length > MAX_CHANGES_OPS) throw new RejectedPayload(`a changeset may contain at most ${MAX_CHANGES_OPS} operations`);
  return value.map((entry): TripStopOp => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new RejectedPayload("each operation must be an object");
    const raw = entry as Record<string, unknown>;
    switch (raw.type) {
      case "addStop": {
        parsePlacement(raw);
        return {
          type: "addStop",
          dayId: validateDayId(raw.dayId),
          content: validateStopContent(raw.content, "content"),
          beforeStopId: optionalBoundedId(raw.beforeStopId, "beforeStopId"),
          afterStopId: optionalBoundedId(raw.afterStopId, "afterStopId"),
          timeWindow: raw.timeWindow === undefined ? undefined : boundedText(raw.timeWindow, "timeWindow"),
          durationMinutes: raw.durationMinutes === undefined ? undefined : validateDurationMinutes(raw.durationMinutes, "durationMinutes"),
          publicNotes: optionalNotes(raw.publicNotes, "publicNotes"),
          privateNotes: optionalNotes(raw.privateNotes, "privateNotes"),
          state: optionalStopState(raw.state, "addStop.state"),
        };
      }
      case "updateStop": {
        const op: TripStopOp = {
          type: "updateStop",
          stopId: boundedId(raw.stopId, "stopId"),
          content: raw.content === undefined ? undefined : validateStopContent(raw.content, "content"),
          timeWindow: raw.timeWindow === undefined ? undefined : boundedText(raw.timeWindow, "timeWindow"),
          durationMinutes: raw.durationMinutes === undefined ? undefined : validateDurationMinutes(raw.durationMinutes, "durationMinutes"),
          publicNotes: optionalNotes(raw.publicNotes, "publicNotes"),
          privateNotes: optionalNotes(raw.privateNotes, "privateNotes"),
          reservation: raw.reservation === undefined ? undefined : boundedText(raw.reservation, "reservation"),
          storedFacts: raw.storedFacts === undefined ? undefined : boundedList(raw.storedFacts, "storedFacts"),
          alternatives: raw.alternatives === undefined ? undefined : boundedList(raw.alternatives, "alternatives"),
          state: optionalStopState(raw.state, "updateStop.state"),
        };
        const changesSomething =
          op.content !== undefined ||
          raw.timeWindow !== undefined ||
          raw.durationMinutes !== undefined ||
          raw.publicNotes !== undefined ||
          raw.privateNotes !== undefined ||
          raw.reservation !== undefined ||
          raw.storedFacts !== undefined ||
          raw.alternatives !== undefined ||
          raw.state !== undefined;
        if (!changesSomething) throw new RejectedPayload("updateStop must change at least one field");
        return op;
      }
      case "moveStop": {
        parsePlacement(raw);
        return {
          type: "moveStop",
          stopId: boundedId(raw.stopId, "stopId"),
          dayId: raw.dayId === undefined ? undefined : validateDayId(raw.dayId),
          beforeStopId: optionalBoundedId(raw.beforeStopId, "beforeStopId"),
          afterStopId: optionalBoundedId(raw.afterStopId, "afterStopId"),
        };
      }
      case "removeStop":
        return { type: "removeStop", stopId: boundedId(raw.stopId, "stopId") };
      case "updateDay":
        return { type: "updateDay", dayId: boundedId(raw.dayId, "dayId"), theme: boundedText(raw.theme, "theme") };
      default:
        throw new RejectedPayload("unknown operation type");
    }
  });
}

/** Agent-authored preference inferences from a base build. These are labels
 * on the document, never user-entered context: the human can remove them, and
 * nothing here is ever rewritten into trip.context. */
export type TripInferenceInput = { text: string; basis: string };

export function validateTripInferences(value: unknown): TripInferenceInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RejectedPayload("inferredPreferences must be an array");
  if (value.length > MAX_TRIP_INFERENCES) throw new RejectedPayload(`inferredPreferences must have at most ${MAX_TRIP_INFERENCES} entries`);
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new RejectedPayload("each inferred preference must be an object");
    const rec = entry as Record<string, unknown>;
    const text = boundedText(rec.text, "inferredPreferences.text", MAX_TRIP_LIST_TEXT);
    const basis = boundedText(rec.basis, "inferredPreferences.basis", MAX_TRIP_LIST_TEXT);
    if (!text || !basis) throw new RejectedPayload("each inferred preference needs text and a basis");
    return { text, basis };
  });
}

export type TripChangesInput = {
  expectedRevision: number;
  clientMutationId: string;
  instruction: string | null;
  operations: TripStopOp[];
};

/** Shared shape check for changes, undo, redo, and lifecycle requests.
 * Operations are parsed separately so undo/redo (which carry none) reuse this
 * validator; "lifecycle" is the envelope-only kind for the single-purpose
 * Trip mutations (setup, rename, duplicate, archive, restore, delete,
 * dismissal, inference removal, share publish/revoke). */
export function validateMutationFields(
  value: unknown,
  kind: "change" | "undo" | "redo" | "lifecycle",
): { expectedRevision: number; clientMutationId: string; instruction: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RejectedPayload("mutation body must be an object");
  const rec = value as Record<string, unknown>;
  const expectedRevision = Number(rec.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new RejectedPayload("expectedRevision must be a positive integer");
  }
  const clientMutationId = boundedText(rec.clientMutationId, "clientMutationId", MAX_MUTATION_ID);
  if (!clientMutationId) throw new RejectedPayload("clientMutationId is required");
  const instruction = kind === "change" ? boundedText(rec.instruction, "instruction", MAX_TRIP_INSTRUCTION) : null;
  return { expectedRevision, clientMutationId, instruction };
}

/** Create has no expectedRevision yet; the mutation id is still required at
 * the HTTP boundary so a lost response can replay instead of inserting twice. */
export function requireClientMutationId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RejectedPayload("mutation body must be an object");
  const clientMutationId = boundedText((value as Record<string, unknown>).clientMutationId, "clientMutationId", MAX_MUTATION_ID);
  if (!clientMutationId) throw new RejectedPayload("clientMutationId is required");
  return clientMutationId;
}

function rejectUnknownSetupFields(rec: Record<string, unknown>, allowed: readonly string[], prefix: string): void {
  for (const key of Object.keys(rec)) {
    if (allowed.includes(key) || (prefix === "" && SETUP_ENVELOPE_FIELDS.has(key))) continue;
    throw new RejectedPayload(prefix ? `${prefix}.${key} is not a trip setup field` : `${key} is not a trip setup field`);
  }
}

export function validateTripSetup(input: unknown): ValidatedTripSetup {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RejectedPayload("trip setup must be an object");
  const rec = input as Record<string, unknown>;
  rejectUnknownSetupFields(rec, TRIP_SETUP_FIELDS, "");

  const destination = boundedText(rec.destination, "destination");
  if (!destination) throw new RejectedPayload("destination is required");

  const startDate = isoDate(rec.startDate, "startDate");
  const endDate = isoDate(rec.endDate, "endDate");
  if (startDate && !endDate) throw new RejectedPayload("endDate is required when startDate is set");
  if (endDate && !startDate) throw new RejectedPayload("startDate is required when endDate is set");

  let durationDays: number;
  if (startDate && endDate) {
    const span = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1;
    if (span <= 0) throw new RejectedPayload("endDate must be on or after startDate");
    if (span > MAX_TRIP_DAYS) throw new RejectedPayload(`a trip may span at most ${MAX_TRIP_DAYS} days`);
    const stated = rec.durationDays;
    if (stated !== undefined && stated !== null && stated !== "") {
      const requested = Number(stated);
      if (!Number.isInteger(requested) || requested !== span) {
        throw new RejectedPayload("durationDays must match the date range");
      }
    }
    durationDays = span;
  } else {
    const stated = rec.durationDays;
    if (stated === undefined || stated === null || stated === "") throw new RejectedPayload("provide a date range or a trip length");
    const requested = Number(stated);
    if (!Number.isInteger(requested) || requested < 1 || requested > MAX_TRIP_DAYS) {
      throw new RejectedPayload(`trip length must be a whole number between 1 and ${MAX_TRIP_DAYS}`);
    }
    durationDays = requested;
  }

  const timezone = boundedText(rec.timezone, "timezone", 64);
  if (timezone && !TIMEZONES.has(timezone)) throw new RejectedPayload("timezone must be a valid IANA timezone");

  let context: Record<string, unknown> = {};
  if (rec.context !== undefined && rec.context !== null) {
    if (typeof rec.context !== "object" || Array.isArray(rec.context)) throw new RejectedPayload("context must be an object");
    context = rec.context as Record<string, unknown>;
    rejectUnknownSetupFields(context, TRIP_CONTEXT_FIELDS, "context");
  }
  return {
    destination,
    title: boundedText(rec.title, "title") ?? destination,
    timezone,
    startDate,
    endDate,
    durationDays,
    travelers: boundedText(rec.travelers, "travelers"),
    context: {
      lodgingAnchors: boundedList(context.lodgingAnchors, "lodgingAnchors"),
      pace: boundedText(context.pace, "pace"),
      mobility: boundedText(context.mobility, "mobility"),
      budget: boundedText(context.budget, "budget"),
      mealPreferences: boundedList(context.mealPreferences, "mealPreferences"),
      interests: boundedList(context.interests, "interests"),
      mustDos: boundedList(context.mustDos, "mustDos"),
      hardConstraints: boundedList(context.hardConstraints, "hardConstraints"),
    },
  };
}

// ---------- Agent trip-review advisories (ticket 09) ----------

export type TripAdvisoryCategory = "travel_feasibility" | "strain" | "missing_information";
export type TripAdvisorySeverity = "info" | "concern" | "urgent";

export type TripAdvisoryFlag = {
  category: TripAdvisoryCategory;
  severity: TripAdvisorySeverity;
  opinion: string;
  rationale: string;
  dayRefs: string[];
  stopRefs: string[];
};

export type TripReviewInput = {
  expectedRevision: number;
  clientMutationId: string;
  flags: TripAdvisoryFlag[];
};

const ADVISORY_CATEGORIES: Set<string> = new Set(["travel_feasibility", "strain", "missing_information"]);
const ADVISORY_SEVERITIES: Set<string> = new Set(["info", "concern", "urgent"]);

/** A review stores opinions only. Unknown fields are rejected by name so a
 * payload carrying URLs, coordinates, reservations, route data, or Library
 * entity references can never persist them as "advice". libraryId/actor are
 * the trusted-adapter keys every Locus body may carry: ignored, never stored. */
const TRUSTED_IGNORED_FIELDS = new Set(["libraryId", "library_id", "actor"]);

function rejectUnknownFields(rec: Record<string, unknown>, allowed: string[], field: string): void {
  for (const key of Object.keys(rec)) {
    if (!allowed.includes(key) && !TRUSTED_IGNORED_FIELDS.has(key)) {
      throw new RejectedPayload(`${field}.${key} is not accepted: reviews store opinions about saved data only`);
    }
  }
}

function advisoryRefList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RejectedPayload(`${field} must be an array of ids`);
  if (value.length > MAX_ADVISORY_REFS) throw new RejectedPayload(`${field} must have at most ${MAX_ADVISORY_REFS} entries`);
  return value.map((entry) => {
    const id = boundedText(entry, field, MAX_ID_LENGTH);
    if (!id) throw new RejectedPayload(`${field} entries must be non-empty ids`);
    return id;
  });
}

export function validateTripReview(value: unknown): TripReviewInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RejectedPayload("review body must be an object");
  const rec = value as Record<string, unknown>;
  rejectUnknownFields(rec, ["expectedRevision", "clientMutationId", "flags"], "review");

  const expectedRevision = Number(rec.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new RejectedPayload("expectedRevision must be a positive integer");
  }
  const clientMutationId = boundedText(rec.clientMutationId, "clientMutationId", MAX_MUTATION_ID);
  if (!clientMutationId) throw new RejectedPayload("clientMutationId is required");

  if (!Array.isArray(rec.flags) || rec.flags.length === 0) {
    throw new RejectedPayload("flags must be a non-empty array of advisory flags");
  }
  if (rec.flags.length > MAX_REVIEW_FLAGS) {
    throw new RejectedPayload(`a review may contain at most ${MAX_REVIEW_FLAGS} flags`);
  }
  const flags = rec.flags.map((entry, index): TripAdvisoryFlag => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new RejectedPayload(`flags[${index}] must be an object`);
    const flag = entry as Record<string, unknown>;
    rejectUnknownFields(flag, ["category", "severity", "opinion", "rationale", "dayRefs", "stopRefs"], `flags[${index}]`);
    const category = boundedText(flag.category, `flags[${index}].category`, 40);
    if (!category || !ADVISORY_CATEGORIES.has(category)) {
      throw new RejectedPayload(`flags[${index}].category must be travel_feasibility, strain, or missing_information`);
    }
    const severity = boundedText(flag.severity, `flags[${index}].severity`, 20);
    if (!severity || !ADVISORY_SEVERITIES.has(severity)) {
      throw new RejectedPayload(`flags[${index}].severity must be info, concern, or urgent`);
    }
    const opinion = boundedText(flag.opinion, `flags[${index}].opinion`, MAX_ADVISORY_OPINION);
    if (!opinion) throw new RejectedPayload(`flags[${index}].opinion is required`);
    const rationale = boundedText(flag.rationale, `flags[${index}].rationale`, MAX_ADVISORY_RATIONALE);
    if (!rationale) throw new RejectedPayload(`flags[${index}].rationale is required`);
    return {
      category: category as TripAdvisoryCategory,
      severity: severity as TripAdvisorySeverity,
      opinion,
      rationale,
      dayRefs: advisoryRefList(flag.dayRefs, `flags[${index}].dayRefs`),
      stopRefs: advisoryRefList(flag.stopRefs, `flags[${index}].stopRefs`),
    };
  });
  return { expectedRevision, clientMutationId, flags };
}
