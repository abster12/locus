import { useEffect, useMemo, useState } from "react";
import { api, type SummarySnapshot } from "./api.ts";
import { useProse } from "./use-prose.ts";
export function SummaryPage({ scope, scopeRef }: { scope: "day" | "collection"; scopeRef: string }) {
  const [snap, setSnap] = useState<SummarySnapshot | null>(null);
  const { prose, error: proseErr, busy, generate: generateProse } = useProse(scope, scopeRef);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setErr(null);
    api.summary(scope, scopeRef).then((r) => {
      setSnap(r.snapshot);
    }).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, [scope, scopeRef]);
  const cited = useMemo(() => new Map(snap?.items.map((i) => [i.id, i]) ?? []), [snap]);
  if (err) return <p className="action-error" role="alert">{err}</p>;
  if (!snap) return <p className="quiet">Loading summary…</p>;
  return (
    <section className="summary">
      <p className="quiet">Highlights from these saves.</p>
      {snap.blocks.map((b) => (
        <article key={b.kind} className="block">
          <h2>{b.title}</h2>
          {b.kind === "inbox" && <p>{b.count} still in inbox</p>}
          {b.rows && (
            <ul>
              {b.rows.map((row, i) => (
                <li key={i}>
                  {String(row.source || row.name || row.tag || row.collection || row.excerpt || "")}
                  {typeof row.count === "number" ? ` · ${row.count}` : ""}{" "}
                  {Array.isArray(row.itemIds) &&
                    row.itemIds.slice(0, 3).map((id) => {
                      const u = cited.get(String(id))?.url;
                      return u ? (
                        <a key={String(id)} className="cite" href={u} target="_blank" rel="noopener noreferrer">
                          ↗
                        </a>
                      ) : null;
                    })}
                  {typeof row.itemId === "string" && cited.get(row.itemId)?.url && (
                    <a className="cite" href={cited.get(row.itemId)!.url} target="_blank" rel="noopener noreferrer">
                      ↗
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
          {b.kind === "citations" && (
            <ul>
              {(b.itemIds || []).map((id) => {
                const it = cited.get(id);
                return (
                  <li key={id}>
                    {it?.url ? (
                      <a href={it.url} target="_blank" rel="noopener noreferrer">
                        {it.title || it.url}
                      </a>
                    ) : (
                      it?.title || id
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </article>
      ))}
      <article className="block">
        <h2>Write a summary</h2>
        <button
          className="btn copper"
          disabled={busy}
          onClick={() => void generateProse()}
        >
          Write summary
        </button>
        {proseErr ? <p className="action-error" role="alert">{proseErr}</p> : null}
        {prose && <p className="prose">{prose}</p>}
      </article>
    </section>
  );
}
