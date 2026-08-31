import { useEffect, useState } from "react";
import { api, type TripChangeOp, type TripSources, type TripStopContent } from "./api.ts";
import { buildAddOrFillOps, type FillPlacement } from "./trips-stop-ops.ts";

/** Library selection -> add/fill ops. Test seam for the picker; wraps the
 * shared placement builder so the Library path cannot drift. */
export function libraryStopOps(input: { dayId: string | null; content: TripStopContent; fill?: FillPlacement }): TripChangeOp[] {
  return buildAddOrFillOps({ dayId: input.dayId, content: input.content, fill: input.fill });
}

/** Bounded Library picker: Items and Places from the authoritative modules,
 * selection fields only. Choosing a result places a reference stop via the
 * same changeset engine as every other edit. */
export function LibrarySearchForm({
  dayId,
  fill,
  busy,
  onAdd,
  onCancel,
}: {
  dayId: string | null;
  fill?: FillPlacement;
  busy: boolean;
  onAdd: (operations: TripChangeOp[]) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TripSources | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      api
        .tripSources(query)
        .then((next) => {
          setResults(next);
          setErr(null);
        })
        .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  const add = (content: TripStopContent) => onAdd(libraryStopOps({ dayId, content, fill }));

  return (
    <div className="trip-search" role="group" aria-label="Add from Library">
      <label className="trip-field">
        Search your Library
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={80}
          autoFocus
          placeholder="Saved posts and Places, e.g. Nishiki"
        />
      </label>
      {err ? (
        <p className="bad" role="alert">
          {err}
        </p>
      ) : null}
      {results ? (
        <>
          {results.items.length > 0 ? (
            <div className="trip-search-group">
              <h4>Saved items</h4>
              <ul>
                {results.items.map((item) => (
                  <li key={item.id}>
                    <button type="button" className="trip-search-result" disabled={busy} onClick={() => add({ kind: "item", itemId: item.id })}>
                      <span className="trip-search-title">{item.title}</span>
                      <span className="trip-search-meta">Saved item{item.source ? ` · ${item.source}` : ""}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {results.places.length > 0 ? (
            <div className="trip-search-group">
              <h4>Places</h4>
              <ul>
                {results.places.map((place) => (
                  <li key={place.id}>
                    <button type="button" className="trip-search-result" disabled={busy} onClick={() => add({ kind: "place", placeId: place.id })}>
                      <span className="trip-search-title">{place.name}</span>
                      <span className="trip-search-meta">Place · {place.kind}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {results.items.length === 0 && results.places.length === 0 ? <p className="trip-stop-empty">Nothing in your Library matches.</p> : null}
        </>
      ) : null}
      <p className="trip-form-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </p>
    </div>
  );
}
