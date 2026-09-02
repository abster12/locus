# 05: Present classified drafts through Library WebMCP

**What to build:** Let a browser agent research with the user while the authenticated private Library is visible, without silently saving exploratory results. Register bounded Library Intake context, search, and draft-presentation WebMCP tools on the owning page. `present_item_drafts` renders temporary, inspectable proposals with the details and opinions needed for a later human decision; dismissal leaves the Library unchanged.

**Blocked by:** 03: Preview, classify, and organize a manual Item.

**Status:** done

- [x] `get_library_intake_context` returns only the authenticated Library's bounded existing tag and Collection vocabulary, stable identifiers, useful descriptions/colors, semantic tag consequences, and a context version—not unrelated Item bodies, notes, credentials, tokens, or session internals.
- [x] `search_library` provides a bounded way to check exact or relevant existing Items without exposing raw queries, arbitrary database access, or full Library export.
- [x] `present_item_drafts` accepts at most 20 validated drafts and renders a desktop sheet or mobile bottom sheet as non-durable page state.
- [x] Each draft shows URL, source-backed/agent-observed details, missing fields, proposed Collections, proposed existing tags, concise classification rationale, bounded evidence basis, uncertainty, and any proposed-new-tag state.
- [x] Agent-authored strings and remote content are treated as untrusted, sanitized for rendering, and never interpreted as Locus or tool instructions.
- [x] Proposed new tags are visually distinct and cannot be silently persisted by the presentation tool.
- [x] Dismissing or navigating away from the sheet writes no Item, tag, Collection, membership, evidence, activity, or durable draft record.
- [x] Tools register only on the authenticated private owning Library/intake surface, are absent from public Share Snapshots and unauthenticated pages, and unregister when the route, Library, document, or authentication lifecycle changes.
- [x] The sheet supports keyboard-only selection/navigation, focus containment and restoration, screen-reader labels for provenance/evidence/missing data, mobile interaction without hover or dragging, and reduced motion.
- [x] Automated regression tests cover bounded schemas/results, Library isolation, lifecycle registration and cleanup, sanitization and prompt-injection text, proposal rendering, no persistence on dismissal, accessibility, and a real-browser discovery/presentation/navigation round trip.
- [x] Relevant existing tests, typecheck, and production build remain green.

## Comments

WebMCP tools `get_library_intake_context`, `search_library`, and `present_item_drafts` register on Desk + `#/save` only. Context is versioned from tag/collection ids+names and includes tag colors. Search is exact normalized URL and/or title/URL `q` (cap 20, no bodies/notes). Presentation validates ≤20 drafts through `preparePresentedDrafts` (no writes); the sheet is inspect + dismiss. 07 owns subset/save.

Follow-up: versioned context; URL/title search only; present is page state. Evidence: `tests/intake-module.test.ts`, `tests/intake-http.test.ts`, `tests/intake-webmcp.test.ts`, `tests/intake-webmcp-browser.test.ts`.
