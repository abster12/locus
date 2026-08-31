Status: ready-for-agent

# Trips — turn saved places into durable travel plans

## Problem Statement

Locus can capture travel Items and classify Places, but turning those saved things into a usable trip still requires bouncing between Atlas, an agent transcript, and outside notes. Agent recommendations often end as prose that must be copied manually. If an agent writes too freely, the user becomes a spectator; if every mechanical edit needs separate approval, planning becomes slower than doing it by hand.

A trip is not temporary scratch work. The user needs multiple durable **Trip Documents**, each with dates, user-entered context, ordered days, stops, unresolved gaps, review history, exports, and optional sharing. A Trip Document must be reopenable, editable without an agent, and usable in hosted and local-only Locus.

## Solution

Add **Trips** as a normal top-level Locus section alongside Desk, Atlas, Kitchen, and Reading. Trips lists durable Trip Documents and opens one as a full planning page. The primary editing view is the **Day Planner**; Overview and Schedule are projections of that same document.

The global header includes a visible labelled **+ New** menu rather than a hidden overflow menu or homepage-only call to action:

- **Plan a trip** creates a Trip Document in Trips.
- **Save a link** enters the existing capture flow. Reading discovery decides whether the captured Item produces a Reading Document.
- **Make a saved dish cookable** routes to Kitchen to choose a Food Item and work on its Recipe Document. It does not create a blank recipe or a second Kitchen workspace.

These entries improve discoverability but do not merge the underlying domains. Trips owns Trip Documents; capture owns Items; Reading owns Reading Documents; Kitchen owns Recipe Documents and Tonight.

AI remains user-driven. Opening Trips, reopening a Trip Document, switching views, or opening an empty day never starts inference. Exact instructions may produce exact revision-checked changes. Open-ended taste decisions produce exactly three visible recommendations with opinions and tradeoffs for the user to select. A user may explicitly ask the agent to review whether a day feels too strenuous or travel appears questionable; those results are stored as clearly labelled advisory opinions based only on the saved Trip Document.

## User Stories

### Navigation and creation

1. As a Locus user, I want Trips visible in primary navigation, so that durable travel planning is not hidden on the homepage or inside an unrelated section.
2. As a Locus user, I want a labelled + New menu available throughout Locus, so that important creation workflows remain discoverable without a hamburger menu.
3. As a traveler, I want Plan a trip available in + New and on the Trips page, so that I can start from anywhere.
4. As a Locus user, I want + New to describe existing workflows honestly, so that Save a link does not pretend to create a Reading Document and Kitchen does not pretend every recipe starts blank.
5. As a Locus user, I want ordinary routes and browser Back behavior, so that entering and leaving Trips follows the rest of the application.
6. As a Locus user, I want navigation and menu opening to perform no inference or mutation.

### Trip Document lifecycle and setup

7. As a traveler, I want to create multiple Trip Documents, so that planning a new trip does not overwrite an old one.
8. As a traveler, I want destination and dates or trip length to be the only required setup fields.
9. As a traveler, I want to optionally enter title, timezone, travelers, lodging anchors, pace, mobility, budget, meal preferences, interests, must-dos, and hard constraints.
10. As a traveler, I want all optional context visibly attributed to me unless I explicitly ask an agent to infer something.
11. As a traveler, I want to browse active and archived trips, reopen one from its full row, rename it, duplicate it, archive or restore it, and delete it.
12. As a traveler, I want deletion confirmed and limited to trip-owned records, never referenced Items or Places.
13. As a hosted user, I want my Trip Documents scoped to my authenticated Library and available across my devices.
14. As a local-only user, I want the same Trip Document behavior backed by my local database.

### Day Planner and projections

15. As a traveler, I want the Day Planner to be the primary editing surface.
16. As a traveler, I want Overview to summarize every day with date, theme, time range, stop count, anchors, holes, and conflicts.
17. As a traveler, I want Schedule to show timed stops from the same Trip Document without becoming a second calendar model.
18. As a traveler, I want an empty day to be a useful intentional state with Add from Library, Add a placeholder, Ask for three opinions, and relevant Unscheduled possibilities.
19. As a traveler, I want opening an empty day to perform no inference.
20. As a traveler, I want to add, edit, remove, reorder, and move stops manually, including moves between days and Unscheduled.
21. As a traveler, I want a compact default stop row and progressively disclosed details for sources, addresses, reservations, notes, evidence, and alternatives.
22. As a traveler, I want Item and Place references to resolve authoritative Library data rather than copy it.
23. As a traveler, I want missing referenced Items to remain visible as broken references instead of silently disappearing.
24. As a traveler, I want outside content bounded, sanitized, visibly distinct, and never promoted to an Item automatically.

### Drafts, holes, and recommendations

25. As a traveler, I want human-created stops Confirmed and agent-created or replaced stops Draft.
26. As a traveler, I want to keep or remove individual Drafts and Keep All currently visible Drafts in one human action.
27. As a traveler, I want a hole to preserve an unresolved need at an exact day and order.
28. As a traveler, I want an exact instruction such as “move Nishiki to Wednesday” applied directly after revision checks.
29. As a traveler, I want an open-ended request such as “find a quiet dinner” to present exactly three recommendations rather than silently choose.
30. As a traveler, I want each recommendation to contain an opinion, why it fits, an important tradeoff, provenance, proposed placement, and likely effect.
31. As a traveler, I want recommendations in a temporary drawer or mobile sheet, with no Trip Document mutation until I choose one.
32. As a traveler, I want a chosen recommendation committed as one human changeset and a dismissed recommendation sheet to leave no durable clutter.

### Agent trip review

33. As a traveler, I want to explicitly ask my browser agent whether a day seems too strenuous or travel seems questionable.
34. As a traveler, I want Locus to give that review only the exact saved Trip Document, not hidden route data, inferred fitness data, or background enrichment.
35. As a traveler, I want the agent to save bounded advisory flags for travel feasibility, strain, or missing information so I can revisit them later.
36. As a traveler, I want every flag labelled Agent opinion with rationale, referenced days/stops, actor, time, and reviewed revision.
37. As a traveler, I want advisories based on an older revision marked stale rather than silently rewritten after itinerary edits.
38. As a traveler, I want to dismiss a current advisory while retaining an understandable historical record.
39. As a Locus user, I want opening a trip never to request or refresh an agent review automatically.

### Revisions and history

40. As a Locus user, I want every mutation to declare an expected Trip Document revision.
41. As a Locus user, I want stale, invalid, or partially invalid writes to leave the document unchanged.
42. As a Locus user, I want retries idempotent through a client mutation id.
43. As a Locus user, I want one agent instruction represented as one atomic Trip Changeset.
44. As a Locus user, I want Undo and Redo to operate on complete changesets.
45. As a Locus user, I want history to show actor, time, instruction when present, and a bounded before/after summary.
46. As a Locus user, I want actor identity derived by the trusted adapter rather than accepted from tool input.

### Sharing and exports

47. As a hosted user, I want to preview and publish a sanitized read-only Share Snapshot through an explicit human action.
48. As a hosted user, I want private captions, Library notes, private trip notes, internal identifiers, agent instructions, and history excluded.
49. As a hosted user, I want private edits to remain private until I explicitly update the shared snapshot.
50. As a hosted user, I want to revoke a capability link immediately.
51. As a recipient, I want a responsive account-free itinerary showing timezone and Last Updated.
52. As a Locus user, I want copyable text, print/PDF, self-contained HTML, and timezone-correct calendar export.
53. As a local-only user, I want exports to make no hosted or third-party request.

### Accessibility and safety

54. As a mobile or keyboard user, I want every drag operation to have explicit Add, Move, Place Before/After, Replace, and Remove controls.
55. As a screen-reader user, I want Draft, Confirmed, stale, conflict, broken-reference, provenance, and Agent opinion states exposed as text.
56. As a user with reduced motion enabled, I want meaningful feedback without unnecessary animation.
57. As a hosted user, I want every private read and mutation authorized against my authenticated Library.
58. As a local-only user, I want existing loopback session and CSRF protections retained.
59. As a Locus user, I want text, URLs, identifiers, arrays, operation counts, recommendations, and advisory flags bounded and sanitized.
60. As a Locus user, I want publish, revoke, Trip Document deletion, and human confirmation unavailable to agent tools.

## Implementation Decisions

### Product boundary and navigation

- Trips is a top-level route and primary navigation item. It is not an overlay, Atlas subview, homepage-only action, or generic multi-job workspace.
- The Trips index follows the established Reading and Kitchen page grammar: one restrained editorial list as the primary surface and a compact contextual rail, not a dashboard or card grid.
- Active and Archived are separate filters with their counts shown once in the filter control. Counts derive from the same filtered Trip Document collection as the rows.
- Each row shows enough durable metadata to identify its Trip Document: date range or open dates, title, destination, duration or stop summary, planning state, outstanding work when relevant, and last-updated context.
- The whole trip row is the navigation target; there is no redundant Open button. Rows work equivalently by pointer, touch, and keyboard and expose a useful accessible name.
- Opening a row uses a stable Trip Document route; browser Back and direct links behave normally. The compact rail may surface planning context or a trip needing attention but must not duplicate the Active/Archived counts.
- The visible + New menu is labelled, keyboard accessible, and available across primary Locus pages. It is not a hamburger or unlabeled icon.
- + New contains Plan a trip, Save a link, and Make a saved dish cookable. Each entry hands off to the owning module and does not duplicate its policy.
- Plan a trip is also the primary contextual action on the Trips index and empty state.
- The locked prototype Direction A is authoritative for the Trips index and Trip Document layouts. Do not restore discarded variants or prototype design controls.

### Deep module seam

- Build one deep **Trips module** used by UI, HTTP, WebMCP, exports, and sharing.
- The Trips module owns Trip Documents, days, stops, revisions, Trip Changesets, holes, advisory flags, validation of saved facts, and sanitized Share Snapshot preparation.
- The Atlas module remains authoritative for Places and Place Assignments. Trips references Place identity without copying it.
- Library Items remain authoritative source objects. Outside trip content remains trip-owned and is never automatically captured.
- Kitchen remains the only owner of Food membership, Tonight, Recipe Documents, evidence, source revisions, and human review. Kitchen WebMCP work is tracked separately.
- Reading remains the only owner of Reading Documents. Saving a link goes through capture and Reading discovery.
- Hosted and local-only adapters call the same Trips interface and invariants.

### Trip Document model

```text
TripDocument {
  id, libraryId, title, destination, dates, timezone,
  travelers, lodgingAnchors, preferences, constraints,
  days[], unscheduled[], advisories[], revision,
  archivedAt?, createdAt, updatedAt
}

TripStop {
  id, dayId?, order, timeWindow?, durationMinutes?,
  content: ItemRef | PlaceRef | OutsideContent,
  state: draft | confirmed,
  provenance, storedFacts[], publicNotes, privateNotes
}

TripChangeset {
  id, tripId, baseRevision, resultRevision, actor,
  instruction?, clientMutationId,
  operations[], inverseOperations[], createdAt
}

TripAdvisory {
  id, tripId, reviewedRevision,
  category: travel_feasibility | strain | missing_information,
  severity, opinion, rationale, dayRefs[], stopRefs[],
  actor: agent, createdAt, dismissedAt?
}
```

- Human-created stops begin Confirmed. Agent-created stops and replacements begin Draft.
- A mechanical agent move of a Confirmed stop under an exact instruction may retain Confirmed state while recording agent provenance.
- Archive is reversible and retains history. Duplicate creates a new identity and no active share.
- Trip deletion removes trip-owned data only.

### Mutation, validation, and history

- `applyTripChanges` accepts a Trip Document id, expected revision, client mutation id, optional user instruction, and bounded typed operations.
- The module derives actor from the adapter, commits transactionally, increments revision once, records inverse operations, and rejects partial writes.
- Deterministic validation reports only conditions derivable from saved data: ordering errors, overlaps, duplicate identities, reservation conflicts, holes, broken references, and stale user-stored facts.
- Locus does not invent travel durations, load thresholds, or route facts.
- Undo and Redo operate on complete changesets and run validation on the resulting document.

### WebMCP interface

- Register tools only while their owning private Trips page and Trip Document are visible; unregister on route or document change.
- Read tools: `list_trips`, `get_trip`, and `search_trip_sources`.
- Exact write and validation tools: `create_trip`, `apply_trip_changes`, and `validate_trip`.
- Draft/recommendation tools: `build_trip_draft` and `present_trip_recommendations`.
- Advisory tool: `record_trip_review`.
- Share preview tool: `get_trip_share_preview`; it is read-only.
- Every mutation carries expected revision and client mutation id. Tool errors map to stable stale/invalid/not-found/forbidden results.
- Tool descriptions state required explicit user intent, visible scope, Draft behavior, bounded payloads, and error modes.
- There are no agent tools for publish, update shared version, revoke, delete, or human confirmation.

### Recommendation contract

- `present_trip_recommendations` accepts exactly three bounded options for one explicit open-ended request or hole.
- Each option contains opinion, fit, tradeoff, provenance/basis, proposed typed operations, and likely effect.
- Presentation is temporary UI state. Selection rechecks the current revision and creates a human changeset; dismissal changes nothing.

### Agent advisory boundary

- `record_trip_review` is available only after the user explicitly asks the visible agent to review the current Trip Document.
- Locus supplies only `get_trip` data. It does not fetch routes, query maps, infer physical ability, or provide hidden enrichment.
- The tool accepts expected revision, client mutation id, and bounded flags with category, severity, opinion, rationale, and valid day/stop references.
- Review payloads cannot add route data, outside facts, URLs, coordinates, reservations, Items, or Places.
- Advisories are visibly subjective, revision-linked, dismissible by the human, and retained in history.

### Sharing and export

- Publishing is human-only and creates an immutable sanitized Share Snapshot, never access to the live Trip Document.
- Public capability tokens are unguessable, stored as hashes, non-enumerable, and revocable.
- Private edits do not update the public snapshot automatically.
- Local export is generated from a selected private revision or sanitized projection without network access.
- Calendar events preserve explicit timezone and stable identity; untimed content receives no invented time.

## Testing Decisions

- Every implementation ticket includes new automated regression coverage with its implementation. No ticket is complete with manual verification alone.
- The principal test seam is the Trips module with a real test database. Assert returned documents, revisions, changesets, advisories, validation, and snapshots rather than internal SQL shape.
- Test navigation and + New behavior through accessible browser outcomes, including keyboard menu operation and the absence of inference on navigation.
- Test Trip lifecycle, Library isolation, current selection, archive/history retention, and deletion boundaries. Index browser coverage includes Active/Archived filtering, data-derived counts, whole-row pointer and keyboard activation, correct Trip Document routing, and absence of a redundant row action.
- Test mutations for revision increments, stale rejection, idempotent retry, bounded operations, atomic rollback, Undo, Redo, and trusted actor derivation.
- Test references, missing Items, outside-content sanitization, and the guarantee that Trips does not create Items or Places automatically.
- Test Overview, Day Planner, Schedule, and empty-day projections against one Trip Document.
- Test recommendations for exactly three rich options, temporary presentation, dismissal without mutation, and stale selection.
- Test agent advisories for explicit invocation, saved-data-only input, invalid references, rejection of external-fact fields, stale revision labeling, dismissal, and no automatic review.
- Test WebMCP schemas, bounds, visible-route registration, cleanup, re-registration, stable errors, and forbidden consequential tools. Include a live target-browser smoke test using the proven Reading WebMCP protocol.
- Test Share Snapshot allowlisting, private-field exclusion, token hashing, non-enumeration, explicit update, and revocation.
- Test local export with zero network calls, stable calendar identities, escaping, and timezone boundaries.
- Every ticket keeps relevant existing tests, typecheck, and production build green.

## Out of Scope

- A generic Scratch Pad, multi-job workspace, overlay, Kitchen board, Reading workspace, direction selector, or generated interface.
- Blank recipe creation. Kitchen works from saved Food Items and owns Recipe Documents.
- Manual Reading Document creation. Save a link uses capture; Reading discovery remains authoritative.
- Collaborative editing, collaborator permissions, presence, live cursors, comments, or multi-user conflict resolution.
- Autonomous or scheduled agents, proactive replanning, automatic trip review, hidden inference, route crawling, or background freshness lookup.
- A mapping/routing provider, distance matrix, booking engine, reservation purchase, payment flow, visa advice, or automatic external reservation changes.
- Nutrition or macro estimation.
- Automatically promoting outside recommendations to Items or Places.
- Viewer accounts, viewer editing, public comments, public indexing, share passwords, or expiring links in v1.

## Further Notes

- This spec supersedes all earlier Scratch Pad naming, overlay, and multi-job decisions.
- The earlier Kitchen Scratch Pad proposal is removed. Recipe Document and Tonight WebMCP capabilities remain separate Kitchen tickets.
- The Reading WebMCP proving slice is complete; Trips adapters should reuse its current target-browser registration and abort-signal lifecycle.
- New domain terms requiring glossary inclusion are **Trips**, **Trip Document**, **Trip Day**, **Trip Stop**, **Trip Changeset**, **Trip Advisory**, **hole**, **outside content**, and **Share Snapshot**.
- Continue using Item, Library, Reading Document, Recipe Box, Recipe Document, Tonight, Place, Place Assignment, provenance, source revision, and evidence reference exactly as already defined.
