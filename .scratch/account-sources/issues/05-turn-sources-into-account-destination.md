# 05: Turn Sources into the Account destination

**What to build:** Turn the existing Sources destination into the place where a person understands and manages their Locus account. The local edition identifies itself honestly, Capture setup remains prominent, preferences are grouped separately, and infrequent data-management actions use progressive disclosure. The structure is ready for Google and GitHub identity to replace the local account summary later without another redesign.

**Blocked by:** 02: Create one coherent Capture setup; 03: Separate imported data into Import history

**Status:** resolved

- [x] The primary navigation label and page heading say Account. The destination route is `#/account`.
- [x] The local edition shows a Local account summary and does not invent an avatar, email address, or sign-in state.
- [x] The page is organized under Account, Capture setup, Preferences, and Data and privacy headings in that reading order.
- [x] Capture-on-open and local writing-tool availability appear under Preferences rather than inside Source connection entries.
- [x] Export, restore, source-import, and Delete Library controls appear under Data and privacy, with import forms collapsed until requested.
- [x] Delete Library is separated from routine actions and requires confirmation that explicitly names the consequence.
- [x] All controls are keyboard reachable and have visible focus treatment.
- [x] At 320 CSS pixels, content wraps without horizontal scrolling, clipped status text, or inaccessible actions.
- [x] Navigation, responsive layout, progressive disclosure, and keyboard behavior have regression coverage.

## Answer

Nav, heading, and route are Account (`#/account`). Local summary is static copy only. Import history and collapsed import forms sit under Data and privacy. Tests: `tests/sources-browser.test.ts`.

## Comments

Old `#/sources` links are not kept. Import history is under Data and privacy, not its own heading.
