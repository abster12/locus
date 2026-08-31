import type { TripDocument, TripStop } from "./module.ts";
import { parseTimeWindow } from "./projections.ts";

// Pure, dependency-free export projections over one itinerary. Everything
// here runs in the browser bundle (type-only imports are erased, nothing
// touches node builtins or the network): the client renders copies, the print
// view, self-contained HTML, and ICS from data it already has.
//
// The input shape is the export seam for BOTH sources: the private Trip
// Document (projected through projectTripForExport) and the sanitized Share
// Snapshot (already in this shape). Private notes never enter an ExportTrip
// — projection reads publicNotes only — so sanitized-source exports cannot
// leak them by construction.

export type ExportStop = {
  name: string;
  kind: "item" | "place" | "outside" | "hole";
  timeWindow: string | null;
  durationMinutes: number | null;
  /** Public notes only; private notes are excluded upstream of this type. */
  notes: string | null;
  /** Public source link only: the Item permalink or user-supplied outside URL. */
  sourceUrl: string | null;
  location: string | null;
  /** Stable calendar identity when the source carries one (private stop ids).
   * Snapshot stops derive a deterministic uid from their content instead. */
  uid?: string;
  draft?: boolean;
};

export type ExportTrip = {
  title: string;
  destination: string;
  timezone: string | null;
  startDate: string | null;
  endDate: string | null;
  durationDays: number;
  days: { label: string; date: string | null; stops: ExportStop[] }[];
  unscheduled: ExportStop[];
};

/** Private Trip Document → export shape. Only public fields cross this line:
 * privateNotes, provenance, advisories, and internal links are dropped here,
 * which is why no downstream exporter can leak them. */
export function projectTripForExport(trip: TripDocument): ExportTrip {
  const exportStop = (stop: TripStop): ExportStop => {
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
              : kind === "item"
                ? "Missing saved item"
                : "Missing place";
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
      uid: stop.id,
      draft: stop.state === "draft",
    };
  };
  return {
    title: trip.title,
    destination: trip.destination,
    timezone: trip.timezone,
    startDate: trip.startDate,
    endDate: trip.endDate,
    durationDays: trip.durationDays,
    days: trip.days.map((day) => ({ label: day.label, date: day.date, stops: day.stops.map(exportStop) })),
    unscheduled: trip.unscheduled.map(exportStop),
  };
}

// ---------- shared helpers ----------

function datesLine(trip: ExportTrip): string {
  const dates =
    trip.startDate && trip.endDate ? `${trip.startDate} – ${trip.endDate}` : `${trip.durationDays} ${trip.durationDays === 1 ? "day" : "days"} · dates open`;
  return `${trip.destination} · ${dates}${trip.timezone ? ` · ${trip.timezone}` : ""}`;
}

function stopTitle(stop: ExportStop): string {
  return stop.draft ? `${stop.name} (draft)` : stop.name;
}

// ---------- text ----------

/** Readable plain text: document day order, stop order, times, public notes,
 * and an unambiguous marker on unresolved holes. */
export function exportTripText(trip: ExportTrip): string {
  const lines: string[] = [trip.title, datesLine(trip), ""];
  const stopLines = (stop: ExportStop): void => {
    if (stop.kind === "hole") {
      lines.push(`  Open: ${stop.name}`);
    } else {
      const time = stop.timeWindow ? `${stop.timeWindow} ` : "";
      const duration = stop.durationMinutes ? ` · ${stop.durationMinutes} min` : "";
      const location = stop.location ? ` · ${stop.location}` : "";
      lines.push(`  ${time}${stopTitle(stop)}${duration}${location}`);
    }
    if (stop.notes) lines.push(`    · ${stop.notes}`);
    if (stop.sourceUrl) lines.push(`    ↗ ${stop.sourceUrl}`);
  };
  for (const day of trip.days) {
    lines.push(`${day.label}${day.date ? ` · ${day.date}` : ""}`);
    if (day.stops.length === 0) lines.push("  Nothing planned yet.");
    day.stops.forEach(stopLines);
  }
  if (trip.unscheduled.length) {
    lines.push("Unscheduled");
    trip.unscheduled.forEach(stopLines);
  }
  return `${lines.join("\n")}\n`;
}

// ---------- self-contained HTML (also the print view) ----------

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** Standalone document: inline styles only, no Locus URLs, no scripts, and
 * the same markup serves the print/PDF view via @media print rules. */
export function exportTripHtml(trip: ExportTrip, options: { updatedAt?: string | null } = {}): string {
  const stopHtml = (stop: ExportStop): string => {
    const kindLabel =
      stop.kind === "hole" ? "Open request" : stop.kind === "item" ? "Saved item" : stop.kind === "place" ? "Place" : "Outside";
    const time = stop.timeWindow ? `<span class="t-time">${escapeHtml(stop.timeWindow)}</span>` : "";
    const duration = stop.durationMinutes ? `<span class="t-dur">${stop.durationMinutes} min</span>` : "";
    const location = stop.location ? `<span class="t-loc">${escapeHtml(stop.location)}</span>` : "";
    const link = stop.sourceUrl ? ` <a href="${escapeHtml(stop.sourceUrl)}" rel="noopener noreferrer">source ↗</a>` : "";
    const notes = stop.notes ? `<p class="t-notes">${escapeHtml(stop.notes)}</p>` : "";
    if (stop.kind === "hole") {
      return `<li class="t-stop t-hole"><span class="t-kind">${kindLabel}</span> <b>${escapeHtml(stop.name)}</b>${time}${duration}${notes}</li>`;
    }
    return `<li class="t-stop"><span class="t-kind">${kindLabel}</span> <b>${escapeHtml(stopTitle(stop))}</b>${time}${duration}${location}${link}${notes}</li>`;
  };
  const dayHtml = (day: ExportTrip["days"][number]): string =>
    `<section class="t-day"><h2>${escapeHtml(day.label)}${day.date ? ` · ${escapeHtml(day.date)}` : ""}</h2>${
      day.stops.length ? `<ul>${day.stops.map(stopHtml).join("")}</ul>` : `<p class="t-empty">Nothing planned yet.</p>`
    }</section>`;
  const unscheduled = trip.unscheduled.length
    ? `<section class="t-day"><h2>Unscheduled</h2><ul>${trip.unscheduled.map(stopHtml).join("")}</ul></section>`
    : "";
  const updated = options.updatedAt ? `<p class="t-updated">Last updated ${escapeHtml(options.updatedAt)}</p>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(trip.title)}</title>
<style>
:root { --paper:#f1f2ef; --card:#fcfdfb; --ink:#17191b; --mute:#6b7176; --rule:#d8dbd5; --accent:#c8352e; --wash:#e7e9e4; }
* { box-sizing: border-box; }
body { margin:0; background:var(--paper); color:var(--ink); font-family:"Avenir Next",Avenir,"Gill Sans",system-ui,sans-serif;
-webkit-font-smoothing:antialiased; overflow-wrap:anywhere; }
main { max-width:760px; margin:0 auto; padding:32px 20px 64px; }
.kicker { font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:var(--mute); margin:0 0 6px; }
h1 { font-family:"Iowan Old Style",Palatino,Georgia,serif; font-weight:500; font-size:34px; letter-spacing:-.02em; margin:0; }
.t-meta { color:var(--mute); font-size:13px; margin:8px 0 0; }
.t-updated { color:var(--mute); font-size:12px; border-bottom:1px solid var(--rule); padding-bottom:18px; }
.t-day h2 { font-family:"Iowan Old Style",Palatino,Georgia,serif; font-size:20px; font-weight:500; margin:26px 0 10px; }
.t-day ul { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
.t-stop { background:var(--card); border:1px solid var(--rule); border-radius:10px; padding:11px 14px; font-size:14px; }
.t-hole { border-style:dashed; color:var(--mute); }
.t-kind { display:inline-block; font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--mute);
border:1px solid var(--rule); border-radius:999px; padding:1px 7px; margin-right:6px; background:var(--wash); }
.t-time, .t-dur, .t-loc { color:var(--mute); font-size:12px; margin-left:8px; }
.t-notes { margin:6px 0 0; font-size:13px; }
.t-empty { color:var(--mute); font-size:13px; }
footer { margin-top:34px; color:var(--mute); font-size:11px; letter-spacing:.06em; }
@media print {
  body { background:#fff; }
  main { max-width:none; padding:0; }
  h1 { font-size:26px; }
  .t-day { break-inside: avoid; page-break-inside: avoid; }
  .t-stop { break-inside: avoid; page-break-inside: avoid; box-shadow:none; }
  .t-day h2 { break-after: avoid; }
  footer { display:none; }
}
@media (max-width:480px) { main { padding:22px 14px 48px; } h1 { font-size:27px; } }
</style></head><body><main>
<p class="kicker">Itinerary</p>
<h1>${escapeHtml(trip.title)}</h1>
<p class="t-meta">${escapeHtml(datesLine(trip))}</p>
${updated}
${trip.days.map(dayHtml).join("")}
${unscheduled}
<footer>Exported from Locus · read-only file</footer>
</main></body></html>`;
}

// ---------- calendar (ICS) ----------

function escapeIcs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** RFC 5545 line folding. Character-based (not octet-based) so multi-byte
 * text never splits mid-rune; every major calendar accepts this. */
function foldIcs(line: string): string[] {
  if (line.length <= 73) return [line];
  const out: string[] = [line.slice(0, 73)];
  for (let at = 73; at < line.length; at += 72) out.push(` ${line.slice(at, at + 72)}`);
  return out;
}

// ponytail: FNV-1a instead of crypto.subtle — sync, deterministic, and uid
// stability (not collision resistance) is the requirement; swap if trips grow.
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stopUid(stop: ExportStop, trip: ExportTrip, dayLabel: string): string {
  if (stop.uid) return `${stop.uid}@locus`;
  return `${fnv1a(`${trip.title}|${dayLabel}|${stop.kind}|${stop.name}|${stop.timeWindow ?? ""}`)}@locus`;
}

/** Wall-clock date + "HH:MM" in the document timezone → UTC basic instant.
 * Returns null when anything is unparseable so callers fall back to the
 * honest (untimed) representation instead of inventing a time. */
function zonedToUtcBasic(date: string, time: string, timezone: string): string | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const parsed = parseTimeWindow(time);
  if (!day || !parsed) return null;
  const hours = Math.floor(parsed.start / 60);
  const minutes = parsed.start % 60;
  try {
    const utcGuess = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), hours, minutes);
    const offsetAt = (at: number): number => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).formatToParts(new Date(at));
      const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
      return Date.UTC(value("year"), value("month") - 1, value("day"), value("hour") % 24, value("minute"), value("second")) - Math.floor(at / 1000) * 1000;
    };
    const offset = offsetAt(utcGuess);
    let instant = utcGuess - offset;
    const corrected = offsetAt(instant);
    if (corrected !== offset) instant = utcGuess - corrected;
    return new Date(instant).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  } catch {
    return null;
  }
}

function basicStamp(value: string | undefined | null): string {
  if (value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  }
  // Deterministic default so tests and repeat exports stay stable.
  return "19800101T000000Z";
}

function basicDate(date: string): string {
  return date.replace(/-/g, "");
}

/** Timezone-correct ICS. Timed stops on dated days become UTC instants
 * computed in the document timezone (DST-safe); untimed stops on dated days
 * become all-day DATE events; anything without a date becomes a VJOURNAL
 * with no DTSTART — no clock time or date is ever invented. UIDs are stable
 * per stop so re-exporting updates events instead of duplicating them. */
export function exportTripIcs(trip: ExportTrip, options: { stamp?: string | null } = {}): string {
  const stamp = basicStamp(options.stamp);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Locus//Trips 1.0//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeIcs(trip.title)}`,
  ];
  if (trip.timezone) lines.push(`X-WR-TIMEZONE:${escapeIcs(trip.timezone)}`);

  const description = (stop: ExportStop, dayLabel: string): string => {
    const parts = [stop.notes ?? ""];
    if (!dayLabel) parts.push(stop.timeWindow ? `Time: ${stop.timeWindow} (no date assigned)` : "Not placed on a day yet");
    if (stop.draft) parts.push("Draft stop");
    return parts.filter(Boolean).join("\n");
  };

  const emit = (stop: ExportStop, dayLabel: string, date: string | null): void => {
    const uid = stopUid(stop, trip, dayLabel);
    const summary = stop.kind === "hole" ? `Open: ${stop.name}` : stopTitle(stop);
    const timed = date && stop.timeWindow && trip.timezone ? zonedToUtcBasic(date, stop.timeWindow, trip.timezone) : null;
    lines.push(date ? "BEGIN:VEVENT" : "BEGIN:VJOURNAL");
    lines.push(`UID:${uid}`, `DTSTAMP:${stamp}`, "SEQUENCE:0", `SUMMARY:${escapeIcs(summary)}`);
    if (timed) {
      lines.push(`DTSTART:${timed}`);
      if (stop.durationMinutes) {
        const end = new Date(Date.parse(`${timed.slice(0, 4)}-${timed.slice(4, 6)}-${timed.slice(6, 8)}T${timed.slice(9, 11)}:${timed.slice(11, 13)}:${timed.slice(13, 15)}Z`) + stop.durationMinutes * 60_000);
        lines.push(`DTEND:${end.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`);
      }
    } else if (date) {
      lines.push(`DTSTART;VALUE=DATE:${basicDate(date)}`);
    }
    if (stop.location) lines.push(`LOCATION:${escapeIcs(stop.location)}`);
    if (stop.sourceUrl) lines.push(`URL:${escapeIcs(stop.sourceUrl)}`);
    const body = description(stop, date ? dayLabel : "");
    if (body) lines.push(`DESCRIPTION:${escapeIcs(body)}`);
    lines.push(date ? "END:VEVENT" : "END:VJOURNAL");
  };

  for (const day of trip.days) for (const stop of day.stops) emit(stop, day.label, day.date);
  for (const stop of trip.unscheduled) emit(stop, "", null);

  lines.push("END:VCALENDAR");
  return `${lines.flatMap(foldIcs).join("\r\n")}\r\n`;
}

/** Deterministic, filesystem-safe download name from the trip title. */
export function exportFileName(title: string, extension: "txt" | "html" | "ics"): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "trip"}.${extension}`;
}
