# 12: Export a Trip Document

**What to build:** Give private and shared itineraries useful exits from the Trips page that do not depend on hosted sharing. A user can copy readable text, print or save a PDF through a clean print view, download self-contained HTML, and export timezone-correct calendar events. Local-only exports run entirely against the selected private Trip Document revision or sanitized projection and make no hosted or third-party request.

**Blocked by:** 05: Plan with Library sources and Unscheduled entries.

**Status:** done

- [x] The user chooses the current private revision or an available sanitized Share Snapshot as the export source and sees which projection will be exported.
- [x] Copyable text preserves day order, stop order, times, public notes, and clear unresolved-hole markers without leaking excluded private fields from a sanitized source.
- [x] Print/PDF uses a dedicated readable layout with sensible page breaks, timezone, provenance links when public, and no editing controls or application chrome.
- [x] Self-contained HTML has no dependency on a running Locus server and includes only the selected projection's allowed assets and fields.
- [x] Calendar export uses explicit timezone data, stable event identities, and update-safe event metadata so re-exporting does not create duplicate events unnecessarily.
- [x] Untimed and Unscheduled content is represented honestly rather than assigned invented calendar times.
- [x] Local-only export performs no hosted Locus request, analytics call, route lookup, external asset fetch, or inference.
- [x] Export tests assert deterministic output, ordering, escaping/sanitization, timezone boundaries, stable event identity, private-field exclusion, and zero network calls in local-only mode. Browser tests cover each visible export action and print accessibility. Relevant existing tests, typecheck, and build remain green.

## Comments

Pure export module `server/trips/export.ts` (no node builtins, no network — the app imports it directly like `projections.ts`): `projectTripForExport` projects the private document through a public-fields-only seam (private notes, provenance, and advisories never enter an export input), and `exportTripText` / `exportTripHtml` / `exportTripIcs` accept BOTH sources — the private projection and the ticket-11 `ShareSnapshot` are the same shape, so sanitized-source exports cannot leak by construction. Text: document order, times, durations, public notes, `Open:` hole markers, `Unscheduled` section. HTML: self-contained inline-styled document in Locus palette, everything escaped, no scripts/images/iframes, no Locus URLs (only the projection's public source links), `@media print` page-break rules — the same string doubles as the print view. ICS: timed stops on dated days convert wall time through the document timezone to UTC instants via `Intl` (DST-safe, verified for EDT/EST), `DTEND` only from real durations, untimed stops on dated days become `DTSTART;VALUE=DATE` all-day events, undated/unscheduled content becomes `VJOURNAL` with no `DTSTART` (known times described in text, never placed), CRLF + RFC escaping + 75-char folding, UIDs are the private stop id or a deterministic FNV-1a of content so re-exports update instead of duplicating, `SEQUENCE:0` + fixed `DTSTAMP` (from the source's `updatedAt`) keep output deterministic.

UI (`ExportControl` on the document page): source radios for Current private revision vs Sanitized snapshot (the snapshot loads through the existing same-origin share-preview endpoint, which writes nothing), a `role="status"` line always names the active projection, then Copy text (clipboard API with textarea fallback), Print / PDF (hidden `srcdoc` iframe printing the export HTML — no app chrome), Download HTML, Download calendar (Blob + `a.download`, `blob:` URLs make no requests).

Tests: `tests/trips-export.test.ts` (10 module tests: text ordering/notes/hole markers/determinism, draft marking, HTML escaping + single-URL + no-server + print rules, Asia/Tokyo and America/New_York DST conversions, DTEND, stable unique UIDs, all-day vs VJOURNAL honesty, ICS escaping/folding/CRLF, snapshot source excludes drafts + private notes, filename slugs) and one browser test in `tests/trips-browser.test.ts` (copy → clipboard content asserted, print frame without app chrome, real downloaded `.html`/`.ics` files via CDP asserted, snapshot-source switch, zero external requests, writes only `POST /api/trips/*`).

Commands: `npx tsc --noEmit`, `npx vite build` (before browser tests), `npm test` (356 pass; one unrelated flaky failure in the first run, four subsequent full runs green), `npm run build` — all green. DeskPage untouched; nothing staged.
