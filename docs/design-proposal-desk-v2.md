# Design proposal — Desk v2: from tag soup to shelves

Status: proposal + clickable prototype (`docs/prototype.html`). No backend changes required for the shape of it; everything below runs on data Locus already stores.

## What's wrong today

1. **Tag soup.** The filter bar renders all 72 tags as flat chips (`tech · 128`, `airfryer · 1`, …). Counts came from Pi auto-tag. The top 12 tags cover ~75% of items; the other 60 tags are noise at decision time. Humans can't choose from 72 options; they can choose from ~9.
2. **Blogs are invisible.** ~50 saves point at outbound articles/repos (lucumr.pocoo.org, blog.cloudflare.com, modem.dev, brentfitzgerald.com, GitHub repos…) and 210 link previews are already fetched and stored. Today they drown inside the reverse-chron wall behind a single unlabeled `reading` chip.
3. **Travel has no geography.** 44 travel saves carry obvious place signals — Barcelona, Japan/Tokyo/Osaka/Kyoto, Dharamshala, Jim Corbett, Goa, Kerala, Sri Lanka, Vietnam, Portugal — yet they're shown as one undifferentiated scroll.
4. Collections exist in the model but are unused; tags are doing all the work with no hierarchy.

## Core idea: categories are shelves, tags live on them

Introduce ~10 fixed **categories** (deterministic, local, editable — no model involved). Every existing tag maps to exactly one category through a static table in core. The UI never shows more than one layer at a time:

```
Category (always ≤10 visible)
  └── its tags (shown only after you pick the category)
```

| Category | Absorbs existing tags | Count today |
|---|---|---|
| Tech & Code | tech, ai, programming, opensource, security, socialmedia, shipping | ~192 |
| Health & Body | health, fitness, grooming, hair, haircut, barber, beauty | ~121 |
| Food | food, recipe, dessert, airfryer | ~110 |
| Travel | travel (+ future place tags) | 44 |
| Sports | sports, bike | 39 |
| Work & Growth | career, education, motivation, selfimprovement, lifehacks | 43 |
| Art & Design | art, design, photography, animation, craft, diy, architecture | 32 |
| Money & Style | finance, watches, sneakers, fashion, style, lifestyle | 26 |
| Screen & Page | books, movies, tv, music, poetry, dance, bhangra, acting | 30 |
| Relationships | dating, relationship(s), couples, love, friendship, wedding | 17 |
| Everything else | comedy, memes, quotes, science, politics, tutorial, guides, nsfw, … | searchable, not surfaced |

Rules:

- The mapping lives in one file (`core/categories.ts`). Renames/remaps are user-visible instantly; nothing in SQLite changes — membership stays tag-based.
- Single-use tags never appear as top-level chips again. They're reachable inside their shelf and via search.
- Auto-tag keeps writing plain tags; categorization is a pure function of tag name.

## New information architecture

```
Desk      Recent + Inbox (badge). Day-grouped wall. Category rail replaces chip soup.
Reading   The blog pile. Grouped by publication, richest previews in the app.
Atlas     Travel, organized by place. Gazetteer sections, photo-forward.
Shelves   Browse all categories → their tags → filtered wall.
Sources   Unchanged.
Search    Moves into the masthead. Always one keystroke away, works across everything.
```

### Desk
- Left rail: category cards with counts (≤10). Picking one reveals its tags as a secondary chip row *inside that context* — max ~7 chips instead of 72.
- Wall unchanged (day groups, triage on hover) so this feels like a refinement, not a move.

### Reading
- Items with outbound links (`isReadingItem` already exists in core).
- Primary grouping: **publication** (hostname). Section header = the site's name/title from the stored link preview (e.g. "Armin Ronacher's Thoughts and Writings"), count, monogram.
- Cards show preview title + description (already fetched, stored in `link_previews` — zero new network calls), saved-from stamp, dateline.
- Sort toggle: by publication / by recency.

### Atlas (travel)
- A local **gazetteer**: a static list of place names (cities, regions, countries, landmarks — start with ~150 entries covering the user's actual data) matched case-insensitively against title + body. Deterministic, offline, no model. Lives in `core/places.ts`.
- Hierarchy: **Country/Region → City → cards**, ordered by count. Sections styled like atlas plates: small-caps labels, rules, counts.
- Items matching no place land in a collapsed "Unplaced" section — never lost, never faked.
- Future: auto-tag can be asked for a `place:` tag convention; the gazetteer remains the free default.

## Visual direction — flat print, lifted cards

No gradients, no colored edges. Cards are **one consistent color** (cool white `#fcfdfb`), one hairline rule, and a soft two-layer paper shadow that lifts them off a cool-gray desk (`#f1f2ef`). All art lives *inside* the media block; the card frame stays quiet.

**Type scale (the only text styles):** mono 12.5px handles · 11.5px meta · display serif 19px titles · display serif 15.5px excerpts · italic serif 15px poster words (always bottom-left) · 10.5px uppercase chips. Dates always mono, right-aligned in captions.

**Palette — cool press room (no warm creams, no coral):**

- **Light:** cool paper `#f1f2ef`, card `#fcfdfb`, ink `#17191b`, accent **print red `#c8352e`** (the one UI accent: tabs, links, badge, compass needle).
- **Dark (true black):** desk `#0b0b0c`, card `#151619`, ink `#e9eaeb`, accent brightened `#ef6355`.
- **Poster pigments (flat, cooler set):** indigo `#4053b3` tech · teal `#17948a` health · tomato `#d64541` food · cerulean `#1e88c9` travel · olive `#77803a` career · forest `#2e6b3e` sports · brass `#a8861f` money · violet `#7a4fb5` culture · slate `#5d6b7a` art · rose `#c9526f` relationships · gray `#7d838a` else.
- **Atlas plates:** Japan crimson `#c8352e` · Spain gold `#d9a419` (ink-on-gold) · India indigo `#3a4fb5` · Sri Lanka viridian `#1e7a5f` · SE Asia violet `#6d4a9c`.

Pigment appears only in poster art, the rail dots, and the region nav — never as card edges or text colors. Source stamps (X/IG/YT/RD) keep their small brand colors.

Per surface:
- **Desk**: lifted cream cards; poster art only where a save has no image.
- **Reading**: press-clipping treatment — neutral masthead blocks, datelines, `❦` ornaments between sections.
- **Atlas**: compass-rose header, `PLATE I…V` region numbering, ink double rules, poster/photo grids per region.

## Where images come from

New items get images **automatically at capture time** — no extra work, no fetching at view time:

1. **Captured media.** Site packs already collect the thumbnails a page renders into `item.media[]` (Instagram photos, YouTube thumbnails, Reddit previews). The card shows the first image, `object-fit: cover` in a fixed-height box. This is what most travel and food saves have.
2. **Link preview images.** Reading items get their image from `link_previews.image` — already fetched once and cached in SQLite (210 stored today).
3. **Poster fallback.** Text-only saves (X posts, comments, threads) have no image, so they get the flat pigment poster with a line-art motif and a subject word. The poster **never replaces a real image** — the rule is `photo → preview image → poster`.

Remote loading stays opt-in per the product promise: images render from what capture already stored; nothing is fetched while you browse.

All art is inline stroke-only SVG (one `MOTIFS` table) — no image assets, works offline. Motion stays minimal; `prefers-reduced-motion` honored.

**Dark mode (true black)** — a token swap, not a second design: true-black desk (`#0b0b0c`) with cool off-white ink, same poster pigments, deeper shadows for the lift. Toggle in the masthead (sun/moon); follows `prefers-color-scheme` by default, remembers the choice in `localStorage`.

## Why this stays within product principles

- No model, network, or API key required: taxonomy and gazetteer are static local tables.
- Tags remain the storage primitive; categories and places are presentation-level groupings computed from stored data.
- Partial/imperfect grouping degrades honestly ("Unplaced", "Everything else") instead of inventing facts.

## Implementation notes (small)

1. `core/categories.ts` — tag→category map (one export, ~20 lines).
2. `core/places.ts` — gazetteer + `detectPlaces(title, body)` (~80 lines incl. data).
3. `app/src/App.tsx` — routes `#/reading`, `#/atlas`, `#/shelves`; replace `themes` chip block with `<CategoryRail/>`; move search to masthead.
4. Server: none. All endpoints used already return tags/body/previews.
5. Later niceties: remember last shelf per session; "Unplaced" counter badge on Atlas tab.

## Prototype

Open `docs/prototype.html` in a browser. It demonstrates all four surfaces with realistic data sampled from the live library (gradient plates stand in for media). Interactions: tab navigation, Desk category rail, Atlas region navigation, Reading sort toggle, Shelves drill-in.
