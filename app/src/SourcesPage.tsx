import { useEffect, useState } from "react";
import { api, type ImportResult, type SourceGroup, type SourceHealth, type SourceId } from "./api.ts";
import { sourceLabel } from "./source-icons.ts";
import { SourceMark } from "./SourceMark.tsx";
import { notifyLibraryChanged } from "./library-events.ts";
export function SourcesPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.sources>> | null>(null);
  const [pair, setPair] = useState<{ text: string; source: SourceId } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [deskAction, setDeskAction] = useState<"export" | "delete" | null>(null);

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
  useEffect(() => {
    void reload().catch(() => {});
    const t = setInterval(() => { void reload().catch(() => {}); }, 1500);
    return () => clearInterval(t);
  }, []);

  if (!data) return <p className="quiet">Loading sources…</p>;

  return (
    <section className="stack">
      <p className="quiet">Connect an account to bring in your saves.</p>
      {msg && <div className="banner">{msg}</div>}
      {pageError ? <p className="action-error" role="alert">{pageError}</p> : null}
      <div className="source-grid">
        {data.sources.map((g) => {
          const shown = g.accounts.length > 0
            ? g.accounts
            : [
                {
                  source: g.source,
                  account: null,
                  running: false,
                  progress: null,
                  lastRun: null,
                } satisfies SourceHealth,
              ];
          return shown.map((health, i) => (
            <SourceCard
              key={`${g.source}-${health.account?.id ?? i}`}
              group={g}
              health={health}
              extensionAlive={data.extension.alive}
              onConnect={async () => {
                const state = sourceAccountState(health);
                const r = await api.connect(g.source, state === "connected" || state === "runner" || state === "extension" ? health.account?.id : undefined);
                setMsg(r.copy);
                notifyLibraryChanged();
                await reload();
              }}
              onCancel={() => health.account ? api.cancel(g.source, health.account.id).then(() => { notifyLibraryChanged(); return reload(); }) : undefined}
              onResume={() => health.account ? api.resume(g.source, health.account.id).then(reload) : undefined}
              onDisconnect={() => {
                if (health.account && confirm(`Disconnect ${g.label}? Your saved items will stay in Locus.`)) {
                  return api.disconnect(g.source, health.account.id).then(() => { notifyLibraryChanged(); return reload(); });
                }
                return undefined;
              }}
              onPair={async () => {
                const r = await api.pairExtension(g.source);
                setPair({ text: `${r.origin}\n${r.token}`, source: g.source });
              }}
            />
          ));
        })}
      </div>
      {pair && (
        <div className="block">
          <h2 className="source-name">
            <SourceMark source={pair.source} />
            Extension pairing
          </h2>
          <p className="quiet">Paste this into the Locus extension. It is shown once.</p>
          <textarea readOnly value={pair.text} />
        </div>
      )}
      <div className="block">
        <h2>Settings</h2>
        <label className="stack">
          <span>
            <input type="checkbox" checked={data.settings.refreshOnOpen} disabled={settingsBusy} onChange={(e) => {
              const checked = e.target.checked;
              setSettingsBusy(true);
              setPageError(null);
              api.settings(checked).then(() => reload()).catch((error: unknown) => setPageError(error instanceof Error ? error.message : String(error))).finally(() => setSettingsBusy(false));
            }} />{" "}
            Refresh sources when Locus opens
          </span>
        </label>
        <p className="quiet">{data.extension.alive ? "Browser extension connected." : "Browser extension not connected."}</p>
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
        <div className="filters">
          <button
            className="btn"
            disabled={Boolean(deskAction)}
            onClick={async () => {
              setDeskAction("export");
              setPageError(null);
              try {
                const lib = await api.exportLibrary();
                const blob = new Blob([JSON.stringify(lib, null, 2)], { type: "application/json" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = "locus-library.json";
                a.click();
                setMsg("Library exported.");
              } catch (e) {
                setPageError(e instanceof Error ? e.message : String(e));
              } finally {
                setDeskAction(null);
              }
            }}
          >
            {deskAction === "export" ? "Exporting…" : "Export JSON"}
          </button>
          <button
            className="btn danger"
            disabled={Boolean(deskAction)}
            onClick={() => {
              if (!confirm("Delete the entire local library?")) return;
              setDeskAction("delete");
              setPageError(null);
              api.deleteLibrary().then(() => { notifyLibraryChanged(); return reload(); }).then(() => setMsg("Library deleted.")).catch((e: unknown) => setPageError(e instanceof Error ? e.message : String(e))).finally(() => setDeskAction(null));
            }}
          >
            {deskAction === "delete" ? "Deleting…" : "Delete library"}
          </button>
        </div>
        <ImportPanel />
      </div>
    </section>
  );
}

type SourceAccountState = "imported" | "pending" | "runner" | "extension" | "connected";

function sourceAccountState(health: SourceHealth): SourceAccountState {
  const explicit = health.account?.state;
  if (explicit) return explicit;
  if (!health.account) return "pending";
  return "connected";
}

function SourceCard({
  group,
  health,
  extensionAlive,
  onConnect,
  onCancel,
  onResume,
  onDisconnect,
  onPair,
}: {
  group: SourceGroup;
  health: SourceHealth;
  extensionAlive: boolean;
  onConnect: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  onResume: () => void | Promise<void>;
  onDisconnect: () => void | Promise<void>;
  onPair: () => void | Promise<void>;
}) {
  const running = health.running;
  const progress = health.progress;
  const last = health.lastRun;
  const state = sourceAccountState(health);
  const connected = state === "connected" || state === "runner" || state === "extension";
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const run = async (action: () => void | Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={`source-card src-${group.source}`}>
      <h3 className="source-name">
        <SourceMark source={group.source} named={false} />
        {group.label}
      </h3>
      <p className="quiet">{health.account?.displayName || (state === "pending" ? "Not connected" : health.account?.externalId) || "Not connected"}</p>
      <p className={`source-state source-state-${state}`} role="status">
        {state === "imported" ? "Imported" : state === "pending" ? "Setup needed" : state === "extension" ? "Browser connected" : connected ? "Connected" : "Not connected"}
      </p>
      {running && progress && (
        <>
          <div className="bar">
            <span style={{ ["--w" as string]: `${Math.min(100, 8 + progress.seen * 3)}%` }} />
          </div>
          <p>{progress.message}</p>
          {progress.previewJpeg && (
            <img alt="The Locus capture window" src={`data:image/jpeg;base64,${progress.previewJpeg}`} style={{ width: "100%", border: "1px solid var(--rule)" }} />
          )}
          <button className="btn danger" disabled={busy} onClick={() => void run(onCancel)}>
            Stop
          </button>
        </>
      )}
      {!running && (
        <div className="filters">
          {state !== "imported" ? <button className="btn primary" disabled={busy} onClick={() => void run(onConnect)}>
            {connected ? "Refresh" : "Connect / pair"}
          </button> : null}
          {last?.errorCode === "challenge" && health.account && state !== "imported" && (
            <button className="btn copper" disabled={busy} onClick={() => void run(onResume)}>
              Resume
            </button>
          )}
          {health.account && connected && (
            <button className="btn danger" disabled={busy} onClick={() => void run(onDisconnect)}>
              Disconnect
            </button>
          )}
          {!extensionAlive || state === "pending" || state === "connected" ? <button className="btn" disabled={busy} onClick={() => void run(onPair)}>
            Pair extension
          </button> : null}
        </div>
      )}
      {busy ? <p className="quiet" role="status">Working…</p> : null}
      {actionError ? <p className="action-error" role="alert">{actionError}</p> : null}
      {last && (
        <p className={last.coverage === "complete" ? "ok" : "warn"}>
          {last.coverageLabel} {last.recovery ? `— ${last.recovery}` : ""}
        </p>
      )}
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
      <h2 style={{ fontFamily: "var(--display)" }}>Import</h2>
      <textarea value={jsonl} onChange={(e) => { setJsonl(e.target.value); setErr(null); }} placeholder="Locus export (JSONL)" aria-label="Locus export JSONL" />
      <div className="filters">
        <button className="btn" disabled={busy} onClick={() => { if (!jsonl.trim()) { setErr("Paste a JSONL file first"); return; } void runImport(() => api.importJsonl(jsonl, true), true); }}>
          Check file
        </button>
        <button className="btn" disabled={busy} onClick={() => { if (!jsonl.trim()) { setErr("Paste a JSONL file first"); return; } void runImport(() => api.importJsonl(jsonl, false), false); }}>
          Import file
        </button>
      </div>
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
