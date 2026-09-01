# Simplify Trip sharing and secondary actions

Type: task
Status: resolved
Blocked by: 27

## Outcome

The Trip Document foregrounds planning, offers one understandable Share action, and moves recovery, lifecycle, and export utilities into progressive disclosure without removing their capabilities.

## Problem

The current page exposes many peer-level controls: Undo, Redo, lifecycle actions, share management, and multiple export formats. The result makes occasional administration compete with the itinerary. Direction A keeps these capabilities but gives them hierarchy.

## Scope

- `app/src/trips-document.tsx`
- `app/src/trips-stops.tsx`
- `app/src/trips-share.tsx`
- `app/src/trips-advisories.tsx`
- Existing export UI owner
- Trips-only styles and share/history browser tests

## Implementation

1. Keep the Trip title, revision context, destination/dates, view navigation, and one Share action in the document header.
2. Before a Share Snapshot exists, Share opens the existing sanitized preview with one primary **Create and copy link** action.
3. After publication, the same Share action copies the current capability link directly and gives a stable status message. Provide a selectable-link fallback when clipboard access is unavailable.
4. Keep update snapshot and revoke actions in a secondary share-management surface with explicit confirmation where already required.
5. Keep Rename, Duplicate, Archive/Restore, Delete, setup editing, and exports in a labelled document menu or settings disclosure. Preserve destructive-action confirmation and current authorization boundaries.
6. Keep Undo for the latest planner change near Activity and recovery. Keep Redo and full history inside that disclosure; announce outcomes and preserve disabled semantics.
7. Keep export functionality available from the secondary surface. Do not place Download HTML, calendar export, or projection selectors in the primary planner flow.
8. Preserve the existing Share Snapshot allowlist: Drafts, private notes, history, internal identifiers, and agent instructions never appear in the public snapshot.

## Tests

- First Share opens preview and creates/copies only after explicit confirmation.
- Later Share copies the existing link without republishing or changing revision.
- Clipboard denial exposes a selectable link and an understandable message.
- Update and revoke remain available and preserve immutable-snapshot semantics.
- Draft and private-field exclusion remains exact.
- Lifecycle, export, Undo, Redo, and history capabilities remain keyboard reachable but absent from the primary action row.
- No share or export action makes an unapproved third-party request.

## Completion criteria

- The planner header has one primary Share concept rather than multiple share/export steps.
- Every existing administrative capability remains discoverable through a labelled secondary surface.
- Focused share/export/history tests, `npm run typecheck`, `npm run build`, and `npm test` pass.

## Exclusions

- Changing Share Snapshot cryptography, token storage, or public-page data model.
- Viewer accounts, editing, comments, or collaboration.
- Removing supported export formats from the product.

## Answer

Header Share is the only primary share/export control. First use opens the existing sanitized preview with **Create and copy link**; later use copies this tab’s capability URL (selectable fallback if clipboard is blocked). Update and revoke live in the ⋯ document menu with the existing preview/confirm gates. Rename, Duplicate, Archive/Restore, Delete, Edit setup, Ask agent to review, and Export are in that menu. Undo sits next to **Activity and recovery**; Redo and history are inside it. Allowlist, token hashing, and export formats are unchanged. `npm run typecheck`, `npm run build`, and `npm test` pass (462).
