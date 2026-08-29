Status: implemented-base; monetization and WebMCP registration unresolved

# Kitchen — turn Food Items into something usable at dinner

## Summary

Kitchen is a focused view of the Library's Food Items. Every save resolves to one of two honest outcomes: an existing **Recipe Document** shown immediately as a readable **recipe score**, or a source view with one **Make this cookable** action. That action either extracts a source-backed recipe from the captured caption or, after explicit consent, generates a clearly labelled suggested recipe for the dish. Video remains an honest **Watch & Cook** source; Kitchen never claims that an inaccessible Reel was transcribed.

The visual and interaction model follows Reading: one strong primary list, restrained editorial rows, a compact secondary rail, quiet empty states, and controls shown only when they change the current task. Kitchen remains recognizably Locus; it is not a recipe-card grid or a second organizer.

The primary path is AI-assisted. The human correction surface is the recipe score itself, made writable — not a separate construction form. When Locus-hosted inference is available, Locus owns the provider account and users never provide, configure, or see model API keys. A later WebMCP adapter lets the user's own browser agent perform the same operation. Both paths submit through the same durable Recipe Document write and always create drafts. Pricing and entitlement are not decided by this spec.

## Problem statement

Food saves are currently mixed into the Desk. Many are Instagram Reels whose useful content is the video itself; some have a useful caption and some have almost none. Automatic OCR or transcription would be expensive, unreliable, and unable to depend on an agent opening an authenticated Reel.

The user needs three things:

1. a quiet place to find Food Items and see all information Locus actually captured; and
2. a better cooking artifact when a caption contains ingredients and steps; and
3. a short list of recipes to watch or follow while cooking tonight.

## Product position

Kitchen is a **Recipe Box, recipe score, and Tonight**, not a video extraction engine.

The Desk answers “what did I save?” Kitchen answers “which food save do I want to cook from, and what did I choose for tonight?” The Item remains the source of truth. Kitchen does not create a second copy of its caption, tags, notes, status, or media.

A caption-backed save may have one durable Recipe Document linked to its Item. The user can structure or correct it without altering the captured caption. A later browser agent may propose the same structure from caption text through WebMCP. The recipe score is the primary cooking artifact once structure exists.

A sparse Reel is still useful: Kitchen shows its creator and thumbnail, preserves any caption, and gives the user a deliberate route to watch the original. Missing ingredients, quantities, timings, and temperatures remain missing.

## Goals

1. Make Food Items findable without browsing unrelated shelves.
2. Preserve and display the complete captured caption safely.
3. Turn usable captions into editable Recipe Documents through one user action and a hosted inference adapter.
4. Present structured recipes as a compact recipe score that makes ingredient-to-step flow visible.
5. Never silently cross from extraction to invention: ask before generating a suggested recipe and label its provenance.
6. Make video-first recipes usable through an explicit Watch & Cook view.
7. Keep a small, persistent, manually ordered Tonight list.
8. Keep Kitchen state independent of Item organization and triage.
9. Reuse the Reading tab's restrained hierarchy: high information density without a dense interface.
10. Put Kitchen behavior behind one module interface so the human UI and later WebMCP adapter share validation and persistence.
11. Keep existing capture, Instagram, and Stage behavior stable.

## Non-goals

- OCR, speech-to-text, video downloading, frame extraction, or transcript storage.
- Presenting generated recipe facts as though they came from the captured caption or creator.
- Grocery-list generation or ingredient consolidation.
- Shipping WebMCP registration in this release. The future adapter contract is specified so it can call the same module later.
- Candidates, holes, annotations, job switching, ranking, recommendation feeds, meal planning, calendars, nutrition tracking, or pantry inventory.
- A bundled/local model, video inference, or a model requirement for reading and editing existing Recipe Documents.
- Bring-your-own-key settings, provider selection, model selection, token balances, or per-recipe AI billing in the user interface.
- A separate Kitchen taxonomy. Existing tags and the Food shelf remain authoritative.
- Mutating Item status, tags, Collections, or notes as a side effect of Kitchen actions.
- Changing site packs, producers, the Capture Protocol, capture tokens, or Instagram capture.
- Bypassing Instagram authentication, embedding restrictions, or unavailable originals.

## Domain language

Existing language in `CONTEXT.md` remains authoritative:

- An **Item** is one saved post stored by Locus.
- **capture** is how Items reach the Library.
- Tags, Collections, notes, and Item status keep their existing meanings.
- The **Food shelf** is the existing deterministic shelf backed by the tags `food`, `recipe`, `dessert`, and `airfryer`.

This spec introduces:

- **Recipe Box** — the Kitchen projection of currently visible Food Items. It is a view, not stored copies or a Collection.
- **Recipe Document** — one durable structured cooking interpretation linked one-to-one with an Item. It contains ingredients, steps, and source evidence; it is not an Item or replacement caption.
- **recipe score** — the human-readable execution view of a Recipe Document: ingredients on the left, ordered actions on the right, and visible ingredient-to-step relationships.
- **source revision** — a stable digest of the exact caption used when a Recipe Document draft was saved.
- **evidence reference** — an exact span in the source caption, an explicit user-authored fact, or an explicitly AI-generated suggestion.
- **suggested recipe** — a generated draft inspired by the visible dish when its source does not contain a usable recipe. It is never attributed to the source creator.
- **Tonight** — one ordered list of Item references chosen by the user. It is working state, not a tag or Collection.
- **Tonight entry** — one durable reference to an Item in Tonight. The Item may later be missing.
- **Watch & Cook** — the focused Kitchen view for one Item, containing the source video or media when available, the captured caption, and an original-post exit.
- **caption** — the captured Item `body`, displayed as source material. Kitchen does not call it instructions or a complete recipe.

Add these terms to `CONTEXT.md` when implementation begins. Do not call a Tonight entry a recipe, Collection, bookmark, or note. Do not call a Recipe Document an Item.

## Core decisions

### 1. The Item remains the source of truth

Recipe Box stores no copies; it reads the current Item. A Recipe Document stores only structured cooking fields plus the exact normalized source-caption snapshot needed to keep its evidence inspectable after capture changes. It does not copy title, author, media, tags, notes, or Item status.

Tonight stores only an ordered Item reference plus entry identity and timestamps. Adding or removing an entry does not mutate the Item.

### 2. Food membership uses the existing shelf predicate

Recipe Box contains Items that:

- match the existing Food shelf through at least one Food tag; and
- satisfy the normal Desk visibility rule: archived and rejected Items are omitted, while accepted and other normally visible Items remain visible.

Kitchen does not add text heuristics such as matching “cook,” inspect source type, or infer food from media. A missed Item is corrected by adding an existing Food tag through ordinary Desk organization.

The Kitchen module must delegate to or share the same Food predicate used by Desk shelf filtering. It must not copy the four tag names into a second query implementation.

### 3. Captured captions are evidence, not structure

`Item.body`, after trimming only outer whitespace, is the caption. Preserve line breaks, emoji, hashtags, creator wording, and source order. Render links safely using the existing owned link renderer. Do not remove prose URLs from the stored or expanded caption.

`Item.title` may repeat the first part of an Instagram caption. When title and caption are equivalent or the title is a prefix excerpt of the caption, show the caption once rather than repeating it. This is display deduplication only; stored fields remain unchanged.

A non-empty caption may still be incomplete. Kitchen uses neutral copy such as **Caption available**, never **Full recipe**.

### 4. Recipe Documents are structured, editable, and provenance-backed

Each Item may have at most one Recipe Document. Its structured payload contains an optional title and serving/time text, ordered ingredient rows, ordered steps, ingredient-to-step references, evidence references, and the normalized source-caption snapshot used by those references. It stores no video or transcript.

A Recipe Document has state:

- `draft` — structured but not confirmed by the user;
- `reviewed` — explicitly reviewed by the user.

An agent-authored write may create or replace a draft only. Only the human UI may mark a document reviewed. Editing a reviewed document returns it to draft unless the human explicitly saves the edit as reviewed.

Every structured fact records evidence:

- `caption` evidence points to one or more exact character spans in the current caption; or
- `user` evidence means the human deliberately entered information not present in the caption; or
- `generated` evidence means the configured Locus model or the user's WebMCP agent generated a suggestion after explicit consent.

Agent writes may use caption evidence for extraction or generated evidence for an explicitly requested suggested recipe, but never mix the two silently. The Kitchen module validates caption spans exactly and forces every agent-authored write to `draft`. The recipe score shows one quiet provenance label: **From the caption**, **AI-generated suggestion**, or **Edited by you**.

Missing values remain absent. The structured schema has optional quantity, unit, preparation, duration, and temperature fields; an empty field is preferable to a guess. The recipe score shows useful omissions quietly and never invents placeholders such as “to taste” unless those words came from the caption or user.

### 5. Source changes never overwrite work

The source revision is computed from the exact normalized caption used by the draft. Every recipe write supplies its expected source revision.

- A mismatched expected revision fails with 409 and leaves the Recipe Document unchanged.
- When capture later changes the Item caption, preserve the existing Recipe Document and report `sourceChanged: true`.
- The UI shows **Caption changed** and offers Compare/Edit. It never silently regenerates or discards a user-reviewed document.
- Saving against the new caption records the new revision.

### 6. Make this cookable is the primary path

When no Recipe Document exists, the primary action is **Make this cookable**. The configured inference adapter first attempts extraction from the Item title and complete stored caption. If the caption supports a recipe, it returns a source-backed draft and Kitchen opens the recipe score. If it does not, Kitchen must stop and ask: **“The original recipe isn't available. Generate a suggested recipe for this dish?”** Only an affirmative user action may run generation.

After a draft exists, correction happens on the same recipe score. Ordinary use must not require selecting evidence spans or assigning every ingredient before the score is readable. The writable score supports correcting, adding, removing, reordering, reviewing, and inspecting provenance. Manual edits become user evidence. A blank score (manual fallback when no document exists) uses the same layout: the timeline is built beat by beat.

The inference adapter is provider-neutral and contains no Kitchen policy. The server validates and persists its bounded structured result, caches unchanged work by Item/source revision/task/prompt/model version, and never blocks capture or Recipe Box rendering.

### 7. Locus AI and WebMCP submit the same draft

Locus AI is the default path when Locus-hosted inference is available. Locus selects the provider/model, stores deployment credentials server-side, pays provider costs, and may apply private operational limits or abuse controls without exposing token accounting to the user. The client never accepts an API key.

**Use my agent** occupies the secondary action slot only when WebMCP is actually available. It is not BYOK and does not appear as a disabled or dead control. Users do not choose a provider or model on every recipe. The browser agent does not need Instagram access because Locus returns the stored caption directly. The adapter exposes:

- `get_recipe_source` — return the Item's title, complete caption, source revision, and current Recipe Document;
- `propose_recipe` — accept an expected source revision, declared provenance (`caption` or `generated`), and a bounded structured draft. Generated provenance requires the same explicit user consent as Locus AI.

Both hosted inference and WebMCP interpretation call the same Kitchen module write with `actor = agent`, which forces `status = draft` and validates declared evidence. A successful call changes the visible Recipe Document and opens the recipe score for review.

WebMCP registration remains a later adapter. Video-only Items may produce a suggested recipe only from the bounded title/caption after consent; neither path claims to inspect inaccessible media.

### 7a. Monetization is an open product question

One possibility is a **US$5/month subscription** that includes Locus-hosted recipe inference, with Locus absorbing provider costs. This is a hypothesis only: the price, plan name, allowance, trial, paywall, billing provider, and entitlement rules are not approved or implemented. Kitchen inference must stay behind a replaceable access-policy seam so this option can be tested without baking it into Recipe Documents, API payloads, or interface copy.

### 8. Video is watched only after an explicit action

Mounting or scrolling Recipe Box must not create Instagram or YouTube embeds. Watch & Cook may create an embed only after the user opens an Item.

Reuse the existing Stage URL classification and embed URL helpers rather than creating a second platform parser. Watch & Cook owns its focused layout; it must not include Stage's summary, tagging, Collection, or note controls.

For Instagram `/reel/`, `/p/`, or `/tv/` Items, attempt the existing Instagram embed. For YouTube Items, use the existing privacy-enhanced embed. For captured `media.kind = video`, use the native video element. Otherwise show captured media and source text.

An **Open original** action is always visible for a safe HTTP(S) Item URL. It opens a new tab with `noopener,noreferrer`. Embedding failure never hides the caption or original action. Kitchen does not claim to detect every cross-origin embed failure; the original action is the reliable fallback.

### 9. Tonight is manual and singular

There is one Tonight list per Library, with no dates or history in this release.

- The user may add a current Recipe Box Item.
- One Item may appear at most once.
- Re-adding an existing Item is idempotent and returns the existing entry.
- The user may remove one entry, reorder all entries, or clear Tonight after confirmation.
- Adding appends to the end.
- Ordering is dense and deterministic.
- Tonight survives refresh and process restart.

An Item that later loses its Food tag, becomes archived/rejected, or leaves ordinary Desk visibility remains on Tonight until the user removes it. It is a deliberate choice, not a live shelf query.

If an Item is deleted, Tonight retains a broken entry showing **Missing Item** and a Remove action. It does not invent title, media, or source data and does not silently drop history.

### 10. Kitchen is quiet by default

Recipe Box is the primary surface. Tonight is secondary and compact. Kitchen does not open with a hero, dashboard, recommendation carousel, category grid, or empty chopping-board illustration.

The first useful action is visible without explanation: search, choose an Item, then open its recipe score, structure its caption, Watch & Cook, or Add to Tonight.

### 11. WebMCP remains a later adapter

The Kitchen UI and HTTP handlers call one Kitchen module interface. This release registers no browser tools. The future recipe tools described above and the later scratch-pad adapter reuse that seam without rewriting Recipe Document validation, Food membership, or Tonight persistence.

Implement the actor/evidence invariants in the module now because both the human UI and named future adapter use them. Do not register tools or build candidates, holes, annotations, or job switching in this change.

## Kitchen module and interface

Create one Kitchen module whose interface is the test surface. It owns Food membership, Recipe Document validation and state, evidence validation, source revisions, Kitchen availability labels, Tonight invariants, ordering, missing-Item behavior, and returned view models.

Conceptual interface:

```ts
type KitchenQuery = {
  q?: string;
  source?: string;
  cursor?: string;
  limit?: number;
};

type KitchenAvailability = "reviewed" | "draft" | "caption" | "watch" | "source_only";

type CaptionSpan = { start: number; end: number; text: string };
type RecipeEvidence =
  | { kind: "caption"; spans: CaptionSpan[] }
  | { kind: "user" };

type RecipeIngredientV1 = {
  id: string;
  raw: string;
  quantity?: string;
  unit?: string;
  name: string;
  preparation?: string;
  group?: string;
  evidence: RecipeEvidence;
};

type RecipeStepV1 = {
  id: string;
  instruction: string;
  ingredientIds: string[];
  duration?: string;
  temperature?: string;
  evidence: RecipeEvidence;
};

type RecipeDraftV1 = {
  version: 1;
  title?: string;
  titleEvidence?: RecipeEvidence;
  servings?: string;
  servingsEvidence?: RecipeEvidence;
  totalTime?: string;
  totalTimeEvidence?: RecipeEvidence;
  ingredients: RecipeIngredientV1[];
  steps: RecipeStepV1[];
};

type RecipeDocument = {
  id: string;
  itemId: string;
  status: "draft" | "reviewed";
  sourceRevision: string;
  sourceCaption: string;
  sourceChanged: boolean;
  updatedBy: "user" | "agent";
  draft: RecipeDraftV1;
  createdAt: string;
  updatedAt: string;
};

type KitchenItem = {
  item: ItemCard;
  availability: KitchenAvailability;
  caption: string | null;
  canWatch: boolean;
  recipe: RecipeDocument | null;
};

type TonightEntry = {
  id: string;
  itemId: string;
  order: number;
  createdAt: string;
  item: KitchenItem | null;
};

getKitchenIndex(db, libraryId, query): {
  items: KitchenItem[];
  nextCursor: string | null;
  counts: { recipes: number; tonight: number };
};

getKitchenItem(db, libraryId, itemId): KitchenItem | null;
putRecipeDocument(db, libraryId, itemId, input, actor, now): RecipeDocument;
removeRecipeDocument(db, libraryId, itemId): boolean;
getTonight(db, libraryId): TonightEntry[];
addTonight(db, libraryId, itemId, now): TonightEntry;
reorderTonight(db, libraryId, orderedEntryIds, now): TonightEntry[];
removeTonight(db, libraryId, entryId): boolean;
clearTonight(db, libraryId): number;
```

The exact TypeScript names may follow repository conventions, but callers and tests must cross this seam rather than reimplementing its rules in React or HTTP handlers.

The recipe write input contains `expectedSourceRevision`, `status`, and `draft`. The module computes current source revision itself; callers cannot submit a replacement caption. `actor = agent` forces draft status and rejects user evidence. `actor = user` may save draft or reviewed and may use caption or user evidence. Every present top-level fact has matching evidence; optional fact/evidence pairs must be present or absent together.

Structured bounds:

- title: optional, 1–200 characters when present; detail falls back to the Item display title;
- servings and total time: at most 80 characters each;
- ingredients: 1–200, each `raw` at most 500 and each parsed field at most 200 characters;
- steps: 1–100, each instruction at most 2,000 characters;
- at most 50 ingredient references per step;
- ids: caller-generated opaque strings matching the repository's bounded id policy, unique inside the document;
- payload: at most 256 KiB after JSON encoding.

Every referenced ingredient id must exist exactly once. Arrays define order. Unknown fields, unknown schema versions, empty ingredient names, empty instructions, invalid spans, and out-of-bounds text fail the whole write. Spans within one evidence list are sorted and non-overlapping; different ingredients or steps may cite the same source text. Caption spans use JavaScript UTF-16 code-unit offsets over the normalized caption (`CRLF` to `LF`, then outer trim), so emoji offsets round-trip through browser selection and server validation. `text` must exactly equal `caption.slice(start, end)` and be non-empty. Source revision is the SHA-256 digest of that exact normalized UTF-8 string. The module stores that normalized caption as `sourceCaption` when the write succeeds.

Availability is a display aid:

- `reviewed`: a reviewed Recipe Document exists;
- `draft`: a draft Recipe Document exists;
- `caption`: a non-empty caption exists; `canWatch` may also be true;
- `watch`: no caption exists and the source/media can be watched;
- `source_only`: neither condition is true, but the Item still has its original link and captured metadata.

Direct Kitchen detail lookup returns an Item when it currently belongs to Recipe Box **or** has a Tonight entry. Other Item ids return 404 through HTTP.

## Persistence

Add two Library-scoped tables:

```sql
CREATE TABLE kitchen_recipe_documents (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'reviewed')),
  source_revision TEXT NOT NULL,
  source_caption TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (updated_by IN ('user', 'agent')),
  draft_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(library_id, item_id),
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE TABLE kitchen_tonight_entries (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(library_id, item_id),
  UNIQUE(library_id, position)
);

CREATE INDEX kitchen_tonight_library_position
  ON kitchen_tonight_entries(library_id, position);

CREATE INDEX kitchen_recipe_library_item
  ON kitchen_recipe_documents(library_id, item_id);
```

The Recipe Document foreign key cascades because structure has no meaning without its Item provenance. The Tonight `item_id` intentionally has no deleting foreign key: broken entries must survive Item deletion. All Kitchen queries and mutations are scoped by `library_id`; localhost resolves the fixed `local` Library.

Reordering runs in one transaction. The submitted ids must contain every current entry exactly once, with no duplicates or foreign-Library ids. On mismatch return a conflict and leave order unchanged. Rewrite positions safely inside the transaction, then normalize to `0..n-1`.

Migration is idempotent and preserves all existing data. Delete Library clears Recipe Documents and Tonight entries. Library export/import includes both as durable Library data. Import validates Recipe Document schema, bounds, evidence spans, source caption/revision integrity, and existing Item provenance before insertion. It rewrites `library_id` to the current Library. Tonight import permits a missing `item_id` so broken entries round-trip intentionally. Generic capture JSONL import restores neither Recipe Documents nor Tonight.

## HTTP interface

All routes resolve the Library from the existing desk session. Clients never submit `library_id`.

### `GET /api/kitchen`

Query:

- `q` — bounded search text;
- `source` — existing source id;
- `cursor` — opaque stable cursor;
- `limit` — default 50, maximum 100.

Response:

```json
{
  "items": [],
  "nextCursor": null,
  "counts": { "recipes": 0, "tonight": 0 }
}
```

Search covers the same Item fields as Desk: title, body, author, tags, and notes. Food membership and normal visibility are always applied. Pagination uses the existing Item ordering and stable Item-id tie-breaker.

### `GET /api/kitchen/items/:id`

Returns one `KitchenItem`, including its Recipe Document when present, for recipe score, editing, or Watch & Cook. Return 404 when the Item does not exist or is neither a current Recipe Box member nor referenced by Tonight. A missing Item referenced by Tonight is represented only through the Tonight response; this route remains 404.

### `GET /api/kitchen/ai`

Returns only bounded product availability and user-facing detail. It never returns provider identity, model identity, credentials, token usage, or deployment configuration. A future hosted access policy may combine commercial entitlement with service health, but no plan is assumed here.

### `POST /api/kitchen/items/:id/make-cookable`

Body: `{ "allowGenerate": false }` for source extraction. A successful extraction stores an agent-authored draft and returns `{ "outcome": "created", "document": ... }`. Insufficient source returns `{ "outcome": "needs_generation", "dish": "..." }` without writing a Recipe Document. Only the explicit confirmation request `{ "allowGenerate": true }` may create a draft with generated evidence. Provider and malformed-output failures leave the source and any existing Recipe Document unchanged.

Provider credentials are deployment secrets supplied by Locus infrastructure, never request fields, cookies, Library settings, or browser storage. A future account layer may gate this route according to the commercial model eventually chosen. Rate and abuse limits are server policy and must not turn the Kitchen UI into a token meter.

### `POST /api/kitchen/items/:id/recipe`

Body:

```json
{
  "expectedSourceRevision": "...",
  "status": "draft",
  "draft": {
    "version": 1,
    "title": "Paneer tikka",
    "titleEvidence": { "kind": "user" },
    "ingredients": [
      {
        "id": "ingredient-1",
        "raw": "200 g paneer",
        "quantity": "200",
        "unit": "g",
        "name": "paneer",
        "evidence": { "kind": "user" }
      }
    ],
    "steps": []
  }
}
```

This is the human write adapter and calls `putRecipeDocument(..., actor = "user")`. Each accepted in-place change posts the full current draft through this route; there is no per-field write. The Item must exist and be a current Recipe Box member or referenced by Tonight. The source revision must match the current normalized Item caption, including the empty-caption revision for deliberate manual recipes. Validate the entire payload before one insert/update transaction. Incomplete working rows that have not been accepted are omitted from the payload. Return 409 on source mismatch and 400 on schema/evidence failure.

Saving `status = reviewed` is the explicit human review action. A document requires at least one ingredient or one step; partial source material is valid in both states. Reviewed means the human confirmed the representation, not that the source contained a complete recipe. All ingredient references must resolve. Missing optional recipe facts remain valid.

### `POST /api/kitchen/items/:id/recipe/remove`

Remove only the structured Recipe Document and return to caption/watch/source-only presentation. Confirm in the UI when the document has user evidence or is reviewed. The Item and Tonight entry remain unchanged.

### Future WebMCP adapter contract (not registered now)

On `#/kitchen/<item-id>`, `get_recipe_source` has no Item-id argument: the adapter binds it to the visible route Item and maps to `getKitchenItem`. It returns only the bounded source fields needed for structuring: Item id, display title, normalized caption, source revision, and current Recipe Document. It does not return credentials, hidden page state, or video bytes.

`propose_recipe` is bound to the same visible route Item and accepts the draft shape, expected revision, and declared provenance, then calls `putRecipeDocument(..., actor = "agent", status = "draft")`. The module rejects user evidence, unsupported caption claims, generation without consent, mixed agent provenance, stale revisions, and invalid references.

A later adapter registers these two tools only on an open Kitchen detail route and unregisters them on route change, following the scratch-pad tool-lifecycle decision. Recipe Box-wide search tools belong to the later scratch-pad scope. This HTTP release does not expose an `actor` field to clients and does not add an unauthenticated agent route.

### `GET /api/kitchen/tonight`

Returns all entries in ascending position. Missing Items return `item: null`.

### `POST /api/kitchen/tonight`

Body: `{ "itemId": "..." }`.

The Item must exist, currently match the Food shelf, and satisfy normal Desk visibility. Return 404 for a missing Item and 409 for a real Item that is not eligible. Append or return the existing entry idempotently.

### `POST /api/kitchen/tonight/reorder`

Body: `{ "entryIds": ["..."] }`.

The list must exactly match the current Library's Tonight entries. Return 409 without mutation when stale or malformed.

### `POST /api/kitchen/tonight/:id/remove`

Remove only the scoped entry. Return 404 without disclosing another Library's entry.

### `POST /api/kitchen/tonight/clear`

Clear the scoped list and return the removed count. The UI confirms first. This never deletes or mutates Items.

All mutations use existing session, CSRF, loopback, body-size, and JSON validation rules.

## Information architecture

### Navigation

Primary tabs become:

`Desk · Kitchen · Atlas · Reading · Sources`

Remove Shelves from primary navigation. Shelf browsing remains in the Desk rail. `#/shelves` redirects with history replacement to `#/recent`; existing external or restored hashes do not land on a dead page. Collections remain reachable through their existing Shelves footer replacement: add a quiet **Collections** link at the bottom of the Desk rail.

Routes:

- `#/kitchen` — Recipe Box with Tonight;
- `#/kitchen/<item-id>` — recipe score when structured, otherwise Watch & Cook;
- `#/kitchen/<item-id>/edit` — the recipe score in edit mode (same page, writable);
- `#/shelves` — compatibility redirect to `#/recent`.

Kitchen search, source filter, pagination state, and approximate scroll position survive navigation to Watch & Cook and back during the browser session.

### Index hierarchy

The header contains:

- `h1`: **Kitchen**;
- count: **“42 recipes · 3 tonight”**, omitting the Tonight phrase when zero;
- subtitle: **“Food saves, ready when you are.”**;
- Kitchen-local search;
- one Source filter control, hidden when the Library has only one represented source.

There is no state switch, sort menu, shelf chooser, tag-chip row, availability filter, or view-density toggle. Recently saved is the only ordering in this release. Search covers both Item source fields and structured recipe title, ingredient text, and step text.

The main column is **Recipe Box**. On wide screens the secondary rail is **Tonight**. Do not repeat “Recipe Box” as a large decorative heading when the page hierarchy is already clear; a small section label is sufficient.

### Recipe Box row

Use a restrained editorial row, not a masonry or card grid. Each row contains only:

- optional 144 × 96 captured thumbnail;
- a concise display title, up to two lines;
- caption preview, up to two lines, when it does not duplicate the title;
- creator/handle, source mark, and saved date;
- one quiet availability label: **Reviewed recipe**, **Draft recipe**, **Caption available**, **Watch recipe**, or **Source only**;
- primary internal link: **Open recipe** when structured, otherwise **Make this cookable**;
- `+ Tonight` action, changing to **On Tonight** when present;
- overflow with **Open original** only.

Title fallback order:

1. non-duplicative `Item.title`;
2. first meaningful line of the caption, bounded for display;
3. creator plus source kind, such as **“@name’s Reel”**;
4. **“Saved food Item”**.

The row itself may open its default detail (recipe score when structured, otherwise Watch & Cook), but nested actions must remain independent keyboard targets. Adding to Tonight must not open the row.

Do not show tags, Collections, notes, archive controls, summaries, ingredient chips, nutrition, ratings, or completeness meters. A structured serving/time value may appear as compact metadata because it belongs to the Recipe Document.

### Tonight rail

Tonight is a compact ordered list, not a second full card list. Each entry contains:

- drag handle plus keyboard Move up/Move down alternatives;
- small thumbnail when available;
- one-line title;
- source mark;
- open action;
- remove action.

Show at most the first five entries without internal scrolling; Tonight itself is expected to remain small, but all entries remain accessible when longer. Use page scrolling rather than a nested scroll region unless measured layout requires otherwise.

When empty, show one line: **“Add something from the Recipe Box.”** No illustration or empty board. Show **Clear Tonight** only when at least two entries exist; require confirmation and restore focus sensibly after completion.

A broken entry reads **“Missing Item”**, has no fabricated metadata, and offers Remove.

### Recipe score

When a Recipe Document exists, its recipe score is the default detail view. The immutable source Item remains visible through creator/source, **Source caption**, Watch source, and Open original actions.

Header:

- Back to Kitchen;
- recipe title;
- **Draft** or **Reviewed** state;
- servings/total time only when present;
- Edit;
- `+ Tonight` or **On Tonight**;
- Watch source when watchable;
- Open original ↗.

Desktop score:

- ingredients and every source-provided measurement occupy a stable left column;
- a fixed centre column contains one continuous vertical timeline spine and a numbered circle for each ordered step;
- ordered method text occupies the wider right column;
- each row's ingredient group, numbered node, and method are vertically centred on the same line regardless of content height;
- each ingredient aligns with the first step that uses it;
- subsequent uses are indicated quietly without crossing lines through text;
- ingredient groups and step order remain readable without understanding the visual spine;
- selecting/focusing a step highlights its referenced ingredients;
- selecting/focusing an ingredient highlights every step that references it.

The numbered circle always represents sequence. When `duration` is present, show it beside the method as a compact print-red box; do not replace the step number with time. Temperature is separate, quieter metadata. Missing timing remains absent rather than becoming a placeholder or estimate.

Preserve multiple source measurement systems. The score shows the parsed `quantity`/`unit` representation and retains a differing `raw` source representation alongside it, so source text such as `4 oz (115 g)` or `1 cup (200 g)` remains available. Kitchen does not discard one unit system, silently choose a preferred system, or calculate a conversion that the source did not provide.

This is inspired by the attached ingredient/action chart and ReUI's restrained timeline/stepper composition, but uses semantic HTML lists under the visual layout. The spine is orientation, not the only representation of a relationship; no curly brace, stretched SVG connector, or diagram coordinates are stored or rendered.

Mobile score keeps the numbered spine in a narrow leading column. Each row stacks its compact ingredient measurements above the method in the content column, wraps long values normally, and never creates horizontal diagram overflow.

Unreferenced ingredients appear in a quiet **Not placed in a step** group. Steps with no ingredient references remain valid for actions such as preheating or resting. Drafts may show a small **Needs review** note; do not scatter warning badges over every omitted optional field.

The complete captured source is under one collapsed **Source caption** disclosure after the score. One quiet score-level provenance label distinguishes **From the caption**, **AI-generated suggestion**, and **Edited by you**. Detailed evidence is available on demand rather than scattered across the score. A changed current caption adds one compact **Caption changed** notice with Compare/Edit; the score remains usable.

### Recipe correction and review

The recipe score is the editor. **Edit** and `#/kitchen/<item-id>/edit` make that same score writable. A populated document and a blank manual recipe share the page. Interaction, units, ticks, and the blank-recipe composer are specified in `in-place-edit.md`.

### Watch & Cook

Watch & Cook is the default detail when no Recipe Document exists and remains available as **Watch source** when one does. It replaces the index content under the persistent Locus masthead and tabs. It is not a modal and does not reuse the Stage's organization/AI footer.

Header:

- Back to Kitchen;
- display title and creator/source;
- **Make this cookable** when the user wants a readable Recipe Document;
- `+ Tonight` or **On Tonight**;
- **Open original ↗**.

Body priority:

1. watchable embed/native video or captured media;
2. heading **Captured caption** and the complete caption;
3. source-only message when no caption exists.

For video-first Items without captions, show:

> This recipe lives in the video. Watch it here, or open the original if playback is unavailable.

For non-video Items without captions, show:

> No caption was captured. Open the original for the source.

The full caption uses readable body type, preserves paragraphs and line breaks, and has a comfortable line length. Long captions remain in normal page flow; do not place them in a fixed-height scroller or truncate them behind “Read more.” URLs are safe links. Hashtags remain text unless existing safe rendering already makes them inert.

The view does not include step checkboxes, timers, wake lock, screen-always-on behavior, notes, or background extraction. Inference starts only after **Make this cookable**. Structured correction is the recipe score in edit mode.

### Empty states

- No Food Items: **“No food saves yet. Add a Food tag to an Item on the Desk and it will appear here.”** Link to Desk.
- Search/source yields none: **“No recipes match these filters.”** Offer Clear filters.
- Tonight empty: the compact rail copy above; it does not replace Recipe Box.
- Item removed while Watch & Cook is open: **“This Item is no longer in the Library.”** Offer Back to Kitchen.
- Index request fails: keep the page shell and controls stable, show one concise retry action.

## Visual direction

Kitchen should feel as quiet and information-rich as Reading while carrying a subtle food-work identity.

- Keep the existing cool-paper/true-black tokens, print-red accent, source marks, type scale, focus treatment, and thin-rule hierarchy.
- Use the Food shelf's tomato pigment only for a small bowl motif, availability mark, or Tonight accent. It must not become a colored card border or large background wash.
- Use one editorial list rhythm with generous row spacing and restrained hover lift.
- Captured food media supplies the appetite; the surrounding interface stays neutral.
- Make the recipe score the one distinctive Kitchen object: a fine vertical spine, centred numbered nodes, and restrained metadata express execution flow without turning the page into a diagram editor.
- Use handwriting nowhere in this base release. Ingredient, method, caption, and editable score text prioritize legibility.
- Motion communicates a write: a row may settle briefly into Tonight after Add. There is no idle animation, steam, bouncing utensils, or looping decoration.
- Skeletons match final row geometry and honor reduced motion.
- Avoid warm parchment, wood textures, recipe-card skeuomorphism, dense grids, carousels, and dashboard statistics.

## Responsive behavior

### Wide desktop (≥ 1100 px)

- Main Recipe Box column up to 820 px plus a 240–280 px Tonight rail.
- Recipe score uses the ingredient/action columns above. Edit mode uses that same score; the caption stays in its disclosure.
- Watch & Cook uses a centered readable column; video may be wider than caption text without exceeding the content region.

### Tablet (700–1099 px)

- One primary column.
- Tonight opens from a compact **Tonight (N)** control as an anchored panel or sheet; Recipe Box remains first.
- Watch & Cook stacks media above caption.
- Recipe score linearizes in view and in edit mode; working edits survive viewport changes.

### Mobile (< 700 px)

- One column with Recipe Box first.
- A two-state control exposes **Recipes** and **Tonight (N)**; default is Recipes.
- Row thumbnails shrink to 96 × 72 or disappear when space is constrained.
- Watch & Cook media is full content width and caption follows in normal flow.
- Recipe score uses the linear method described above in view and in edit mode.
- Add, Open, Remove, reorder, filter, and back targets are at least 44 × 44 CSS px.
- At 320 CSS px there is no horizontal page overflow or clipped control text.

## Accessibility

- One `h1` per route; use ordered headings below it.
- Recipe Box and Tonight are semantic lists. Rows are list items/articles.
- Recipe score ingredients and steps are semantic ordered/unordered lists. The visual spine is decorative; numbered nodes retain accessible step-order labels.
- Ingredient/step highlighting works with focus as well as pointer hover and does not hide unrelated content.
- Every in-place field, tick, and cross is labelled. Ingredient fields are single-line. Reorder controls have keyboard alternatives.
- Watch & Cook is ordinary page content, not an unnecessarily modal dialog.
- Internal route and original-source actions are real links.
- Source filter exposes name, expanded/selected state, and keyboard behavior.
- Tonight drag-and-drop has keyboard Move up/Move down controls and announces the new position through a polite live region.
- Add/remove/clear success and request failures use polite live regions without stealing focus.
- Focus is visible and follows existing rounded control geometry.
- Media thumbnails use empty alt; Kitchen does not invent image descriptions.
- Video controls remain available. Iframes have source-specific titles.
- Contrast meets WCAG AA in light and dark themes.
- Reduced motion disables settling animation and skeleton shimmer.
- At 200% zoom, Recipe Box, Tonight, recipe score (view and edit), and Watch & Cook remain operable without two-dimensional scrolling.

## Privacy and security

- Treat Item title, body, author fields, media URLs, and source URLs as untrusted.
- Treat Recipe Document JSON and future tool input as untrusted even after schema validation.
- Render captions through owned React elements; never use source HTML.
- Render recipe fields through owned text elements; timeline layout never injects SVG/HTML from the document.
- Reuse existing URL sanitization, embed allowlists, and external-link policy.
- Recipe Box creates no Instagram/YouTube iframe and no new link-preview request.
- Watch & Cook contacts a platform only after explicit user navigation to the Item.
- Use `referrerPolicy="no-referrer"` where supported for media/iframes and `noopener,noreferrer` for new tabs.
- No credentials, cookies, media bytes, or transcripts are copied into Kitchen state or sent to inference. After the user's action, only the bounded display title and stored caption are sent to the configured provider.
- Every mutation is Library-scoped and protected by existing session/CSRF/loopback rules.
- Bound search text, page size, reorder list length, and all request bodies.
- Validate source revisions, schema version, evidence spans, ingredient references, actor permissions, and structured payload bounds inside the Kitchen module, not only at HTTP/WebMCP adapters.

## Performance requirements

- `GET /api/kitchen` is paginated and returns counts independent of the loaded page.
- The index reuses the bounded Item summary shape and never returns duplicate caption storage or Tonight payload per page.
- Recipe Box summaries include only Recipe Document id, state, title, optional serving/time text, and source-changed flag; ingredient/step payload loads on detail.
- Initial render for 1,000 Food Items does not load all Items into the browser.
- Recipe Box mounting and scrolling make zero embed or link-preview requests.
- Search debounces and aborts stale requests as Reading does.
- Adding/removing/reordering Tonight patches local state or refreshes only Tonight; it does not refetch every Recipe Box page.
- Stable pagination has Item id as its final tie-breaker.
- Reorder is bounded to 100 Tonight entries. Adding the 101st returns 409 with a clear message; this is a safety cap, not a product target.
- A 200-ingredient/100-step document renders and edits without blocking the main thread for more than one frame budget during ordinary interaction; timeline layout is CSS-driven and performs no document-specific geometry calculation.

## Loading, errors, and recovery

- Keep the Kitchen header and controls mounted while rows load; use geometry-matched skeleton rows.
- Abort stale list requests when search/source changes.
- A failed list request shows Retry without clearing a previously rendered Tonight rail.
- A failed Tonight mutation leaves the prior visible order intact and announces the error.
- Duplicate Add is success and resolves to **On Tonight**.
- A stale reorder returns 409; reload Tonight and tell the user the list changed.
- Embed failure leaves caption and Open original usable.
- Missing Item entries remain removable.
- A stale recipe save preserves the working copy, reloads the changed caption only after user confirmation, and offers comparison.
- Invalid future agent drafts fail atomically and never replace the last valid Recipe Document.

## Export, import, and Library deletion

Recipe Documents and Tonight entries are durable Library data and round-trip through the library archive. Recipe export includes schema version, state, source-caption snapshot/revision, evidence, structured payload, actor, and timestamps. Tonight contains only entry id, Item reference, position, and timestamps. Broken Tonight references are valid; orphan Recipe Documents are not.

Delete Library removes Recipe Documents and Tonight entries. Restoring an archive into an empty Library restores Recipe Documents after Items, then Tonight order; missing Tonight Item references remain broken pins. Capture JSONL import affects Items only.

## Acceptance criteria

### Membership and correctness

- Recipe Box membership exactly matches Desk's Food shelf predicate under the normal Desk visibility rule.
- Unknown and non-Food tags do not place an Item in Kitchen.
- Archived and rejected Food Items are absent from Recipe Box.
- A Food Item already on Tonight remains there after tag removal or archive/reject.
- Search matches title, caption/body, author, tags, and notes while retaining Food membership.
- Source and search combine with stable pagination and correct full counts.
- The complete stored caption is available in Watch & Cook with line breaks preserved and no source HTML execution.
- Duplicate title/caption excerpts are not rendered twice.
- Kitchen never labels a caption as complete instructions or fills missing recipe facts.
- One Item has at most one Recipe Document; saving structure does not alter the Item caption or organization.
- A source revision always hashes the exact stored source-caption snapshot.
- Current-caption changes preserve the Recipe Document and report source changed.
- Every caption evidence span resolves exactly against the stored source snapshot; user evidence is visibly distinct.
- Agent-actor module writes can save caption-backed or explicitly generated drafts and cannot mark reviewed.
- User-actor writes may deliberately add user evidence and explicitly mark reviewed.

### Recipe Box and Watch & Cook

- The default page has one restrained Recipe Box list and a compact Tonight rail; no recipe-card grid or recommendation section appears.
- Every row communicates title/fallback, creator/source, saved context, structure/watch availability, open action, and Tonight state.
- Opening Watch & Cook does not mutate Item status or Tonight.
- Recipe Box does not mount platform embeds or request link previews.
- Watch & Cook attempts an allowed embed only after explicit navigation and always offers Open original.
- Video-only copy is honest when the caption is absent.
- A long caption is readable in normal page flow without truncation or nested scrolling.
- Returning from Watch & Cook restores index query and approximate scroll position.
- A structured Item opens the recipe score by default; its source video and caption remain reachable.
- Desktop score shows ingredient-to-step relationships as a centre-aligned vertical timeline; every numbered node is geometrically centred on its row and spine.
- A step duration, when present, appears in a print-red box beside the method while the centre node remains the step number.
- Source-provided alternate measurements remain visible rather than being normalized away.
- Mobile score is a readable linear timeline with compact per-step ingredients and no horizontal diagram overflow.
- **Make this cookable** creates a caption-backed draft when possible; insufficient source stops at a consent prompt before any suggested recipe is generated.
- Correction happens on the writable recipe score. A tick writes that unit; clicking away does not. Suggested-ingredient chips are not used. Manual evidence-span selection and ingredient linking are not the entry path.
- Removing structure leaves the Item and Tonight entry intact.

### Tonight

- Add appends one entry and is idempotent for the same Item.
- Add rejects missing, non-Food, archived, and rejected Items without mutation.
- Remove deletes only the Tonight entry, never the Item.
- Reorder accepts every current entry exactly once and persists dense order across restart.
- Stale, duplicate, omitted, foreign-Library, or invented reorder ids fail atomically.
- Clear requires UI confirmation and removes no Items.
- Removing a Food tag or changing Item status does not silently remove a Tonight entry.
- Deleting an Item leaves a removable Missing Item entry.

### Navigation and compatibility

- Primary tabs are Desk, Kitchen, Atlas, Reading, and Sources.
- Shelf filtering remains on Desk.
- `#/shelves` replaces itself with `#/recent` rather than leaving a dead route or adding a history step.
- Collections remains reachable from the Desk rail.
- Existing Desk, Reading, Atlas, Sources, search, Collection, Summary, and Stage routes continue to work.

### Accessibility and layout

- Critical flows work with keyboard only: search, filter, Watch & Cook, add/remove, reorder, clear, back, and open original.
- Automated accessibility checks report no serious/critical violations on populated, empty, filtered-empty, missing-Item, and Watch & Cook states.
- Both themes meet AA contrast.
- Reduced motion removes non-essential movement.
- There is no page-level horizontal overflow at 320 px.
- The interface remains usable at 200% zoom.

### Data safety

- Migration is idempotent and preserves existing Library data.
- All Kitchen reads and writes are Library-scoped; cross-Library existence is not disclosed.
- Tonight round-trips through library export/import, including missing Item references.
- Recipe Documents round-trip with schema, source snapshot/revision, evidence, state, actor, and order intact.
- Unsafe, malformed, stale, oversized, unsupported-version, or referentially invalid Recipe Documents fail atomically.
- Delete Library clears Kitchen state and leaves a reusable empty installation.
- Invalid mutations roll back completely.

## Verification strategy

Tests follow the repository test strategy and exercise the Kitchen module interface rather than React internals.

### Pure policy tests

- Availability classification for reviewed, draft, caption, watchable no-caption, and source-only Items.
- Caption trimming and title/caption display deduplication.
- Title fallback order.
- Watchability classification reuses existing platform/media policy.
- Caption normalization and stable source revision.
- Recipe schema bounds, id uniqueness, ingredient references, evidence-span validation, and actor/state policy.
- Recipe score projection: first-use placement, repeated use, unreferenced ingredients, and steps without ingredients.

### SQLite/module tests

- Recipe Box equals `listItemsPage(..., { view: "recent", shelf: "food" })` for membership and ordering.
- Search/source combination, counts, pagination, and stable cursors.
- Recipe create/update/review/remove; one document per Item; current caption remains unchanged.
- User evidence accepted for user actor; rejected for agent actor.
- Agent actor forced to draft; stale revision and invalid evidence leave the prior document unchanged.
- Source caption change preserves structure and reports `sourceChanged`; resave adopts the new snapshot/revision.
- Structured search matches title, ingredient, and step text without losing Food membership.
- Add idempotence, append order, 100-entry cap, remove, clear, and dense reorder.
- Reorder atomicity for stale, duplicate, omitted, invented, and cross-Library ids.
- Food/status eligibility on Add.
- Tonight retention after tag/status changes.
- Missing Item hydration after Item deletion.
- Kitchen operations do not change Item status, tags, Collections, or notes.
- Library scoping and archive round-trip.
- Recipe archive validation and orphan rejection; Tonight broken-reference preservation remains allowed.

### HTTP integration tests

- Every route's success, validation, 404/409 behavior, session, CSRF, and Library scoping.
- Search and reorder bounds.
- Kitchen detail eligibility for current Food Items and Tonight-only Items.
- Recipe write/remove validation, stale 409, reviewed state, and source-change response.
- Missing Tonight Item representation.
- Clear removes entries only.

### Browser end-to-end tests

- Navigate from Desk to Kitchen; search and filter; paginate without duplication.
- Add two Items, reorder by pointer and keyboard, reload, remove one, then clear with confirmation.
- Open caption-backed Watch & Cook and verify complete caption plus original action.
- Open video-only Watch & Cook and verify honest fallback copy.
- Open a structured recipe, enter edit mode on the score, change one beat, confirm that leaving the field does not persist, then tick and reload to verify the write.
- Add an ingredient in one click with the name field focused; accept it with Enter; place an unplaced ingredient onto a beat with one click.
- On a blank recipe, type the first beat and verify Draft appears before accept; tick creates the document.
- Verify score relationships with the decorative spine enabled and disabled, verify node/ingredient/method centre alignment across mixed row heights, then verify the linear mobile representation.
- Change the source caption through a fixture/setup seam and verify Caption changed without losing the score.
- Verify keyboard reordering, stale-save recovery of the working copy, and remove-structure confirmation.
- Verify no embed/link-preview request occurs while browsing Recipe Box; an embed request may occur only after Watch & Cook opens.
- Delete an Item through a fixture/setup seam and verify Missing Item remains removable.
- Open `#/shelves` and verify history replacement to Desk.
- Run populated and empty states in both themes at desktop, tablet, 320 px mobile, 200% zoom, keyboard-only, and reduced motion.

Do not assert on precise shadows, bowl SVG paths, animation frames, or platform iframe internals.

## Delivery sequence

1. Add Kitchen domain terms, Recipe Document/Tonight migrations, schema/evidence policy, Kitchen module, and module tests. Complete when every Recipe Document, membership, actor, source-revision, and Tonight invariant passes through the module interface.
2. Add Kitchen HTTP routes and integration tests. Complete when scoped reads/writes, structured validation, stale-write behavior, and failure codes match this spec.
3. Add `#/kitchen`, Recipe Box, Tonight rail, session query/scroll restore, and restrained responsive styling. Complete when structured/unstructured, populated/empty/filter states match the information hierarchy in both themes.
4. Add recipe score and in-place correction on that score. Complete when a human can edit, tick-save, reorder, review, read, and remove a Recipe Document without changing its Item, and the score works without visual connectors.
5. Add Watch & Cook using existing embed/sanitize helpers. Complete when caption-backed, video-only, source-only, structured-source, and missing states all retain a usable original exit.
6. Replace the Shelves tab, add the compatibility redirect and Desk Collections link, then run route regression tests. Complete when every retained route remains reachable.
7. Add the hosted Kitchen inference adapter and **Make this cookable** flow. Complete when extraction creates a source-backed draft, sparse input requires explicit generation consent, generation is visibly labelled, provider failure preserves the source view, and unchanged work is not repeated.
8. Add archive/delete integration and complete browser, accessibility, responsive, external-request, and performance verification. Complete when every acceptance criterion has evidence.

## Relationship to the scratch-pad proposal

`.scratch/scratch-pad/spec.md` remains a later proposal. This Kitchen release resolves the standalone base:

- Recipe Box supplies Food Item discovery.
- Recipe Documents supply the durable structured artifact and review seam.
- Recipe score supplies the distinctive cooking presentation.
- Tonight supplies one persistent manual working list.
- Watch & Cook supplies the human consumption path.

The later WebMCP work registers recipe tools against the same Kitchen module used by hosted inference. The later scratch-pad implementation must preserve existing Recipe Documents, provenance, review state, Tonight order, and Item references. This release does not implement party state, candidate lanes, holes, annotations, or browser-tool registration.

If the two specs conflict during this release, this Kitchen spec controls Kitchen base behavior; the scratch-pad spec controls only its later collaborative expansion.

## Resolved owner decisions

1. Kitchen replaces Shelves in primary navigation; shelf browsing stays on Desk.
2. Kitchen stores and displays whatever capture already placed in the Item caption.
3. Video-only food saves remain watchable source material; Kitchen does not transcribe them. A suggested recipe may use only the visible title/caption and must say it did not come from the video.
4. WebMCP registration is deferred, but its agent will submit through the same Recipe Document write seam as Locus AI.
5. Structured Recipe Documents and recipe score are core Kitchen functionality, not deferred enrichment.
6. **Make this cookable** is the primary creation path; the writable recipe score is for correction, review, and the blank manual fallback.
7. Users do not provide model API keys. A US$5/month Locus-hosted inference plan is only a monetization possibility, not an approved or implemented decision. A later WebMCP adapter lets the user's own agent submit the same caption-backed or explicitly generated draft.
8. Recipe Box, structured recipe score (view and edit), Watch & Cook, and Tonight are the first release; grocery generation remains deferred.
9. Reading's “show as much as possible while showing as little as possible” hierarchy is the usability reference.
