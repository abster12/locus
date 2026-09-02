# 03: Preview, classify, and organize a manual Item

**What to build:** Extend manual link intake into a complete review-and-organize flow. Before saving, the user can preview the Item, choose existing Collections and tags, and explicitly create a new tag when the current vocabulary is insufficient. The Item and all requested organization must commit atomically while classification remains separate from workflow status.

**Blocked by:** 02: Save a link manually from New and Desk.

**Status:** done

- [x] The preview shows the exact sanitized source fields that will be saved, clearly marks missing optional details, and shows selected Collections and tags before commit.
- [x] Existing tags and Collections are scoped to the authenticated Library and use stable identifiers while displaying familiar names and relevant descriptions or semantic consequences.
- [x] Collection placement is presented as destination/organization, while tags are presented as classification; neither silently changes Item status, snooze state, notes, archive state, or Reading progress.
- [x] The user can explicitly create a new tag through the existing human-authorized tag path, including case-insensitive duplicate-name handling, and can then select it for the pending Item.
- [x] Item creation, new human-created tag when requested, Collection memberships, tag memberships, user actor attribution, activity, and downstream reconciliation have one atomic outcome.
- [x] Unknown, deleted, cross-Library, or otherwise invalid tag and Collection identifiers reject the save without a partial Item or membership.
- [x] A successful save is immediately visible in ordinary Desk filters, search, Collections, tag views, and Item detail behavior.
- [x] Food-semantic tag behavior is observed through Kitchen's existing authoritative predicate; Intake does not create Recipe Documents or Tonight entries.
- [x] Automated regression tests cover preview accuracy, existing and newly created organization, case-insensitive tag reuse, atomic rollback, cross-Library rejection, user membership attribution, ordinary Library visibility, and Food projection without copied Kitchen state.
- [x] Relevant existing tests, typecheck, and production build remain green.

## Comments

Save dialog now picks existing Collections and tags, creates a tag through `ensureTag` (same case-insensitive path as Stage), and shows a preview of fields, missing optionals, and selected organization. `commitIntakeItem` accepts `tagIds`, `collectionIds`, and `newTags` in one transaction. `POST /api/intake/preview` sanitizes without writing. Invalid targets roll back. Food tags appear through Kitchen's Recipe Box predicate.

Follow-up: preview; destination vs classification; atomic new-tag. Evidence: `tests/intake-module.test.ts`, `tests/intake-http.test.ts`, `tests/intake-browser.test.ts`.
