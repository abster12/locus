# 07: Review, edit, and selectively save exploratory drafts

**What to build:** Complete the exploratory WebMCP workflow by giving the human final control over what enters the Library. From the temporary draft sheet, the user can select any subset, change existing destinations and tags, explicitly confirm a proposed new tag, and save only the approved drafts. Source fields stay as presented. Agent rationale/evidence/uncertainty stay a notes block on the sheet.

**Blocked by:** 05: Present classified drafts through Library WebMCP; 06: Create exact requested Items through Library WebMCP.

**Status:** done

- [x] The user can select or reject each presented draft independently; saving a subset neither persists rejected drafts nor requires re-presenting the accepted ones.
- [x] Source fields (URL, title, source text, author, publication date, media) stay as presented. Before commit, the user can choose different existing tags and Collections. The sheet is the preview of what will be saved.
- [x] Agent rationale, evidence, and uncertainty remain visible as a notes block on the draft. They are not Item notes and are not written as Item notes.
- [x] A proposed new tag requires a distinct human Create through the human-authorized tag path. After creation, Intake refreshes its context and the Item save uses the new stable identifier. Confirming a tag then dismissing the sheet can leave the tag. Unconfirmed proposals are not created.
- [x] If the taxonomy changed since presentation, save fails with a stale-context explanation, preserves the user's current selections/edits, refreshes available targets, and performs no partial write.
- [x] Sheet Save is a page-only reviewed batch: selected drafts only, agent provenance, atomic created/reused outcomes. It does not call the `create_items` tool and does not reconstruct observedFields or classification evidence. Direct `create_items` stays strict.
- [x] Dismissal before Save remains non-durable for Items, memberships, evidence, activity, and batch history. Abandoned selections and edits do not enter the Library.
- [x] The complete review, tag/Collection editing, new-tag confirmation, stale-context recovery, and commit flow is accessible by keyboard and on mobile, with correct focus and screen-reader status announcements.
- [x] Automated regression tests cover arbitrary subset selection, tag/Collection edits, explicit new-tag confirmation and refreshed context, rejection/abandonment, stale-context preservation, atomic reviewed commit, duplicate reuse, accessibility, and a real-browser exploratory presentation-to-save flow.
- [x] Relevant existing tests, typecheck, and production build remain green.

## Comments

Sheet fields are the format. No second hidden create payload. Notes stay on the draft for reading. Human click authorizes the reviewed save; the agent tool path still needs evidence.

Sheet Save posts to `/api/intake/drafts/save` (`commitReviewedDrafts`, actor `agent`, no evidence reconstruction). New tags go through `POST /api/intake/tags` (`ensureTag`) then a refreshed context. `create_items` / `/api/intake/batch` stay strict. Evidence: `tests/intake-module.test.ts`, `tests/intake-http.test.ts`, `tests/intake-drafts-browser.test.ts`. `npx tsc --noEmit` and `npm run build` green.
