# Build and run

Requires Node 22.5+ and, for live capture, installed Google Chrome.

```bash
cd /Users/abhigyan/Desktop/Dev/locus
npm install
npm test
npm run dev
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787).

Production:

```bash
npm run build
npm start
```

## Capture runner

Connect / Capture now on Account opens a headed Chrome window with a per-account profile at:

`~/Library/Application Support/Locus/browsers/<source>/<accountId>/`

Locus does not copy that profile.

## Extension

`npm run build:extension` writes `extension/shell/pack.js` from `site-packs/` (also runs from `npm run dev` / `npm run build`).

1. Chrome → Extensions → Load unpacked → `extension/shell`
2. On Account, click **Pair extension**
3. Paste origin + token into the popup
4. On a post, **Save this item**

Host permission is requested only for the current site.

## Importers

- Capture Protocol JSONL on Account
- Reddit official `saved_posts.csv` / `saved_comments.csv`
- Instagram official export is not shipped (no proven Saved fixtures)

## Optional prose

Deterministic summaries always work. “Write as prose” uses the user’s Pi login (`~/.pi/agent/auth.json`) if `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` can be resolved from `optional/summaries/pi/node_modules` or `~/.pi/agent/npm/node_modules`. Locus does not store those keys.
