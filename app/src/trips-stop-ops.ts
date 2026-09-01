import type { TripChangeOp, TripStopContent } from "./api.ts";

export type FillPlacement = { holeId: string; beforeStopId?: string };
export type AddSource = "library" | "outside" | "hole";
export type OpenAdd = {
  dayId: string | null;
  source: AddSource | null;
  fill?: FillPlacement;
} | null;
export type StopAnchor = { beforeStopId: string } | { afterStopId: string };

/** One add/fill op list for Library and outside content. Fill is remove+add in one changeset. */
export function buildAddOrFillOps(input: {
  dayId: string | null;
  content: TripStopContent;
  fill?: FillPlacement;
  timing?: { timeWindow: string | null; durationMinutes: number | null };
  publicNotes?: string | null;
  privateNotes?: string | null;
  state?: "confirmed" | "draft";
}): TripChangeOp[] {
  const add: Extract<TripChangeOp, { type: "addStop" }> = {
    type: "addStop",
    dayId: input.dayId,
    content: input.content,
    ...(input.fill?.beforeStopId ? { beforeStopId: input.fill.beforeStopId } : {}),
    ...(input.timing ?? {}),
    ...(input.publicNotes?.trim() ? { publicNotes: input.publicNotes.trim() } : {}),
    ...(input.privateNotes?.trim() ? { privateNotes: input.privateNotes.trim() } : {}),
    ...(input.state ? { state: input.state } : {}),
  };
  return input.fill ? [{ type: "removeStop", stopId: input.fill.holeId }, add] : [add];
}

/** One moveStop op for drag, keyboard, and menu placement. Anchors are stop ids. */
export function moveStopOp(stopId: string, target: { dayId?: string | null; beforeStopId?: string; afterStopId?: string }): TripChangeOp {
  return { type: "moveStop", stopId, ...target };
}

export function isHomePlacement(list: { id: string }[], stopId: string, anchor: StopAnchor): boolean {
  const index = list.findIndex((stop) => stop.id === stopId);
  if (index < 0) return false;
  return "beforeStopId" in anchor ? list[index + 1]?.id === anchor.beforeStopId : list[index - 1]?.id === anchor.afterStopId;
}

/** Pointer/touch target: stop id + before/after half. Null means home, never an index. */
export function placementAt(list: { id: string }[], stopId: string, overId: string, half: "before" | "after"): StopAnchor | null {
  if (overId === stopId) return null;
  if (!list.some((stop) => stop.id === stopId) || !list.some((stop) => stop.id === overId)) return null;
  const anchor: StopAnchor = half === "before" ? { beforeStopId: overId } : { afterStopId: overId };
  return isHomePlacement(list, stopId, anchor) ? null : anchor;
}

function slotList(list: { id: string }[], stopId: string): StopAnchor[] {
  const others = list.filter((stop) => stop.id !== stopId);
  if (others.length === 0) return [];
  return [{ beforeStopId: others[0]!.id }, ...others.map((stop) => ({ afterStopId: stop.id }))];
}

function slotIndex(slots: StopAnchor[], anchor: StopAnchor | null, fallback: number): number {
  if (!anchor) return fallback;
  const index = slots.findIndex((slot) =>
    "beforeStopId" in slot && "beforeStopId" in anchor
      ? slot.beforeStopId === anchor.beforeStopId
      : "afterStopId" in slot && "afterStopId" in anchor && slot.afterStopId === anchor.afterStopId,
  );
  return index < 0 ? fallback : index;
}

/** Keyboard move before/after. Null current is the saved place; edges clamp. */
export function stepAnchor(list: { id: string }[], stopId: string, current: StopAnchor | null, direction: -1 | 1): StopAnchor | null {
  const slots = slotList(list, stopId);
  if (slots.length === 0) return null;
  const home = Math.max(0, list.findIndex((stop) => stop.id === stopId));
  const index = slotIndex(slots, current, home);
  const next = index + direction;
  if (next < 0 || next >= slots.length) return current ?? slots[home] ?? null;
  return slots[next]!;
}
