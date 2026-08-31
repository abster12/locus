import { useEffect, useRef, useState } from "react";
import { api, type TripSetupBody } from "./api.ts";
import { attachTripsWebmcp, type TripsWebmcpHost } from "./trips-webmcp.ts";
import { TripSetupPage, TripsIndex } from "./trips-index.tsx";
import { TripDocumentPage } from "./trips-document.tsx";

// Trips setup is user-authored only: nothing on this page calls an agent and
// every value below is stored exactly as entered (bounded by the Trips module).
export function TripsPage({
  mode,
  tripId,
  filter = "active",
  documentView = "",
}: {
  mode: "index" | "setup" | "document";
  tripId?: string;
  filter?: "active" | "archived";
  documentView?: string;
}) {
  const visibleTripId = mode === "document" ? tripId ?? null : null;
  const visibleRef = useRef(visibleTripId);
  visibleRef.current = visibleTripId;

  // Armed review is trip-bound: a late arm for a previous document must not
  // expose the tool on a different Trip. Opening a trip never sets this.
  const [armedTripId, setArmedTripId] = useState<string | null>(null);
  useEffect(() => {
    setArmedTripId(null);
  }, [mode, tripId]);
  const reviewRequested = armedTripId !== null && armedTripId === visibleTripId;

  // Trips WebMCP lives and dies with the private Trips routes: registered
  // while any Trips page is visible, re-registered when the document changes,
  // and removed when the user leaves Trips. The host calls the same HTTP API
  // the page itself uses, so session and CSRF handling stay identical.
  useEffect(() => {
    const host: TripsWebmcpHost = {
      surface: () => (mode === "document" ? "document" : mode === "setup" ? "setup" : "index"),
      getVisibleTripId: () => visibleRef.current,
      reviewRequested: () => reviewRequested,
      consumeReviewIntent: () => setArmedTripId(null),
      listTrips: () => api.trips(),
      getTrip: async (id) => (await api.trip(id)).trip,
      searchSources: (q) => api.tripSources(q),
      createTrip: (setup) => api.createTrip(setup as unknown as TripSetupBody & { clientMutationId: string }),
      applyChanges: async (id, input) => {
        const result = await api.applyTripChangesAsAgent(id, input);
        // Agent writes must move the visible artifact immediately, exactly
        // like a human Day Planner edit does.
        window.dispatchEvent(new CustomEvent("locus:trip-updated", { detail: result.trip }));
        return result;
      },
      recordReview: async (id, input) => {
        const result = await api.recordTripReviewAsAgent(id, input);
        window.dispatchEvent(new CustomEvent("locus:trip-updated", { detail: result.trip }));
        return result;
      },
      // Presentation is transient: the drawer on the visible document page
      // listens for this event; nothing is written until the human chooses.
      present: (panel) => window.dispatchEvent(new CustomEvent("locus:trip-recommendations", { detail: panel })),
      previewShare: async (id) => {
        const result = await api.sharePreview(id);
        return { snapshot: result.snapshot };
      },
    };
    return attachTripsWebmcp(host);
  }, [mode, tripId, reviewRequested]);

  if (mode === "setup") return <TripSetupPage />;
  if (mode === "document")
    return (
      <TripDocumentPage
        key={tripId}
        tripId={tripId ?? ""}
        view={documentView}
        reviewRequested={reviewRequested}
        onRequestReview={(id) => {
          if (id === visibleRef.current) setArmedTripId(id);
        }}
      />
    );
  return <TripsIndex filter={filter} />;
}
