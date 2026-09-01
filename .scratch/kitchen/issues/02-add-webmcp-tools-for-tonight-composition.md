# 02: Add WebMCP tools for Tonight composition

**What to build:** Let a user explicitly ask their browser agent to compose the existing Tonight list from saved Recipe Box options. Register bounded WebMCP tools on the private Kitchen index page for reading Tonight, searching eligible Food Items, and atomically adding, removing, or reordering Tonight entries. The visible Tonight section remains the only composition surface; do not introduce a Chopping Board, separate Kitchen planning workspace, outside restaurant planner, nutrition estimator, or second copy of Recipe Documents.

**Blocked by:** None (can start immediately; the Reading WebMCP live-interoperability prerequisite is already resolved).

**Status:** resolved

- [x] `get_tonight` returns the current ordered Tonight entries, a revision or equivalent concurrency token, bounded Kitchen availability/Recipe Document summaries, and honest missing-Item entries for the authenticated Library.
- [x] `search_food_items` returns bounded summaries only from the existing Recipe Box/Food predicate and supports the same relevant filters as the human Kitchen page. It cannot search arbitrary Items, outside restaurants, or raw database fields.
- [x] `apply_tonight_changes` accepts an expected Tonight revision, client mutation id, optional originating user instruction, and bounded typed add/remove/reorder operations over eligible saved Item references.
- [x] One call commits atomically and updates the visible Tonight list immediately. Stale revisions, duplicate Item additions, invalid orderings, ineligible Items, over-capacity results, or one invalid operation reject the entire change.
- [x] Retry with the same client mutation id is idempotent and cannot duplicate dishes or be reused for a different payload.
- [x] Agent identity is derived by the trusted WebMCP adapter. The tool cannot alter tags, Collections, Item status, captions, Recipe Documents, evidence, review state, or source revisions.
- [x] Missing Items already referenced by Tonight remain visible and removable; the agent cannot silently replace or discard them.
- [x] The tool descriptions require explicit user intent. Opening Kitchen, changing filters, or restoring Tonight never invokes an agent or changes the list.
- [x] Tools register only while the authorized Kitchen index/Tonight surface is visible, unregister on navigation, and do not remain active on a Recipe Document detail route unless separately owned by that route.
- [x] Nutrition or macro claims are outside this ticket. No macro values are invented from captions or Recipe Documents without a separately approved nutrition-data design.
- [x] Kitchen module tests cover atomic composition, eligibility, capacity, ordering, missing Items, stale concurrency, idempotency, Library isolation, and non-interference with Recipe Documents. WebMCP adapter and real-browser tests cover schemas, bounds, explicit invocation, visible updates, route lifecycle, forbidden fields, and no inference on page open. Relevant existing tests, typecheck, and build remain green.

## Answer

Shipped `get_tonight` + `search_food_items` + `apply_tonight_changes` on `#/kitchen` via `app/src/kitchen-tonight-webmcp.ts`. `applyTonightChanges` is one transaction with revision + clientMutationId receipts. Tools unregister on the Recipe Document route.
