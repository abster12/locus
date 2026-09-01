import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../../db/open.ts";
import { newId, nowIso } from "../../db/open.ts";
import { RejectedPayload } from "../../core/sanitize.ts";
import { TripConflict, withTripMutation } from "./receipts.ts";
import { getTrip, type TripDocument, type TripStop } from "./repository.ts";

// The Share Snapshot allowlist is this file. Everything a public viewer may
// see is named below; every other Trip Document field (private notes, Item
// captions, internal ids, provenance, advisories, inferences, changesets,
// account identity) is absent from the snapshot object by construction — the
// public renderer never has to filter anything out.

export type ShareStopView = {
  name: string;
  kind: "item" | "place" | "outside" | "hole";
  timeWindow: string | null;
  durationMinutes: number | null;
  /** Public notes only. Private notes never enter the snapshot. */
  notes: string | null;
  /** Public source links only: the saved Item's original permalink or the
   * user-entered outside URL (sanitized at write time). */
  sourceUrl: string | null;
  /** Place ancestry display string, when the Place has one. */
  location: string | null;
  /** Map coordinates only when the Place already carries them. */
  coordinates: { lat: number; lng: number } | null;
};

export type ShareSnapshot = {
  title: string;
  destination: string;
  startDate: string | null;
  endDate: string | null;
  durationDays: number;
  timezone: string | null;
  days: { label: string; date: string | null; stops: ShareStopView[] }[];
  unscheduled: ShareStopView[];
};

type ShareRow = {
  id: string;
  trip_revision: number;
  token_hash: string;
  snapshot_json: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

function stopView(stop: TripStop): Omit<ShareStopView, "coordinates"> | null {
  // Draft stops are unreviewed agent content, not a shared plan: they stay
  // out until a human keeps them. Broken references have no honest name to
  // share, so they stay out too. Holes share as unresolved requests.
  if (stop.state === "draft") return null;
  const kind = stop.content.kind;
  const name =
    kind === "outside"
      ? stop.content.title
      : kind === "hole"
        ? stop.content.request
        : stop.resolved?.kind === "item"
          ? stop.resolved.title
          : stop.resolved?.kind === "place"
            ? stop.resolved.name
            : null;
  if (!name) return null;
  return {
    name,
    kind,
    timeWindow: stop.timeWindow,
    durationMinutes: stop.durationMinutes,
    notes: stop.publicNotes.trim() || null,
    sourceUrl:
      kind === "outside"
        ? stop.content.url
        : kind === "item" && stop.resolved?.kind === "item"
          ? stop.resolved.url
          : null,
    location: stop.resolved?.kind === "place" ? stop.resolved.location : null,
  };
}

/** The single allowlist seam: resolved Trip Document in, sanitized projection
 * out. Place coordinates come straight from the authoritative Atlas row and
 * are included only when the Place already carries them. Publish and update
 * both snapshot through this function. */
export function prepareShareSnapshot(db: Db, trip: TripDocument): ShareSnapshot {
  const coordinates = (stop: TripStop): { lat: number; lng: number } | null => {
    if (stop.content.kind !== "place") return null;
    const row = db.prepare(`SELECT lat, lng FROM atlas_places WHERE id = ? AND library_id = ?`).get(stop.content.placeId, trip.libraryId) as
      | { lat: number | null; lng: number | null }
      | undefined;
    return row?.lat != null && row.lng != null ? { lat: row.lat, lng: row.lng } : null;
  };
  const shareStop = (stop: TripStop): ShareStopView | null => {
    const view = stopView(stop);
    if (!view) return null;
    return { ...view, coordinates: coordinates(stop) };
  };
  return {
    title: trip.title,
    destination: trip.destination,
    startDate: trip.startDate,
    endDate: trip.endDate,
    durationDays: trip.durationDays,
    timezone: trip.timezone,
    days: trip.days.map((day) => ({
      label: day.label,
      date: day.date,
      stops: day.stops.map(shareStop).filter((stop): stop is ShareStopView => stop !== null),
    })),
    unscheduled: trip.unscheduled.map(shareStop).filter((stop): stop is ShareStopView => stop !== null),
  };
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Deterministic digest of the allowlisted snapshot. Preview returns it;
 * publish recomputes and rejects if the document moved. */
export function snapshotDigest(snapshot: ShareSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function previewDigestOf(input: unknown): string | null {
  const rec = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const digest = typeof rec.digest === "string" ? rec.digest.trim().toLowerCase() : "";
  return /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}

export function previewShareSnapshot(
  db: Db,
  libraryId: string,
  tripId: string,
): { snapshot: ShareSnapshot; digest: string; revision: number; shared: ShareState | null } | null {
  const trip = getTrip(db, libraryId, tripId);
  if (!trip) return null;
  const snapshot = prepareShareSnapshot(db, trip);
  return { snapshot, digest: snapshotDigest(snapshot), revision: trip.revision, shared: getShareState(db, libraryId, tripId) };
}

export type ShareState = { revision: number; updatedAt: string };

/** Owner-facing state. Never carries the token — only its hash is stored. */
export function getShareState(db: Db, libraryId: string, tripId: string): ShareState | null {
  const row = db.prepare(`SELECT * FROM trip_share_snapshots WHERE trip_id = ?`).get(tripId) as ShareRow | undefined;
  if (!row || row.revoked_at) return null;
  const trip = getTrip(db, libraryId, tripId);
  if (!trip) return null;
  return { revision: row.trip_revision, updatedAt: row.updated_at };
}

export type SharePublishResult = { token: string; snapshot: ShareSnapshot; revision: number; updatedAt: string };

/** Replay of a publish whose response may have been lost: the original
 * snapshot without re-minting or re-showing the token. Only the token hash is
 * stored, so a replay cannot hand the capability back. */
export type SharePublishReplay = Omit<SharePublishResult, "token"> & { token: null };

/** Human-only publish (and re-publish), revision-checked through the standard
 * Trip mutation envelope. Every first call mints a fresh unguessable token,
 * stores only its SHA-256 hash, and snapshots the document as it stands right
 * now. Revoked shares are replaced, never revived — so an old link stays dead
 * and the new capability is a new token. The document revision does not move:
 * publishing records the revision it snapshotted, it does not edit the plan. */
export function publishShareSnapshot(
  db: Db,
  libraryId: string,
  tripId: string,
  input: unknown,
  at = nowIso(),
): SharePublishResult | SharePublishReplay | null {
  return withTripMutation<SharePublishResult | SharePublishReplay>(db, libraryId, tripId, {
    kind: "share-publish",
    input,
    payload: { digest: previewDigestOf(input) },
    at,
    apply: (_tripRow, at) => {
      const bound = previewDigestOf(input);
      if (!bound) throw new RejectedPayload("share publish requires the preview digest");
      const trip = getTrip(db, libraryId, tripId)!;
      const snapshot = prepareShareSnapshot(db, trip);
      if (snapshotDigest(snapshot) !== bound) {
        throw new TripConflict("share preview is stale; preview the Trip Document again");
      }
      const token = randomBytes(32).toString("base64url");
      db.prepare(`DELETE FROM trip_share_snapshots WHERE trip_id = ?`).run(tripId);
      db.prepare(
        `INSERT INTO trip_share_snapshots (id, trip_id, trip_revision, token_hash, snapshot_json, created_at, updated_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(newId(), tripId, trip.revision, tokenHash(token), JSON.stringify(snapshot), at, at);
      return {
        result: { token, snapshot, revision: trip.revision, updatedAt: at },
        receipt: { token: null, snapshot, revision: trip.revision, updatedAt: at },
      };
    },
  });
}

export function revokeShareSnapshot(db: Db, libraryId: string, tripId: string, input: unknown, at = nowIso()): boolean | null {
  return withTripMutation<boolean>(db, libraryId, tripId, {
    kind: "share-revoke",
    input,
    at,
    apply: (_tripRow, at) => {
      const result = db.prepare(`UPDATE trip_share_snapshots SET revoked_at = ? WHERE trip_id = ? AND revoked_at IS NULL`).run(at, tripId);
      return { result: result.changes > 0 };
    },
  });
}

/** Public lookup by raw token. Revoked and unknown tokens are the same
 * "no itinerary payload" result. */
export function findSharedSnapshot(db: Db, token: string): { snapshot: ShareSnapshot; revision: number; updatedAt: string } | null {
  const trimmed = token.trim();
  if (!trimmed || trimmed.length > 128) return null;
  const row = db.prepare(`SELECT * FROM trip_share_snapshots WHERE token_hash = ?`).get(tokenHash(trimmed)) as ShareRow | undefined;
  if (!row || row.revoked_at) return null;
  return { snapshot: JSON.parse(row.snapshot_json) as ShareSnapshot, revision: row.trip_revision, updatedAt: row.updated_at };
}

// ---------- public page rendering (static HTML, no scripts) ----------

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function stopHtml(stop: ShareStopView): string {
  const kindLabel = stop.kind === "hole" ? "Unresolved" : stop.kind === "item" ? "Saved item" : stop.kind === "place" ? "Place" : "Outside";
  const time = stop.timeWindow ? `<span class="s-time">${escapeHtml(stop.timeWindow)}</span>` : "";
  const duration = stop.durationMinutes ? `<span class="s-dur">${stop.durationMinutes} min</span>` : "";
  const link = stop.sourceUrl ? ` <a href="${escapeHtml(stop.sourceUrl)}" rel="noopener noreferrer">source ↗</a>` : "";
  const location = stop.location ? `<span class="s-loc">${escapeHtml(stop.location)}</span>` : "";
  const coords = stop.coordinates ? `<span class="s-loc">${stop.coordinates.lat.toFixed(5)}, ${stop.coordinates.lng.toFixed(5)}</span>` : "";
  const notes = stop.notes ? `<p class="s-notes">${escapeHtml(stop.notes)}</p>` : "";
  return `<li class="s-stop s-stop-${stop.kind}"><span class="s-kind">${kindLabel}</span> <b>${escapeHtml(stop.name)}</b>${time}${duration}${link}${location}${coords}${notes}</li>`;
}

/** Static, self-contained read-only page. No scripts ship at all, so a public
 * viewer cannot mutate anything, comment, or invoke private WebMCP tools. */
export function renderShareHtml(snapshot: ShareSnapshot, updatedAt: string): string {
  const days = snapshot.days
    .map(
      (day) => `<section class="s-day"><h2>${escapeHtml(day.label)}${day.date ? ` · ${escapeHtml(day.date)}` : ""}</h2>${
        day.stops.length
          ? `<ul>${day.stops.map(stopHtml).join("")}</ul>`
          : `<p class="s-empty">No confirmed stops yet.</p>`
      }</section>`,
    )
    .join("");
  const unscheduled = snapshot.unscheduled.length
    ? `<section class="s-day"><h2>Unscheduled</h2><ul>${snapshot.unscheduled.map(stopHtml).join("")}</ul></section>`
    : "";
  const dates = snapshot.startDate && snapshot.endDate ? `${escapeHtml(snapshot.startDate)} – ${escapeHtml(snapshot.endDate)}` : `${snapshot.durationDays} days · dates open`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(snapshot.title)}</title>
<style>
:root { --paper:#f1f2ef; --card:#fcfdfb; --ink:#17191b; --mute:#6b7176; --rule:#d8dbd5; --accent:#c8352e; --wash:#e7e9e4; }
* { box-sizing: border-box; } body { margin:0; background:var(--paper); color:var(--ink);
font-family:"Avenir Next",Avenir,"Gill Sans",system-ui,sans-serif; -webkit-font-smoothing:antialiased; overflow-wrap:anywhere; }
main { max-width:760px; margin:0 auto; padding:32px 20px 64px; }
.kicker { font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:var(--mute); margin:0 0 6px; }
h1 { font-family:"Iowan Old Style",Palatino,Georgia,serif; font-weight:500; font-size:34px; letter-spacing:-.02em; margin:0; }
.s-meta { color:var(--mute); font-size:13px; margin:8px 0 4px; }
.s-updated { color:var(--mute); font-size:12px; border-bottom:1px solid var(--rule); padding-bottom:18px; margin-bottom:8px; }
.s-day h2 { font-family:"Iowan Old Style",Palatino,Georgia,serif; font-size:20px; font-weight:500; margin:26px 0 10px; }
.s-day ul { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
.s-stop { background:var(--card); border:1px solid var(--rule); border-radius:10px; padding:11px 14px; font-size:14px; }
.s-stop-hole { border-style:dashed; color:var(--mute); }
.s-kind { display:inline-block; font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--mute);
border:1px solid var(--rule); border-radius:999px; padding:1px 7px; margin-right:6px; background:var(--wash); }
.s-time, .s-dur, .s-loc { color:var(--mute); font-size:12px; margin-left:8px; }
.s-notes { margin:6px 0 0; color:var(--ink); font-size:13px; }
.s-empty { color:var(--mute); font-size:13px; }
footer { margin-top:34px; color:var(--mute); font-size:11px; letter-spacing:.06em; }
@media (max-width:480px) { main { padding:22px 14px 48px; } h1 { font-size:27px; } }
</style></head><body><main>
<p class="kicker">Shared itinerary</p>
<h1>${escapeHtml(snapshot.title)}</h1>
<p class="s-meta">${escapeHtml(snapshot.destination)} · ${dates}${snapshot.timezone ? ` · ${escapeHtml(snapshot.timezone)}` : ""}</p>
<p class="s-updated">Last updated ${escapeHtml(updatedAt)}</p>
${days}${unscheduled}
<footer>Shared from Locus · read-only</footer>
</main></body></html>`;
}
