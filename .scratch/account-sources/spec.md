# Account and Sources

Status: proposed
Date: 2026-09-01

## Outcome

Replace the overloaded Sources screen with one Account destination where a person can understand who is signed in, how saves enter Locus, and how to manage their data.

The first implementation remains local-first and does not depend on OAuth or Cloudflare. OAuth can later fill the Account identity section without redesigning the page.

## Product decisions

1. Rename the navigation label from **Sources** to **Account**. Keep `#/sources` as the route during the first pass so bookmarks and internal links continue to work.
2. Show exactly one connection entry for each supported provider: X, Instagram, YouTube, and Reddit.
3. A source connection is a live capture relationship. Imported provenance is not a connection and must never create another provider card.
4. Browser extension pairing is device-level setup. Show it once, not inside every provider entry.
5. Use **capture** for bringing saves into Locus. Do not use “sync” or mix “refresh” and “capture” for the same action.
6. Put destructive data actions behind a separate **Data and privacy** section. They must not compete with ordinary source actions.
7. The first pass supports one visible live connection per provider. Multiple accounts per provider are out of scope for the beta.

## Page structure

The page is a narrow settings layout with four sections in this order.

### 1. Account

For the current local edition:

- title: `Local account`
- supporting text: `Your Library is stored on this device.`
- no fake avatar, email, or sign-in controls

After OAuth is implemented, this same section shows:

- avatar, display name, and primary email
- linked sign-in methods: Google and GitHub
- `Sign out`
- a separate session-management link when that capability exists

OAuth providers authenticate the Locus account. They are not listed as save Sources.

### 2. Capture setup

Show one **Browser extension** setup panel before the providers:

- states: `Not paired`, `Paired`, `Needs attention`
- primary action when unpaired: `Pair extension`
- when paired: last-seen information and a secondary `Pair another browser` action
- the one-time pairing value appears in a labelled, read-only field with a `Copy pairing code` button

Below it, show a heading and explanation:

> Sources
> Connect the places where you save things. Locus keeps captured Items when a Source is disconnected.

Render four compact provider rows or cards. Each contains:

- provider mark and name
- connected handle, when available
- one textual status
- last successful capture, when available
- one contextual primary action
- secondary actions in a small menu or disclosure

Do not render capture previews permanently in the card. If interactive local capture needs a preview, show it in a temporary progress detail below the active provider.

### 3. Preferences

- `Capture new saves when Locus opens` checkbox for the local edition
- writing-tools availability belongs here only while it is a user-configurable local capability

Hosted behavior may replace the on-open preference with a background-capture schedule; that is a later decision.

### 4. Data and privacy

Use progressive disclosure for infrequent operations:

- Export Library
- Restore from archive
- Import source exports
- Delete Library

`Delete Library` is visually separated, uses explicit destructive copy, and requires confirmation that names the consequence. Import forms are collapsed until requested; empty textareas should not dominate the page on every visit.

## Provider state model

The API returns one presentation model per provider, rather than every `source_accounts` row.

| State | Meaning | Primary action | Secondary action |
| --- | --- | --- | --- |
| `not_connected` | No live or pending connection | Connect | None |
| `connecting` | One pending setup exists | Continue setup | Cancel setup |
| `connected` | One resolved live account exists | Capture now | Disconnect |
| `capturing` | Capture is active | View progress | Stop capture |
| `needs_attention` | Latest live capture requires recovery | Resolve issue | Disconnect |

Status copy must explain state without relying on color. Examples:

- `Connected as @abhigyan898`
- `Last captured 12 minutes ago`
- `Capture stopped. Sign in to X, then continue.`
- `Not connected`

Imported data is summarized separately in **Import history**, for example `Reddit export · 428 Items · 28 Aug 2026`. It never changes a provider's connection state.

## API shape

Replace `SourceGroup.accounts: SourceHealth[]` as the page-facing contract with an aggregate shape equivalent to:

```ts
interface SourceConnection {
  source: SourceId;
  label: string;
  state: "not_connected" | "connecting" | "connected" | "capturing" | "needs_attention";
  liveAccount: {
    id: string;
    externalId: string;
    displayName: string | null;
  } | null;
  progress: SourceProgress | null;
  lastCapture: SourceRunSummary | null;
}

interface AccountSourcesOverview {
  account: { mode: "local" };
  extension: ExtensionHealth;
  connections: SourceConnection[];
  imports: ImportSummary[];
  preferences: { captureOnOpen: boolean };
}
```

The server, not the React page, owns the precedence and aggregation rules. The UI must not guess which database row represents the connection.

## Data invariants and cleanup

For the current local database, and later per Library in D1:

- at most one resolved live account per provider
- at most one pending live account per provider, and only while setup is incomplete
- any number of imported identities may remain for provenance
- imported identities are never accepted by connect, disconnect, or capture-now endpoints
- when a resolved live account exists, it wins over a stale pending row in the presentation model

Before deleting duplicate or stale rows, preserve references from:

- source collections and capture runs
- source records
- capture tokens and capture sessions

Cleanup is transactional:

1. Select a canonical live account for each provider: active capture first, otherwise the newest resolved live account.
2. Repoint compatible referenced records to the canonical account, resolving uniqueness collisions by retaining the newest/highest-revision record.
3. Revoke tokens attached to discarded pending accounts.
4. Delete only pending rows that have no remaining irreplaceable provenance.
5. Leave imported rows intact and expose them only through Import history.

Creating or continuing setup must reuse the existing pending row. Completing setup must resolve that row or merge it into the canonical live account; it must not leave another visible connection behind.

## Interaction and accessibility requirements

- The page has one `h1` (`Account`) followed by coherent `h2` section headings.
- Buttons use verb-first, sentence-case labels.
- Only one filled primary action appears within each provider entry.
- Status and failure messages use text in addition to color and are announced appropriately.
- Action errors stay next to the action and explain the next recovery step.
- Pairing output has a persistent label; copying it gives a visible confirmation.
- All controls are reachable by keyboard and have a visible focus state.
- At 320 CSS pixels and at 200% zoom, provider details wrap without horizontal scrolling or hidden actions.
- Destructive actions are not adjacent to the routine primary action on narrow screens.

## Delivery slices

### Slice A — correct the model and duplicate display

- add the aggregate server response
- render exactly four provider entries
- exclude imported identities from connection state
- prefer a resolved live account over pending setup
- add API tests for the screenshot scenario and repeated setup

### Slice B — make the page an Account destination

- rename the navigation label to Account
- add the local Account summary
- move extension pairing into one setup panel
- change routine source action copy from `Refresh` to `Capture now`
- move imports to collapsed Import history/data controls

### Slice C — harden lifecycle and cleanup

- make connect/setup idempotent
- merge or safely remove stale pending rows
- make disconnect revoke connection access while retaining Items and import provenance
- add migration and lifecycle tests

OAuth integration is deliberately not part of these slices. It will replace the local Account summary after this page is stable.

## Acceptance criteria

- The current screenshot scenario shows four provider entries, not seven.
- X shows the connected handle; its imported and pending rows do not appear as connections.
- Instagram shows one connected entry; its imported row appears only in Import history.
- Browser extension pairing appears once on the page.
- Repeated Connect, Continue setup, Cancel, and Import operations do not create additional visible connections.
- Disconnect keeps previously captured Items and imported provenance.
- A partial imported run is not presented as the live account's latest capture status.
- Account, Capture setup, Preferences, and Data and privacy remain understandable and usable on desktop, keyboard-only navigation, 320px width, and 200% zoom.

## Explicitly deferred

- Google/GitHub OAuth implementation
- multi-user tenancy and admin management
- multiple live accounts for the same provider
- Cloudflare Workers and D1 migration
- background schedules and Queues
- Effect adoption
