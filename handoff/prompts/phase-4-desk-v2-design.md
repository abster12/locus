# Phase 4. Desk v2 — design-only reskin (shelves, Reading, Atlas, dark mode)

You are implementing Phase 4 of Locus and only Phase 4.

Work from `/Users/abhigyan/Desktop/Dev/locus`.

This is a **design-only** phase. You are re-skinning the existing dashboard and adding three browse views. You are **not** changing how cards behave, how data is stored, or how anything is captured.

## Read first

1. `/Users/abhigyan/Desktop/Dev/locus/handoff/handoff-locus.md` (product and architecture source of truth)
2. `/Users/abhigyan/Desktop/Dev/locus/docs/design-proposal-desk-v2.md` (this phase's rationale and palette)
3. `/Users/abhigyan/Desktop/Dev/locus/docs/prototype.html` (**visual source of truth** — copy design tokens, type scale, motifs, and layout structure from here, not from your imagination)
4. `app/src/App.tsx`, `app/src/styles.css`, `app/src/api.ts`, `core/sanitize.ts` (the code you are changing)

The prototype is a static mock with seed data. The real app keeps its real data flow.

## Hard scope rules

Design only. If a change would alter behavior, data, or protocol, stop and leave it as is.

Do NOT change:

- Any server file, endpoint, schema, or the Capture Protocol
- Item actions and their wiring: click-opens-original (unless the click hit an `a`/`button`), hover actions (accept ✓ / archive ⌄ / open original ↗), tag chips filtering, `Read more` excerpt expansion, `Summary` button on reading items, `Auto-tag` button, inbox count badge
- Day grouping, date language ("discovered/captured", never invented save dates), source stamps
- Summaries, prose, import/export, Sources page functionality, pairing, settings
- `package.json` dependencies (zero new deps — the prototype is vanilla CSS/SVG for a reason)

You MAY restructure `App.tsx` internals (new components, new routes) as long as every existing behavior above keeps working.

## Build

### 1. Design tokens — rewrite `app/src/styles.css` `:root`

Copy the token block from `docs/prototype.html` exactly (cool press-room palette):

- Light: paper `#f1f2ef`, card `#fcfdfb`, ink `#17191b`, mute `#6b7176`, rule `#d8dbd5`, wash `#e7e9e4`, accent `#c8352e` (print red, the only UI accent)
- Dark (`html[data-theme="dark"]`): paper `#0b0b0c`, card `#151619`, ink `#e9eaeb`, mute `#8f949a`, rule `#2b2d31`, wash `#1d1f23`, accent `#ef6355`, `--src-x: #c9cdd2`, `color-scheme: dark`
- `--lift` shadow token per theme; cards are one flat color, one hairline rule, lifted. **No gradients anywhere. No colored card edges.**
- Keep the existing source-color tokens (`--src-x/instagram/youtube/reddit`) for stamps.
- Keep existing fonts (`--display/--ui/--mono` stacks). Type scale: mono 12.5px handles, 11.5px meta, display 19px card titles, display 15.5px excerpts clamp-3, italic display 15px poster words bottom-left, 10.5px uppercase chips/tags. Dates mono, right-aligned in captions.
- Keep `:focus-visible` outlines and `prefers-reduced-motion` handling.

### 2. Theme toggle

Sun/moon round button next to the global search in the masthead (icons: copy the inline SVGs from the prototype). Toggles `data-theme` on `<html>`; default follows `prefers-color-scheme`; explicit choice persists in `localStorage` key `locus-theme`. 250ms background/color transition, disabled under reduced motion.

### 3. Global search moves to the masthead

One search input in the masthead on every view (round, magnifier icon, `/` kbd hint). It drives the existing `#/search?q=` route exactly as today. Remove the per-view toolbar search input. Do not change search semantics.

### 4. `core/categories.ts` — tag → shelf map

Pure functions, no I/O:

```ts
export interface Shelf { key: ShelfKey; name: string; color: string; motif: MotifName; }
export function shelfOfTag(name: string): Shelf;   // lowercase-trim lookup, fallback "else"
export function shelvesWithCounts(tagsByItem: { tags: string[] }[]): { shelf: Shelf; count: number }[];
```

Exact mapping (every tag that exists in the library today — counts in parentheses; unknown/future tags fall back to `else`):

- `tech` Tech & Code: tech(128), ai(56), programming(2), opensource(1), security(1), socialmedia(2), shipping(1), tutorial(5), guides(1), video(1), short(0)
- `health` Health & Body: health(95), fitness(15), grooming(4), hair(3), haircut(2), barber(1), beauty(1), fragrance(2)
- `food` Food: food(107), recipe(1), dessert(1), airfryer(1)
- `travel` Travel: travel(44)
- `career` Work & Growth: career(38), education(1), motivation(2), selfimprovement(1), lifehacks(1)
- `sports` Sports: sports(38), bike(1)
- `money` Money & Style: finance(12), watches(4), watch(0), sneakers(2), fashion(6), style(1), lifestyle(1)
- `culture` Screen & Page: books(7), movies(4), tv(1), music(5), poetry(5), dance(6), bhangra(1), acting(1), gaming(15)
- `art` Art & Design: art(16), design(12), photography(1), animation(1), craft(1), diy(1), architecture(0), toys(1)
- `love` Relationships: dating(7), relationship(4), relationships(2), couples(2), love(1), friendship(1), wedding(1)
- `else` Everything else: comedy(20), memes(1), quotes(4), science(7), politics(1), social(3), trending(1), questions(7), nsfw(1), desk(0) — and the fallback

Shelf colors (poster pigments, flat): tech `#4053b3`, health `#17948a`, food `#d64541`, travel `#1e88c9`, career `#77803a`, sports `#2e6b3e`, money `#a8861f`, culture `#7a4fb5`, art `#5d6b7a`, love `#c9526f`, else `#7d838a`.

### 5. `core/places.ts` — local gazetteer

Pure, deterministic, offline:

```ts
export interface PlaceHit { place: string; region: string; }
export function detectPlaces(title: string | null, body: string | null): PlaceHit[];
```

- Static table of place names → region. Word-boundary, case-insensitive match over `title + " " + body`. Return unique regions in a stable order (by hit count desc, then name). No fuzzy matching, no network, no model.
- Seed the table with at least these (present in the user's library): Japan, Tokyo, Osaka, Kyoto, USJ, Spain, Barcelona, Parc Güell, Andalusía, India, Uttarakhand, Jim Corbett, Fatehpur, Dharamshala, Himachal, Goa, Kerala, Mumbai, Andaman, Bengaluru, Delhi, Ladakh, Kashmir, Rishikesh, Sri Lanka, Colombo, Ella, Vietnam, Da Nang, Hanoi, Philippines, Portugal, Lisbon, Porto, Europe, Paris, London, Thailand, Bali, Indonesia, Dubai, Singapore, Malaysia, Nepal, USA, New York. Add common variants (e.g. "Uttarakhand"/"Jim Corbett" → India; "USJ"/"Osaka" → Japan).
- Regions shown in Atlas (with plate colors): Japan `#c8352e`, Spain `#d9a419` (ink text on gold), India `#3a4fb5`, Sri Lanka `#1e7a5f`, Southeast Asia & beyond `#6d4a9c`. Items with no hit are listed under a collapsed "Unplaced" section — never guessed, never dropped.

### 6. Desk — category rail replaces chip soup

- Left rail (sticky, ~216px): "All saves" + the 11 shelves with item counts (count = items with ≥1 tag on that shelf, computed client-side from loaded items). Shelf rows show a small pigment dot; active shelf gets a left rule + card background.
- Picking a shelf filters the wall (client-side, same as today's tag filter). A contextual chip row appears above the wall: "Inside {Shelf} ·" followed by only that shelf's tags as chips (existing tag-filter behavior per chip) + a `clear` control.
- The wall keeps everything: day-group headers, masonry columns, cards. Cards are re-skinned per the prototype (flat, lifted, no colored spine). Tags on cards stay clickable filters. Hover actions unchanged.
- `Auto-tag` button stays (move it to the contextual row area or keep beside the wall — same handler, same copy).

### 7. Reading page — `#/reading`

- Items where `isReadingItem(body, url)` is true (already in `core/sanitize.ts`).
- Group by publication = hostname of the item's outbound link (reuse the extraction logic from `previewUrls`/`outboundUrls`; factor it out of `App.tsx` into a shared helper if needed). Section header: neutral monogram block + site name/title + host (mono) + count.
- Cards show, in this order: preview image if `api.linkPreview(url)` returned one (reuse the existing `LinkPreview` fetch — it is already cached server-side in `link_previews`; no server change), preview title, preview description clamp-3, footer `host · saved-from · date ↗`.
- Sort toggle: `By publication` (default) / `By recency` (flat grid, newest first by `firstObservedAt`). Client-side only.
- Clicking a clipping opens the original in a new tab (`noopener noreferrer`), same as link cards today. No triage actions on clippings.

### 8. Atlas page — `#/atlas`

- Travel shelf items (`shelfOfTag` over item tags, shelf `travel`).
- Run `detectPlaces(title, body)` per item; group by region; regions sorted by count desc; each region renders `PLATE {N}` + name + count + double rule + cities line + card grid (masonry columns).
- Card media rule, in order: (1) `item.media[]` first image/video → real thumbnail, `object-fit: cover`, fixed height; (2) link-preview image via `api.linkPreview` for link items; (3) poster fallback — flat region-pigment field + line-art motif + place/subject word bottom-left italic. The poster **never** replaces a real image. Remote images stay opt-in per the product promise: only render media URLs already stored, and previews already cached — do not add new fetch-on-view behavior beyond the existing `linkPreview` endpoint.
- Region nav: sticky pill bar with pigment dots, anchor-scrolls to sections (`scroll-margin-top`). Collapsed `Unplaced` section at the bottom listing unmatched items with the reason "no place named".
- Compass-rose inline SVG in the page header (copy from prototype).

### 9. Shelves page — `#/shelves`

Grid of 11 shelf plates: motif line-icon (ink), shelf name, count, sample tags line (small caps), small pigment dot. Click → `#/recent` (or current list view) with that shelf pre-selected in the rail. Include the long-tail note line from the prototype.

### 10. Line-art motif library

Copy the `MOTIFS` table and `motif()`/`motifIcon()` helpers from `docs/prototype.html` into `app/src/motifs.ts` (stroke-only SVG, `currentColor`, no fills). Shelf→motif: tech `term`, health `pulse`, food `bowl`, travel `plane`, career `clip`, sports `spark`, money `coin`, culture `book`, art `camera`, love `heart`, else `spark`; regions: Japan `torii`, Spain `arch`, India `peaks`, Sri Lanka `palms`, SE Asia `boat`; photo placeholder `photo`.

### 11. Navigation

Tabs become: `Desk` (Recent, keeps inbox badge) · `Reading` · `Atlas` · `Shelves` · `Sources`. Keep `#/search`, `#/collections`, `#/summary/*` routes and their entry points working (Collections and Summary stay reachable — Collections from wherever it is linked today; if it loses its tab, link it from Shelves page footer). Update `Route`/`parseHash` for the three new routes.

## Verification

1. `npm run typecheck` — clean.
2. `npm test` — all existing tests pass. Add pure-unit tests: `core/categories.ts` (every tag above maps to its shelf; unknown tag → `else`), `core/places.ts` (finds Japan/Barcelona/Kerala in sample text; returns [] for no-hit text; word-boundary safety, e.g. "Usain" does not match "USJ").
3. Run `npm run dev`, walk every view in **both themes** and confirm:
   - Recent/Inbox/Search/collection views: cards render in the new skin; click opens original; hover ✓/⌄/↗ work; tag chips filter; Read more works; Summary button works on reading items; Auto-tag works.
   - Rail: counts sane, shelf filter + contextual tag chips + clear work.
   - Reading: grouped by publication, sort toggle works, previews render from cache.
   - Atlas: regions correct for the seeded data, photos win over posters, Unplaced lists leftovers, region nav scrolls.
   - Shelves: 11 plates, click-through filters the desk.
   - Theme toggle: persists across reload, follows system when never touched.
4. No console errors.

## Done when

- [ ] All 72 existing tags resolve to exactly one shelf; unknown tags fall back to `else`
- [ ] No view shows more than ~12 top-level filter choices at once
- [ ] Reading and Atlas pages work fully offline on already-captured data
- [ ] Card functionality is byte-for-byte the same set of actions as before
- [ ] Both themes complete; no gradients; no colored card edges; true-black dark mode
- [ ] `npm run typecheck` and `npm test` pass, including the new unit tests
- [ ] Zero new dependencies, zero server changes

Do not commit or push. Leave the working tree for user review. Report what you changed file-by-file and anything you deliberately left alone.
