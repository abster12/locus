import { useEffect, useState } from "react";
import {
  api,
  type AtlasCard,
  type AtlasPlace,
  type AtlasProjection,
  type AtlasReviewRow,
  type ItemCard,
} from "./api.ts";
import { cardTitle, firstVisual, hostOf, pubLabel, who } from "./item-content.ts";
import { CapturedMedia, Poster } from "./ItemVisuals.tsx";
import { useLinkPreview } from "./link-preview.ts";
import { firstStageDestination } from "./stage-navigation.ts";

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

export function AtlasPage({ onOpen }: { onOpen: (item: ItemCard, page?: string) => void }) {
  const [atlas, setAtlas] = useState<AtlasProjection | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [picker, setPicker] = useState<{ mode: "place" | "home"; itemId?: string; version?: number } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .atlas(controller.signal)
      .then((page) => {
        setAtlas(page);
        setErr(null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
  }, []);

  const apply = (page: AtlasProjection) => setAtlas(page);

  const run = async (work: () => Promise<{ atlas: AtlasProjection }>) => {
    try {
      apply((await work()).atlas);
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (!atlas) {
    return (
      <section>
        <Header count={null} />
        {err ? <p className="bad">{err}</p> : <p className="empty">Loading Atlas…</p>}
      </section>
    );
  }

  const preview = atlas.needsPlace.preview.map((row) => cardTitle(row.item) || who(row.item) || "save").slice(0, 3).join(" · ");

  return (
    <section>
      <Header count={`${atlas.counts.items} save${atlas.counts.items === 1 ? "" : "s"} · ${atlas.counts.destinations} destination${atlas.counts.destinations === 1 ? "" : "s"}`} />
      {err ? <p className="bad">{err}</p> : null}
      {!atlas.home.place ? (
        <div className="atlas-alert">
          <div>
            <h3>No home base</h3>
            <p>Destinations still work. Local saves wait until you choose a home.</p>
          </div>
          <button type="button" className="chip" onClick={() => setPicker({ mode: "home" })}>
            Choose home
          </button>
        </div>
      ) : (
        <p className="atlas-home-line">
          Home · {atlas.home.place.name}{" "}
          <button type="button" className="quiet" onClick={() => setPicker({ mode: "home" })}>Change home</button>
        </p>
      )}
      {atlas.needsPlace.count > 0 ? (
        <div className="atlas-alert">
          <div>
            <h3>Needs a place · {atlas.needsPlace.count}</h3>
            <p>{preview || "Review saves that still need a destination."}</p>
          </div>
          <button type="button" className="chip" onClick={() => setReviewOpen((open) => !open)}>
            {reviewOpen ? "Hide" : "Review"}
          </button>
        </div>
      ) : null}
      {reviewOpen && atlas.needsPlace.count > 0 ? (
        <div className="atlas-review-list">
          {atlas.needsPlace.items.map((row) => (
            <ReviewRow
              key={row.item.id}
              row={row}
              onOpen={onOpen}
              onAccept={(index) => run(() => api.atlasAccept(row.item.id, index, row.assignment?.version ?? 0))}
              onExact={() => setPicker({ mode: "place", itemId: row.item.id, version: row.assignment?.version ?? 0 })}
              onMultiple={() => run(() => api.atlasMultiple(row.item.id, row.assignment?.version ?? 0))}
              onNotAtlas={() => run(() => api.atlasNotAtlas(row.item.id, row.assignment?.version ?? 0))}
              onLeave={() => run(() => api.atlasLeave(row.item.id, row.assignment?.version ?? 0))}
            />
          ))}
        </div>
      ) : null}
      {atlas.counts.items === 0 && atlas.needsPlace.count === 0 ? (
        <p className="empty">No placed saves yet.</p>
      ) : (
        <>
          <nav className="atlas-nav" aria-label="Destinations">
            {atlas.destinations.map((section) => (
              <button key={section.id} type="button" onClick={() => document.getElementById(`rg-${section.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                <span className="sw" style={{ ["--c" as string]: section.items[0]?.assignment.primary?.accent.color ?? "var(--mute)" }} />
                {section.title}
              </button>
            ))}
            {atlas.multiple.length > 0 ? (
              <button type="button" onClick={() => document.getElementById("rg-multiple")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                Multiple · {atlas.multiple.length}
              </button>
            ) : null}
          </nav>
          {atlas.destinations.map((section, i) => (
            <div className="region" id={`rg-${section.id}`} key={section.id}>
              <div className="region-head">
                <span className="region-no">{section.kind === "around_home" ? "HOME" : `PLATE ${ROMAN[i] ?? String(i + 1)}`}</span>
                <h3 className="region-name">{section.title}</h3>
                <span className="region-count">
                  {section.count} save{section.count === 1 ? "" : "s"}
                </span>
              </div>
              <hr className="region-rule" />
              <hr className="region-rule2" />
              {section.contained.length > 0 ? (
                <div className="cities">
                  Cities & places — {section.contained.map((name, idx) => (
                    <span key={name}>
                      {idx > 0 ? " · " : ""}
                      <b>{name}</b>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="plates">
                {section.items.map((card) => (
                  <PlaceCard key={card.item.id} card={card} onOpen={onOpen} onChange={() => setPicker({ mode: "place", itemId: card.item.id, version: card.assignment.version })} />
                ))}
              </div>
            </div>
          ))}
          {atlas.multiple.length > 0 ? (
            <div className="region" id="rg-multiple">
              <div className="region-head">
                <span className="region-no">MULTI</span>
                <h3 className="region-name">Multiple destinations</h3>
                <span className="region-count">
                  {atlas.multiple.length} save{atlas.multiple.length === 1 ? "" : "s"}
                </span>
              </div>
              <hr className="region-rule" />
              <hr className="region-rule2" />
              <div className="plates">
                {atlas.multiple.map((card) => (
                  <PlaceCard key={card.item.id} card={card} onOpen={onOpen} onChange={() => setPicker({ mode: "place", itemId: card.item.id, version: card.assignment.version })} />
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
      {picker ? (
        <PlaceSheet
          title={picker.mode === "home" ? "Home base" : "Choose exact place"}
          onClose={() => setPicker(null)}
          onSelect={(place) => {
            const current = picker;
            setPicker(null);
            if (current.mode === "home") return run(() => api.atlasHome({ placeId: place.id }));
            return run(() => api.atlasPlace(current.itemId!, { placeId: place.id, expectedVersion: current.version ?? 0 }));
          }}
          onCreate={(name, kind, parentId) => {
            const current = picker;
            setPicker(null);
            if (current.mode === "home") return run(() => api.atlasHome({ name, kind, parentId }));
            return run(() => api.atlasPlace(current.itemId!, { name, kind, parentId, expectedVersion: current.version ?? 0 }));
          }}
        />
      ) : null}
    </section>
  );
}

function Header({ count }: { count: string | null }) {
  return (
    <div className="atlas-top">
      <svg className="compass" viewBox="0 0 100 100" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="50" cy="50" r="46" />
        <circle cx="50" cy="50" r="34" strokeWidth="1" />
        <path d="M50 12v10M50 78v10M12 50h10M78 50h10" />
        <path d="M50 26 58 50 50 74 42 50 Z" fill="var(--accent)" stroke="none" />
        <path d="M26 50 50 42 74 50 50 58 Z" strokeWidth="1.4" />
      </svg>
      <div style={{ flex: 1 }}>
        <div className="pagehead">
          <h2>Atlas</h2>
          {count ? <span className="count">{count}</span> : null}
        </div>
        <p className="pagesub">Saved places, grouped by where they belong.</p>
      </div>
    </div>
  );
}

function ReviewRow({
  row,
  onOpen,
  onAccept,
  onExact,
  onMultiple,
  onNotAtlas,
  onLeave,
}: {
  row: AtlasReviewRow;
  onOpen: (item: ItemCard, page?: string) => void;
  onAccept: (index: number) => void;
  onExact: () => void;
  onMultiple: () => void;
  onNotAtlas: () => void;
  onLeave: () => void;
}) {
  const item = row.item;
  const suggestions = row.assignment?.suggestions ?? [];
  return (
    <article className="atlas-review">
      <button type="button" className="atlas-review-open" onClick={() => onOpen(item, firstStageDestination(item) ?? undefined)}>
        <strong>{cardTitle(item) || item.body?.slice(0, 80) || item.url}</strong>
        <span>
          {who(item) || hostOf(item.url)}
          {item.body ? ` · ${item.body.replace(/\s+/g, " ").slice(0, 90)}` : ""}
        </span>
      </button>
      {suggestions.map((suggestion, index) => (
        <button key={`${suggestion.name}-${index}`} type="button" className="chip" onClick={() => onAccept(index)}>
          {suggestion.name}
          {suggestion.evidence[0]?.text ? ` — “${suggestion.evidence[0].text}”` : ""}
        </button>
      ))}
      <div className="atlas-review-actions">
        <button type="button" className="chip" onClick={onExact}>Choose exact place</button>
        <button type="button" className="chip" onClick={onMultiple}>Multiple destinations</button>
        <button type="button" className="chip" onClick={onNotAtlas}>Not for Atlas</button>
        <button type="button" className="quiet" onClick={onLeave}>Leave unresolved</button>
      </div>
    </article>
  );
}

function PlaceCard({ card, onOpen, onChange }: { card: AtlasCard; onOpen: (item: ItemCard, page?: string) => void; onChange: () => void }) {
  const item = card.item;
  const place = card.assignment.primary;
  const caption = item.title || item.body?.replace(/\s+/g, " ").trim().slice(0, 120) || who(item) || item.url;
  return (
    <article
      className="place-card"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button")) return;
        onOpen(item, firstStageDestination(item) ?? undefined);
      }}
    >
      <AtlasMedia item={item} accent={place?.accent ?? { color: "#3d4a55", ink: "#f2f3f0" }} word={place?.name || item.title?.split(/\s+/)[0] || "place"} />
      <div className="caption">
        <span className="cap-text">
          {caption}
          <small>{who(item) || hostOf(item.url)}</small>
        </span>
        <span className="cap-date">{pubLabel(item.publishedAt)}</span>
      </div>
      <div className="atlas-card-meta">
        {card.assignment.actor === "analyzer" ? <span className="atlas-inferred">Inferred</span> : null}
        <button type="button" className="quiet" onClick={onChange}>Change place</button>
      </div>
    </article>
  );
}

function AtlasMedia({ item, accent, word }: { item: ItemCard; accent: { color: string; ink: string }; word: string }) {
  const visual = firstVisual(item);
  const previewUrl = visual ? null : firstStageDestination(item) ?? null;
  const { preview, done } = useLinkPreview(previewUrl);
  if (visual) return <CapturedMedia item={item} />;
  if (preview?.image) {
    return (
      <div className="media">
        <img src={preview.image} alt="" referrerPolicy="no-referrer" loading="lazy" />
      </div>
    );
  }
  if (previewUrl && !done) return <div className="media" />;
  return <Poster color={accent.color} ink={accent.ink} motifName="spark" word={word} />;
}

const PLACE_KINDS = ["place", "country", "admin", "city", "neighbourhood", "venue", "landmark", "natural"];

function PlaceSheet({
  title,
  onClose,
  onSelect,
  onCreate,
}: {
  title: string;
  onClose: () => void;
  onSelect: (place: AtlasPlace) => void;
  onCreate: (name: string, kind: string, parentId: string | null) => void;
}) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("place");
  const [parentId, setParentId] = useState("");
  const [places, setPlaces] = useState<AtlasPlace[]>([]);
  const [parents, setParents] = useState<AtlasPlace[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    api.atlasPlaces("", controller.signal).then((result) => setParents(result.places)).catch(() => {});
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.atlasPlaces(q, controller.signal).then((result) => setPlaces(result.places)).catch(() => {});
    }, 120);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [q]);
  return (
    <div className="atlas-scrim" role="presentation" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="atlas-sheet" role="dialog" aria-label={title}>
        <h3>{title}</h3>
        <input className="atlas-search" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search places" autoFocus />
        <div className="atlas-hits">
          {places.map((place) => (
            <button key={place.id} type="button" onClick={() => onSelect(place)}>
              {place.name}
              {place.ancestors.length > 0 ? <small className="path">{place.ancestors.map((row) => row.name).join(" · ")}</small> : null}
            </button>
          ))}
        </div>
        {q.trim() ? (
          <div className="atlas-create">
            <label>
              Kind
              <select value={kind} onChange={(event) => setKind(event.target.value)}>
                {PLACE_KINDS.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              Parent
              <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
                <option value="">None</option>
                {parents.map((place) => (
                  <option key={place.id} value={place.id}>{place.ancestors.map((row) => row.name).concat(place.name).join(" · ")}</option>
                ))}
              </select>
            </label>
            <button type="button" className="chip" onClick={() => onCreate(q.trim(), kind, parentId || null)}>
              Create “{q.trim()}”
            </button>
          </div>
        ) : null}
        <div className="atlas-sheet-acts">
          <button type="button" className="chip" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
