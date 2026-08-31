import type { TripStop } from "./api.ts";

export function formatDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return date.toLocaleDateString(undefined, { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}

export function weekdayDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short", day: "numeric" });
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
