import type { TripChangeOp, TripStopContent } from "./api.ts";

export type FillPlacement = { holeId: string; beforeStopId?: string };

/** One add/fill op list for Library and placeholder. Fill is remove+add in one changeset. */
export function buildAddOrFillOps(input: {
  dayId: string | null;
  content: TripStopContent;
  fill?: FillPlacement;
  timing?: { timeWindow: string | null; durationMinutes: number | null };
}): TripChangeOp[] {
  const add: Extract<TripChangeOp, { type: "addStop" }> = {
    type: "addStop",
    dayId: input.dayId,
    content: input.content,
    ...(input.fill?.beforeStopId ? { beforeStopId: input.fill.beforeStopId } : {}),
    ...(input.timing ?? {}),
  };
  return input.fill ? [{ type: "removeStop", stopId: input.fill.holeId }, add] : [add];
}
