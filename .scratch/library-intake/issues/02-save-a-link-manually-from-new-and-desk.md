# 02: Save a link manually from New and Desk

**What to build:** Let a person deliberately save one link into their Library without an agent. Provide a visible global `New → Save a link` action leading to a keyboard-accessible form where URL is the only required source field. Saving creates an ordinary Inbox Item labelled as added by the user and updates the visible Library immediately. Desk lists those Items through a You source filter. Do not add a second Save a link control on Desk.

**Blocked by:** 01: Extract source-neutral Item intake persistence.

**Status:** done

- [x] The global New action exposes the manual intake flow; it is not hidden exclusively in a hamburger menu, does not add a second Save a link control on Desk, and does not turn the homepage into a feature dashboard.
- [x] The form requires one HTTP(S) URL and optionally accepts user-entered title, source text, author, publication date, and up to eight safe remote media references within the spec's bounds. An omitted publication date on a user save defaults to today.
- [x] Opening the form performs no URL fetch, redirect lookup, page extraction, inference, background classification, or mutation.
- [x] The server derives the authenticated Library and user actor, enforces hosted ownership or local session/CSRF protections as appropriate, and rejects cross-Library or impersonation attempts.
- [x] Invalid schemes, credential-bearing URLs, malformed timestamps, unsafe media, control/bidirectional display characters, excessive content, and unsupported fields produce stable validation feedback without persisting anything.
- [x] A successful save creates an ordinary Inbox Item with `Added by you` provenance and activity, then makes it visible through the existing Library refresh/event behavior without a full-page reload.
- [x] Desk source filters include You, listing Items whose intake actor is the user, next to All, X, Instagram, YouTube, and Reddit.
- [x] A failed save leaves every entered value available for correction and never persists an abandoned draft.
- [x] The form, errors, and completion state are operable by keyboard and expose meaningful screen-reader labels; reduced-motion preferences are respected.
- [x] Automated regression tests cover the module/HTTP success path, validation and authorization failures, CSRF behavior, draft preservation, immediate visible refresh, the You filter, accessibility basics, and the guarantee that opening the form performs no work.
- [x] Relevant existing tests, typecheck, and production build remain green.

## Comments

Wired existing `+ New → Save a link` to `#/save`. `POST /api/intake` calls `commitIntakeItem` with session Library and actor `user`. User saves default omitted publication date to today. Desk filter `source=you` lists them. No Desk Save a link chip.

Follow-up: New is the only save entry; You filter; default today. Evidence: `tests/intake-module.test.ts`, `tests/intake-http.test.ts`, `tests/intake-browser.test.ts`.
