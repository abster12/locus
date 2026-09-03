import { useEffect, useState } from "react";
import { api, type Collection } from "./api.ts";
import { notifyLibraryChanged } from "./library-events.ts";
import { RUNTIME } from "./runtime.ts";
export function CollectionsPage() {
  const [cols, setCols] = useState<Collection[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.collections().then((r) => setCols(r.collections)).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  return (
    <section>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          const clean = name.trim();
          if (!clean) {
            setErr("Collection name is required");
            return;
          }
          setBusy(true);
          setErr(null);
          api.createCollection(clean).then((r) => {
            setCols(r.collections);
            setName("");
            notifyLibraryChanged();
          }).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
        }}
      >
        <input className="search" value={name} onChange={(e) => { setName(e.target.value); setErr(null); }} placeholder="New collection" aria-invalid={Boolean(err)} />
        <button className="btn primary" disabled={busy} type="submit">
          {busy ? "Creating…" : "Create"}
        </button>
      </form>
      {err ? <p className="action-error" role="alert">{err}</p> : null}
      <div className="grid">
        {cols.map((c) => (
          <a key={c.id} className="card src-neutral" href={`#/collections/${c.id}`}>
            <h3>{c.name}</h3>
            <p className="quiet">{c.count} items</p>
            {RUNTIME !== "hosted" ? (
              <p>
                <a href={`#/summary/collection/${c.id}`} onClick={(e) => e.stopPropagation()}>
                  Summary
                </a>
              </p>
            ) : null}
          </a>
        ))}
      </div>
    </section>
  );
}
