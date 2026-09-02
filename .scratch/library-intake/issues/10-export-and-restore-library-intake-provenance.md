# 10: Export and restore Library Intake provenance

**What to build:** Put Intake's per-Item origin and tag explanations into the existing Library backup. One file, same export and import as everything else. Restore copies Items as they already are; it does not replay saves.

**Blocked by:** 07: Review, edit, and selectively save exploratory drafts; 09: Create exact classified batches through direct MCP.

**Status:** done

- [x] The existing Library export includes Intake-created Items, their tag and Collection memberships, `Added by you` / `Added by agent`, agent-observed fields, and active tag explanations.
- [x] Capability secrets, revocation material, page drafts, abandoned selections, and Intake batch retry records (client mutation ids, payload hashes, receipts) are not exported.
- [x] Import validates the archive and commits as one unit, or writes nothing. It does not fetch URLs, rerun agent inference, or recreate capabilities.
- [x] After wipe and restore, Desk still shows `Added by you` / `Added by agent`, memberships keep their original actor, and tag explanations are still there.
- [x] Restored Items behave as ordinary Library Items in Desk, search, tags, Collections, Item detail, and Reading / Atlas / Food projection from durable state. Import does not create Recipe Documents, Places, or Reading Documents itself.
- [x] Capture finish/removal still ignores Intake-created Items after restore. Reused producer-owned Items keep their producer records.
- [x] Automated tests cover that round trip, exclusion of secrets / drafts / retry records, invalid archive rollback, and Capture isolation after restore.
- [x] Relevant existing tests, typecheck, and production build remain green.

## Comments

One Library backup. Intake rides along as Item state (who added it, observed fields, tag explanations). Restore is a copy into an empty Library, not an Intake save, so batch retry ids are live-only and stay out of the archive.

`exportIntakeRecords` / `importIntakeRecords` add `itemIntake` records to the existing archive. `intake_batches` is excluded. Evidence: `tests/intake-archive.test.ts`. `npx tsc --noEmit`, `npm test` (565 pass), `npm run build` green.
