Status: ready-for-agent

# Reading WebMCP — the first agent-on-the-page proving slice

## Problem Statement

Reading already contains a truthful outbound queue of saved Reading Documents, with search, metadata, provenance, reading length, progress, and safe stored article content. A browser agent cannot currently inspect that queue through page-defined tools. If I ask “what should I read when I want something thoughtful but not exhausting?”, the agent either lacks my saved context or answers from the open web instead of my Library.

Before building the larger Scratch Pad, we need a small, low-risk proof that WebMCP works end to end in Locus: tools register only on the correct page, the user's chosen agent can read bounded Library data, the agent can reason over it, and its requested number of recommendations can appear visibly on the existing Reading page. The proof must not add a Locus-hosted recommendation model, restore an in-app reader, crawl the web, or mutate Reading state.

## Solution

Add a WebMCP adapter to the existing Reading index. When Reading is visible, it exposes four bounded tools backed by the existing Reading module:

- `get_reading_context` returns current Reading filters, counts, and tool capability version. Its legacy mood field remains nullable for contract compatibility; the page does not set it.
- `search_reading` lists or searches the complete non-removed Reading section, including source-only entries for which Locus has metadata and a link but no stored article text.
- `get_reading` returns one safe, bounded Reading Document projection, including stored text when available and the original URL when it is safe to open.
- `present_reading_recommendations` accepts a variable non-empty list of existing Reading Document ids, short agent-authored reasons, and the evidence basis used, then renders them in a temporary recommendation sheet on the Reading page. The array length is the requested count. There is no arbitrary numeric maximum: unique authenticated Library documents with safe source URLs form the dynamic upper bound.

The browser agent performs the recommendation reasoning. Locus does not expose a `recommend_reading` tool because that would misleadingly imply that Locus itself runs a recommender. The user states any preference in their agent prompt, then explicitly asks the agent for recommendations. The agent receives summaries for the whole Reading section—50 entries in one call when the section has 50—uses stored text where Locus has it, and may independently visit safe original URLs when more context is needed. Opening a result uses the existing outbound source link and existing progress behavior.

This is a proving slice for WebMCP registration, trusted Library scoping, bounded reads, a visible non-durable write, navigation cleanup, and browser-agent interoperability. It is separate from Scratch Pad implementation.

## User Stories

### User intent and page behavior

1. As a reader, I want Reading to remain the existing outbound queue, so that WebMCP does not replace a working page.
2. As a reader in a capable browser, I want one concise indication that my browser agent can use Reading, so that I know to ask it for help.
3. As a reader, I want to state free-form preferences in my agent prompt, so that the Reading page does not constrain my request with preset controls.
4. As a reader, I want the capability message itself to perform no inference, so that AI usage remains explicit.
5. As a reader, I want opening Reading to perform no inference, so that browsing the queue remains free of hidden agent work.
6. As a reader, I want clear copy explaining that my browser agent can search, compare, recommend, and present results, so that I understand the available assistance without the page pretending it can initiate an agent turn.
7. As a reader, I want the page to remain fully usable when WebMCP is unavailable, so that this integration is progressive enhancement.
8. As a reader, I want the normal Unread and Finished views, search, filters, sort, progress actions, and outbound links to keep working, so that the proving slice does not regress Reading.

### Tool discovery and scope

9. As a browser-agent user, I want Reading tools registered only while the Reading index is visible, so that the agent's capabilities match the page.
10. As a browser-agent user, I want Reading tools removed when I navigate away, so that stale tools cannot operate outside their context.
11. As a browser-agent user, I want tool descriptions to distinguish Locus reads from the agent's independent browser access, so that it knows when stored text exists and when it may need to inspect the source URL.
12. As a browser-agent user, I want the tool interface to report a capability version, so that compatibility failures are diagnosable.
13. As a browser-agent user, I want repeated route mounting to avoid duplicate tool registration, so that navigation does not produce ambiguous tools.
14. As a browser-agent user, I want an unavailable or unsupported WebMCP runtime to fail quietly in the page UI, so that ordinary Reading still works.
15. As a reader, I want the agent capability message to appear only when a compatible site-tools runtime is detected, so that unsupported browsers do not advertise unavailable behavior.
16. As a reader, I do not want agent tools registered on the public shared-trip page or unrelated Library pages, so that capability scope stays narrow.

### Reading context

17. As a browser agent, I want the legacy mood field to remain nullable for contract compatibility while user intent comes from the prompt.
18. As a browser agent, I want to read the active Unread/Finished view, search, kind, source, and sort filters, so that recommendations can respect what the user is viewing.
19. As a browser agent, I want queue counts, so that I understand whether there is enough material to recommend from.
20. As a browser agent, I want page context without DOM scraping, so that recommendation logic is robust to visual changes.
21. As a reader, I want the context tool to return no article bodies, notes, credentials, or hidden UI state, so that the first tool call is minimal.
22. As a reader, I want changing a filter to be reflected in the next context call, so that the agent uses current page context.

### Search and list

23. As a browser agent, I want to list saved Reading Documents without a search phrase, so that I can browse a small queue.
24. As a browser agent, I want to search title, subtitle, byline, publication, excerpt, host, stored article text, linked Item text, tags, and notes through the existing Reading search, so that recommendations use the same index as the user.
25. As a browser agent, I want to filter by Unread or Finished, so that I can avoid recommending something already completed unless asked.
26. As a browser agent, I want kind and source filters, so that I can honor requests such as “an essay from Reddit saves.”
27. As a browser agent, I want reading length and sort controls, so that “short” and “not exhausting” can be grounded in known duration.
28. As a reader, I want search results to cover every non-removed Reading Document in my Reading section, so that source-only or partially stored entries are not invisible to my agent.
29. As a reader, I want each result to state availability, stored-text availability, and whether the original URL is safe to open, so that the agent knows what evidence it actually has.
30. As a reader, I want search results to include stable document id, title, publication/host, excerpt, kind, reading minutes, saved date, source marks, reading state, and safe original URL, so that an agent can shortlist without fetching every document.
31. As a reader, I want search results to omit raw HTML, content blocks, asset paths, private session data, and internal table fields, so that list calls remain bounded.
32. As a browser agent, I want cursor pagination, so that a large Library can be explored without one enormous response.
33. As a reader, I want one call to return up to 50 summaries with pagination beyond that, so that an ordinary Reading section can be understood without dozens of tool calls.
34. As a reader, I want invalid filters, cursors, sorts, or limits rejected without falling back to a broader query, so that malformed calls do not overexpose data.
35. As a hosted user, I want every search resolved against my authenticated Library, so that cross-account Reading data cannot leak.
36. As a local-only user, I want the same tool behavior using the local Library, so that the proving slice works in both deployment modes.

### Document inspection

37. As a browser agent, I want to inspect one search result by opaque Reading Document id, so that I can judge whether it matches the mood.
38. As a browser agent, I want safe stored title, byline, publication, excerpt, reading length, canonical source, saved provenance summary, normalized article text when present, and explicit availability, so that recommendations can be grounded honestly.
39. As a reader, I want the Locus tool itself to perform no publisher fetch, while still returning the safe source URL my browser agent may inspect independently, so that product responsibilities remain clear.
40. As a reader, I want article text flattened from safe stored blocks and capped to a documented maximum, so that tool responses remain manageable.
41. As a browser agent, I want a truncation marker and total available length when content is capped, so that I know when I saw only part of a document.
42. As a reader, I want documents without stored text to return their bounded metadata, safe URL, and stable availability rather than pretending article content exists, so that they remain usable without being misrepresented.
43. As a reader, I want a missing, removed, foreign-Library, or invented document id to return the same not-found result, so that existence is not disclosed.
44. As a reader, I want raw fetched HTML, binary assets, cookies, credentials, local paths, and video bytes excluded, so that document inspection stays safe.
45. As a reader, I want bounded tag names and note excerpts available only in the provenance context needed for recommendation, so that personal context is useful but not unbounded.
46. As a reader, I want the page to disclose that an invoked browser agent may receive saved metadata and stored article text, so that the data flow is understandable.

### Recommendation presentation

47. As a browser agent, I want to present the user's requested number of selected Reading Documents on the page with the basis I used—stored text, metadata, or inspected original—so that my answer lands visibly and honestly in Locus.
48. As a reader, I want each recommendation to show title, publication/host, reading time, current state, and a short reason, so that I can choose quickly.
49. As a reader, I want the recommendation reason labelled as agent-authored, so that it is not mistaken for publisher text or Locus metadata.
50. As a reader, I want presentation to accept only non-removed Reading Document ids from my Library with a safe original URL, so that an agent cannot inject an arbitrary external recommendation.
51. As a reader, I want duplicate recommendation ids rejected, so that the panel always contains distinct choices.
52. As a reader, I want recommendation reasons bounded and sanitized, so that an agent cannot inject markup or overwhelm the page.
53. As a reader, I want the panel to preserve the requested mood label, so that I remember what the recommendations answer.
54. As a reader, I want new recommendations to replace the previous temporary set, so that the page does not accumulate a recommendation feed.
55. As a reader, I want to dismiss the recommendation sheet with its dismiss control, Escape, or a pointer on the dimmed backdrop, so that I control the page.
56. As a reader, I want recommendations to be non-durable page state, so that testing WebMCP does not create a new recommendation database.
57. As a reader, I want opening a recommendation to use the existing canonical outbound link, so that no in-app reader is introduced.
58. As a reader, I want opening an Unread recommendation to use the existing Opened progress behavior, so that WebMCP does not invent another reading state.
59. As a reader, I want Mark Finished and Mark Unread to remain human UI actions in this proving slice, so that the first WebMCP implementation has no durable mutations.
60. As a reader, I want a clear empty result when the agent finds no suitable match after stored and optional source inspection, so that it does not fabricate one.

### Accessibility, safety, and failure handling

61. As a keyboard user, I want recommendation cards, dismiss, and outbound open controls reachable and operable, so that the feature does not require a pointer.
62. As a screen-reader user, I want recommendation updates announced through a polite live region, so that visible tool success is also perceivable.
63. As a mobile user, I want recommendations in a temporary bottom sheet rather than a permanent side rail, so that they fit a narrow screen.
64. As a reader, I want reduced-motion preferences honored when recommendations appear, so that tool feedback remains comfortable.
65. As a reader, I want a tool failure to leave existing recommendations and Reading state unchanged, so that failures are non-destructive.
66. As a browser agent, I want stable invalid, not-found, unavailable, stale-context, and unsupported results, so that I can recover without guessing.
67. As a reader, I want all tool strings, arrays, query lengths, result limits, ids, and reasons bounded, so that WebMCP is not an arbitrary data channel.
68. As a reader, I want the adapter to derive Library identity from the trusted session, so that a tool cannot select another Library.
69. As a reader, I want no tool for removing Reading Documents, changing progress, retrying fetches, or mutating Items in this first slice, so that the proof remains low risk.
70. As a developer, I want tool calls observable through bounded diagnostics without logging article text or private notes, so that interoperability can be debugged safely.

### Proving-slice completion

71. As a product owner, I want to open Reading in a WebMCP-capable browser and see all four tools, so that registration is proven.
72. As a product owner, I want to ask the browser agent for any practical number of recommendations and see that many real saved Reading Documents appear, so that the full loop is proven without an arbitrary display count.
73. As a product owner, I want the agent's reasons to identify whether they use stored text, metadata, or an independently inspected original, so that recommendation grounding is proven.
74. As a product owner, I want to open one recommendation at its original source, so that existing outbound behavior is preserved.
75. As a product owner, I want navigating to Kitchen or Desk to remove the Reading tools, so that lifecycle cleanup is proven.
76. As a product owner, I want the same Reading page to work normally in a browser without WebMCP, so that progressive enhancement is proven.
77. As a developer, I want the WebMCP adapter tested without a live third-party agent, so that CI remains deterministic.
78. As a developer, I want one manual run with the actual target browser agent recorded before Scratch Pad implementation begins, so that protocol assumptions are verified in the real environment.

## Implementation Decisions

### Scope and seam

- This feature is a standalone proving slice and prerequisite for full Scratch Pad WebMCP implementation.
- Keep the existing Reading module as the only domain/data seam. The WebMCP adapter calls `listReadingDocuments` and `getReadingDocument`; it does not query Reading tables or duplicate search policy.
- Do not add a generic Locus MCP server. Register page-defined WebMCP tools only on the existing Reading index route.
- Do not add a Locus-hosted recommendation model. The user's browser agent searches, reads, reasons, and selects. Therefore the interface deliberately has no `recommend_reading` tool.
- Do not add durable recommendation state. The only write tool updates temporary UI state after validating selected Reading Document ids.

### Page interaction

- Keep Unread/Finished controls and editorial rows unchanged. Recommendations appear only after `present_reading_recommendations`, as a temporary modal sheet over Reading — not an in-list block and not a permanent rail.
- When a compatible runtime is detected, show one compact capability callout explaining that the browser agent can search saved articles, compare them, recommend what to read, and return results to the page. Do not render mood chips, queue-specific prompting, or implementation terms such as WebMCP.
- When the runtime is absent, omit the capability callout and keep ordinary Reading unchanged. Do not label a button “Ask agent” unless the host platform supplies a real, user-initiated agent-prompt operation.
- On wide screens the sheet is a full-height panel from the trailing edge. On narrow screens it is a bottom sheet. While open it is a modal dialog: dimmed backdrop, body scroll locked, initial focus on dismiss, Tab cycles inside the sheet, focus returns to the page on close. Dismiss with the dismiss control, Escape, or a pointer on the backdrop.
- The sheet labels itself as browser-agent recommendations, keeps the mood when one was given, and shows each card’s title, publication/host, reading time, current state, evidence basis, and an agent-authored reason.
- Recommendation appearance uses a restrained write animation and a polite live-region announcement. Honor reduced motion.

### Tool contracts

- `get_reading_context({})` returns:
  - capability version;
  - legacy mood field, currently null;
  - current view, query, kind, source, and sort;
  - unread, reading, preparing, and finished counts;
  - whether WebMCP is currently active.
- `search_reading(input)` accepts optional `q`, `view`, `kind`, `source`, `sort`, `cursor`, and `limit`. It maps to the existing Reading list query.
- `search_reading` defaults to the current page view and filters when an input field is omitted. Explicit tool input overrides page context for that call but does not change the visible Reading filters.
- `search_reading` limit defaults to 50 and is capped at 50. It returns a next cursor and bounded summaries only. It includes every non-removed Reading Document, including pending, metadata-only, blocked, unsupported, errored, unknown-kind, and PDF records, with explicit availability and `hasStoredText`. It never returns raw blocks or article text.
- `search_reading` requires the Reading module to provide an agent-facing all-Reading query rather than reusing only the visual Unread/Finished list projection, which deliberately hides some availability states. Reading Candidates and tombstones remain excluded.
- `get_reading({ documentId })` resolves one same-Library Reading Document through the Reading module. It returns safe display metadata, availability, progress state, canonical URL when safe to open, bounded provenance context, and normalized plain article text when validated stored blocks exist.
- `get_reading` returns at most 30,000 UTF-16 code units of normalized article text, plus `truncated` and `totalTextLength`. It never triggers enrichment, retry, refresh, preview, or publisher fetch.
- Provenance returned to the agent is capped at five Item sources. Each includes source name, saved date, bounded tag names, and at most two note excerpts of 240 characters. Omit captured bodies, credentials, internal paths, and unrelated Item fields.
- `present_reading_recommendations({ mood, recommendations })` accepts a non-empty variable list of `{ documentId, reason, basis }`, where the array length is the requested count and `basis` is `stored_text`, `metadata`, or `external_source`. Every id must be unique and resolve to a recommendable document in the authenticated Library, making the Library size the dynamic maximum. Mood is at most 80 characters; each reason is at most 240 characters.
- Presentation resolves every id through the Reading module under the trusted Library, rejects duplicates, removed documents, and documents without a safe original URL atomically, sanitizes strings, and then replaces the temporary recommendation panel.
- Presentation does not change Reading progress, Items, tags, notes, filters, or durable storage.
- All tools return stable structured outcomes. Do not expose stack traces, SQL, filesystem paths, session values, or raw provider/browser errors.

### Registration lifecycle

- Register the four tools after the Reading index is mounted and the trusted session is ready.
- Registration is idempotent across React development remounts and route revisits.
- Unregister all four tools when Reading unmounts, the authenticated Library changes, or the page loses the Reading route.
- Tool callbacks read current filter state without re-registering on each state change.
- If the WebMCP runtime is absent or registration fails, log one bounded diagnostic in development and render Reading normally. Do not show a blocking error to users.
- Keep adapter diagnostics to tool name, outcome category, duration, and bounded result count. Never log query result bodies, article text, note excerpts, cookies, tokens, or full tool payloads.

### Trust, privacy, and hosted/local behavior

- The trusted HTTP/session adapter supplies Library id. Tool input never contains `libraryId` or actor.
- Hosted Locus uses the authenticated Library. Local-only uses the existing local Library and loopback session/CSRF protections.
- The Reading page discloses that using these tools may provide the chosen browser agent with saved Reading metadata and stored article text.
- Locus tool callbacks perform no external-origin request. Safe canonical URLs are returned to the browser agent, which may independently inspect them while fulfilling the user's explicit recommendation request and report `basis: external_source`.
- This proving slice is read-only with respect to durable Locus data. Do not expose progress, remove, retry, refresh, tag, note, capture, or Item mutation tools.

### Acceptance path

- Seed at least five Reading Documents with varied lengths, publications, tags/notes, and availability, including a thoughtful source-only entry, one thoughtful stored article, and one clearly irrelevant piece.
- In the target WebMCP-capable browser: open Reading, ask the agent for a specific recommendation count, verify it calls context/search/detail as needed, then verify `present_reading_recommendations` visibly renders that many real documents with grounded reasons.
- Open one recommendation and verify the publisher source opens through the existing real link while Locus records its existing Opened behavior.
- Navigate away and verify the Reading tools are absent. Return and verify they register once.
- Repeat the Reading page flow with WebMCP unavailable and verify the ordinary queue is unchanged.

## Testing Decisions

- Test the existing Reading module at its established interface; do not move Reading search or document policy into WebMCP tests.
- Add adapter tests with a fake page-defined WebMCP runtime. Assert exact tool names, schemas, idempotent registration, cleanup, and stable outcomes.
- Test `get_reading_context` against changing filters without re-registration and keep the legacy mood field nullable.
- Test `search_reading` defaults, explicit overrides, 50-result cap, cursor forwarding, all non-removed availability states, availability/stored-text flags, tombstone and Reading Candidate exclusion, malformed input, and Library isolation.
- Test `get_reading` with safe stored blocks, 30,000-character truncation, total length, bounded provenance, note truncation, metadata-only/source-only content, safe URL behavior, removed content, invented ids, and cross-Library ids.
- Test that search and document inspection make no network, retry, enrichment, preview, progress, or database mutation call.
- Test `present_reading_recommendations` for one, two, ten, and more than fifty results; every valid evidence basis; duplicate ids; a list larger than the available Library; missing/foreign/removed/unsafe-url ids; oversized mood/reason; atomic rejection; sanitization; replacement of prior recommendations; and no durable mutation.
- Test trusted Library resolution and confirm `libraryId`/actor cannot be supplied through tool input.
- Test route lifecycle: mount, React development remount, navigate away, navigate back, authenticated Library change, and runtime absence.
- Test bounded diagnostics and explicitly assert that article text, notes, cookies, tokens, and full payloads are not logged.
- Add a browser smoke test using a fake WebMCP runtime to invoke all four registered handlers and assert the visible recommendation panel through accessible names/text rather than component internals.
- Add one manual interoperability test with the actual target browser agent. Record tool discovery, calls, visible presentation, navigation cleanup, and any protocol variance as acceptance evidence.
- Acceptance evidence: [`issues/01-live-agent-interoperability.md`](issues/01-live-agent-interoperability.md) records the passing Codex in-app Browser run and the protocol variance found and fixed.
- Good tests assert externally observable Reading-module or adapter behavior. Do not assert on React component names, CSS geometry, private SQL shape, or browser-agent prose.
- Follow existing prior art: built-in Node test runner, strict assertions, real SQLite databases for Reading behavior, and pure/fake adapters for protocol lifecycle.

## Out of Scope

- Full Scratch Pad, Trip Documents, Atlas tools, Kitchen board tools, Recipe Document WebMCP, or hosted trip sharing.
- A `recommend_reading` server/tool, Locus-hosted recommendation model, embeddings, vector search, or new full-text subsystem.
- An in-app Reading reader, book surface, article rendering, TOC, resume anchor UI, clipping, highlighting, or Reading annotations.
- Durable recommendation history, recommendation Collections/tags, automatic mood inference, or a recommendation feed.
- WebMCP tools that mutate progress, remove/restore Reading Documents, retry/refresh enrichment, modify Items, add tags/notes, capture sources, or open links automatically.
- Publisher fetching by Locus tools, link preview requests, asset downloads, OCR, video transcription, or bypassing unavailable sources. Independent browsing by the user's agent through a returned safe original URL is allowed.
- A generic MCP server, browser extension changes, capture changes, site-pack changes, or named in-app agents.
- Automatically starting an agent from a page load. The user initiates the browser-agent turn.
- Reworking Reading information architecture, filters, sorting, progress semantics, enrichment, storage, archive behavior, or source-opening behavior.

## Further Notes

- This spec extracts and supersedes every Reading WebMCP requirement previously carried by the Scratch Pad spec.
- Use existing domain language: Reading Document, Reading Candidate, provenance, availability, original status, reading state, Item, and Library.
- “Reading Item” in user-facing shorthand means the saved provenance through which a Reading Document entered the Library. Tool payloads should identify the Reading Document and summarize its Item provenance rather than inventing a second entity.
- The visible recommendation sheet is intentionally the one non-durable write in this proving slice. It proves that an agent can read Locus state and place a validated result onto the page without granting durable mutation authority.
- Successful completion is the gate for implementing Scratch Pad WebMCP. Protocol or lifecycle lessons discovered here should update the shared WebMCP adapter design before Atlas and Kitchen tools are built.
