import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { SHELVES, shelvesWithCounts, tagsForShelf } from "../../core/categories.ts";
import { MotifSvg } from "./ItemVisuals.tsx";

export function shelfCounts(response: { counts?: { shelves?: Record<string, number> } } | undefined): Record<string, number> {
  return response?.counts?.shelves ?? {};
}

function go(hash: string): void {
  location.hash = hash;
}
export function ShelvesPage() {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.itemCounts()
      .then((response) => setCounts(shelfCounts(response)))
      .catch(() => api.allItems().then((items) => {
        const byShelf = shelvesWithCounts(items.map((item) => ({ tags: item.tags.map((tag) => tag.name) })));
        setCounts(Object.fromEntries(byShelf.map(({ shelf, count }) => [shelf.key, count])));
      }))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  return (
    <section>
      <div className="pagehead">
        <h2>Shelves</h2>
        <span className="count">{SHELVES.length} shelves</span>
      </div>
      <p className="pagesub">Browse your saves by topic.</p>
      {err ? <p className="action-error" role="alert">{err}</p> : null}
      <div className="shelf-grid">
        {SHELVES.map((shelf) => (
          <button
            key={shelf.key}
            type="button"
            className="shelf-plate"
            style={{ ["--c" as string]: shelf.color }}
            onClick={() => go(`#/recent?shelf=${shelf.key}`)}
          >
            <span className="head">
              <MotifSvg name={shelf.motif} icon />
              <h3>{shelf.name}</h3>
              <span className="dot" />
              <span className="n">{counts[shelf.key] ?? 0}</span>
            </span>
            <span className="sample">{tagsForShelf(shelf.key).slice(0, 5).join(" · ")}</span>
          </button>
        ))}
      </div>
      <p className="shelf-note">Prefer your own groups? Open <a href="#/collections">Collections</a>.</p>
    </section>
  );
}
