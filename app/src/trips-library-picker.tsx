import { useEffect, useRef, useState } from "react";
import { api, type TripChangeOp, type TripSources, type TripStopContent } from "./api.ts";
import { StopPlacementFields, type DayOption } from "./trips-stop-forms.tsx";
import { buildAddOrFillOps, type FillPlacement } from "./trips-stop-ops.ts";

/** Library selection -> add/fill ops. Test seam for the picker; wraps the
 * shared placement builder so the Library path cannot drift. */
export function libraryStopOps(input: {
  dayId: string | null;
  content: TripStopContent;
  fill?: FillPlacement;
  timing?: { timeWindow: string | null; durationMinutes: number | null };
  publicNotes?: string;
  privateNotes?: string;
  state?: "confirmed" | "draft";
}): TripChangeOp[] {
  return buildAddOrFillOps(input);
}

type Picked = { content: TripStopContent; title: string; meta: string };

/** Bounded Library picker: Items and Places from the authoritative modules,
 * selection fields only. Choosing a result plus Add stop places a reference
 * via the same changeset engine as every other edit. */
export function LibrarySearchForm({
  dayId: initialDayId,
  days,
  fill,
  busy,
  onAdd,
  onBack,
}: {
  dayId: string | null;
  days: DayOption[];
  fill?: FillPlacement;
  busy: boolean;
  onAdd: (operations: TripChangeOp[]) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TripSources | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Picked | null>(null);
  const [dayId, setDayId] = useState(initialDayId);
  const [timeWindow, setTimeWindow] = useState("");
  const [duration, setDuration] = useState("");
  const [publicNotes, setPublicNotes] = useState("");
  const [privateNotes, setPrivateNotes] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);

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

  useEffect(() => {
    if (selected) clearRef.current?.focus();
    else searchRef.current?.focus();
  }, [selected]);

  function submit(state?: "draft") {
    if (!selected) return;
    onAdd(
      libraryStopOps({
        dayId,
        content: selected.content,
        fill,
        timing: timeWindow.trim() || duration ? { timeWindow: timeWindow.trim() || null, durationMinutes: duration ? Number(duration) : null } : undefined,
        publicNotes,
        privateNotes,
        state,
      }),
    );
  }

  return (
    <form
      className="trip-add-form"
      aria-label="Add from Library"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <button type="button" className="trip-add-back" onClick={onBack}>
        ← Choose another source
      </button>
      {selected ? (
        <div className="trip-search-picked">
          <p>
            <span className="trip-search-title">{selected.title}</span>
            <span className="trip-search-meta">{selected.meta}</span>
          </p>
          <button type="button" className="trip-search-clear" ref={clearRef} aria-label="Clear selection" onClick={() => setSelected(null)}>
            ×
          </button>
        </div>
      ) : (
        <label className="trip-field">
          Search your Library
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={80}
            autoFocus
            placeholder="Saved posts and Places, e.g. Nishiki"
          />
        </label>
      )}
      {err ? (
        <p className="bad" role="alert">
          {err}
        </p>
      ) : null}
      {!selected && results ? (
        <>
          {results.items.length > 0 ? (
            <div className="trip-search-group">
              <h4>Saved items</h4>
              <ul>
                {results.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="trip-search-result"
                      onClick={() =>
                        setSelected({
                          content: { kind: "item", itemId: item.id },
                          title: item.title,
                          meta: item.source ? `Saved item · ${item.source}` : "Saved item",
                        })
                      }
                    >
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
                    <button
                      type="button"
                      className="trip-search-result"
                      onClick={() =>
                        setSelected({
                          content: { kind: "place", placeId: place.id },
                          title: place.name,
                          meta: `Place · ${place.kind}`,
                        })
                      }
                    >
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
      {selected ? (
        <>
          <StopPlacementFields
            days={days}
            dayId={dayId}
            locked={Boolean(fill)}
            onDayId={setDayId}
            timeWindow={timeWindow}
            onTimeWindow={setTimeWindow}
            duration={duration}
            onDuration={setDuration}
            publicNotes={publicNotes}
            onPublicNotes={setPublicNotes}
            privateNotes={privateNotes}
            onPrivateNotes={setPrivateNotes}
            privateHint="Library-private context; never shared"
          />
          <p className="trip-form-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => submit("draft")}>
              {busy ? "Saving…" : "Save as Draft"}
            </button>
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? "Saving…" : "Add stop"}
            </button>
          </p>
        </>
      ) : null}
    </form>
  );
}
