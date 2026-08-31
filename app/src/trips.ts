/** Client Trips facade. UI and WebMCP import operations from here instead of
 * projection/export internals. parseTimeWindow and other helpers stay hidden. */

export { projectTripOverview, projectTripSchedule, validateTripDocument } from "../../server/trips/projections.ts";
export type { TripOverview, TripSchedule } from "../../server/trips/projections.ts";

export {
  exportFileName,
  exportTripHtml,
  exportTripIcs,
  exportTripText,
  projectTripForExport,
} from "../../server/trips/export.ts";
export type { ExportTrip } from "../../server/trips/export.ts";
