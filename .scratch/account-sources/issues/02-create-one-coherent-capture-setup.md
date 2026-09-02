# 02: Create one coherent Capture setup

**What to build:** Give people one understandable place to set up capture. Browser extension pairing appears once for the device, while each Source entry shows its own connection status, latest live capture result, and one contextual primary action. Routine language consistently describes bringing saves into Locus as capture.

**Blocked by:** 01: Present one connection per Source

**Status:** resolved

- [x] Browser extension status and pairing controls appear once above the Source entries, not once per provider.
- [x] Pairing output has a persistent label, a copy action, and visible copy confirmation.
- [x] Source entries support the user-visible states Not connected, Connecting, Connected, Capturing, and Needs attention.
- [x] Each Source entry exposes the appropriate primary action: Connect, Continue setup, Capture now, View progress, or Resolve issue.
- [x] Stop capture, Cancel setup, and Disconnect are available only when relevant and do not compete visually with the routine primary action.
- [x] Statuses, progress, and failures remain understandable without color and are announced appropriately to assistive technology.
- [x] Action failures stay beside the affected Source and explain what the person can do next.
- [x] Tests cover extension pairing once, each provider state, and the contextual action shown for that state.

## Answer

Browser extension health is `{ state, lastSeenAt }` from in-memory heartbeats: never seen → `not_paired`; last beat within 45s (`EXTENSION_STALE_MS`) → `paired`; older beat → `needs_attention`. Pairing tokens do not change that state. Last successful live capture is `lastSuccessfulCapture`: the newest terminal, error-free live run with status `ok` or `complete`. Successful partial coverage counts; failed, cancelled, interrupted, and imported runs do not. Coverage stays on the summary so clients can tell partial from complete. The newest run, including failures, is `latestAttempt`. Tests: `tests/sources-overview.test.ts`, `tests/sources-browser.test.ts`, `tests/jobs.test.ts`.
