import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PAGE_AGENT, pageToolsRequested } from "../app/src/page-agent-banner.tsx";

test("pageToolsRequested is off unless search is tools=1", () => {
  assert.equal(pageToolsRequested(""), false);
  assert.equal(pageToolsRequested("q=kitchen"), false);
  assert.equal(pageToolsRequested("tools=0"), false);
  assert.equal(pageToolsRequested("tools=1"), true);
  assert.equal(pageToolsRequested("view=overview&tools=1"), true);
});

test("capability copy names asks, not tool identifiers", () => {
  const identifiers = Object.values(PAGE_AGENT).flatMap((entry) => [...entry.tools]);
  assert.deepEqual(
    [...new Set(identifiers)],
    [
      "get_library_intake_context",
      "search_library",
      "present_item_drafts",
      "create_items",
      "get_tonight",
      "search_food_items",
      "apply_tonight_changes",
      "get_recipe_source",
      "propose_recipe",
      "get_reading_context",
      "search_reading",
      "get_reading",
      "present_reading_recommendations",
      "list_trips",
      "search_trip_sources",
      "create_trip",
      "get_trip",
      "apply_trip_changes",
      "build_trip_draft",
      "present_trip_recommendations",
      "validate_trip",
      "get_trip_share_preview",
      "record_trip_review",
    ],
  );
  for (const [surface, entry] of Object.entries(PAGE_AGENT)) {
    for (const name of identifiers) {
      assert.equal(entry.title.includes(name), false, `${surface} title must not include ${name}`);
      assert.equal(entry.copy.includes(name), false, `${surface} copy must not include ${name}`);
    }
  }
  assert.match(PAGE_AGENT.kitchen.copy, /put something on Tonight/);
  assert.match(PAGE_AGENT.trip.copy, /three options on a hole/);
  assert.match(PAGE_AGENT.desk.copy, /Nothing becomes an Item until you confirm/);
  assert.match(PAGE_AGENT.kitchenItem.copy, /cannot mark the recipe Reviewed/);
});

test("Atlas and Account do not mount a capabilities banner", () => {
  const atlas = readFileSync(new URL("../app/src/AtlasPage.tsx", import.meta.url), "utf8");
  const account = readFileSync(new URL("../app/src/SourcesPage.tsx", import.meta.url), "utf8");
  const hostedAccount = readFileSync(new URL("../app/src/hosted-account.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(atlas, /PageAgentBanner/);
  assert.doesNotMatch(account, /PageAgentBanner/);
  assert.doesNotMatch(hostedAccount, /PageAgentBanner/);
});
