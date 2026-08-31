/** Compatibility shim: existing consumers and tests import the Trips domain
 * through here. The stable seam is facade.ts; internals live in repository,
 * lifecycle, receipts, changes, search, advisories, review, and policy. */
export {
  MAX_CHANGES_OPS,
  MAX_TRIP_DAYS,
  MAX_TRIP_INFERENCES,
  MAX_TRIP_LIST_ITEMS,
  MAX_TRIP_LIST_TEXT,
  MAX_TRIP_NOTES,
  MAX_TRIP_TEXT,
  parseTripOperations,
  requireClientMutationId,
  validateMutationFields,
  validateTripInferences,
  validateTripReview,
  validateTripSetup,
  validateTripTitle,
} from "./policy.ts";
export type {
  TripAdvisoryCategory,
  TripAdvisorySeverity,
  TripChangesInput,
  TripContext,
  TripInferenceInput,
  TripReviewInput,
  TripSetupInput,
  TripStopContent,
  TripStopOp,
  TripStopProvenance,
  TripStopSnapshot,
} from "./policy.ts";
export { TripConflict, withTripMutation } from "./receipts.ts";
export { archiveTrip, createTrip, deleteTrip, duplicateTrip, renameTrip, restoreTrip, updateTripSetup } from "./lifecycle.ts";
export {
  getTrip,
  listDismissedAdvisories,
  listTrips,
  type TripAdvisoryView,
  type TripDay,
  type TripDocument,
  type TripInference,
  type TripStop,
  type TripStopResolved,
  type TripSummary,
} from "./repository.ts";
export {
  applyTripChanges,
  getTripHistory,
  redoTripChanges,
  undoTripChanges,
  type TripChangesetView,
  type TripMutationResult,
} from "./changes.ts";
export { MAX_TRIP_SOURCE_RESULTS, searchTripSources, type TripSourceItem, type TripSourcePlace, type TripSources } from "./search.ts";
export { applyTripReview, recordTripReview } from "./review.ts";
export { dismissTripAdvisory, removeTripInference } from "./advisories.ts";
