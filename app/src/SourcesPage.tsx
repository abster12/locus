import { useEffect, useState } from "react";
import { api, type ExtensionHealth, type ImportResult, type ImportSummary, type LibraryCapability, type LibraryCapabilityScope, type SourceConnection, type SourceConnectionState } from "./api.ts";
import { SourceMark } from "./SourceMark.tsx";
import { notifyLibraryChanged } from "./library-events.ts";
import { RUNTIME } from "./runtime.ts";

const CONNECTION_UI: Record<SourceConnectionState, { status: string; primary: string; secondary: string | null }> = {
  not_connected: { status: "Not connected", primary: "Connect", secondary: null },
  connecting: { status: "Connecting", primary: "Continue setup", secondary: "Cancel setup" },
  connected: { status: "Connected", primary: "Capture now", secondary: "Disconnect" },
  capturing: { status: "Capturing", primary: "View progress", secondary: "Stop capture" },
  needs_attention: { status: "Needs attention", primary: "Resolve issue", secondary: "Disconnect" },
};

function isPlaceholderHandle(value: string): boolean {
  const name = value.trim();
  return !name || name === "pending" || name.startsWith("pending:") || /^(x|instagram|youtube|reddit|unknown|extension)$/i.test(name);
}

function liveHandle(connection: SourceConnection): string | null {
  if (connection.state !== "connected" && connection.state !== "capturing" && connection.state !== "needs_attention") return null;
  const account = connection.liveAccount;
  if (!account) return null;
  for (const value of [account.displayName, account.externalId]) {
    const handle = value?.trim() ?? "";
    if (handle && !isPlaceholderHandle(handle)) return handle;
  }
  return null;
}

function formatImportDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}

function formatWhen(iso: string, verb: "captured" | "seen", now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return `Last ${verb} ${iso}`;
  const delta = now - t;
  if (delta < 0 || delta >= 24 * 60 * 60 * 1000) return `Last ${verb} ${formatImportDay(iso)}`;
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return `Last ${verb} just now`;
  if (minutes < 60) return `Last ${verb} ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  return `Last ${verb} ${hours} hour${hours === 1 ? "" : "s"} ago`;
}

function extensionStatus(extension: ExtensionHealth): string {
  if (extension.state === "paired") return "Paired";
  if (extension.state === "needs_attention") return "Needs attention";
  return "Not paired";
}

function importHistoryLine(entry: ImportSummary): string {
  const items = `${entry.itemCount} ${entry.itemCount === 1 ? "Item" : "Items"}`;
  return `${entry.label} · ${items} · ${formatImportDay(entry.importedAt)}`;
}

function nextStep(state: SourceConnectionState): string {
  switch (state) {
    case "not_connected":
      return "Connect this Source to try again.";
    case "connecting":
      return "Continue setup, or cancel it.";
    case "connected":
      return "Try Capture now again.";
    case "capturing":
      return "View progress, or stop capture.";
    case "needs_attention":
      return "Resolve the issue, then try again.";
  }
}

export function SourcesPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.sources>> | null>(null);
  const [pair, setPair] = useState<{ origin: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [deskAction, setDeskAction] = useState<"export" | "restore" | "delete" | null>(null);
  const [grants, setGrants] = useState<LibraryCapability[] | null>(null);
  const [grantLabel, setGrantLabel] = useState("");
  const [grantBusy, setGrantBusy] = useState(false);
  const [issued, setIssued] = useState<{ id: string; token: string; url: string; scope: LibraryCapabilityScope } | null>(null);
  const [issuedCopied, setIssuedCopied] = useState(false);

  async function reload() {
    try {
      setData(await api.sources());
      setPageError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setPageError(message);
      throw e;
    }
  }
  async function reloadGrants() {
    const overview = await api.libraryCapabilities();
    setGrants(overview.capabilities);
  }
  async function issueGrant(scope: LibraryCapabilityScope) {
    if (grantBusy) return;
    setGrantBusy(true);
    setPageError(null);
    setIssuedCopied(false);
    try {
      const created = await api.issueLibraryCapability(scope, grantLabel);
      setIssued({ id: created.capability.id, token: created.token, url: created.url, scope: created.capability.scope });
      await reloadGrants();
    } catch (e) {
      setPageError(e instanceof Error ? e.message : String(e));
    } finally {
      setGrantBusy(false);
    }
  }
  async function revokeGrant(grant: LibraryCapability) {
    if (grantBusy) return;
    if (!confirm(`Revoke ${grant.scope === "library:read" ? "read" : "write"} access${grant.label.trim() ? ` for ${grant.label.trim()}` : ""}?`)) return;
    setGrantBusy(true);
    setPageError(null);
    try {
      await api.revokeLibraryCapability(grant.id);
      if (issued?.id === grant.id) setIssued(null);
      await reloadGrants();
    } catch (e) {
      setPageError(e instanceof Error ? e.message : String(e));
    } finally {
      setGrantBusy(false);
    }
  }
  useEffect(() => {
    void reload().catch(() => {});
    void reloadGrants().catch(() => {});
    const t = setInterval(() => { void reload().catch(() => {}); }, 1500);
    return () => clearInterval(t);
  }, []);

  if (!data) return <p className="quiet">Loading account…</p>;

  const pairingText = pair ? `${pair.origin}\n${pair.token}` : "";

  async function pairExtension() {
    if (pairBusy) return;
    setPairBusy(true);
    setPairError(null);
    setCopied(false);
    try {
      setPair(await api.pairExtension());
    } catch (e) {
      setPairError(`${e instanceof Error ? e.message : String(e)} Copy the pairing code once it appears, then paste it into the extension.`);
    } finally {
      setPairBusy(false);
    }
  }

  return (
    <section className="stack">
      {msg && <div className="banner">{msg}</div>}
      {pageError ? <p className="action-error" role="alert">{pageError}</p> : null}

      {RUNTIME !== "hosted" ? (
        <div className="pagehead">
          <h1>Account</h1>
        </div>
      ) : null}

      {RUNTIME !== "hosted" ? (
        <div className="block" id="local-account">
          <h2>Account</h2>
          <h3>Local account</h3>
          <p className="quiet">Your Library is stored on this device.</p>
        </div>
      ) : null}

      <div className="block" id="library-intake-access">
        <h2>Library Intake</h2>
        <p className="quiet">Let a chosen agent look up this Library when Locus is not open. This is not Capture access.</p>
        <label htmlFor="library-intake-agent">Agent name</label>
        <input
          id="library-intake-agent"
          value={grantLabel}
          maxLength={80}
          onChange={(e) => setGrantLabel(e.target.value)}
          placeholder="Claude, Cursor, …"
        />
        <div className="source-actions">
          <button type="button" className="btn" disabled={grantBusy} onClick={() => void issueGrant("library:read")}>
            Create read access
          </button>
          <button type="button" className="btn" disabled={grantBusy} onClick={() => void issueGrant("library:write")}>
            Create write access
          </button>
        </div>
        {issued ? (
          <>
            <label htmlFor="library-intake-secret">Access details</label>
            <textarea id="library-intake-secret" className="source-pair-code" readOnly value={`${issued.url}\n${issued.token}`} />
            <button
              type="button"
              className="btn"
              onClick={() => {
                const text = `${issued.url}\n${issued.token}`;
                const ok = () => setIssuedCopied(true);
                try {
                  void navigator.clipboard.writeText(text).then(ok, ok);
                } catch {
                  ok();
                }
              }}
            >
              Copy access details
            </button>
            <p role="status">{issuedCopied ? `Copied ${issued.scope === "library:read" ? "read" : "write"} access.` : "Shown once. Copy it now."}</p>
          </>
        ) : null}
        {grants && grants.length > 0 ? (
          <ul className="library-intake-grants">
            {grants.map((grant) => (
              <li key={grant.id}>
                <span>{grant.label.trim() || "Unnamed agent"} · {grant.scope === "library:read" ? "Read" : "Write"}</span>
                <button
                  type="button"
                  className="btn"
                  disabled={grantBusy}
                  onClick={() => void revokeGrant(grant)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <h2>Capture setup</h2>
      <p className="quiet">Bring saves into Locus from the browser extension and your Sources.</p>

      <div className="block" id="extension-setup">
        <h3>Browser extension</h3>
        <p role="status">{extensionStatus(data.extension)}</p>
        {data.extension.lastSeenAt ? <p>{formatWhen(data.extension.lastSeenAt, "seen")}</p> : null}
        <div className="source-actions">
          {data.extension.state === "not_paired" ? (
            <button type="button" className="btn primary" disabled={pairBusy} onClick={() => void pairExtension()}>
              Pair extension
            </button>
          ) : data.extension.state === "needs_attention" ? (
            <button type="button" className="btn primary" disabled={pairBusy} onClick={() => void pairExtension()}>
              Pair another browser
            </button>
          ) : (
            <button type="button" className="btn" disabled={pairBusy} onClick={() => void pairExtension()}>
              Pair another browser
            </button>
          )}
        </div>
        {pair ? (
          <>
            <label htmlFor="pairing-code">Pairing code</label>
            <textarea id="pairing-code" className="source-pair-code" readOnly value={pairingText} />
            <button
              type="button"
              className="btn"
              id="copy-pairing-code"
              onClick={() => {
                const copiedCode = () => setCopied(true);
                const failed = () => setPairError("Copy failed. Select the pairing code and copy it yourself.");
                const fallback = () => {
                  const field = document.getElementById("pairing-code");
                  if (field instanceof HTMLTextAreaElement) field.select();
                  if (document.execCommand("copy")) copiedCode();
                  else failed();
                };
                try {
                  void navigator.clipboard.writeText(pairingText).then(copiedCode, fallback);
                } catch {
                  fallback();
                }
              }}
            >
              Copy pairing code
            </button>
            <p role="status">{copied ? "Copied pairing code." : ""}</p>
          </>
        ) : null}
        {pairError ? <p className="action-error" role="alert">{pairError}</p> : null}
      </div>

      <h3>Sources</h3>
      <p className="quiet">Connect the places where you save things. Locus keeps captured Items when a Source is disconnected.</p>
      <div className="source-grid">
        {data.connections.map((connection) => {
          const accountId = connection.liveAccount?.id;
          return (
            <SourceCard
              key={connection.source}
              connection={connection}
              onStart={() =>
                api.connect(connection.source, connection.state === "not_connected" ? undefined : accountId).then(() => {
                  notifyLibraryChanged();
                  return reload();
                })
              }
              onResolve={() =>
                accountId ? api.resume(connection.source, accountId).then(() => { notifyLibraryChanged(); return reload(); }) : undefined
              }
              onCancel={() =>
                accountId ? api.cancel(connection.source, accountId).then(() => { notifyLibraryChanged(); return reload(); }) : undefined
              }
              onDisconnect={() => {
                if (accountId && confirm(`Disconnect ${connection.label}? Your saved items will stay in Locus.`)) {
                  return api.disconnect(connection.source, accountId).then(() => { notifyLibraryChanged(); return reload(); });
                }
                return undefined;
              }}
            />
          );
        })}
      </div>
      {RUNTIME !== "hosted" ? (
      <div className="block" id="preferences">
        <h2>Preferences</h2>
        <label className="stack">
          <span>
            <input type="checkbox" checked={data.preferences.captureOnOpen} disabled={settingsBusy} onChange={(e) => {
              const checked = e.target.checked;
              setSettingsBusy(true);
              setPageError(null);
              api.settings(checked).then(() => reload()).catch((error: unknown) => setPageError(error instanceof Error ? error.message : String(error))).finally(() => setSettingsBusy(false));
            }} />{" "}
            Capture new saves when Locus opens
          </span>
        </label>
        {data.pi.available ? <p className="quiet">Writing tools ready.</p> : null}
        {!data.pi.available && (
          <p className="quiet">
            To use summaries and Auto-tag, install{" "}
            <a href="https://pi.dev" target="_blank" rel="noopener noreferrer">
              Pi
            </a>
            , then sign in.
          </p>
        )}
      </div>
      ) : null}

      <div className="block" id="data-and-privacy">
        <h2>{RUNTIME === "hosted" ? "Import" : "Data and privacy"}</h2>
        {data.imports.length > 0 ? (
          <div id="import-history">
            <h3>Import history</h3>
            <ul>
              {data.imports.map((entry) => (
                <li key={entry.id}>{importHistoryLine(entry)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {RUNTIME !== "hosted" ? (
        <div className="filters">
          <button
            className="btn"
            disabled={Boolean(deskAction)}
            onClick={async () => {
              setDeskAction("export");
              setPageError(null);
              try {
                const lib = await api.exportLibrary();
                const a = document.createElement("a");
                a.href = URL.createObjectURL(lib.blob);
                a.download = lib.filename;
                a.click();
                URL.revokeObjectURL(a.href);
                setMsg("Library exported.");
              } catch (e) {
                setPageError(e instanceof Error ? e.message : String(e));
              } finally {
                setDeskAction(null);
              }
            }}
          >
            {deskAction === "export" ? "Exporting…" : "Export library"}
          </button>
          <button
            className="btn"
            disabled={Boolean(deskAction)}
            onClick={() => {
              if (!confirm("Restore requires an empty library. Delete Library first if this desk already has saves.")) return;
              const input = document.createElement("input");
              input.type = "file";
              input.accept = ".ndjson,.locus.ndjson,application/x-ndjson,text/plain";
              input.onchange = () => {
                const file = input.files?.[0];
                if (!file) return;
                setDeskAction("restore");
                setPageError(null);
                api
                  .importLibrary(file)
                  .then(() => {
                    notifyLibraryChanged();
                    return reload();
                  })
                  .then(() => setMsg("Library restored."))
                  .catch((e: unknown) => setPageError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setDeskAction(null));
              };
              input.click();
            }}
          >
            {deskAction === "restore" ? "Restoring…" : "Restore from archive"}
          </button>
        </div>
        ) : null}
        <details id="import-source-exports" className="account-import">
          <summary>Import source exports</summary>
          <ImportPanel />
        </details>
        {RUNTIME !== "hosted" ? (
        <div className="account-danger">
          <button
            className="btn danger"
            disabled={Boolean(deskAction)}
            onClick={() => {
              if (!confirm("This permanently deletes every Item in this Library.")) return;
              setDeskAction("delete");
              setPageError(null);
              api.deleteLibrary().then(() => { notifyLibraryChanged(); return reload(); }).then(() => setMsg("Library deleted.")).catch((e: unknown) => setPageError(e instanceof Error ? e.message : String(e))).finally(() => setDeskAction(null));
            }}
          >
            {deskAction === "delete" ? "Deleting…" : "Delete library"}
          </button>
        </div>
        ) : null}
      </div>
    </section>
  );
}

function SourceCard({
  connection,
  onStart,
  onResolve,
  onCancel,
  onDisconnect,
}: {
  connection: SourceConnection;
  onStart: () => void | Promise<void>;
  onResolve: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  onDisconnect: () => void | Promise<void>;
}) {
  const state = connection.state;
  const copy = CONNECTION_UI[state];
  const handle = liveHandle(connection);
  const progress = connection.progress;
  const progressId = `${connection.source}-progress`;
  const errorId = `${connection.source}-action-error`;
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const run = async (action: () => void | Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (e) {
      setActionError(`${e instanceof Error ? e.message : String(e)} ${nextStep(state)}`);
    } finally {
      setBusy(false);
    }
  };
  const onPrimary = () => {
    if (state === "capturing") {
      document.getElementById(progressId)?.focus();
      return;
    }
    void run(state === "needs_attention" ? onResolve : onStart);
  };
  const onSecondary = () => {
    void run(state === "connecting" || state === "capturing" ? onCancel : onDisconnect);
  };
  return (
    <article className={`source-card src-${connection.source}`}>
      <h4 className="source-name">
        <SourceMark source={connection.source} named={false} />
        {connection.label}
      </h4>
      {handle ? <p className="source-handle">{handle}</p> : null}
      <p className={`source-state source-state-${state.replaceAll("_", "-")}`} role="status">
        {copy.status}
      </p>
      {connection.lastSuccessfulCapture?.finishedAt ? <p>{formatWhen(connection.lastSuccessfulCapture.finishedAt, "captured")}</p> : null}
      {state === "needs_attention" && connection.latestAttempt?.recovery ? <p role="status">{connection.latestAttempt.recovery}</p> : null}
      {state === "capturing" && progress ? (
        <div id={progressId} tabIndex={-1} role="status">
          <div className="bar">
            <span style={{ ["--w" as string]: `${Math.min(100, 8 + progress.seen * 3)}%` }} />
          </div>
          <p>{progress.message}</p>
          {progress.previewJpeg ? (
            <img alt="The Locus capture window" src={`data:image/jpeg;base64,${progress.previewJpeg}`} style={{ width: "100%", border: "1px solid var(--rule)" }} />
          ) : null}
        </div>
      ) : null}
      <div className="source-actions">
        <button type="button" className="btn primary" disabled={busy} aria-describedby={actionError ? errorId : undefined} onClick={onPrimary}>
          {copy.primary}
        </button>
        {copy.secondary ? (
          <details className="source-more">
            <summary>More</summary>
            <button type="button" className={copy.secondary === "Disconnect" ? "btn danger" : "btn"} disabled={busy} onClick={onSecondary}>
              {copy.secondary}
            </button>
          </details>
        ) : null}
      </div>
      {busy ? <p className="quiet" role="status">Working…</p> : null}
      {actionError ? <p id={errorId} className="action-error" role="alert">{actionError}</p> : null}
    </article>
  );
}

function ImportPanel() {
  const [jsonl, setJsonl] = useState("");
  const [posts, setPosts] = useState("");
  const [comments, setComments] = useState("");
  const [out, setOut] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function runImport(work: () => Promise<ImportResult>, dryRun: boolean) {
    if (busy) return;
    setErr(null);
    setOut("");
    setBusy(true);
    try {
      const result = await work();
      setOut(formatImportResult(result, dryRun));
      notifyLibraryChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack" style={{ marginTop: 16 }}>
      <textarea value={jsonl} onChange={(e) => { setJsonl(e.target.value); setErr(null); }} placeholder="Locus export (JSONL)" aria-label="Locus export JSONL" />
      <div className="filters">
        <button className="btn" disabled={busy} onClick={() => { if (!jsonl.trim()) { setErr("Paste a JSONL file first"); return; } void runImport(() => api.importJsonl(jsonl, true), true); }}>
          Check file
        </button>
        <button className="btn" disabled={busy} onClick={() => { if (!jsonl.trim()) { setErr("Paste a JSONL file first"); return; } void runImport(() => api.importJsonl(jsonl, false), false); }}>
          Import file
        </button>
      </div>
      {RUNTIME !== "hosted" ? (
      <>
      <textarea value={posts} onChange={(e) => { setPosts(e.target.value); setErr(null); }} placeholder="Reddit saved_posts.csv" aria-label="Reddit saved posts CSV" />
      <textarea value={comments} onChange={(e) => { setComments(e.target.value); setErr(null); }} placeholder="Reddit saved_comments.csv" aria-label="Reddit saved comments CSV" />
      <div className="filters">
        <button className="btn" disabled={busy} onClick={() => { if (!posts.trim() && !comments.trim()) { setErr("Paste a Reddit export first"); return; } void runImport(() => api.importReddit(posts, comments, true), true); }}>
          Check Reddit export
        </button>
        <button className="btn" disabled={busy} onClick={() => { if (!posts.trim() && !comments.trim()) { setErr("Paste a Reddit export first"); return; } void runImport(() => api.importReddit(posts, comments, false), false); }}>
          Import Reddit export
        </button>
      </div>
      </>
      ) : null}
      {busy ? <p className="quiet" role="status">Importing…</p> : null}
      {err ? <p className="action-error" role="alert">{err}</p> : null}
      {out ? <p className="quiet" role="status">{out}</p> : null}
    </div>
  );
}

function formatImportResult(result: ImportResult, dryRun: boolean): string {
  if (dryRun) return `Ready to import ${result.changes} change${result.changes === 1 ? "" : "s"}.`;
  const parts = [`${result.inserted} added`, `${result.updated} updated`, `${result.removed} removed`];
  if (result.replayed) parts.push(`${result.replayed} already imported`);
  return `${parts.join(" · ")}.`;
}
