import type { Db } from "../../db/open.ts";
import type { TripDocument, TripStop } from "./module.ts";

export type { TripDocument, TripStop };

// Pure view-model projections over one Trip Document. Overview and Schedule
// own no data of their own: every field below is derived from the same saved
// days and stops the Day Planner edits. Wall-clock times come only from the
// user's free-text time windows — nothing here invents durations or clock
// times for untimed stops.

export type OverviewAnchor = { time: string | null; title: string };

export type OverviewDay = {
  id: string;
  label: string;
  theme: string | null;
  date: string | null;
  isEmpty: boolean;
  stopCount: number;
  holeCount: number;
  timedCount: number;
  timeRange: { start: string; end: string } | null;
  anchors: OverviewAnchor[];
  conflicts: string[];
};

export type TripOverview = {
  stopCount: number;
  unscheduledCount: number;
  emptyDayCount: number;
  conflictCount: number;
  holeCount: number;
  days: OverviewDay[];
};

export type ScheduleStop = { id: string; title: string; timeWindow: string | null };

export type ScheduleDay = {
  id: string;
  label: string;
  date: string | null;
  slots: { hour: number; label: string; stops: ScheduleStop[] }[];
  untimed: ScheduleStop[];
};

export type TripSchedule = {
  timezone: string | null;
  rows: { hour: number; label: string }[];
  days: ScheduleDay[];
  unscheduled: ScheduleStop[];
  timedCount: number;
};

export function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** A stop is timed only when the entire trimmed time-window string is one
 * complete, valid 24-hour range "HH:MM[-–]HH:MM" (hyphen or en-dash, optional
 * surrounding spaces). A bare start time, a missing or invalid endpoint, a
 * reversed or identical range, or any extra text stays untimed — never a
 * partial match, never swapped, never rolled onto another date. Shared by
 * projections and exports so both interpretations can never disagree. The
 * saved string can still be shown as-is. */
export function parseTimeWindow(text: string | null): { start: number; end: number | null } | null {
  if (!text) return null;
  const match = /^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const startHour = Number(match[1]!);
  const startMinute = Number(match[2]!);
  const endHour = Number(match[3]!);
  const endMinute = Number(match[4]!);
  if (startHour > 23 || startMinute > 59 || endHour > 23 || endMinute > 59) return null;
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  if (start >= end) return null;
  return { start, end };
}

export function stopDisplayTitle(stop: TripStop): string {
  if (stop.content.kind === "outside") return stop.content.title;
  if (stop.content.kind === "hole") return stop.content.request;
  if (stop.broken || !stop.resolved) return stop.content.kind === "item" ? "Missing saved item" : "Missing place";
  return stop.resolved.kind === "item" ? stop.resolved.title : stop.resolved.name;
}

/** A hole is a request, not a plan: projections count it separately and never
 * let it pose as a timed stop, an anchor, or a conflict. */
function planStops(stops: TripStop[]): TripStop[] {
  return stops.filter((stop) => stop.content.kind !== "hole");
}

function toScheduleStop(stop: TripStop): ScheduleStop {
  return { id: stop.id, title: stopDisplayTitle(stop), timeWindow: stop.timeWindow };
}

/** Two stops conflict only when both carry a parseable start AND end and the
 * ranges intersect. Start-only or unparseable windows never claim a conflict. */
function dayConflicts(stops: TripStop[]): string[] {
  const ranged = stops
    .map((stop) => ({ stop, window: parseTimeWindow(stop.timeWindow) }))
    .filter((entry): entry is { stop: TripStop; window: { start: number; end: number } } => entry.window?.end != null);
  const conflicts: string[] = [];
  for (let i = 0; i < ranged.length && conflicts.length < 3; i += 1) {
    for (let j = i + 1; j < ranged.length && conflicts.length < 3; j += 1) {
      const a = ranged[i]!;
      const b = ranged[j]!;
      if (a.window.start < b.window.end && b.window.start < a.window.end) {
        conflicts.push(`${stopDisplayTitle(a.stop)} overlaps ${stopDisplayTitle(b.stop)}`);
      }
    }
  }
  return conflicts;
}

export function projectTripOverview(trip: TripDocument): TripOverview {
  const days: OverviewDay[] = trip.days.map((day) => {
    const stops = planStops(day.stops);
    const holeCount = day.stops.length - stops.length;
    const windows = stops.map((stop) => ({ stop, window: parseTimeWindow(stop.timeWindow) }));
    const starts = windows.filter((entry) => entry.window).map((entry) => entry.window!.start);
    const ends = windows.filter((entry) => entry.window?.end != null).map((entry) => entry.window!.end!);
    const startByStop = new Map(windows.filter((entry) => entry.window).map((entry) => [entry.stop.id, entry.window!.start]));
    return {
      id: day.id,
      label: day.label,
      theme: day.theme,
      date: day.date,
      isEmpty: stops.length === 0 && holeCount === 0,
      stopCount: stops.length,
      holeCount,
      timedCount: windows.filter((entry) => entry.window).length,
      timeRange: starts.length > 0 ? { start: hhmm(Math.min(...starts)), end: hhmm(Math.max(...(ends.length > 0 ? ends : starts))) } : null,
      anchors: stops.slice(0, 3).map((stop) => ({
        time: startByStop.has(stop.id) ? hhmm(startByStop.get(stop.id)!) : null,
        title: stopDisplayTitle(stop),
      })),
      conflicts: dayConflicts(stops),
    };
  });
  return {
    stopCount: days.reduce((total, day) => total + day.stopCount, 0),
    unscheduledCount: trip.unscheduled.length,
    emptyDayCount: days.filter((day) => day.isEmpty).length,
    conflictCount: days.reduce((total, day) => total + day.conflicts.length, 0),
    holeCount: days.reduce((total, day) => total + day.holeCount, 0),
    days,
  };
}

export type TripIssue =
  | { kind: "overlap"; dayId: string; detail: string }
  | { kind: "unfilled_hole"; stopId: string; dayId: string | null; detail: string }
  | { kind: "duplicate_identity"; stopId: string; detail: string }
  | { kind: "ordering"; dayId: string | null; detail: string }
  | { kind: "broken_reference"; stopId: string; detail: string }
  | { kind: "reservation_conflict"; dayId: string; detail: string };

/** Deterministic validation over saved Trip Document data only: ranged-window
 * overlaps, unfilled holes, duplicate stop identities, and stop positions that
 * disagree with container order. No routes, clocks, loads, or inference — what
 * the user never saved cannot be validated here. */
export function validateTripDocument(trip: TripDocument): { valid: boolean; issues: TripIssue[] } {
  const issues: TripIssue[] = [];
  const overview = projectTripOverview(trip);
  for (const day of overview.days) {
    for (const conflict of day.conflicts) {
      issues.push({ kind: "overlap", dayId: day.id, detail: conflict.slice(0, 160) });
    }
  }
  const seen = new Map<string, number>();
  const scan = (stops: TripStop[], dayId: string | null) => {
    for (const stop of stops) {
      seen.set(stop.id, (seen.get(stop.id) ?? 0) + 1);
      if (stop.content.kind === "hole") {
        issues.push({ kind: "unfilled_hole", stopId: stop.id, dayId, detail: `unfilled hole: ${stop.content.request.slice(0, 120)}` });
      }
      if (stop.broken) {
        issues.push({ kind: "broken_reference", stopId: stop.id, detail: `${stopDisplayTitle(stop).slice(0, 80)} is a broken Library reference` });
      }
    }
    stops.forEach((stop, index) => {
      if (stop.position !== index) {
        issues.push({ kind: "ordering", dayId, detail: `${stopDisplayTitle(stop).slice(0, 80)} is shown at position ${index} but stored as ${stop.position}` });
      }
    });
  };
  for (const day of trip.days) {
    scan(day.stops, day.id);
    const reserved = new Map<string, string[]>();
    for (const stop of day.stops) {
      const key = stop.reservation?.trim();
      if (!key) continue;
      const titles = reserved.get(key) ?? [];
      titles.push(stopDisplayTitle(stop));
      reserved.set(key, titles);
    }
    for (const [key, titles] of reserved) {
      if (titles.length > 1) {
        issues.push({ kind: "reservation_conflict", dayId: day.id, detail: `${titles.slice(0, 3).join(" and ")} share reservation ${key.slice(0, 80)}` });
      }
    }
  }
  scan(trip.unscheduled, null);
  for (const [stopId, count] of seen) {
    if (count > 1) issues.push({ kind: "duplicate_identity", stopId, detail: `stop ${stopId} appears ${count} times in the document` });
  }
  return { valid: issues.length === 0, issues };
}

export function projectTripSchedule(trip: TripDocument): TripSchedule {
  const days: ScheduleDay[] = trip.days.map((day) => {
    const timed: { stop: ScheduleStop; start: number }[] = [];
    const untimed: ScheduleStop[] = [];
    for (const stop of planStops(day.stops)) {
      const window = parseTimeWindow(stop.timeWindow);
      if (window) timed.push({ stop: toScheduleStop(stop), start: window.start });
      else untimed.push(toScheduleStop(stop));
    }
    const hours = [...new Set(timed.map((entry) => Math.floor(entry.start / 60)))].sort((a, b) => a - b);
    return {
      id: day.id,
      label: day.label,
      date: day.date,
      slots: hours.map((hour) => ({
        hour,
        label: `${hhmm(hour * 60)}`,
        stops: timed.filter((entry) => Math.floor(entry.start / 60) === hour).map((entry) => entry.stop),
      })),
      untimed,
    };
  });
  const hours = [...new Set(days.flatMap((day) => day.slots.map((slot) => slot.hour)))].sort((a, b) => a - b);
  return {
    timezone: trip.timezone,
    rows: hours.map((hour) => ({ hour, label: `${hhmm(hour * 60)}` })),
    days,
    unscheduled: trip.unscheduled.filter((stop) => stop.content.kind !== "hole").map(toScheduleStop),
    timedCount: days.reduce((total, day) => total + day.slots.reduce((count, slot) => count + slot.stops.length, 0), 0),
  };
}
