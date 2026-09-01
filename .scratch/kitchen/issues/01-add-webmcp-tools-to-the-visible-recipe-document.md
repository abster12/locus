# 01: Add WebMCP tools to the visible Recipe Document

**What to build:** Make the existing full Recipe Document page the shared working artifact for a user and their chosen browser agent. While one private Recipe Document is visible, register bounded WebMCP tools that let the agent read the stored source material and propose a structured Draft through the existing Kitchen module. Do not create a separate Kitchen planning workspace, generic recipe modal, parallel recipe store, or agent-only editor. The real recipe score refreshes after a valid proposal, and only the human UI can mark it Reviewed.

**Blocked by:** None (can start immediately; the Reading WebMCP live-interoperability prerequisite is already resolved).

**Status:** resolved

- [x] `get_recipe_source` registers only while one authorized Recipe Document detail route is visible and is bound to that exact Item and Library.
- [x] The read result contains bounded Item identity/display fields, stored caption/source material, current source revision, availability, and existing Recipe Document summary needed for grounded work. It never fetches the publisher page, watches inaccessible media, returns credentials, or exposes unrelated Library content.
- [x] `propose_recipe` accepts the current source revision and one bounded structured proposal compatible with the existing Kitchen module's Recipe Document contract.
- [x] Caption-backed ingredients, quantities, timings, and steps require valid evidence references to exact stored caption spans. Unsupported source claims reject the complete write atomically.
- [x] Insufficient caption evidence remains visibly incomplete. The agent cannot silently cross from extraction into invention.
- [x] A suggested recipe path is allowed only after an explicit human consent state is present for the visible Item. Generated evidence is labelled AI-generated suggestion and is never attributed to the source creator.
- [x] Every accepted agent proposal is forced to Draft, records agent provenance, respects the expected source revision, and updates the visible recipe score immediately without changing Tonight placement.
- [x] The agent cannot mark a Recipe Document Reviewed, dismiss a Caption Changed warning, alter the Item caption/source, or bypass evidence validation.
- [x] Tools register through the proven target-browser WebMCP lifecycle, abort/unregister when the detail route or visible Item changes, and re-register once without duplicates when the same route returns.
- [x] Existing Edit Recipe, On Tonight, Watch Source, Open Original, source availability, source-revision warning, and recipe-score behavior remain intact and human-operable without WebMCP.
- [x] Kitchen module tests cover evidence validation, Draft enforcement, generated-consent boundaries, source-revision conflicts, atomic rejection, and preservation of Tonight. WebMCP adapter tests cover schemas, bounds, authorization, visible-Item binding, stable errors, and forbidden review. A real-browser test discovers and invokes both tools, verifies the recipe score refresh, navigates away, and confirms cleanup/re-registration. Relevant existing tests, typecheck, and build remain green.

## Answer

Shipped `get_recipe_source` + `propose_recipe` on authorized `#/kitchen/:id` via `app/src/kitchen-recipe-webmcp.ts`. Writes go through `putRecipeDocument(..., actor: "agent")` (always Draft; generated evidence needs on-page consent). Human UI unchanged without a WebMCP runtime.
