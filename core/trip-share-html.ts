// Public Trip Share page renderer. Pure: no I/O, no node built-ins. The
// allowlist is the ShareSnapshot shape itself — everything a public viewer may
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
