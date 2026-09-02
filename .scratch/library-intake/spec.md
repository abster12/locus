Status: ready-for-agent

# Library Intake — manual and agent-directed Item capture

## Problem Statement

I can capture saved posts from supported source collections, but I cannot simply give Locus a useful URL or ask my chosen agent to save a set of things directly into my Library. When an agent finds something useful, its work often remains in chat. I must recreate the Item, copy its details, find the right Collection, apply the right tags, and then wait for the rest of Locus to recognize whether it belongs in Reading, Atlas, or Kitchen.

Creating an Item without organization is not enough. I want the Item to arrive with the source-backed details that are actually available, in my chosen Collection, and classified using my existing tag vocabulary. I also need to understand which details came from the source, which classifications were agent opinions, and which information is still missing. The agent must not invent source facts, create near-duplicate tags, overwrite existing Items, or turn an exploratory recommendation into a save without my decision.

The existing Capture Protocol solves a different problem. It lets paired producers capture authoritative source collections with sessions, coverage, and removal reconciliation. A one-off manual or agent-directed Item must not impersonate a source collection, inherit source-removal semantics, or reuse a producer token with broader meaning than intended.

## Solution

Add **Library Intake**, a Library-wide capability for deliberately creating and organizing Items outside producer-owned source collection capture. It is exposed through three adapters around one deep Library Intake module:

- A **manual UI** lets the user enter a URL, supply or correct available details, choose existing tags and Collections, and save without AI.
- A Library-scoped **direct MCP adapter** lets a chosen agent create an exact, explicitly requested batch even when a Locus page is not open.
- A page-scoped **WebMCP adapter** lets a chosen browser agent work with the user on the visible Library page, inspect the permitted organization vocabulary, present exploratory Item drafts for selection, or commit an exact requested batch.

All adapters use the same module interface for Library authorization, validation, URL normalization, duplicate handling, classification evidence, memberships, provenance, idempotency, activity, and downstream reconciliation. An Item and its requested organization commit atomically. Successful creation immediately becomes ordinary Library state and runs the existing Reading and Atlas reconciliation paths; Kitchen continues to project Food Items through its authoritative Food predicate.

Agent classification is structured. Before proposing or creating Items, an agent reads a bounded Intake Context containing existing tags, Collections, their descriptions, semantic tag guidance, and a version. The agent applies existing identifiers, explains why each tag fits, and points to bounded evidence in the proposed Item fields or the user's explicit classification instruction. Agent adapters cannot silently create new tags. WebMCP may present a proposed new tag for human confirmation; direct MCP v1 is limited to existing tags and Collections.

Exact and exploratory requests behave differently. “Save these five URLs to Research and tag them by topic” may create one atomic batch. “Find useful writing about local-first software” must present bounded Item drafts first; only the drafts the user selects become Items. Manual capture never requires an agent, and opening an intake surface never starts inference, browsing, or background classification.

## User Stories

### Manual intake and product scope

1. As a Locus user, I want to save a useful HTTP(S) URL manually, so that Library intake is not limited to supported social source collections.
2. As a Locus user, I want manual intake available from the visible global New action, so that saving is discoverable without a second Desk control or a homepage dashboard.
3. As a Locus user, I want URL to be the only required source field, so that I can save something even when other details are unavailable.
4. As a Locus user, I want to enter or correct title, source text, author, publication date, and safe media URLs when I know them, so that the Item is useful immediately. If I omit publication date on a manual save, it defaults to today.
5. As a Locus user, I want to choose one or more existing Collections during intake, so that the Item reaches my preferred organizational destination atomically.
6. As a Locus user, I want to choose existing tags during intake, so that I can classify an Item without an agent.
7. As a Locus user, I want to create a new tag through an explicit human UI when the existing vocabulary is insufficient, so that taxonomy growth remains my decision.
8. As a Locus user, I want a preview of the Item and its organization before saving, so that I can catch incorrect details or destinations.
9. As a Locus user, I want manual intake to remain fully usable without MCP, WebMCP, or an AI provider, so that AI is optional.
10. As a Locus user, I want opening the intake UI to perform no fetch, inference, or mutation, so that saving begins only after an explicit action.
11. As a Locus user, I want a successful save to appear immediately in the Library, so that I can continue organizing or opening it without refreshing.
12. As a Locus user, I want a failed save to preserve my entered draft and explain the validation problem, so that I can correct it without re-entering everything.

### Intake Context and taxonomy

13. As an agent user, I want my agent to read the current Intake Context before classifying Items, so that it uses my actual tags and Collections rather than inventing a parallel taxonomy.
14. As a Locus user, I want Intake Context scoped to my Library, so that another account's organization never appears in my agent's choices.
15. As a Locus user, I want existing tag identifiers and display names returned together, so that the agent writes stable identifiers while explaining choices in familiar language.
16. As a Locus user, I want Collection identifiers, names, and bounded descriptions returned together, so that the agent can choose the intended destination without reading unrelated Item contents.
17. As a Locus user, I want semantic guidance for tags with product meaning, such as Food membership, so that the agent understands the consequence of applying them.
18. As a Locus user, I want the user instruction supplied with the batch included as classification context, so that project-specific requests such as “tag all of these Client A” are applied consistently.
19. As a Locus user, I want the Intake Context versioned, so that an agent cannot apply tags or Collections from a taxonomy that changed after it was read.
20. As a Locus user, I want a stale Intake Context rejected without partial writes, so that removed or renamed destinations are not silently substituted.
21. As a Locus user, I want agents to prefer existing tags case-insensitively, so that “Local First” and “local first” do not become duplicates.
22. As a Locus user, I want direct MCP limited to existing tag and Collection identifiers in v1, so that an unattended adapter cannot expand my taxonomy.
23. As a WebMCP user, I want an agent-proposed new tag shown distinctly from existing tags, so that I can approve, rename, or reject it before creation.
24. As a Locus user, I want Collection placement distinguished from classification, so that “save to Research” is not misrepresented as evidence that the Item is about research.
25. As a Locus user, I want Item status and snoozing to remain separate from intake classification, so that adding tags does not silently triage the Item.

### Source details, provenance, and classification evidence

26. As a Locus user, I want Item source details to remain source-backed or explicitly user-entered, so that agent interpretation is not presented as captured fact.
27. As a Locus user, I want an agent-added Item labelled as added by an agent, so that its origin remains visible after the intake session ends.
28. As a Locus user, I want a manually added Item labelled as added by me, so that provenance does not pretend it came from a producer.
29. As a Locus user, I want an agent-supplied title, author, publication date, source text, or media reference to declare that the agent observed it at the submitted URL, so that those fields are not confused with Locus fetching the page.
30. As a Locus user, I want missing details to remain missing, so that an agent cannot fill gaps with plausible inventions.
31. As a Locus user, I want agent summaries excluded from the captured source-text field, so that interpretation never masquerades as the publisher's words.
32. As a Locus user, I want every agent-applied tag to have a concise rationale, so that I can understand the classification.
33. As a Locus user, I want tag rationale tied to a bounded source field, exact bounded excerpt, or my explicit classification instruction, so that unsupported classifications are detectable.
34. As a Locus user, I want classification evidence stored privately with the tag membership, so that I can inspect later why the tag arrived.
35. As a Locus user, I want tag membership actor recorded as user or agent by the trusted adapter, so that an agent cannot claim I assigned its classification.
36. As a Locus user, I want uncertain classifications omitted or presented as uncertain drafts, so that low-confidence guesses do not become durable tags.
37. As a Locus user, I want source URLs and media URLs validated and sanitized, so that unsafe protocols, credentials, markup, and control characters cannot enter the Library.
38. As a Locus user, I want remote media references bounded and not downloaded during intake, so that saving an Item cannot become an unbounded fetch.
39. As a Locus user, I want agent-supplied content treated as untrusted input, so that instructions embedded in a page cannot control Locus or its tools.
40. As a Locus user, I want classification evidence stored with the Item and included in the existing Library backup, so that after restore I can still see why a tag was applied. There is no separate public Item export for evidence.

### Exact agent-directed intake

41. As an MCP user, I want to tell my agent “save these URLs to this Collection and tag them,” so that exact work lands directly in the Library instead of chat.
42. As a WebMCP user, I want the same exact instruction to update the visible Library immediately, so that I can see what the agent created.
43. As an agent user, I want a bounded `get_library_intake_context` tool, so that I can obtain the permitted organization vocabulary and context version.
44. As an agent user, I want a bounded `search_library` tool, so that I can check whether a URL already exists before proposing a duplicate.
45. As an agent user, I want one `create_items` tool for exact batches, so that Item details, classifications, and Collection placement share one atomic outcome.
46. As a Locus user, I want an agent batch to carry my originating instruction, so that its purpose is understandable in private activity history.
47. As a Locus user, I want every batch to carry a client mutation id, so that retries cannot duplicate Items or memberships.
48. As a Locus user, I want a bounded batch size and bounded per-Item organization, so that MCP cannot become an unbounded write channel.
49. As a Locus user, I want a successful agent batch to report which Items were created and which existing Items were reused, so that the result is honest.
50. As a Locus user, I want one invalid Item, tag, Collection, evidence reference, or stale context to reject the complete batch, so that exact multi-Item instructions do not half-complete.
51. As a Locus user, I want direct MCP credentials revocable and Library-scoped, so that I can withdraw access without affecting producer capture tokens.

### Exploratory WebMCP intake

52. As a Locus user, I want an exploratory request such as “find useful writing about local-first software” to present drafts before saving, so that discovery does not become automatic collection.
53. As a WebMCP user, I want `present_item_drafts` to render drafts on the visible page rather than returning only chat prose, so that selection happens next to my Library.
54. As a Locus user, I want each presented draft to show URL, title, source-backed details, proposed Collections, proposed tags, and missing information, so that I know what would be created.
55. As a Locus user, I want each proposed tag to show its rationale and evidence, so that I can evaluate the classification rather than trust a label blindly.
56. As a Locus user, I want proposed new tags visually distinguished and unavailable for silent commit, so that taxonomy changes require a human decision.
57. As a Locus user, I want to select any subset of presented drafts, so that rejecting one option does not discard the useful ones.
58. As a Locus user, I want to edit destination and tags before committing a selected draft, so that the final organization remains mine.
59. As a Locus user, I want dismissing the draft sheet to leave the Library unchanged, so that exploratory work is safely temporary.
60. As a Locus user, I want presented drafts to be non-durable page state until selected, so that abandoned agent output does not clutter my Library or database.
61. As a mobile and keyboard user, I want the draft sheet fully operable without dragging, hover, or precise pointer input, so that agent-assisted intake is accessible.

### Duplicate handling, atomicity, and history

62. As a Locus user, I want URLs normalized before duplicate checks, so that superficial URL formatting does not create an obvious duplicate.
63. As a Locus user, I want an exact normalized-URL match to reuse the existing Item rather than create a second copy, so that organization can be added safely.
64. As a Locus user, I want duplicate reuse to add only the requested missing memberships, so that the agent cannot overwrite source content already captured by a producer.
65. As a Locus user, I do not want fuzzy title or author similarity to merge Items automatically, so that distinct sources are not collapsed by guesswork.
66. As a Locus user, I do not want Locus to follow redirects or fetch canonical URLs during intake, so that duplicate detection remains bounded and network-free.
67. As a Locus user, I want a repeated client mutation id with the same payload to return the original batch result, so that network retries are safe.
68. As a Locus user, I want reuse of a client mutation id with a different payload rejected, so that idempotency cannot hide a changed instruction.
69. As a Locus user, I want Items, memberships, classification evidence, activity, and downstream reconciliation committed in one transaction, so that a crash cannot leave a partially classified Item.
70. As a Locus user, I want new Items to begin in the existing Inbox state unless I explicitly triage them later, so that intake does not silently alter workflow status.
71. As a Locus user, I want batch history to record actor, time, originating instruction, context version, and created/reused outcomes, so that agent writes are auditable.
72. As a Locus user, I want a reused Item's original provenance and source records preserved, so that agent organization does not rewrite capture history.
73. As a Locus user, I want stable invalid, stale-context, not-found, duplicate-policy, forbidden, and unavailable results, so that adapters can handle failures without leaking internals.

### Downstream Locus behavior

74. As a Reading user, I want a newly created Item to enter the existing Reading discovery path when its content qualifies, so that Intake does not need to create Reading Documents directly.
75. As an Atlas user, I want a newly created Item to enter the existing Atlas classification path, so that Intake does not need to create Places or Place Assignments directly.
76. As a Kitchen user, I want an Item with an appropriately evidenced existing Food tag to appear through the Recipe Box's authoritative predicate, so that Intake does not copy Kitchen state.
77. As a Kitchen user, I do not want Intake to create a Recipe Document, recipe score, or Tonight entry automatically, so that saving and cooking remain distinct decisions.
78. As a Trips user, I want later “Save to Library” promotion of trip-owned outside content to call Library Intake, so that Trips does not own a second Item-creation implementation.
79. As a Trips user, I want promoting outside content to be explicit and to preserve the Trip Stop's history, so that the Library is not polluted by every recommendation.
80. As a Locus user, I want existing Desk filters, Collections, tags, notes, and Item detail behavior to work immediately for Intake-created Items, so that they are ordinary Items after commit. Desk source filters include You for Items I added, next to All, X, Instagram, YouTube, and Reddit.
81. As a Locus user, I want the existing Library backup to include Intake-created Items, memberships, who added them, and tag explanations, so that restore looks like the same Library. Restore copies Items; it does not replay Intake saves or restore batch retry ids.
82. As a Locus user, I want producer capture reconciliation to ignore Intake-created Items when a source collection reports removals, so that unrelated source refreshes cannot delete or hide them.

### Security, permissions, and deployment

83. As a hosted user, I want every Intake read and write authorized against my authenticated Library, so that another account cannot inspect my taxonomy or create Items for me.
84. As a local-only user, I want loopback session and CSRF protections retained for manual and WebMCP writes, so that a foreign page cannot forge local intake.
85. As an MCP user, I want direct MCP to use a separate Library capability rather than a Capture token, so that ad-hoc writes cannot start or finish producer capture sessions.
86. As a Locus user, I want Library read and Library write capabilities distinguishable and revocable, so that an agent receives only the authority it needs.
87. As a Locus user, I want actor identity derived from the authenticated adapter or capability, so that tool input cannot impersonate a human.
88. As a Locus user, I want WebMCP tools registered only on the owning private Library/intake surface, so that page capabilities match what is visible.
89. As a Locus user, I want WebMCP tools unregistered when the route or authenticated Library changes, so that stale page tools cannot write elsewhere.
90. As a Locus user, I want direct MCP and WebMCP to expose the same validation and creation behavior, so that there is no weaker agent-only path.
91. As a Locus user, I want all text, URLs, arrays, evidence excerpts, classification rationales, and batches bounded before persistence, so that Intake resists resource exhaustion and hostile content.
92. As a Locus user, I want Locus to perform no general crawling, page extraction, OCR, video interpretation, or hidden inference during Intake, so that research remains the chosen agent's explicit work.
93. As a Locus user, I want agent-observed remote content labelled untrusted and source-provided, so that webpage prompt injection is never interpreted as a Locus instruction.
94. As a Locus user, I want Intake unavailable on public Share Snapshots and unauthenticated pages, so that public viewers cannot write to a Library.
95. As a local-only user, I want manual Intake and explicitly configured direct MCP to work without hosted Locus, so that local-first operation remains real.
96. As a developer, I want hosted and local-only adapters to call the same Library Intake interface, so that the feature does not split into two products.

## Implementation Decisions

### Product boundary and terminology

- Library Intake is a separate Library-wide feature, not part of Trips, Reading, Atlas, or Kitchen. Those features consume ordinary Items or call the Intake interface for an explicit promotion workflow.
- **Library Intake** means deliberate manual or agent-directed creation and organization of Items outside producer-owned source collection capture.
- An **Intake Draft** is a validated prospective Item plus proposed organization and classification evidence. It is not an Item until committed.
- An **Intake Context** is the bounded, versioned set of existing tags, Collections, semantic guidance, and request-specific classification instruction available to one Library intake operation.
- An **Intake Batch** is one atomic manual or agent-directed commit containing one or more Item drafts, requested memberships, provenance, context version, and client mutation id.
- Add Library Intake, Intake Draft, Intake Context, and Intake Batch to the domain glossary when implementation begins. Continue using Item, Library, Collection, tag, Source account, Source collection, Capture Protocol, Reading Document, Place Assignment, Recipe Box, Recipe Document, and Tonight exactly as already defined.
- “Preferred storage space” in v1 means the owning Locus Library plus selected existing Collections and tags. It does not mean an arbitrary filesystem path, cloud drive, database, or third-party workspace.

### Deep module seam

- Build one deep **Library Intake module** as the primary interface and test seam. Manual UI, HTTP, direct MCP, WebMCP, local persistence, hosted persistence, archive import/export, and later Trips promotion are adapters around it.
- Keep the external interface small: obtain Intake Context, search for existing Items, validate/prepare Intake Drafts, and atomically commit an Intake Batch. The module hides normalization, deduplication, membership validation, classification evidence, idempotency, activity, and downstream reconciliation.
- The module accepts trusted Library and actor context from the adapter. Library id and actor are never accepted as untrusted request fields.
- Return a complete result for each requested draft: created or reused, resulting Item summary, applied memberships, omitted duplicate memberships, and downstream reconciliation outcome. Callers must not reconstruct state through additional writes.
- The interface is the principal stateful test surface. Tests use a real test database and call the same operations used by human and agent adapters.

### Relationship to Capture Protocol

- Existing Capture Protocol sessions, tokens, source accounts, source collections, coverage, cursors, source records, and removal reconciliation remain unchanged and authoritative for producers.
- Do not implement manual or agent intake by manufacturing a custom source collection or one-item capture session. Intake has no finish/coverage semantics and no authority to remove Items based on a later source scan.
- Do not reuse Capture tokens for direct MCP. Introduce a distinct revocable Library capability model with separate read and write authority.
- The Capture implementation and Library Intake module may share an internal Item persistence/reconciliation helper so both consistently create Item state, activity, Reading discovery, and Atlas enqueue work. That internal seam is not exposed to adapters.
- Intake duplicate reuse never updates producer-owned source records or overwrites Item source fields already maintained by a producer.

### Intake Context and classification instruction

- `get_library_intake_context` returns a bounded representation of existing tags and Collections in the authenticated Library, including stable ids, display names, colors/descriptions when relevant, semantic consequences, and a context version.
- Context does not include unrelated Item bodies, notes, credentials, capture tokens, session information, or raw queries.
- A request may include a bounded user classification instruction such as “tag by technical topic” or “place all of these in Client A.” Store that instruction privately with an agent-authored Intake Batch.
- Compute a stable context version from the organization vocabulary relevant to the result. `create_items` requires the version used for classification and rejects stale tag/Collection targets atomically.
- Existing tag identifiers are the only agent-writable classification targets in v1. Match display names case-insensitively for discovery, but commit stable ids.
- Manual UI may create a tag explicitly through the existing human-authorized tag path. WebMCP may present a proposed new tag for human confirmation, but it cannot include an unapproved new tag in `create_items`. Direct MCP v1 cannot create tags or Collections.
- Collection membership represents destination/organization and does not require classification evidence. Tag membership represents classification and requires evidence for agent writes.

### Intake Draft and source-field provenance

- A committed Item requires one safe HTTP(S) URL. Reuse existing Item validation limits where they are already appropriate: URL up to 2,000 characters, title up to 500, source body up to 20,000, author fields up to 200, and at most eight safe remote media references.
- Continue to validate allowed content types, ISO timestamps, HTTP(S) schemes, absence of URL credentials, bounded metadata, and sanitized text. Reject control/format characters that could create invisible or bidirectional UI manipulation in agent-authored display text.
- Locus does not fetch the URL during Intake. Manual fields are user-entered. Agent fields are represented as agent-observed at the submitted URL and remain untrusted input.
- On a user-authored manual save, an omitted or blank publication date is stored as the current day. Agent intake still leaves a missing publication date missing.
- An agent may supply source title, author, publication date, exact source text, and safe media references only when it claims to have observed them at the URL. Missing or inaccessible information stays absent.
- Agent summaries, interpretations, and recommendations do not enter the Item source-body field. Classification rationale has its own private bounded storage.
- Record Intake origin and batch provenance separately from producer source records. UI can distinguish Added by you from Added by agent without pretending either came from a source collection.
- Store provenance for agent-supplied factual fields sufficiently to identify actor, submitted URL, observed time supplied by the agent when present, and originating Intake Batch. Do not claim that Locus verified the remote page.

### Tags, Collections, and classification evidence

- Commit Item creation, requested Collection memberships, requested tag memberships, and agent classification evidence in the same transaction.
- Reuse the existing memberships as the authoritative relation between Items and tags/Collections. Preserve actor on every membership and derive it from the trusted adapter.
- For every new agent-authored tag membership, require a bounded rationale plus one or more valid bases: a bounded exact excerpt/reference from the draft title/body/author/URL or the explicit user classification instruction.
- Validate that evidence references point into the submitted, sanitized draft rather than unrelated text. A rationale alone is not evidence for a factual semantic tag.
- Store classification evidence privately alongside the target tag membership and Intake Batch. Removing the membership removes or retires its active evidence without erasing the historical batch record.
- If an Item already has the requested membership, return it as already present and preserve the original membership actor/evidence rather than rewriting authorship.
- Applying a Food-semantic tag may make the Item visible in Recipe Box, but Intake does not create Kitchen state. Applying a geographic tag does not create a Place or Place Assignment.
- Uncertain classifications should be omitted from exact writes or shown as unresolved in an Intake Draft. Do not persist confidence theatre as if it were source evidence.

### Duplicate policy, batches, and idempotency

- Normalize safe URLs deterministically for Intake duplicate lookup. Normalize protocol/host casing, default ports, and other non-semantic URL representation differences without fetching redirects or external canonical metadata.
- An exact normalized-URL match in the same Library reuses the existing Item. Reuse may add requested missing memberships and classification evidence but does not overwrite existing title, body, author, dates, media, source records, or provenance.
- Do not fuzzy-merge by title, author, body similarity, or agent confidence. Ambiguous matches return existing candidates for a human or exact follow-up decision.
- One Intake Batch may contain at most 25 Item drafts. Each draft may target at most 12 existing tags and five existing Collections. Bound total serialized input as well as individual fields.
- `create_items` requires a context version and client mutation id. Client mutation ids are unique within the authenticated Library/adapter authority.
- Replaying the same mutation id and normalized payload returns the original result. Reusing it for a different payload is invalid.
- Validate the complete batch before writing. One invalid URL, content field, membership, evidence reference, duplicate policy conflict, stale context, or cross-Library target rolls back every Item and membership in the batch.
- Newly created Items start in the existing Inbox state. Intake does not set status, snooze, archive, notes, Tonight, Reading progress, or Trip placement.
- Record a private Intake Batch history entry with actor, time, originating instruction when agent-authored, context version, client mutation id digest/reference, and per-draft created/reused outcome.

### Manual UI and HTTP adapter

- Provide a visible global New → Save a link action. Do not add a second Save a link control on Desk, a hidden hamburger-only action, or a large homepage feature dashboard.
- Desk source filters include You, which lists Items whose intake actor is the user, next to All, X, Instagram, YouTube, and Reddit.
- Manual intake supports URL, optional source-backed fields, existing tag/Collection selection, an explicit human new-tag path, preview, and atomic Save.
- Opening the form performs no fetch or inference. A user can complete the entire flow without an agent.
- Keep the unsaved draft locally in page state after validation failures. Do not persist abandoned manual drafts as Items.
- HTTP mutations require authenticated Library ownership in hosted mode and the existing local session/CSRF protection in local-only mode.
- A successful result updates visible Library state through the existing Library refresh/event mechanism rather than requiring a reload.

### Direct MCP adapter

- Direct MCP is an adapter around the Library Intake module, usable without a visible Locus page after the user explicitly configures and authorizes it.
- Serve it as HTTP JSON-RPC at `POST /mcp` with a Bearer Library capability. Local and hosted use that same path. Do not use stdio, Capture tokens, or browser session cookies for this adapter.
- Issue Library capabilities from the private Account page. Each secret is shown once, stored as a hash, labelled with the chosen agent, and bound to one Library (`library_id` from day one). `library:read` and `library:write` are separate rows and independently revocable.
- The adapter derives Library id and agent actor from the authenticated capability. Tool input cannot select another Library, claim to be the human, or broaden scopes.
- Missing, malformed, revoked, wrong-scope, and cross-Library credentials return the same bounded unauthorized/unavailable errors and do not reveal whether private resources exist.
- Expose `get_library_intake_context` and `search_library` with `library:read`. Expose `create_items` with `library:write` (ticket 09). `tools/list` returns only the tools the presented capability may call. Do not expose raw SQL, arbitrary Item mutation, tag/Collection creation, capture session control, deletion, or status changes.
- Direct MCP exact writes are appropriate for an explicit instruction with known URLs, destinations, and classification intent. Tool descriptions must state that exploratory discovery should not be silently committed.
- Limit direct MCP v1 to existing tag and Collection identifiers. A user who needs a new organization target creates it through the human UI first.
- Return stable bounded results and never reveal credentials, token material, private notes, unrelated Item bodies, or full Library exports.
- Exclude Library capability secrets from archives and logs. Wipe deletes them with the Library.

### Page-scoped WebMCP adapter

- Register Library Intake WebMCP tools only on the authenticated private Library/intake surface that can present their results. Unregister them when the route, Library, or document lifecycle changes.
- Expose the same `get_library_intake_context`, `search_library`, and `create_items` contracts through the page adapter. UI and WebMCP call the same module operations.
- Add `present_item_drafts` as a page-presentation tool for exploratory work. It accepts a bounded list of at most 20 validated drafts and renders a temporary desktop sheet or mobile bottom sheet.
- Presented drafts show source details, missing fields, destination Collections, tags, proposed-new-tag state, and a notes block for agent rationale, evidence, and uncertainty. Treat all agent-authored strings as untrusted and sanitize before rendering. The notes block is not an Item note and is not written as one.
- Presentation is non-durable page state. Dismissal makes no Item write. The sheet is the format: source fields stay as presented; the human selects any subset and may change existing tags and Collections. Unselected drafts are discarded with the sheet and are not re-presented.
- Human Save on the sheet commits only the selected drafts through a page-only reviewed batch against the current Intake Context version (same Intake module, agent provenance, created/reused outcomes). It does not invoke the `create_items` tool. Direct `create_items` still requires observed fields and classification evidence; a reviewed sheet save does not reconstruct or re-prove those.
- A proposed new tag needs an explicit human Create on the sheet through the human-authorized tag path. That create happens immediately, Intake Context refreshes, and the following Item save uses the new stable tag id. Confirming a tag and then dismissing the sheet can leave the tag. Unconfirmed proposals are not created.
- If the Intake Context is stale at save, explain, keep the current selections and tag/Collection edits, refresh available targets, and write nothing.
- Use the proven current WebMCP runtime lifecycle: document-scoped registration with abort-signal cleanup, bounded JSON schemas, stable errors, and visible result updates.
- Opening the Library or Intake sheet does not summon an agent, browse URLs, or register tools on public/unauthenticated pages.

### Downstream reconciliation and ordinary Item behavior

- A newly created Item is an ordinary Item immediately after commit. Existing Desk filters, search, Item detail, tags, Collections, notes, and status operations apply without Intake-specific copies.
- In the same transaction as new Item persistence, invoke or enqueue the same Reading discovery and Atlas analysis reconciliation used after producer capture. A crash cannot keep the Item while losing required downstream discovery state.
- For reused Items, rerun downstream reconciliation only when the newly added organization changes an authoritative predicate that requires it; do not restart unrelated expensive work on every duplicate save.
- Recipe Box continues to use its existing Food predicate. Library Intake never duplicates the predicate or writes Recipe Documents and Tonight entries.
- Reading remains authoritative for Reading Documents and progress. Intake never creates Reading Documents or marks them unread/reading/finished directly.
- Atlas remains authoritative for Places, Place Assignments, and Place Suggestions. Intake never turns a tag or agent classification into a confirmed geographic entity.
- A future Trips “Save to Library” action calls the same Intake interface with explicit human/agent provenance, then records any Trip Stop reference replacement through the Trips module as a separate auditable change.

### Persistence, archives, and deployment

- Persist Intake Batch idempotency/history, Item intake provenance, and agent classification evidence in Library-scoped records. Exact table normalization is an implementation choice as long as the module interface and deletion/export behavior remain stable.
- Memberships remain authoritative for active organization. Evidence/provenance records supplement them and do not become a second tag or Collection system.
- The existing Library archive includes Item intake provenance and active classification evidence. It does not include batch retry/idempotency records, capability secrets, or transient presented drafts. Restore copies stored Items into an empty Library; it is not an Intake save and does not need retry ids.
- Import validates ownership, identifiers, bounds, membership targets, and evidence references. It does not rerun agent inference or remote fetches.
- Hosted and local-only modes use the same module invariants. Authentication/session, persistence, capability storage, and MCP transport are adapters.
- Do not select a hosted identity vendor, billing plan, MCP transport vendor, or public infrastructure in this spec.

### Security and consequential actions

- All adapter input is untrusted. Bound operation counts, arrays, strings, URLs, evidence excerpts, rationales, serialized payload size, and result size before persistence or rendering.
- Reject non-HTTP(S) URLs, embedded credentials, unsafe media URLs, malformed timestamps, unknown content types, unknown fields that would broaden writes, cross-Library identifiers, and invalid evidence spans.
- Page/source content may contain prompt injection. Tool descriptions and results label remote content as untrusted; Locus never follows instructions inside submitted content.
- Actor, Library, capabilities, human new-tag approval, and page visibility are trusted adapter context, not payload fields an agent can assert.
- Intake tools cannot delete or overwrite Items, change Item status, modify source records, finish Capture sessions, create Recipe Documents, review recipes, publish Trips, or write arbitrary notes.
- No Intake path performs general web fetch, open-web search, crawling, OCR, transcription, inaccessible-media interpretation, or hidden inference.

## Testing Decisions

- The principal test seam is the Library Intake module interface. Tests call it with a real test database and assert complete results and durable observable state: Items, memberships, classification evidence, provenance, batch history, idempotency, and downstream reconciliation.
- Every implementation ticket derived from this spec must add automated regression coverage with the implementation. Feature work is incomplete unless the new success path, important validation/authorization failures, persistence where relevant, and preservation of existing behavior are tested.
- Module tests cover manual and agent actors, safe source-field bounds, context versioning, exact existing targets, classification evidence spans, atomic batches, duplicate reuse, no-overwrite guarantees, stale context, idempotent retry, changed-payload rejection, and cross-Library isolation.
- Test semantic tag consequences through existing module interfaces rather than copying policy into Intake tests: Food-tagged Items appear through Kitchen's Recipe Box predicate, Reading discovery uses the Reading module, and Atlas work uses the Atlas module.
- Add regression tests proving that producer capture finish/removal does not remove or hide Intake-created Items and that duplicate intake does not alter producer-owned source records.
- HTTP tests cover hosted-style Library authorization context, local session/CSRF enforcement, manual preview/commit, stable errors, and visible Library refresh behavior.
- Direct MCP adapter tests cover read/write capability separation, revocation, bounded schemas/results, existing-target enforcement, actor derivation, exact batch creation, and absence of raw or consequential operations.
- WebMCP adapter tests cover tool registration only on the private owning surface, abort cleanup, clean re-registration, draft presentation, subset selection, edited tags/Collections, reviewed sheet save without evidence reconstruction, new-tag confirmation, stale-context save recovery, sanitization, and no Item persistence on dismissal.
- Add a real-browser interoperability test following the proven Reading WebMCP prior art: discover the Intake tools, invoke context/search/presentation/create against real Library data, verify the visible page updates, navigate away, and verify tools disappear and return once.
- Accessibility browser tests cover keyboard-only manual intake, tag/Collection selection, draft-sheet focus, screen-reader labels for actor/evidence/missing fields, mobile bottom-sheet behavior, and reduced motion.
- Archive tests cover export/import round trips for Intake-created Items, memberships, actor provenance, and evidence, while excluding Library capability secrets, transient presented drafts, and Intake batch retry records.
- Security tests include unsafe schemes, credential-bearing URLs, oversized batches, excessive tags/Collections/media, control and bidirectional characters, markup injection, invalid evidence spans, cross-Library ids, unapproved new tags, and prompt-injection text treated as inert content.
- Good tests assert externally observable behavior at module and adapter seams. Do not assert internal table layout, React component names, SQL statement order, WebMCP registration mechanics beyond lifecycle behavior, or implementation-specific helper calls.
- Follow existing repository prior art: built-in Node test runner, strict assertions, real SQLite databases for stateful module tests, existing Capture Protocol authorization/idempotency tests, Item mutation tests, Reading/Atlas reconciliation tests, archive tests, and Reading WebMCP browser coverage.
- Relevant existing tests, typecheck, and production build must remain green for every implementation slice.

## Out of Scope

- Replacing or redesigning Capture Protocol, site packs, the extension, runner, source accounts, source collections, producer pairing, capture coverage, or source-removal reconciliation.
- Treating Intake as a custom source collection or allowing Intake capabilities to start, batch, finish, or cancel producer capture sessions.
- Automatic browsing, crawling, link expansion, redirect following, page extraction, scraping, OCR, video/audio transcription, inaccessible-media interpretation, or hidden inference by Locus.
- Automatically creating new tags or Collections through direct MCP. WebMCP may present a new-tag proposal, but creation is a separate explicit human action in v1.
- Arbitrary filesystem directories, cloud-drive folders, Notion databases, external vector stores, or other third-party “preferred storage” destinations. V1 destinations are the Locus Library, Collections, and tags.
- Fuzzy Item merging, automatic canonical-URL fetching, cross-Item content deduplication, or overwriting producer-captured content with agent-supplied fields.
- Direct creation of Reading Documents, Places, Place Assignments, Recipe Documents, recipe scores, Tonight entries, Trip Documents, or Trip Stops.
- Automatic Item status changes, snoozing, archiving, notes, deletion, bulk editing of existing Item source content, or agent-controlled human review actions.
- Nutrition or macro estimation, recipe generation, travel planning, general research recommendations, or public sharing. Those belong to their owning features.
- Scheduled or proactive background agents, automatic reclassification when tags change, or inference on page open.
- Collaborative multi-user taxonomy editing, approval workflows, organization permissions beyond Library ownership, or public Intake tools.
- Selecting an MCP client, hosted authentication vendor, inference provider, billing model, or entitlement plan.

## Further Notes

- This specification deliberately separates Library Intake from Trips. Trips may later expose “Save outside recommendation to Library,” but that action must call the Library Intake interface rather than create Items itself.
- “Agent” means the user's chosen MCP or browser agent. Locus exposes bounded tools and validation; it does not introduce a hidden in-app agent.
- User-directed AI permits a substantial exact batch after a clear instruction. It does not permit exploratory results to be saved without selection or page-open inference.
- “All details” means all available, source-backed or explicitly user-entered Item fields plus transparent organization—not fabricated completeness. Missing information is an honest supported state.
- Classification is useful precisely because it has product consequences. Existing tags and Collection descriptions form the vocabulary; evidence, actor attribution, and human control prevent convenience from becoming taxonomy drift.
- The intended deepening opportunity is to share internal Item persistence/reconciliation between producer capture and Library Intake while keeping their external interfaces and authorization semantics distinct.
