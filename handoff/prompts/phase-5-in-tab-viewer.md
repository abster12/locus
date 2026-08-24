# Phase 5. In-tab viewer (half-tab WebView)

You are implementing Phase 5 of Locus and only Phase 5.

Work from `/Users/abhigyan/Desktop/Dev/locus`.

If Phase 4 is not done (shelves, Reading, Atlas, dark mode), stop and say so. Go back to `handoff/prompts/phase-4-desk-v2-design.md`.

Do not start native shells, Document Picture-in-Picture, cookie reuse, or a chat thread.

## Read first

1. `/Users/abhigyan/Desktop/Dev/locus/handoff/handoff-locus.md`
2. This file
3. `/Users/abhigyan/Desktop/Dev/locus/docs/pip-prototype.html` (interaction source of truth — open it, click cards, drag the corner)
4. `app/src/App.tsx`, `app/src/styles.css`, `app/src/api.ts`, `core/sanitize.ts`

Desk v2 tokens stay. Do not restyle the desk. The viewer must look like it belongs on that desk (same paper, ink, lift, type).

## Mission

Clicking a save must no longer leave the tab. A half-tab viewer opens on top of the desk. The user can keep browsing. AI actions live on that viewer. Outbound links (the blog inside an X post) open as a **live page** in the same viewer — a phone WebView, not extracted text.

The dashboard stays useful with no model. Embeds talk to source servers only after a click.

## Decisions already made (do not reopen)

- **Shape is A**, not B or C. Floating stage, parked bottom-right. Not a 50/50 split. Not a lightbox that collapses to a chip.
- Default size **half the tab**: `50vw × 50vh`. User can resize. Remember the last size in `localStorage` (`locus-stage-size`).
- Resize by dragging a visible handle on the **top-left** corner (the stage is anchored bottom-right). Min ~320×280. Max almost the viewport. No new dependency — pointer events, not a library, not CSS `resize` alone (the native grip is invisible).
- Card click **opens the stage**. It does **not** `window.open`. This deliberately changes Phase 4’s “click opens original”. `↗` still opens the original in a new tab.
- Esc and × close. Clicking another card swaps the save. Works from Desk, Reading, and Atlas.
- **No “Read as text”.** No reader-mode proxy. No article extract. If a live page will not sit in a frame, the frame is blank and `↗` is the way out. Do not invent a fallback document.
- **No live X.com or Instagram.com session** inside the desk. Locus is `127.0.0.1`. Those cookies do not come with us. Do not export cookies from the capture profile or everyday Chrome. Do not strip `X-Frame-Options` / `frame-ancestors`. Do not write extension tricks that force a site into a frame.
- **No Electron / Tauri / WKWebView** in this phase. The in-tab WebView **is an `<iframe>`**. Say so if a site refuses.
- AI in the viewer: existing **Summary** (`POST /api/summaries/item/:id/prose`) and **Add note** (`POST /api/items/:id/notes`). No new endpoints. No chat.

## Hard scope rules

Do NOT change:

- Server, schema, Capture Protocol, site packs, runner, extension
- `package.json` dependencies
- How capture, tags, auto-tag, collections, summaries, import/export, or Sources work
- Date language
- Theme tokens

You MAY add a small helper next to existing URL helpers (YouTube id). Do not import `server/enrich.ts` into the client. `outboundUrls` / `isPlatformPermalink` / `isReadingItem` already live in `core/sanitize.ts` — reuse them.

## Build

One stage, mounted from `App` so it survives route changes. Fewest files. Prefer more code in `App.tsx` / `styles.css` over a new package.

### 1. Open path

Today `PostCard` and `AtlasCard` do `window.open(item.url)`. `ClipCard` is an `<a target="_blank">`.

Change all three: click (not on an `a` / `button`) calls `openStage(item)`. Keep `↗` / explicit original links as `target="_blank"` `rel="noopener noreferrer"`.

### 2. Stage chrome

Fixed, bottom-right, above the desk (`z-index` above grain, below nothing important). Default `50vw × 50vh`.

Bar: handle · author/host · source · **←** when a page is stacked on the save · **↗** original · **×**.

Body scrolls. AI strip pinned at the bottom of the stage: **Summary** and **Add note**. Summary is the existing Pi extra (same copy energy as today’s reading Summary: user-chosen, uses their Pi login). Notes stay local.

Esc closes. Do not trap `/` search.

### 3. What the body shows

Pick the first rule that matches. Local capture first. Network only on an explicit click.

**YouTube** (`item.url` is a watch/youtu.be permalink — parse the id in the client, same rules as `videoId` in `server/enrich.ts`):

- Show title + captured thumbnail/poster.
- **Play here** (one click) mounts  
  `https://www.youtube-nocookie.com/embed/{id}`  
  with `allow="accelerometer; autoplay; encrypted-media; picture-in-picture"`.
- Public videos play. Private / age-gated fail inside the frame — leave `↗`. Do not auto-play on open.

**X / Reddit / other text:**

- Show the captured title, body, and media we already have.
- Do not iframe `x.com` / `twitter.com` / `reddit.com` permalinks.
- Linkify `http(s)` URLs in the body. A click on an **outbound** URL (use `outboundUrls` / `isPlatformPermalink` — not the post’s own permalink) **does not open a tab**. It pushes a live page onto the stage (section 4).

**Instagram:**

- Show the captured photo (existing `firstVisual` rules: one IG image, skip avatars).
- Do not iframe `instagram.com/p|reel|tv/...` as the app.
- A public official embed (`/p/{code}/embed` or `/reel/{code}/embed`) is allowed only behind an explicit **Try embed** click. When it fails (usual), the frame is blank; keep the captured still and `↗`. Do not promise Reels play.

**Everything else:** captured body + media. Same outbound-link rule as X.

### 4. Live page (the WebView)

This is an `<iframe src="{url}">` filling the stage body under the chrome. It is a live document, not HTML we fetched.

- Back returns to the save. The iframe unmounts.
- Address chrome shows the hostname only, labeled like a live page.
- `sandbox` is optional; if you set it, allow scripts or the page is dead. Prefer no sandbox so it behaves like a phone WebView. The user clicked the link.
- Do not detect X-Frame-Options and replace the frame with an extract. Blank + `↗`.
- Summary/Note stay on the **save**, not on the framed site, while the page is showing.

### 5. Opt-in and honesty

Remote embeds contact YouTube / Instagram / the blog. That matches the product rule: remote media is opt-in. Play here / click link / try embed are the consent. Do not mount those iframes just because the stage opened.

Do not tell the user we are using their X/Instagram/Google login. We are not.

### 6. Tests

If you add a YouTube-id or “is this an outbound link we open in-stage” helper, give it a small `tests/*.test.ts` (or extend `tests/hostile-render.test.ts`). No new test framework. `npm test` and `npm run typecheck` stay green.

## Out of scope (say no)

- Variant B (split blotter) and C (focus + chip)
- OS / document picture-in-picture
- Native WebView wrapper
- Reader-mode / “Read as text” / proxying article HTML
- Chat, extra model calls, new summary scopes
- Forcing framed X/IG with header rewriting
- Drag-to-move the stage (resize only)
- Persisting which item was open

## Done when

- [ ] Clicking a card on Desk, Reading, or Atlas opens the stage; the desk is still there
- [ ] Default size is half the tab; drag-resize works; size survives reload
- [ ] `↗` and Esc / × behave as specified
- [ ] YouTube plays only after **Play here**, via youtube-nocookie
- [ ] An X save with a blog URL opens that URL in the stage iframe; Back returns to the save
- [ ] No reader-mode path exists
- [ ] No new dependencies, no server/protocol changes
- [ ] `npm test` and `npm run typecheck` pass

Do not commit or push. Leave the working tree for user review. Report what you changed file-by-file and anything you deliberately left alone.
