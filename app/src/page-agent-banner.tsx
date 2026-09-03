import { useState } from "react";

// Reading-shaped page banner: what a person can ask, not function names.
// Tool identifiers stay behind “Show page tools” / ?tools=1.

export type PageAgentSurface = "desk" | "kitchen" | "kitchenItem" | "reading" | "trips" | "trip";

export const PAGE_AGENT = {
  desk: {
    title: "Your browser agent can help with this desk",
    copy: "Ask it to search what you already saved, or to file something new. Nothing becomes an Item until you confirm.",
    tools: ["get_library_intake_context", "search_library", "present_item_drafts", "create_items"],
  },
  kitchen: {
    title: "Your browser agent can help with tonight",
    copy: "Ask it to search the Recipe Box or put something on Tonight. Tonight stays your list.",
    tools: ["get_tonight", "search_food_items", "apply_tonight_changes"],
  },
  kitchenItem: {
    title: "Your browser agent can help with this recipe",
    copy: "Ask it to read the caption and propose a draft. It cannot mark the recipe Reviewed.",
    tools: ["get_recipe_source", "propose_recipe"],
  },
  reading: {
    title: "Your browser agent can help with your reading",
    copy: "Ask it to search your saved articles, compare them, or recommend what to read next—it can bring the results back here. When asked, your agent may receive saved Reading metadata and stored article text.",
    tools: ["get_reading_context", "search_reading", "get_reading", "present_reading_recommendations"],
  },
  trips: {
    title: "Your browser agent can help plan a trip",
    copy: "Ask it to list your trips or start one. Opening this page does not start an agent.",
    tools: ["list_trips", "search_trip_sources", "create_trip"],
  },
  trip: {
    title: "Your browser agent can help with this trip",
    copy: "Ask it for three options on a hole, or to make an exact change you named. It cannot pick for you.",
    tools: [
      "get_trip",
      "search_trip_sources",
      "apply_trip_changes",
      "build_trip_draft",
      "present_trip_recommendations",
      "validate_trip",
      "get_trip_share_preview",
      "record_trip_review",
    ],
  },
} as const satisfies Record<PageAgentSurface, { title: string; copy: string; tools: readonly string[] }>;

export function pageToolsRequested(search: string = typeof location === "undefined" ? "" : location.search): boolean {
  return new URLSearchParams(search).get("tools") === "1";
}

export function syncPageToolsQuery(open: boolean): void {
  if (typeof location === "undefined" || typeof history === "undefined") return;
  const url = new URL(location.href);
  if (open) url.searchParams.set("tools", "1");
  else url.searchParams.delete("tools");
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${location.pathname}${location.search}${location.hash}`;
  if (next !== current) history.replaceState(null, "", next);
}

export function PageAgentBanner({ surface }: { surface: PageAgentSurface }) {
  const help = PAGE_AGENT[surface];
  const [toolsOpen, setToolsOpen] = useState(() => pageToolsRequested());
  return (
    <section className="reading-agent" data-agent-banner={surface} aria-label="Browser agent available">
      <span className="reading-agent-mark" aria-hidden="true">
        ✦
      </span>
      <div>
        <p className="reading-agent-title">{help.title}</p>
        <p className="reading-agent-copy">{help.copy}</p>
        <details
          className="reading-agent-tools"
          open={toolsOpen}
          onToggle={(event) => {
            const next = event.currentTarget.open;
            if (next === toolsOpen) return;
            setToolsOpen(next);
            syncPageToolsQuery(next);
          }}
        >
          <summary>Show page tools</summary>
          <ul>
            {help.tools.map((name) => (
              <li key={name}>
                <code>{name}</code>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </section>
  );
}
