<p align="center">
  <img src="app/public/locus-mark.svg" width="88" height="88" alt="Locus logo">
</p>

# Locus

The things we save should become part of our lives, not disappear into another endless list.

Locus is a private desk for articles, recipes, places, videos, and posts you’ve already kept. One saved Item can become something to read, dinner tonight, a Place, or a stop on a trip, and it still points at the original.

A browser agent can help, but it works on the page you have open. You see the result in Locus and you decide what stays.

**Try it:** [locus-identity-staging.abhigyan0987.workers.dev](https://locus-identity-staging.abhigyan0987.workers.dev) — use **Try the example library** if you don’t want an account.

[Watch the demo (2 min)](https://youtu.be/u7fo_twY7DU)

## What it actually does

- **Desk** — all the saves in one place. Status, tags, collections, notes.
- **Reading** — keeps the writing when it can, and helps you pick what to read next.
- **Kitchen** — food posts become recipes and a Tonight list.
- **Atlas** — the same items, hung on Places you reuse.
- **Trips** — an itinerary from saves, places, leftover ideas, and holes you haven’t filled yet.

You can do all of this by hand. The agent is extra.

## Getting saves in

Paste a public URL. Or ask the agent to save one. Or, if you want your existing bookmarks, load the Chrome extension from [`extension/shell`](extension/shell) (it isn’t in the store). It reads X Bookmarks, Instagram Saved, YouTube Watch Later, and Reddit Saved in the browser you’re already signed into. Chrome → Load unpacked → that folder, then **Pair extension** on Account. Locus never asks for those passwords.

Setup notes are in [docs/BUILD.md](docs/BUILD.md#extension).

Locus is not affiliated with X, Instagram, YouTube, or Reddit.

<p align="center">
  <img src="app/public/readme-desk.png" width="920" alt="Locus Desk showing saved posts from YouTube, X, Instagram, and Reddit">
  <br><sub>Desk.</sub>
</p>

<p align="center">
  <img src="app/public/readme-trip-day.png" width="920" alt="Locus day planner showing saved sources, draft stops, and a dinner hole">
  <br><sub>A trip day, still missing dinner.</sub>
</p>

## The agent (WebMCP)

Locus uses [WebMCP](https://webmachinelearning.github.io/webmcp/). The page you’re on registers a few tools. Leave the page, they’re gone. The agent never gets a free pass at the whole library.

| On this page | It can |
| --- | --- |
| Desk | Search, draft items, save a batch you approve |
| Reading | Search saved writing, open the stored text, recommend in the page |
| Kitchen | Read a captured recipe, propose a draft, add to Tonight |
| Trips | Read the trip, find saved places, draft stops, make a change you named, or show a few options and wait |

“Add these three places to Saturday” can go through. “Where should we eat?” shows options in Locus and waits. Recipes and trip stops it creates start as drafts. Publishing, deleting, pairing the extension — that’s you.

ChatGPT’s in-app browser already speaks WebMCP. In Chrome, turn on `chrome://flags/#enable-webmcp-testing` (you’ll want a current Canary or Dev build) and open the live URL or the local app.

## Run it

Node.js 22.5+. Chrome is only for live capture and browser tests.

```bash
git clone https://github.com/abster12/locus.git
cd locus
npm install
npm test
npm run dev
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). Your library is a SQLite file:

- macOS: `~/Library/Application Support/Locus/locus.db`
- Windows: `%APPDATA%/Locus/locus.db`
- Linux: `~/.local/share/Locus/locus.db`

Extension, capture, import: [docs/BUILD.md](docs/BUILD.md).


## Challenge work and prior evidence

Locus is an existing project that was meaningfully extended for the WebMCP Challenge.

The pre-challenge baseline is commit [`4b7da03`](https://github.com/abster12/locus/commit/4b7da033544d43dd239485926745dac2101137a3), committed on **August 24, 2026 at 12:46 pm PDT**, before the submission period opened. At that point, Locus was a local-only desk that could capture saves from X, Instagram, YouTube, and Reddit into one SQLite Library and open them in-tab.

Challenge-period development begins with commit [`77e29ff`](https://github.com/abster12/locus/commit/77e29ff282f535ba90b18134b94ffe2d994a217c), committed on **August 25, 2026 at 11:19 am PDT**, after the submission period opened. During the challenge we added:

- page-defined WebMCP workflows for Reading, Kitchen, Library Intake, and Trips;
- the complete Trips, Kitchen, Atlas, and Reading experiences used by those workflows;
- the authenticated, multi-user Cloudflare Worker and D1 edition;
- Library-scoped security, resumable hosted capture, public Trip snapshots, and live browser-agent verification.

## License

[MIT](LICENSE). Third-party notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
