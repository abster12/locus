Type: task
Status: resolved

# Record the live target-agent WebMCP interoperability run

## Finding

P2: the implementation and automated browser coverage existed, but the repository had no durable record of the manual interoperability test required by the Reading WebMCP spec.

## Answer

Result: **PASS**

Tested on 2026-08-30 against the running local Locus server at `http://127.0.0.1:8787/#/reading` using the Codex desktop in-app Browser and its built-in WebMCP/Site tools capability. Site tools were enabled. The browser-agent model identity was not surfaced to the page and is therefore not inferred in this record.

### Tool discovery

The target agent discovered exactly these four page-defined tools while Reading was mounted:

1. `get_reading_context`
2. `search_reading`
3. `get_reading`
4. `present_reading_recommendations`

Discovery exposed each tool's description, JSON input schema, read-only/untrusted-content annotations, origin, and current page URL. The final `present_reading_recommendations` schema accepts a non-empty variable-length array with no fixed `maxItems`; unique recommendable documents in the authenticated Library form the dynamic upper bound.

### Calls exercised by the target agent

- `get_reading_context({})` returned `ok: true`, capability version `1`, the live `surprising` mood, active queue view, current filters/sort, queue counts, and `webmcpActive: true` without article bodies.
- `search_reading({ limit: 5 })` returned five real Library summaries plus a pagination cursor. Results included ready stored-text documents and honest unsupported/error source-only rows.
- `get_reading({ documentId })` retrieved the stored copy of “Rebuilding Linear’s delta sync read path,” including provenance, safe canonical URL, `hasStoredText: true`, 9,076 characters of normalized text, and `truncated: false`. No publisher fetch was performed by Locus.
- `present_reading_recommendations(...)` succeeded with one, three, and five real documents during the manual session. The final five-result run returned `ok: true` and five resolved recommendations with `basis: stored_text`.

### Visible presentation

The five-result call opened a fixed recommendation sheet in the real Reading page rather than returning only chat prose. Manual DOM verification recorded:

- five `.reading-rec` entries;
- sheet summary `5 recommendations for surprising · chosen from your saved reading`;
- `role="dialog"` and `aria-modal="true"`;
- fixed backdrop layer;
- initial focus on `Dismiss recommendations`;
- Escape, backdrop, and keyboard dismiss behavior covered by the browser smoke test.

The sheet is non-durable page state. It does not mutate Reading progress, tags, notes, documents, or recommendations in storage.

### Route lifecycle in the actual target browser

The same Codex tab was navigated through this sequence:

1. `#/reading`: exactly four tools discovered.
2. `#/kitchen`: `No WebMCP tools are available in this document.`
3. `#/reading`: exactly the same four tools discovered again, once each.

This verifies target-browser registration scope, abort-signal cleanup on route exit, and clean re-registration on return.

### Protocol variance found and resolved

The first live attempt exposed zero tools and logged `reading-webmcp register unsupported`. The implementation had been probing the older `navigator.modelContext` plus `unregisterTool` shape. The target browser implements the current WebMCP interface:

- registration through `document.modelContext.registerTool(tool, { signal })`;
- lifecycle cleanup by aborting the supplied signal.

Locus was updated to use that current interface while retaining a wrapped fallback for legacy runtimes. After the change, Codex discovered and invoked all four tools successfully. Tool handles are document snapshots, so the agent fetches tools again after reload or navigation; this matched the target browser's expected behavior.

### Supporting automated evidence

The manual run is supplemented—not replaced—by these passing checks:

- `node --experimental-sqlite --import tsx --test tests/reading-webmcp.test.ts tests/ui-copy.test.ts`
- `node --experimental-sqlite --import tsx --test tests/reading-webmcp-browser.test.ts`
- `npm run typecheck`
- `npm run build`

The adapter suite covers variable result counts including 1, 2, 10, and 75, duplicate/missing/unsafe ids, atomic rejection, Library scoping, bounded diagnostics, and runtime lifecycle. The real-Chrome smoke test invokes all four handlers, verifies the modal sheet through accessible state, dismisses it by keyboard, navigates away, and verifies clean re-registration.

## Comments

- 2026-08-30: Added after the P2 review finding that `.scratch/reading-webmcp/` contained only the spec and no live-agent acceptance record.
