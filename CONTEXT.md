# Locus — domain language

Local-first desk for personal social saves (X Bookmarks, Instagram Saved, YouTube Watch Later, Reddit Saved). Use **capture**, not “sync.”

## Things in the library

- **Item** — one saved post, after Locus stores it.
- **Source account** — one login on one site.
- **Source collection** — that account’s Bookmarks / Saved / Watch Later. Not a user folder.
- **Collection / tag / note** — how the user organizes Items.
- **Library** — the private ownership scope for Items and Reading data. A localhost install has one fixed Library (`local`).
- **Reading Candidate** — a normalized outbound URL or source body that may represent readable writing. Internal discovery state, not necessarily visible.
- **Reading Document** — one canonical piece of writing in Reading, linked to one or more Items in the same Library. Not an Item, Collection, or clipping.
- **provenance** — the Item or Items through which the user saved a Reading Document.
- **availability** — whether Locus has a readable saved snapshot, only metadata, or a known failure.
- **original status** — reachability of the publisher copy; it never downgrades an existing ready snapshot.
- **reading state** — `unread` (no progress row), `reading`, or `finished`; independent of Item status. User removal is a document tombstone (`removed_at`), not a fourth progress state.
- **Recipe Box** — Kitchen's live projection of visible Food Items; not stored copies or a Collection.
- **Recipe Document** — one durable structured cooking interpretation linked to an Item, with ingredients, steps, and source evidence.
- **recipe score** — a Recipe Document's cooking view, relating ordered ingredients to ordered actions.
- **source revision** — the SHA-256 digest of the normalized caption used by a Recipe Document.
- **evidence reference** — an exact caption span, a fact deliberately entered by the user, or an explicitly generated suggestion.
- **suggested recipe** — an AI-generated Recipe Document draft inspired by a dish when the source recipe is unavailable; never the creator's attributed recipe.
- **Tonight** — one persistent ordered list of Item references selected for cooking; working state, not organization.
- **Tonight entry** — one durable Item reference in Tonight, retained even when its Item is missing.
- **Watch & Cook** — a focused Kitchen source view with available media, captured caption, and original-post exit.
- **caption** — the captured Item body shown as source material, never a claim of complete instructions.
- **Place** — a reusable, user-visible geographic or visitable entity known to the Library. It has a canonical display name, a kind, an optional parent Place, alternate names, and optional coordinates or external identifier. A Place is not a tag or Collection.
- **Place Assignment** — one Item's durable Atlas classification, including its outcome, primary Place when applicable, actor, evidence, source revision, and contained or mentioned Places.
- **Place Suggestion** — a bounded analyzer proposal awaiting validation or user choice. It is not a confirmed Place Assignment.
- **home base** — the one user-selected Place used to project a local Atlas section. It is configuration, not a special Place kind. Location analysis is desk-side enrichment, never “sync.”

## How captures reach the desk

- **Producer** — something that reads a site and sends posts to Locus. Two producers: the **extension** (your everyday Chrome) and the **runner** (a separate Chrome Locus opens).
- **Capture Protocol** — the desk messages: start session → batches → finish. Producers send these. Site packs do not.
- **Capture token** — revocable permission to send those messages.

## Site pack

One module. Source of truth: `site-packs/`. Both producers call it. A build copies it into `extension/shell/` so Chrome can load it. Do not keep a second handwritten scraper (`extract.js`).

It owns:

- is this the saved-items page? (homepage is not)
- read the posts on screen
- scroll the real list until nothing new appears (extension thoroughness, not a 60-post X cap)
- Instagram / Reddit: open each **new** post and read the caption
- two calls: **read this list** (Connect) and **read this one page** (Save this item)
- return **posts** (id, text, url, media), not desk messages
- take ids the desk already has and skip those

It does not own pairing, tokens, sessions, or batches.

Producers only supply: run this function in the page, scroll this tab, go to this URL.

Tests call the Site pack with a fake page. No live Chrome required for the homepage / one-post / skip-list checks.

## When we build this

**Teach as we go.** The owner has not shipped a Chrome extension before. Each step of the Site pack change, explain in plain language: which file just ran, what Chrome is doing, and the call stack (who called whom). Do not open a lesson series. Talk in the same conversation as the edits.

**Comments for the next person.** While touching extension, runner, and site-pack files, leave short comments at the confusing spots — why this file exists, which Chrome it talks to, where control goes next. Not a comment on every line. Enough that someone new can follow Connect and Save this item without a walkthrough.
