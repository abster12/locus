import { RejectedPayload, sanitizeText } from "../../core/sanitize.ts";

export const PLACE_KINDS = ["country", "admin", "city", "neighbourhood", "venue", "landmark", "natural", "place"] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

export const PLACE_ROLES = ["primary", "contained", "mentioned"] as const;
export type PlaceRole = (typeof PLACE_ROLES)[number];

export const ASSIGNMENT_OUTCOMES = ["placed", "needs_place", "multiple", "not_atlas"] as const;
export type AssignmentOutcome = (typeof ASSIGNMENT_OUTCOMES)[number];

export const ASSIGNMENT_ACTORS = ["analyzer", "user"] as const;
export type AssignmentActor = (typeof ASSIGNMENT_ACTORS)[number];

export const MAX_PLACE_NAME = 80;
export const MAX_ALT_NAMES = 8;
export const MAX_PRIMARY_CANDIDATES = 3;
export const MAX_RELATED = 12;
export const MAX_EVIDENCE = 4;
export const MAX_REVIEW_PREVIEW = 3;
export const MAX_PLACE_SEARCH = 80;
export const HOME_SETTING = "atlas.homePlaceId";
export const BACKFILL_SETTING = "atlas.backfill.cursor";
export const BACKFILL_VERSION_SETTING = "atlas.backfill.version";
export const BACKFILL_DONE = "done";
export const BACKFILL_BATCH = 50;
export const ATLAS_BATCH = 8;
export const MAX_ATLAS_ATTEMPTS = 4;
// Screening is a cheaper, batched relevance pass. Keep its version separate
// from the detailed interpreter version because the two contracts evolve
// independently and have different retry/cost characteristics.
export const SCREENING_POLICY_VERSION = 1;
// This bounded migration is separate from the broad screening backfill. It
// only revisits existing Travel-tagged Items so the high-recall override can
// be adopted without rerunning detailed analysis for the whole library.
export const TRAVEL_OVERRIDE_POLICY_VERSION = 1;
export const TRAVEL_OVERRIDE_VERSION_SETTING = "atlas.travel-override.version";
export const TRAVEL_OVERRIDE_CURSOR_SETTING = "atlas.travel-override.cursor";
// Increment when the interpreter contract or validation semantics change. It
// is intentionally separate from Item sourceRevision: the latter is user
// visible content provenance, while this value controls analyzer work.
export const ANALYZER_POLICY_VERSION = 3;

const KIND_SET = new Set<string>(PLACE_KINDS);
const ROLE_SET = new Set<string>(PLACE_ROLES);
const PROPOSAL_KEYS = new Set(["itemId", "relevance", "multiple", "destinations"]);
const PAYLOAD_KEYS = new Set(["containedPlaceIds", "mentionedPlaceIds", "peerPlaceIds", "suggestions"]);
const DEST_KEYS = new Set(["name", "kind", "parentName", "parentKind", "altNames", "role", "evidence"]);
const EVIDENCE_KEYS = new Set(["field", "start", "end", "text"]);
const PALETTE = [
  { color: "#3d4a55", ink: "#f2f3f0" },
  { color: "#5c4a3a", ink: "#f2f3f0" },
  { color: "#3a4f4a", ink: "#f2f3f0" },
  { color: "#4a3d55", ink: "#f2f3f0" },
  { color: "#554a3a", ink: "#f2f3f0" },
  { color: "#3a4555", ink: "#f2f3f0" },
] as const;

export type EvidenceSpan = { field: "title" | "body"; start: number; end: number; text: string };

export type DestinationCandidate = {
  name: string;
  kind: PlaceKind;
  parentName?: string;
  parentKind?: PlaceKind;
  altNames: string[];
  role: PlaceRole;
  evidence: EvidenceSpan[];
};

export type AtlasProposal = {
  itemId: string;
  relevance: "atlas" | "not_atlas";
  multiple: boolean;
  destinations: DestinationCandidate[];
};

export type AssignmentPayload = {
  containedPlaceIds: string[];
  mentionedPlaceIds: string[];
  peerPlaceIds: string[];
  suggestions: DestinationCandidate[];
};

export function emptyPayload(): AssignmentPayload {
  return { containedPlaceIds: [], mentionedPlaceIds: [], peerPlaceIds: [], suggestions: [] };
}

export function normalizeSource(title: string | null | undefined, body: string | null | undefined): { title: string; body: string } {
  return { title: (title ?? "").replace(/\r\n/g, "\n").trim(), body: (body ?? "").replace(/\r\n/g, "\n").trim() };
}

export function foldName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, " ")
    .trim();
}

export function sanitizePlaceName(name: string): string {
  const clean = sanitizeText(name, MAX_PLACE_NAME);
  if (!clean) throw new RejectedPayload("place name required");
  return clean;
}

export function mapKind(raw: string): PlaceKind {
  return KIND_SET.has(raw) ? (raw as PlaceKind) : "place";
}

export function parseKind(raw: unknown): PlaceKind {
  if (typeof raw !== "string" || !raw) throw new RejectedPayload("invalid place kind");
  return mapKind(raw);
}

export function placeAccent(id: string): { color: string; ink: string } {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

export function validateAssignmentPayload(raw: unknown, title: string, body: string): AssignmentPayload {
  if (raw == null) return emptyPayload();
  if (typeof raw !== "object" || Array.isArray(raw)) throw new RejectedPayload("invalid assignment payload");
  const rec = raw as Record<string, unknown>;
  rejectUnknown(rec, PAYLOAD_KEYS);
  const suggestions = rec.suggestions === undefined ? [] : readSuggestions(rec.suggestions, title, body);
  return {
    containedPlaceIds: requireIds(rec.containedPlaceIds),
    mentionedPlaceIds: requireIds(rec.mentionedPlaceIds),
    peerPlaceIds: requireIds(rec.peerPlaceIds),
    suggestions,
  };
}

export function parsePayload(raw: string): AssignmentPayload {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return emptyPayload();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyPayload();
  const rec = value as Record<string, unknown>;
  return {
    containedPlaceIds: stringIds(rec.containedPlaceIds),
    mentionedPlaceIds: stringIds(rec.mentionedPlaceIds),
    peerPlaceIds: stringIds(rec.peerPlaceIds),
    suggestions: Array.isArray(rec.suggestions) ? rec.suggestions.filter(isCandidate) : [],
  };
}

export function repairProposal(raw: unknown, itemId: string, title: string, body: string, _travelContext = false): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RejectedPayload("invalid atlas proposal");
  }
  const rec = raw as Record<string, unknown>;
  if (rec.itemId !== undefined && typeof rec.itemId !== "string") throw new RejectedPayload("invalid item");
  if (rec.multiple !== undefined && typeof rec.multiple !== "boolean") throw new RejectedPayload("invalid multiple");
  if (rec.destinations !== undefined && !Array.isArray(rec.destinations)) throw new RejectedPayload("invalid destinations");
  const destinations = (Array.isArray(rec.destinations) ? rec.destinations : []).map((row) => repairCandidate(row, title, body));
  return {
    itemId: typeof rec.itemId === "string" ? rec.itemId : itemId,
    relevance: rec.relevance,
    multiple: rec.multiple === true,
    destinations,
  };
}

export function validateProposal(raw: unknown, itemId: string, title: string, body: string): AtlasProposal {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RejectedPayload("invalid atlas proposal");
  const rec = raw as Record<string, unknown>;
  rejectUnknown(rec, PROPOSAL_KEYS);
  if (rec.itemId !== itemId) throw new RejectedPayload("unknown item");
  if (rec.relevance !== "atlas" && rec.relevance !== "not_atlas") throw new RejectedPayload("invalid relevance");
  if (rec.multiple !== undefined && typeof rec.multiple !== "boolean") throw new RejectedPayload("invalid multiple");
  if (rec.destinations !== undefined && !Array.isArray(rec.destinations)) throw new RejectedPayload("invalid destinations");
  const destinations = (rec.destinations ?? []).map((row) => readCandidate(row, title, body));
  if (destinations.length > MAX_RELATED) throw new RejectedPayload("too many destinations");
  const primaries = destinations.filter((row) => row.role === "primary");
  if (primaries.length > MAX_PRIMARY_CANDIDATES) throw new RejectedPayload("too many suggestions");
  return {
    itemId,
    relevance: rec.relevance,
    multiple: rec.multiple === true,
    destinations,
  };
}

export function decideOutcome(proposal: AtlasProposal): AssignmentOutcome {
  if (proposal.relevance === "not_atlas") return "not_atlas";
  const primaries = proposal.destinations.filter((row) => row.role === "primary" && row.evidence.length > 0);
  if (proposal.multiple) return primaries.length >= 2 ? "multiple" : "needs_place";
  if (primaries.length === 1 && proposal.destinations.filter((row) => row.role === "primary").length === 1) return "placed";
  return "needs_place";
}

function repairCandidate(raw: unknown, title: string, body: string): DestinationCandidate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RejectedPayload("invalid destination");
  const rec = raw as Record<string, unknown>;
  if (typeof rec.name !== "string") throw new RejectedPayload("invalid destination name");
  let name: string;
  try {
    name = sanitizePlaceName(rec.name.slice(0, MAX_PLACE_NAME));
  } catch {
    throw new RejectedPayload("invalid destination name");
  }
  if (rec.role !== undefined && (typeof rec.role !== "string" || !ROLE_SET.has(rec.role))) throw new RejectedPayload("unknown role");
  const role = rec.role === undefined ? "primary" : (rec.role as PlaceRole);
  const evidence: EvidenceSpan[] = [];
  if (Array.isArray(rec.evidence)) {
    for (const span of rec.evidence) {
      const fixed = repairSpan(span, title, body, name);
      if (fixed) evidence.push(fixed);
      if (evidence.length >= MAX_EVIDENCE) break;
    }
  }
  // Providers may return the supporting text without offsets (or with stale
  // offsets after truncation). Derive exact local offsets from the captured
  // source; never manufacture evidence for a name absent from it.
  if (evidence.length === 0) {
    const found = findSpan(title, body, name);
    if (found) evidence.push(found);
  }
  const candidate: DestinationCandidate = {
    name,
    kind: mapKind(typeof rec.kind === "string" ? rec.kind : "place"),
    altNames: repairAltList(rec.altNames),
    role,
    evidence,
  };
  if (typeof rec.parentName === "string" && rec.parentName.trim()) {
    try {
      candidate.parentName = sanitizePlaceName(rec.parentName.slice(0, MAX_PLACE_NAME));
    } catch {
      /* omit empty / illegal parent */
    }
  }
  if (typeof rec.parentKind === "string" && rec.parentKind) candidate.parentKind = mapKind(rec.parentKind);
  return candidate;
}

function repairSpan(raw: unknown, title: string, body: string, fallback: string): EvidenceSpan | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    const field = rec.field === "title" || rec.field === "body" ? rec.field : null;
    const start = typeof rec.start === "number" ? rec.start : -1;
    const end = typeof rec.end === "number" ? rec.end : -1;
    const text = typeof rec.text === "string" ? rec.text : "";
    if (field && Number.isInteger(start) && Number.isInteger(end) && text && text.length <= 200) {
      const source = field === "title" ? title : body;
      if (start >= 0 && end <= source.length && start < end && source.slice(start, end) === text) {
        return { field, start, end, text };
      }
    }
    if (text) {
      const found = findSpan(title, body, text);
      if (found) return found;
    }
  }
  return findSpan(title, body, fallback);
}

function findSpan(title: string, body: string, needle: string): EvidenceSpan | null {
  const inTitle = locateSpan(title, needle);
  if (inTitle) return { field: "title", start: inTitle.start, end: inTitle.end, text: title.slice(inTitle.start, inTitle.end) };
  const inBody = locateSpan(body, needle);
  if (inBody) return { field: "body", start: inBody.start, end: inBody.end, text: body.slice(inBody.start, inBody.end) };
  return null;
}

function locateSpan(source: string, needle: string): { start: number; end: number } | null {
  if (!needle || needle.length > 200) return null;
  const exact = source.indexOf(needle);
  if (exact >= 0) return { start: exact, end: exact + needle.length };
  const i = source.toLowerCase().indexOf(needle.toLowerCase());
  if (i >= 0) return { start: i, end: i + needle.length };
  return null;
}

function repairAltList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const name of raw.slice(0, MAX_ALT_NAMES)) {
    if (typeof name !== "string" || !name) continue;
    try {
      const clean = sanitizePlaceName(name.slice(0, MAX_PLACE_NAME));
      if (!names.includes(clean)) names.push(clean);
    } catch {
      /* skip */
    }
  }
  return names;
}

function readCandidate(raw: unknown, title: string, body: string): DestinationCandidate {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RejectedPayload("invalid destination");
  const rec = raw as Record<string, unknown>;
  rejectUnknown(rec, DEST_KEYS);
  if (typeof rec.role !== "string" || !ROLE_SET.has(rec.role)) throw new RejectedPayload("unknown role");
  if (!Array.isArray(rec.evidence)) throw new RejectedPayload("invalid evidence");
  if (rec.evidence.length > MAX_EVIDENCE) throw new RejectedPayload("too much evidence");
  const evidence = rec.evidence.map((span) => readEvidence(span, title, body));
  if (rec.role === "primary" && evidence.length === 0) throw new RejectedPayload("missing evidence");
  const altNames = readAltNames(rec.altNames);
  const candidate: DestinationCandidate = {
    name: sanitizePlaceName(requiredString(rec.name, MAX_PLACE_NAME)),
    kind: parseKind(rec.kind),
    altNames,
    role: rec.role as PlaceRole,
    evidence,
  };
  if (rec.parentName !== undefined) candidate.parentName = sanitizePlaceName(requiredString(rec.parentName, MAX_PLACE_NAME));
  if (rec.parentKind !== undefined) candidate.parentKind = parseKind(rec.parentKind);
  return candidate;
}

function readEvidence(raw: unknown, title: string, body: string): EvidenceSpan {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RejectedPayload("invalid evidence");
  const rec = raw as Record<string, unknown>;
  rejectUnknown(rec, EVIDENCE_KEYS);
  if (rec.field !== "title" && rec.field !== "body") throw new RejectedPayload("invalid evidence");
  if (!Number.isInteger(rec.start) || !Number.isInteger(rec.end)) throw new RejectedPayload("invalid evidence");
  if (typeof rec.text !== "string" || rec.text.length === 0 || rec.text.length > 200) throw new RejectedPayload("invalid evidence");
  const source = rec.field === "title" ? title : body;
  const start = rec.start as number;
  const end = rec.end as number;
  if (start < 0 || end > source.length || start >= end) throw new RejectedPayload("evidence out of bounds");
  if (source.slice(start, end) !== rec.text) throw new RejectedPayload("evidence mismatch");
  return { field: rec.field, start, end, text: rec.text };
}

function readAltNames(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ALT_NAMES) throw new RejectedPayload("invalid alt names");
  const names = raw.map((name) => sanitizePlaceName(requiredString(name, MAX_PLACE_NAME)));
  return [...new Set(names)];
}

function requiredString(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new RejectedPayload("invalid string");
  return value;
}

function stringIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 80);
}

function requireIds(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_RELATED) throw new RejectedPayload("invalid assignment places");
  return raw.map((id) => requiredString(id, 80));
}

function readSuggestions(raw: unknown, title: string, body: string): DestinationCandidate[] {
  if (!Array.isArray(raw)) throw new RejectedPayload("invalid suggestions");
  if (raw.length > MAX_PRIMARY_CANDIDATES) throw new RejectedPayload("too many suggestions");
  return raw.map((row) => readCandidate(row, title, body));
}

function isCandidate(raw: unknown): raw is DestinationCandidate {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const rec = raw as Record<string, unknown>;
  return typeof rec.name === "string" && typeof rec.kind === "string" && typeof rec.role === "string";
}

function rejectUnknown(rec: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) throw new RejectedPayload("unknown field");
  }
}
