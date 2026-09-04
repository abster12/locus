# Build and run

Requires Node 22.5+ and, for live capture, installed Google Chrome.

```bash
git clone https://github.com/abster12/locus.git
cd locus
npm install
npm test
npm run dev
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787).

Hosted (Worker + D1 staging): `.scratch/hosted-deployment/spec.md`.

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
3. If the extension is installed in this browser, it pairs by itself — no copy-paste. The pairing code only appears when no extension replies: paste it into the extension popup on the browser that has the extension, or on a desk URL the manifest does not cover (localhost and the hosted Worker are covered).
4. On a post, **Save this item**

Host permission is requested only for the current site. Hosted capture uses the same Load unpacked path from GitHub until a Chrome Web Store listing exists.

## Importers

- Capture Protocol JSONL on Account
- Reddit official `saved_posts.csv` / `saved_comments.csv`
- Instagram official export is not shipped (no proven Saved fixtures)

## Optional prose

Deterministic summaries always work. “Write as prose” uses the user’s Pi login (`~/.pi/agent/auth.json`) if `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` can be resolved from `optional/summaries/pi/node_modules` or `~/.pi/agent/npm/node_modules`. Locus does not store those keys.
