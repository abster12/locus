/** Narrow Trips seam: the operations HTTP and other consumers use, and only
 * those. Internal modules (repository, lifecycle, receipts, changes, search,
 * advisories, review, policy) stay behind this file; tests may import
 * internals directly. */
export { applyTripChanges, getTripHistory, redoTripChanges, undoTripChanges } from "./changes.ts";
export { archiveTrip, createTrip, deleteTrip, duplicateTrip, renameTrip, restoreTrip, updateTripSetup } from "./lifecycle.ts";
export { getTrip, listTrips } from "./repository.ts";
export { requireClientMutationId } from "./policy.ts";
export { TripConflict } from "./receipts.ts";
export { armReviewIntent, ReviewIntentError, recordAgentReview } from "./review.ts";
export { searchTripSources } from "./search.ts";
export { dismissTripAdvisory, removeTripInference } from "./advisories.ts";
export {
  findSharedSnapshot,
  getShareState,
  previewShareSnapshot,
  publishShareSnapshot,
  renderShareHtml,
  revokeShareSnapshot,
} from "./share.ts";
