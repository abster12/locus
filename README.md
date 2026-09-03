<p align="center">
  <img src="app/public/locus-mark.svg" width="88" height="88" alt="Locus logo">
</p>

# Locus

The things we save should become part of our lives, not disappear into another endless list.

Locus is a private desk for articles, recipes, places, videos, and posts saved across the web. A saved Item can become something to read, a dish for tonight, a Place, or a stop on a Trip while keeping a link to where it came from. When a browser agent helps, it works inside the Locus page you have open and brings the result back into the interface for you to inspect and decide.

**Live app:** [locus-identity-staging.abhigyan0987.workers.dev](https://locus-identity-staging.abhigyan0987.workers.dev)<br>
Google sign-in is available, and registration remains open through September 21, 2026 at 5:00 pm PDT.

## Try it

The example Library is the fastest way to understand Locus. It runs in the real interface and does not require an account, social login, or browser extension.

1. Open the [live app](https://locus-identity-staging.abhigyan0987.workers.dev) in ChatGPT's in-app browser or a WebMCP-enabled Chrome window.
2. Select **Try the example library**.
3. Open **Trips**, then open **48 hours in Lisbon**.
4. Ask your browser agent:

   > Look at this trip and my saved Lisbon Items. Give me three options for the Friday dinner hole, present them in Locus, and leave the choice to me.

5. Compare the options in Locus and select one yourself.

You can also sign in with Google and paste public URLs into your own private Library. Connecting a social account is optional.

<p align="center">
  <img src="app/public/readme-desk.png" width="920" alt="Locus Desk showing saved posts from YouTube, X, Instagram, and Reddit">
  <br><sub>One private desk for the things you chose to save.</sub>
</p>

<p align="center">
  <img src="app/public/readme-trip-day.png" width="920" alt="Locus day planner showing saved sources, draft stops, and a dinner hole">
  <br><sub>Saved places become a plan, while Drafts and open choices remain visible.</sub>
</p>

## From a save to something useful

Locus accepts URLs directly and can capture saves from X, Instagram, YouTube, and Reddit through an optional Chrome extension. Capture runs in your browser, where you are already signed in. Locus does not ask for or store your social account passwords.

Once an Item reaches the Library, it can move through several parts of the same product:

- **Desk** keeps saves together and organizes them with status, tags, Collections, and notes.
- **Reading** preserves available writing and helps you choose what to read next.
- **Kitchen** turns grounded food posts into Recipe Documents and a Tonight list.
- **Atlas** organizes Items around reusable Places.
- **Trips** combines saved Items, Places, outside ideas, and open holes into a durable itinerary.

Locus is not affiliated with X, Instagram, YouTube, or Reddit.

## How WebMCP fits

Locus uses page-defined [WebMCP](https://webmachinelearning.github.io/webmcp/) tools. The app does not hand an agent one unrestricted connection to everything you have saved. Each page offers only the capabilities that make sense for the work visible there, and those tools are removed when you navigate away.

| Page | What the browser agent can help with | Implementation |
| --- | --- | --- |
| Desk and intake | Search the Library, present Item drafts, and save an exact batch you approve | [`library-intake-webmcp.ts`](app/src/library-intake-webmcp.ts) |
| Reading | Search saved writing, read stored text, and present recommendations | [`reading-webmcp.ts`](app/src/reading-webmcp.ts) |
| Kitchen | Read a captured recipe, propose a Draft, and compose Tonight | [`kitchen-recipe-webmcp.ts`](app/src/kitchen-recipe-webmcp.ts), [`kitchen-tonight-webmcp.ts`](app/src/kitchen-tonight-webmcp.ts) |
| Trips | Read an itinerary, find saved sources, build Draft stops, make exact changes, check the plan, and present choices | [`trips-webmcp.ts`](app/src/trips-webmcp.ts) |

The adapters register structured tools with `document.modelContext.registerTool(...)`. They validate every input and call the same application services used by the human interface. A successful call updates the open React page, so its result appears as an Item draft, reading recommendation, recipe draft, Tonight entry, or Trip change rather than existing only in chat.

The boundary depends on what the person asked for:

- An exact instruction, such as adding three named places to Saturday, may become a revision-checked change.
- An open-ended question, such as choosing dinner, produces a small set of options in the page and waits for the person to choose.
- Agent-created recipes and Trip stops begin as **Drafts**.
- Publishing, deletion, review, capture setup, and Place assignment remain human actions.
- Saved captions and remote pages are treated as untrusted content and never become instructions to Locus.

The browser agent supplies the reasoning during these WebMCP interactions. The submitted hosted app does not require an OpenAI API key or a server-side AI model.

## How it is built

The interface is React 19 and TypeScript, built with Vite and custom CSS. The submitted app runs as a Cloudflare Worker with Static Assets and D1. Better Auth and Google OAuth establish the session, after which the Worker derives the private Library for every request; the browser never chooses a Library ID.

The local-first edition uses Node.js 22 and SQLite. Both editions share the same domain language and validation rules. The Chrome Manifest V3 extension and local capture runner also share one set of source-specific site packs rather than maintaining separate scrapers.

Testing uses Node's built-in test runner for domain and HTTP behavior, fake-page tests for capture, and Puppeteer Core with Google Chrome for real browser behavior. WebMCP discovery, tool calls, visible updates, navigation cleanup, and re-registration were also tested in ChatGPT's in-app browser.

## Run locally

You need Node.js 22.5 or later. Google Chrome is needed only for live capture and browser tests.

```bash
git clone https://github.com/abster12/locus.git
cd locus
npm install
npm test
npm run dev
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). Local data stays in:

- macOS: `~/Library/Application Support/Locus/locus.db`
- Windows: `%APPDATA%/Locus/locus.db`
- Linux: `~/.local/share/Locus/locus.db`

See [docs/BUILD.md](docs/BUILD.md) for extension setup, capture, import, and optional local features.

To run the hosted Worker locally, copy [`hosted/.dev.vars.example`](hosted/.dev.vars.example) to `hosted/.dev.vars`, provide Google OAuth credentials, then run:

```bash
cd hosted
npm install
npm run dev
```

The local Worker opens at [http://127.0.0.1:8791](http://127.0.0.1:8791).

## Challenge work and prior evidence

Locus is an existing project that was meaningfully extended for the WebMCP Challenge.

The pre-challenge baseline is commit [`4b7da03`](https://github.com/abster12/locus/commit/4b7da033544d43dd239485926745dac2101137a3), committed on **August 24, 2026 at 12:46 pm PDT**, before the submission period opened. At that point, Locus was a local-only desk that could capture saves from X, Instagram, YouTube, and Reddit into one SQLite Library and open them in-tab.

Challenge-period development begins with commit [`77e29ff`](https://github.com/abster12/locus/commit/77e29ff282f535ba90b18134b94ffe2d994a217c), committed on **August 25, 2026 at 11:19 am PDT**, after the submission period opened. During the challenge we added:

- page-defined WebMCP workflows for Reading, Kitchen, Library Intake, and Trips;
- the complete Trips, Kitchen, Atlas, and Reading experiences used by those workflows;
- the authenticated, multi-user Cloudflare Worker and D1 edition;
- Library-scoped security, resumable hosted capture, public Trip snapshots, and live browser-agent verification.

[Compare the pre-challenge baseline with the challenge work](https://github.com/abster12/locus/compare/4b7da03...main). The repository's dated commit history is the evidence boundary between prior work and the submitted extension.

## License

[MIT](LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
