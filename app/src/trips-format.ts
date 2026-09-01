import type { TripStop } from "./api.ts";

export function formatDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return date.toLocaleDateString(undefined, { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}

export function weekdayDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short", day: "numeric" });
}

export function dayStamp(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
}

/** One display title per stop: Library references resolve through the server
 * projection and stay visible as broken text when the entity is gone. */
export function stopDisplay(stop: TripStop): { title: string; kindLabel: string | null } {
  const content = stop.content;
  if (content.kind === "outside") return { title: content.title, kindLabel: "Outside" };
  if (content.kind === "hole") return { title: content.request, kindLabel: "Hole" };
  if (stop.broken || !stop.resolved) {
    return { title: content.kind === "item" ? "Missing saved item" : "Missing place", kindLabel: "Missing" };
  }
  return stop.resolved.kind === "item" ? { title: stop.resolved.title, kindLabel: "Saved item" } : { title: stop.resolved.name, kindLabel: "Place" };
}

export function stopOpenLabel(stop: TripStop): string {
  const { title } = stopDisplay(stop);
  return stop.state === "draft" ? `Open details for Draft ${title}` : `Open details for ${title}`;
}

/** Compact card chips: Draft text, kind, duration. Time sits in its own column. */
export function stopCardMeta(stop: TripStop): string[] {
  const { kindLabel } = stopDisplay(stop);
  const meta: string[] = [];
  if (stop.state === "draft") meta.push("Draft");
  if (kindLabel) meta.push(kindLabel);
  if (stop.durationMinutes) meta.push(`${stop.durationMinutes} min`);
  return meta;
}

export function stopSourceLink(stop: TripStop): { href: string; label: string } | null {
  if (stop.content.kind === "item" && stop.resolved?.kind === "item" && stop.resolved.url) {
    return { href: stop.resolved.url, label: "Open original ↗" };
  }
  if (stop.content.kind === "outside" && stop.content.url) {
    return { href: stop.content.url, label: "Open link ↗" };
  }
  return null;
}

export type StopFact = { label: string; text: string; href?: string };

/** Bounded fields for the details dialog. Omits empty values; broken Library
 * references stay visible as text instead of disappearing. */
export function stopFacts(stop: TripStop): StopFact[] {
  const facts: StopFact[] = [];
  const missing = stop.content.kind === "item" || stop.content.kind === "place" ? stop.broken || !stop.resolved : false;
  if (missing) {
    facts.push({
      label: "Reference",
      text: stop.content.kind === "item" ? "The saved item is missing from the Library." : "The place is missing from the Library.",
    });
  }
  const time = [stop.timeWindow, stop.durationMinutes ? `${stop.durationMinutes} min` : null].filter(Boolean).join(" · ");
  if (time) facts.push({ label: "Time", text: time });
  if (stop.content.kind === "item" && stop.resolved?.kind === "item") {
    if (stop.resolved.source) facts.push({ label: "Source", text: stop.resolved.source });
    facts.push(stop.resolved.url ? { label: "Original", text: "Open original ↗", href: stop.resolved.url } : { label: "Original", text: "link unavailable" });
  }
  if (stop.content.kind === "place" && stop.resolved?.kind === "place") {
    facts.push({ label: "Kind", text: stop.resolved.kindLabel });
    if (stop.resolved.location) facts.push({ label: "Location", text: stop.resolved.location });
  }
  if (stop.content.kind === "outside") {
    if (stop.content.notes) facts.push({ label: "Notes", text: stop.content.notes });
    if (stop.content.url) facts.push({ label: "Source link", text: "Open link ↗", href: stop.content.url });
  }
  if (stop.publicNotes) facts.push({ label: "Public notes", text: stop.publicNotes });
  if (stop.privateNotes) facts.push({ label: "Private notes", text: stop.privateNotes });
  if (stop.reservation) facts.push({ label: "Reservation", text: stop.reservation });
  if (stop.storedFacts.length > 0) facts.push({ label: "Stored facts", text: stop.storedFacts.join(" · ") });
  if (stop.alternatives.length > 0) facts.push({ label: "Alternatives", text: stop.alternatives.join(" · ") });
  const who = stop.provenance.actor === "user" ? "you" : stop.provenance.actor;
  facts.push({ label: "Added", text: `by ${who} · ${new Date(stop.createdAt).toLocaleDateString()}` });
  return facts;
}
