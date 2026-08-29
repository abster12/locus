import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  api,
  type ItemCard,
  type KitchenIndex,
  type KitchenItem,
  type RecipeDocument,
  type RecipeEvidence,
  type TonightEntry,
} from "./api.ts";
import { firstVisual, pubLabel, who } from "./item-content.ts";
import { SourceMark } from "./SourceMark.tsx";
import { instagramEmbedUrl, youtubeEmbedUrl } from "../../core/sanitize.ts";

// Kitchen keeps all recipe rules on the server module. This file is views only:
// it renders what /api/kitchen returns and posts drafts back through the seam.

const INDEX_KEY = "locus-kitchen-index";

function go(hash: string): void {
  location.hash = hash;
}

function normalizeCaption(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\r\n/g, "\n").trim();
}

async function captionRevisionOf(item: ItemCard): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeCaption(item.body)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const AVAILABILITY_LABEL: Record<KitchenItem["availability"], string> = {
  reviewed: "Reviewed recipe",
  draft: "Draft recipe",
  caption: "Caption available",
  watch: "Watch recipe",
  source_only: "Source only",
};

function safeHttpUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function openOriginal(url: string): string | null {
  return safeHttpUrl(url);
}

export function KitchenPage() {
  const [query, setQuery] = useState<{ q: string; source: string }>(() => readIndexQuery());
  const [draftQ, setDraftQ] = useState(query.q);
  const [page, setPage] = useState<KitchenIndex | null>(null);
  const [tonight, setTonight] = useState<TonightEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [pane, setPane] = useState<"recipes" | "tonight">("recipes");
  const searchTimer = useRef<number | null>(null);

  useEffect(() => {
    writeIndexQuery(query);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    setPage(null);
    api
      .kitchen(indexQueryString(query), controller.signal)
      .then((result) => {
        setPage(result);
        setErr(null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    api
      .tonight(controller.signal)
      .then((rows) => setTonight(rows))
      .catch(() => setTonight([]));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const onPoint = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      for (const menu of document.querySelectorAll("details.kitchen-more[open]")) {
        if (!menu.contains(target)) menu.removeAttribute("open");
      }
    };
    document.addEventListener("pointerdown", onPoint);
    return () => document.removeEventListener("pointerdown", onPoint);
  }, []);

  useLayoutScrollRestore(page);

  const sources = shownSources(page, query.source);
  const tonightIds = new Set((tonight ?? []).map((row) => row.itemId));

  async function loadMore(): Promise<void> {
    if (!page?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api.kitchen(indexQueryString(query, page.nextCursor));
      setPage({ ...next, items: [...page.items, ...next.items], counts: next.counts });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  async function addToTonight(item: KitchenItem): Promise<void> {
    try {
      const entry = await api.addTonight(item.item.id);
      setTonight((rows) => (rows?.some((row) => row.id === entry.id) ? rows : [...(rows ?? []), entry]));
      setNotice(`Added ${item.displayTitle} to Tonight.`);
    } catch (e: unknown) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeFromTonight(entry: TonightEntry): Promise<void> {
    try {
      await api.removeTonight(entry.id);
      setTonight((rows) => (rows ?? []).filter((row) => row.id !== entry.id));
      setNotice("Removed from Tonight.");
    } catch (e: unknown) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  async function move(entry: TonightEntry, to: number): Promise<void> {
    if (!tonight) return;
    const ids = tonight.map((row) => row.id);
    const from = ids.indexOf(entry.id);
    if (from < 0 || to < 0 || to >= ids.length || from === to) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    try {
      setTonight(await api.reorderTonight(ids));
      setNotice(`Moved to position ${to + 1}.`);
    } catch {
      // A stale order means someone else changed it; reload the truth.
      try {
        setTonight(await api.tonight());
      } catch {
        /* keep old list */
      }
      setNotice("The Tonight list changed. Order reloaded.");
    }
  }

  async function clearAll(): Promise<void> {
    if (!window.confirm("Clear every entry from Tonight?")) return;
    try {
      const { removed } = await api.clearTonight();
      setTonight([]);
      setNotice(`Cleared ${removed} ${removed === 1 ? "entry" : "entries"} from Tonight.`);
    } catch (e: unknown) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  const hasFilters = Boolean(query.q || query.source);
  const counts = page?.counts;
  const countLine = counts
    ? `${counts.foodSaves} food ${counts.foodSaves === 1 ? "save" : "saves"} · ${counts.structuredRecipes} structured${counts.tonight ? ` · ${counts.tonight} tonight` : ""}`
    : "";

  return (
    <section className={`kitchen ${pane === "tonight" ? "kitchen-pane-tonight" : ""}`}>
      <div className="kitchen-pagehead">
        <div className="pagehead">
          <h1>Kitchen</h1>
          {countLine ? <span className="count">{countLine}</span> : null}
        </div>
        <p className="pagesub">Food saves, ready when you are.</p>
        <div className="kitchen-controls">
          <label className="kitchen-search">
            <span className="visually-hidden">Search recipes</span>
            <input
              type="search"
              value={draftQ}
              placeholder="Search recipes"
              onChange={(e) => {
                const value = e.target.value;
                setDraftQ(value);
                if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
                searchTimer.current = window.setTimeout(() => setQuery((prev) => ({ ...prev, q: value })), 250);
              }}
            />
          </label>
          {sources.length > 1 ? (
            <div className="kitchen-sourcefilter" role="group" aria-label="Filter by source">
              {["", ...sources].map((source) => (
                <button
                  key={source || "all"}
                  type="button"
                  className={`chip ${source ? `src-${source}` : ""} ${query.source === source ? "active" : ""}`}
                  aria-pressed={query.source === source}
                  onClick={() => setQuery((prev) => ({ ...prev, source }))}
                >
                  {source ? source : "All"}
                </button>
              ))}
            </div>
          ) : null}
          <button type="button" className="kitchen-toggle" aria-pressed={pane === "tonight"} onClick={() => setPane(pane === "tonight" ? "recipes" : "tonight")}>
            {pane === "tonight" ? "Recipes" : `Tonight (${tonight?.length ?? 0})`}
          </button>
        </div>
      </div>
      <p className="kitchen-notice" role="status" aria-live="polite">
        {notice}
      </p>
      {err ? (
        <p className="bad" role="alert">
          {err}{" "}
          <button type="button" className="btn" onClick={() => setQuery((prev) => ({ ...prev }))}>
            Retry
          </button>
        </p>
      ) : null}
      <div className="kitchen-root">
        <div className="kitchen-main">
          {!page && !err ? (
            <ul className="kitchen-list" aria-hidden="true">
              {[0, 1, 2].map((row) => (
                <li key={row} className="kitchen-row kitchen-skeleton">
                  <span className="kitchen-thumb" />
                  <span className="kitchen-skeleton-lines">
                    <span />
                    <span />
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {page && page.items.length === 0 ? (
            <p className="empty">
              {hasFilters
                ? "No recipes match these filters."
                : "No food saves yet. Add a Food tag to an Item on the Desk and it will appear here."}
              {hasFilters ? (
                <>
                  {" "}
                  <button type="button" className="btn" onClick={() => setQuery({ q: "", source: "" })}>
                    Clear filters
                  </button>
                </>
              ) : (
                <>
                  {" "}
                  <a href="#/recent">Open Desk</a>
                </>
              )}
            </p>
          ) : null}
          {page && page.items.length > 0 ? (
            <ul className="kitchen-list">
              {page.items.map((item) => (
                <RecipeRow
                  key={item.item.id}
                  item={item}
                  onTonight={tonightIds.has(item.item.id)}
                  onAdd={() => void addToTonight(item)}
                />
              ))}
            </ul>
          ) : null}
          {page?.nextCursor ? (
            <p className="kitchen-loadmore">
              <button type="button" className="btn" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </p>
          ) : null}
        </div>
        <aside className="kitchen-tonight" aria-label="Tonight">
          <h2>Tonight</h2>
          {!tonight || tonight.length === 0 ? <p className="kitchen-tonight-empty">Add something from the Recipe Box.</p> : null}
          {tonight && tonight.length > 0 ? (
            <>
              <ul className="kitchen-tonight-list">
                {tonight.map((entry, index) => (
                  <TonightRow
                    key={entry.id}
                    entry={entry}
                    index={index}
                    total={tonight.length}
                    onMove={(to) => void move(entry, to)}
                    onRemove={() => void removeFromTonight(entry)}
                    onDrop={async (event) => {
                      const id = event.dataTransfer.getData("text/kitchen-entry");
                      const to = tonight.findIndex((row) => row.id === entry.id);
                      const from = tonight.findIndex((row) => row.id === id);
                      if (id && from >= 0 && to >= 0 && from !== to) await move(tonight[from]!, to);
                    }}
                  />
                ))}
              </ul>
              {tonight.length >= 2 ? (
                <button type="button" className="btn danger kitchen-clear" onClick={() => void clearAll()}>
                  Clear Tonight
                </button>
              ) : null}
            </>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

function RecipeRow({ item, onTonight, onAdd }: { item: KitchenItem; onTonight: boolean; onAdd: () => void }) {
  const href = `#/kitchen/${item.item.id}`;
  const primaryHref = href;
  const original = openOriginal(item.item.url);
  const visual = firstVisual(item.item);
  return (
    <li
      className="kitchen-row"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button, summary")) return;
        go(href);
      }}
    >
      <a className="kitchen-row-open" href={href} onClick={(e) => e.stopPropagation()}>
        <span className="kitchen-thumb">
          {visual ? <img src={visual.url} alt="" referrerPolicy="no-referrer" loading="lazy" /> : <span className="kitchen-thumb-bowl" aria-hidden="true" />}
        </span>
        <span className="kitchen-row-main">
          <span className="kitchen-row-title">{item.displayTitle}</span>
          {item.showCaptionPreview && item.caption ? <span className="kitchen-row-caption">{item.caption}</span> : null}
          <span className="kitchen-row-meta">
            {who(item.item) ? <span>{who(item.item)}</span> : null}
            <SourceMark source={String(item.item.source)} />
            <span>{pubLabel(item.item.firstObservedAt)}</span>
          </span>
          <span className={`kitchen-avail kitchen-avail-${item.availability}`}>{AVAILABILITY_LABEL[item.availability]}</span>
        </span>
      </a>
      <span className="kitchen-row-actions">
        <a className={`btn ${!item.recipe ? "primary" : ""}`} href={primaryHref} onClick={(e) => e.stopPropagation()}>
          {item.recipe ? "Open recipe" : "Make this cookable"}
        </a>
        {onTonight ? (
          <span className="chip kitchen-on-tonight" aria-label="On Tonight">
            On Tonight
          </span>
        ) : (
          <button
            type="button"
            className="chip kitchen-add-tonight"
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
          >
            + Tonight
          </button>
        )}
        {original ? (
          <details className="kitchen-more">
            <summary aria-label="More actions">⋯</summary>
            <a href={original} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
              Open original ↗
            </a>
          </details>
        ) : null}
      </span>
    </li>
  );
}

function TonightRow({
  entry,
  index,
  total,
  onMove,
  onRemove,
  onDrop,
}: {
  entry: TonightEntry;
  index: number;
  total: number;
  onMove: (to: number) => void;
  onRemove: () => void;
  onDrop: (event: DragEvent<HTMLLIElement>) => void;
}) {
  const item = entry.item;
  const href = item ? `#/kitchen/${item.item.id}` : null;
  const visual = item ? firstVisual(item.item) : null;
  return (
    <li
      className="kitchen-tonight-row"
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/kitchen-entry", entry.id)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <span className="kitchen-handle" aria-hidden="true">
        ⠿
      </span>
      {href ? (
        <a className="kitchen-tonight-open" href={href}>
          {visual ? <img src={visual.url} alt="" referrerPolicy="no-referrer" loading="lazy" /> : null}
          <span className="kitchen-tonight-title">{item!.displayTitle}</span>
          <SourceMark source={String(item!.item.source)} />
        </a>
      ) : (
        <span className="kitchen-tonight-open kitchen-tonight-missing">
          <span className="kitchen-tonight-title">Missing Item</span>
        </span>
      )}
      <span className="kitchen-tonight-actions">
        <button type="button" aria-label={`Move ${item?.displayTitle ?? "entry"} up`} disabled={index === 0} onClick={() => onMove(index - 1)}>
          ↑
        </button>
        <button type="button" aria-label={`Move ${item?.displayTitle ?? "entry"} down`} disabled={index === total - 1} onClick={() => onMove(index + 1)}>
          ↓
        </button>
        <button type="button" aria-label={`Remove ${item?.displayTitle ?? "missing Item"} from Tonight`} onClick={onRemove}>
          ×
        </button>
      </span>
    </li>
  );
}

export function KitchenDetail({ itemId, mode }: { itemId: string; mode: "auto" | "watch" | "edit" }) {
  const [data, setData] = useState<KitchenItem | null>(null);
  const [missing, setMissing] = useState(false);
  const [tonightIds, setTonightIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setMissing(false);
    api
      .kitchenItem(itemId, controller.signal)
      .then((item) => setData(item))
      .catch(() => {
        if (!controller.signal.aborted) setMissing(true);
      });
    api
      .tonight(controller.signal)
      .then((rows) => setTonightIds(new Set(rows.map((row) => row.itemId))))
      .catch(() => {});
    return () => controller.abort();
  }, [itemId, reloadKey]);

  useEffect(() => {
    document.title = data ? `${data.displayTitle} · Kitchen` : "Kitchen";
    return () => {
      document.title = "Locus";
    };
  }, [data]);

  if (missing) {
    return (
      <section className="kitchen">
        <p className="empty">This Item is no longer in the Library.</p>
        <p>
          <a className="btn" href="#/kitchen">
            Back to Kitchen
          </a>
        </p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="kitchen">
        <p className="quiet" aria-live="polite">
          Opening recipe…
        </p>
      </section>
    );
  }

  async function toggleTonight(): Promise<void> {
    try {
      const entry = await api.addTonight(itemId);
      setTonightIds((ids) => new Set(ids).add(entry.itemId));
      setNotice("On Tonight.");
    } catch (e: unknown) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  const tonightButton =
    tonightIds.has(itemId) ? (
      <span className="chip kitchen-on-tonight">On Tonight</span>
    ) : (
      <button type="button" className="chip" onClick={() => void toggleTonight()}>
        + Tonight
      </button>
    );

  if (mode === "edit") {
    return (
      <RecipeEditor
        key={reloadKey}
        data={data}
        notice={notice}
        tonightButton={tonightButton}
        onDone={() => go(`#/kitchen/${itemId}`)}
        onRemoved={() => go(`#/kitchen/${itemId}`)}
      />
    );
  }
  if (mode === "watch" || (mode === "auto" && !data.recipe)) {
    return (
      <WatchCook
        data={data}
        notice={notice}
        tonightButton={tonightButton}
        onCreated={() => setReloadKey((key) => key + 1)}
      />
    );
  }
  return (
    <RecipeScoreView
      data={data}
      document={data.recipe as RecipeDocument}
      notice={notice}
      tonightButton={tonightButton}
    />
  );
}

function DetailHeader({
  data,
  title,
  stateChip,
  tonightButton,
  titleSlot,
  factsSlot,
  children,
}: {
  data: KitchenItem;
  title?: string;
  stateChip?: string | null;
  tonightButton: React.ReactNode;
  // Edit mode swaps the read-only h1 for the writable title and adds the
  // writable facts unit between the byline and the actions.
  titleSlot?: React.ReactNode;
  factsSlot?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const original = openOriginal(data.item.url);
  return (
    <header className="kitchen-detail-head">
      <nav className="kitchen-back" aria-label="Breadcrumb">
        <a href="#/kitchen">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m11.5 5-5 5 5 5M7 10h7" />
          </svg>
          <span>Kitchen</span>
        </a>
      </nav>
      <div className="kitchen-detail-titlerow">
        {titleSlot ?? <h1>{title || data.displayTitle}</h1>}
        {stateChip ? <span className={`chip kitchen-state-${stateChip.toLowerCase()}`}>{stateChip}</span> : null}
      </div>
      <p className="kitchen-detail-byline">
        {who(data.item) ? <span>{who(data.item)}</span> : null}
        <SourceMark source={String(data.item.source)} />
      </p>
      {factsSlot}
      <div className="kitchen-detail-actions">
        {children}
        {tonightButton}
        {data.canWatch ? (
          <a className="btn" href={`#/kitchen/${data.item.id}/watch`}>
            Watch source
          </a>
        ) : null}
        {original ? (
          <a className="btn" href={original} target="_blank" rel="noopener noreferrer">
            Open original ↗
          </a>
        ) : null}
      </div>
    </header>
  );
}

function RecipeScoreView({
  data,
  document: doc,
  notice,
  tonightButton,
}: {
  data: KitchenItem;
  document: RecipeDocument;
  notice: string;
  tonightButton: React.ReactNode;
}) {
  const [active, setActive] = useState<{ kind: "step" | "ing"; id: string } | null>(null);
  const draft = doc.draft;
  const byId = new Map(draft.ingredients.map((row) => [row.id, row]));

  // The server owns score projection. The view only arranges that projection
  // into first-use rows and annotates later uses for display.
  const firstUse = new Map(doc.score.placed.map((entry) => [entry.ingredient.id, entry.firstStepId]));
  const laterUses = new Map<string, number[]>();
  doc.score.steps.forEach(({ ingredients }, stepIndex) => {
    for (const ingredient of ingredients) {
      if (firstUse.get(ingredient.id) !== draft.steps[stepIndex]?.id) {
        laterUses.set(ingredient.id, [...(laterUses.get(ingredient.id) ?? []), stepIndex]);
      }
    }
  });

  const stepHot = (stepIndex: number) =>
    active?.kind === "ing" && doc.score.steps[stepIndex]?.ingredients.some((ingredient) => ingredient.id === active.id);

  const focusedExcerpt = (() => {
    if (!active) return null;
    if (active.kind === "ing") {
      const row = byId.get(active.id);
      return row ? evidenceExcerpt(row.evidence) : null;
    }
    const step = draft.steps.find((row) => row.id === active.id);
    return step ? evidenceExcerpt(step.evidence) : null;
  })();

  return (
    <section className="kitchen-detail">
      <DetailHeader data={data} title={draft.title || data.displayTitle} stateChip={doc.status === "reviewed" ? "Reviewed" : "Draft"} tonightButton={tonightButton}>
        <a className="btn primary" href={`#/kitchen/${data.item.id}/edit`}>
          Edit
        </a>
        {draft.servings || draft.totalTime ? (
          <span className="kitchen-detail-facts">
            {draft.servings ? <span>{draft.servings}</span> : null}
            {draft.totalTime ? <span>{draft.totalTime}</span> : null}
          </span>
        ) : null}
      </DetailHeader>
      <p className="kitchen-notice" role="status" aria-live="polite">
        {notice}
      </p>
      {doc.sourceChanged ? (
        <div className="kitchen-changed">
          <p>Caption changed since this recipe was saved.</p>
          <details>
            <summary>Compare</summary>
            <p className="kitchen-compare-old">{doc.sourceCaption}</p>
            <p className="kitchen-compare-new">{data.caption ?? "(no caption captured)"}</p>
          </details>
          <a className="btn" href={`#/kitchen/${data.item.id}/edit`}>
            Edit
          </a>
        </div>
      ) : null}
      <p className={`kitchen-provenance kitchen-provenance-${doc.provenance}`}>
        {doc.provenance === "generated"
          ? "AI-generated suggestion — not the creator’s original recipe"
          : doc.provenance === "caption"
            ? "Prepared from the captured caption"
            : "Edited by you"}
      </p>
      <div className="kitchen-score" data-layout="vertical-timeline">
        <div className="kitchen-score-heading kitchen-score-heading-ing"><h2>Ingredients</h2></div>
        <div className="kitchen-score-heading kitchen-score-heading-method"><h2>Method</h2></div>
        {doc.score.steps.length === 0 ? <p className="quiet kitchen-score-empty">No steps recorded yet.</p> : null}
        <ol className="kitchen-score-flow" aria-label="Recipe timeline">
          {doc.score.steps.map(({ step, ingredients }, stepIndex) => {
            const arriving = doc.score.placed
              .filter((entry) => entry.firstStepId === step.id)
              .map((entry) => entry.ingredient);
            return (
              <li key={step.id} className="kitchen-score-row">
                <div className="kitchen-score-ing">
                  {arriving.length > 0 ? (
                    <ul aria-label={`Ingredients first used in step ${stepIndex + 1}`}>
                      {arriving.map((row, index) => (
                        <IngredientLine
                          key={row.id}
                          row={row}
                          later={laterUses.get(row.id) ?? []}
                          showGroup={Boolean(row.group) && row.group !== arriving[index - 1]?.group}
                          hot={ingHotFor(active, draft, row.id)}
                          onEnter={() => setActive({ kind: "ing", id: row.id })}
                          onLeave={() => setActive(null)}
                        />
                      ))}
                    </ul>
                  ) : <span className="kitchen-score-no-ing" aria-hidden="true">—</span>}
                </div>
                <div className="kitchen-score-spine">
                  <span className="kitchen-step-node" role="img" aria-label={`Step ${stepIndex + 1}`}>
                    {stepIndex + 1}
                  </span>
                </div>
                <article
                  className={`kitchen-step ${stepHot(stepIndex) ? "hot" : ""}`}
                  data-step-id={step.id}
                  tabIndex={0}
                  onMouseEnter={() => setActive({ kind: "step", id: step.id })}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive({ kind: "step", id: step.id })}
                  onBlur={() => setActive(null)}
                >
                  {ingredients.length > 0 ? <span className="kitchen-step-ings">{ingredients.map((ingredient) => ingredient.name).join(", ")}</span> : null}
                  <p>{step.instruction}</p>
                  <span className="kitchen-step-meta">
                    {step.duration ? <span className="kitchen-step-time" aria-label={`Time: ${step.duration}`}>{step.duration}</span> : null}
                    {step.temperature ? <span className="kitchen-step-temperature" aria-label={`Temperature: ${step.temperature}`}>{step.temperature}</span> : null}
                    <EvidenceMark evidence={step.evidence} />
                  </span>
                </article>
              </li>
            );
          })}
        </ol>
        {doc.score.unreferenced.length > 0 ? (
          <section className="kitchen-score-unplaced">
            <h3>Not placed in a step</h3>
            <ul>
              {doc.score.unreferenced.map((row, index) => (
                <IngredientLine
                  key={row.id}
                  row={row}
                  later={[]}
                  showGroup={Boolean(row.group) && row.group !== doc.score.unreferenced[index - 1]?.group}
                  hot={ingHotFor(active, draft, row.id)}
                  onEnter={() => setActive({ kind: "ing", id: row.id })}
                  onLeave={() => setActive(null)}
                />
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      {focusedExcerpt ? <p className="kitchen-evidence-excerpt">Source: {focusedExcerpt}</p> : null}
      <details className="kitchen-source-caption">
        <summary>Source caption</summary>
        <p>{doc.sourceCaption}</p>
      </details>
    </section>
  );
}

function ingHotFor(
  active: { kind: "step" | "ing"; id: string; index?: number } | null,
  draft: RecipeDocument["draft"],
  id: string,
): boolean {
  if (!active) return false;
  if (active.kind === "step") {
    const step = draft.steps.find((row) => row.id === active.id);
    return Boolean(step?.ingredientIds.includes(id));
  }
  return active.id === id;
}

function IngredientLine({
  row,
  later,
  showGroup,
  hot,
  onEnter,
  onLeave,
}: {
  row: RecipeDocument["draft"]["ingredients"][number];
  later: number[];
  showGroup?: boolean;
  hot: boolean;
  onEnter: () => void;
  onLeave: () => void;
}) {
  return (
    <li
      className={`kitchen-ing ${hot ? "hot" : ""}`}
      tabIndex={0}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
    >
      {showGroup ? <span className="kitchen-ing-group">{row.group}</span> : null}
      <span className="kitchen-ing-text">
        {[row.quantity, row.unit, row.name, row.preparation].filter(Boolean).join(" ")}
        {row.raw && row.raw !== [row.quantity, row.unit, row.name, row.preparation].filter(Boolean).join(" ") ? (
          <span className="kitchen-ing-raw"> · {row.raw}</span>
        ) : null}
      </span>
      {later.length > 0 ? <span className="kitchen-ing-later">also step {later.map((n) => n + 1).join(", ")}</span> : null}
      <EvidenceMark evidence={row.evidence} />
    </li>
  );
}

function WatchCook({
  data,
  notice,
  tonightButton,
  onCreated,
}: {
  data: KitchenItem;
  notice: string;
  tonightButton: React.ReactNode;
  onCreated: () => void;
}) {
  const [preparing, setPreparing] = useState(false);
  const [generationDish, setGenerationDish] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const item = data.item;
  const original = openOriginal(item.url);
  const instagramEmbed = instagramEmbedUrl(item.url);
  const embed = instagramEmbed ?? youtubeEmbedUrl(item.url);
  const nativeVideo = item.media.find((m) => m.kind === "video");
  const image = item.media.find((m) => m.kind === "image");
  const isVideo = Boolean(embed || nativeVideo);

  async function makeCookable(allowGenerate: boolean): Promise<void> {
    setPreparing(true);
    setAiError(null);
    try {
      const result = await api.makeCookable(item.id, allowGenerate);
      if (result.outcome === "needs_generation") {
        setGenerationDish(result.dish);
        return;
      }
      onCreated();
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparing(false);
    }
  }

  return (
    <section className="kitchen-detail kitchen-watch">
      <DetailHeader data={data} tonightButton={tonightButton}>
        {!data.recipe ? (
          <MakeCookableActions preparing={preparing} onLocusAi={() => void makeCookable(false)} />
        ) : null}
      </DetailHeader>
      <p className="kitchen-notice" role="status" aria-live="polite">
        {notice}
      </p>
      {generationDish ? (
        <section className="kitchen-generation" aria-labelledby="kitchen-generation-title">
          <p className="kitchen-generation-kicker">No source recipe found</p>
          <h2 id="kitchen-generation-title">Generate a suggested recipe for {generationDish}?</h2>
          <p>This will be a new AI-generated recipe inspired by the dish—not the creator’s recipe or a transcription of the video.</p>
          <div>
            <button type="button" className="btn primary" disabled={preparing} onClick={() => void makeCookable(true)}>
              {preparing ? "Generating…" : "Generate suggested recipe"}
            </button>
            <button type="button" className="btn" disabled={preparing} onClick={() => setGenerationDish(null)}>
              Keep source only
            </button>
          </div>
        </section>
      ) : null}
      {aiError ? (
        <div className="kitchen-ai-error" role="alert">
          <p>{aiError}</p>
          <a className="btn" href={`#/kitchen/${item.id}/edit`}>Enter recipe manually</a>
        </div>
      ) : null}
      {embed ? (
        <iframe
          className={`kitchen-embed${instagramEmbed ? " kitchen-embed-instagram" : ""}`}
          src={embed}
          title={`${data.displayTitle} video`}
          referrerPolicy="no-referrer"
          allowFullScreen
        />
      ) : nativeVideo ? (
        <video className="kitchen-video" src={safeHttpUrl(nativeVideo.url) ?? undefined} controls preload="metadata" />
      ) : image ? (
        <img className="kitchen-media" src={image.url} alt="" referrerPolicy="no-referrer" />
      ) : null}
      {data.caption ? (
        <>
          <h2>Captured caption</h2>
          <div className="kitchen-caption-text">{renderCaptionLinks(data.caption)}</div>
        </>
      ) : (
        <p className="empty">
          {isVideo
            ? "This recipe lives in the video. Watch it here, or open the original if playback is unavailable."
            : "No caption was captured. Open the original for the source."}
        </p>
      )}
    </section>
  );
}

function MakeCookableActions({
  preparing,
  onLocusAi,
  webMcpAction = null,
}: {
  preparing: boolean;
  onLocusAi: () => void;
  webMcpAction?: React.ReactNode;
}) {
  return (
    <span className="kitchen-make-actions">
      <button type="button" className="btn primary" disabled={preparing} onClick={onLocusAi}>
        {preparing ? "Preparing…" : "Make this cookable"}
      </button>
      {webMcpAction}
    </span>
  );
}

const CAPTION_URL_RE = /https?:\/\/[^\s)>"']+/g;

function renderCaptionLinks(caption: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of caption.matchAll(CAPTION_URL_RE)) {
    const url = safeHttpUrl(match[0]);
    if (!url) continue;
    const start = match.index ?? 0;
    if (start > cursor) parts.push(caption.slice(cursor, start));
    parts.push(
      <a key={`${start}-${url}`} href={url} target="_blank" rel="noopener noreferrer">
        {match[0]}
      </a>,
    );
    cursor = start + match[0].length;
  }
  if (cursor < caption.length) parts.push(caption.slice(cursor));
  return parts;
}

// ---------- in-place writable score ----------
// The score is the editor (docs/kitchen-edit-prototype.html). The working copy
// is what is on screen; the accepted copy is the last successful write. Units
// are facts, one ingredient, one step, and the composer: blur never writes, a
// tick posts the full valid draft as status=draft, a cross restores that unit
// from the accepted copy, and a failed write keeps the working copy.

type WFact = { value: string; evidence?: RecipeEvidence };
type WIng = {
  id: string;
  raw: string;
  quantity: string;
  unit: string;
  name: string;
  preparation: string;
  group: string;
  evidence: RecipeEvidence;
};
type WStep = {
  id: string;
  instruction: string;
  duration: string;
  temperature: string;
  ingredientIds: string[];
  evidence: RecipeEvidence;
};
type WDraft = { title: WFact; servings: WFact; totalTime: WFact; ingredients: WIng[]; steps: WStep[] };
type RecipeDraftV1 = RecipeDocument["draft"];
type RecipeIngredientV1 = RecipeDraftV1["ingredients"][number];
type RecipeStepV1 = RecipeDraftV1["steps"][number];

function emptyWDraft(): WDraft {
  return { title: { value: "" }, servings: { value: "" }, totalTime: { value: "" }, ingredients: [], steps: [] };
}

function normalizeDraft(draft: RecipeDraftV1 | undefined): WDraft {
  if (!draft) return emptyWDraft();
  return {
    title: { value: draft.title ?? "", evidence: draft.titleEvidence },
    servings: { value: draft.servings ?? "", evidence: draft.servingsEvidence },
    totalTime: { value: draft.totalTime ?? "", evidence: draft.totalTimeEvidence },
    ingredients: draft.ingredients.map((row) => ({
      id: row.id,
      raw: row.raw,
      quantity: row.quantity ?? "",
      unit: row.unit ?? "",
      name: row.name,
      preparation: row.preparation ?? "",
      group: row.group ?? "",
      evidence: row.evidence,
    })),
    steps: draft.steps.map((row) => ({
      id: row.id,
      instruction: row.instruction,
      duration: row.duration ?? "",
      temperature: row.temperature ?? "",
      ingredientIds: [...row.ingredientIds],
      evidence: row.evidence,
    })),
  };
}

// A dirty fact keeps its user evidence; an untouched fact keeps the accepted
// evidence so provenance only changes when content actually changes.
function factToDraft(w: WFact, accepted: WFact): { value: string; evidence: RecipeEvidence } | null {
  const value = w.value.trim();
  if (!value) return null;
  if (value === accepted.value.trim() && accepted.evidence) return { value, evidence: accepted.evidence };
  return { value, evidence: w.evidence ?? { kind: "user" } };
}

function ingToDraft(row: WIng): RecipeIngredientV1 {
  const quantity = row.quantity.trim();
  const unit = row.unit.trim();
  const name = row.name.trim();
  return {
    id: row.id,
    // The server requires non-empty raw; compose one from the fields when the
    // row was typed by hand and has no source text.
    raw: row.raw.trim() || [quantity, unit, name].filter(Boolean).join(" "),
    name,
    ...(quantity ? { quantity } : {}),
    ...(unit ? { unit } : {}),
    ...(row.preparation.trim() ? { preparation: row.preparation.trim() } : {}),
    ...(row.group.trim() ? { group: row.group.trim() } : {}),
    evidence: row.evidence,
  };
}

function stepToDraft(step: WStep, ingredientIds: ReadonlySet<string>): RecipeStepV1 {
  return {
    id: step.id,
    instruction: step.instruction.trim(),
    ingredientIds: step.ingredientIds.filter((id) => ingredientIds.has(id)),
    ...(step.duration.trim() ? { duration: step.duration.trim() } : {}),
    ...(step.temperature.trim() ? { temperature: step.temperature.trim() } : {}),
    evidence: step.evidence,
  };
}

function ingMain(row: WIng): string {
  return [row.quantity, row.unit, row.name, row.preparation].map((part) => part.trim()).filter(Boolean).join(" ");
}

// Uncontrolled contenteditable: typing re-renders without touching the DOM so
// the caret stays put; callers bump resetKey after programmatic changes
// (accept/revert) to resync the text.
function Editable({
  value,
  resetKey,
  placeholder,
  label,
  className,
  multiline,
  as = "div",
  dataEdit,
  onInput,
}: {
  value: string;
  resetKey: number;
  placeholder: string;
  label: string;
  className?: string;
  multiline?: boolean;
  as?: "div" | "span";
  dataEdit?: string;
  onInput: (value: string) => void;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.innerText.replace(/\n$/, "") !== value) el.innerText = value;
    // Resync is driven by resetKey, not by every keystroke.
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const shared = {
    className,
    contentEditable: true,
    suppressContentEditableWarning: true,
    role: "textbox" as const,
    "aria-multiline": multiline || undefined,
    "aria-label": label,
    "data-ph": placeholder,
    "data-edit": dataEdit,
    onInput: (event: React.FormEvent<HTMLElement>) => {
      const el = event.currentTarget;
      if (!el.innerText.trim()) el.innerHTML = ""; // keep the :empty placeholder working
      onInput(el.innerText.replace(/\n$/, ""));
    },
    onPaste: (event: React.ClipboardEvent<HTMLElement>) => {
      event.preventDefault();
      document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
    },
  };
  return as === "span" ? (
    <span ref={ref as unknown as React.RefObject<HTMLSpanElement>} {...shared} />
  ) : (
    <div ref={ref as unknown as React.RefObject<HTMLDivElement>} {...shared} />
  );
}

function RecipeEditor({
  data,
  notice,
  tonightButton,
  onDone,
  onRemoved,
}: {
  data: KitchenItem;
  notice: string;
  tonightButton: React.ReactNode;
  onDone: () => void;
  onRemoved: () => void;
}) {
  const savedDoc = data.recipe && "draft" in data.recipe ? data.recipe : null;
  const [doc, setDoc] = useState<RecipeDocument | null>(savedDoc);
  const [accepted, setAccepted] = useState<WDraft>(() => normalizeDraft(savedDoc?.draft));
  const [working, setWorking] = useState<WDraft>(() => normalizeDraft(savedDoc?.draft));
  const [composer, setComposer] = useState("");
  const [composerReset, setComposerReset] = useState(0);
  const [factsReset, setFactsReset] = useState(0);
  const [stepResets, setStepResets] = useState<Record<string, number>>({});
  const [editingIng, setEditingIng] = useState<string | null>(null);
  const [localNotice, setLocalNotice] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [changedDismissed, setChangedDismissed] = useState(false);
  // Structural pending ownership: a beat marked for removal stays on screen
  // (struck, with its own tick/cross) until accepted or reverted.
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [liveItem, setLiveItem] = useState(data.item);
  const [pendingFreshItem, setPendingFreshItem] = useState<ItemCard | null>(null);
  const [focusStep, setFocusStep] = useState<string | null>(null);

  useEffect(() => {
    if (!focusStep) return;
    const el = document.querySelector<HTMLElement>(`[data-edit="${focusStep}"]`);
    setFocusStep(null);
    el?.focus();
  }, [focusStep]);

  // The ingredient inputs stay mounted (visibility is CSS-toggled), so focus
  // the name field imperatively whenever an editor opens.
  useEffect(() => {
    if (!editingIng) return;
    document.querySelector<HTMLInputElement>(".kitchen-ing.editing input.n")?.focus();
  }, [editingIng]);

  const ingDirty = (row: WIng): boolean => {
    const acc = accepted.ingredients.find((other) => other.id === row.id);
    if (!acc) return true;
    return (
      row.raw !== acc.raw ||
      row.quantity !== acc.quantity ||
      row.unit !== acc.unit ||
      row.name !== acc.name ||
      row.preparation !== acc.preparation ||
      row.group !== acc.group
    );
  };

  const factKeys = ["title", "servings", "totalTime"] as const;
  const factsDirty = factKeys.some((key) => working[key].value !== accepted[key].value);
  const composerDirty = composer.trim().length > 0;

  // Pending order state: accepted beat ids in working order vs accepted order.
  // Pending removals are excluded from both sides so only the moved beats are
  // position-dirty, not every beat after the removal.
  const acceptedStepIds = accepted.steps.map((step) => step.id);
  const removedSet = new Set(removedIds);
  const workingAcceptedOrder = working.steps
    .filter((step) => acceptedStepIds.includes(step.id) && !removedSet.has(step.id))
    .map((step) => step.id);
  const baseOrder = acceptedStepIds.filter((id) => !removedSet.has(id));
  const orderDirty = workingAcceptedOrder.join("\u0000") !== baseOrder.join("\u0000");
  const positionDirtyIds = new Set<string>();
  if (orderDirty) {
    workingAcceptedOrder.forEach((id, index) => {
      if (baseOrder[index] !== id) positionDirtyIds.add(id);
    });
  }
  // One structural change at a time: while a move or removal is pending, the
  // other move/remove controls wait for it to be ticked or crossed.
  const structLocked = removedIds.length > 0 || orderDirty;

  const stepDirty = (step: WStep): boolean => {
    const acc = accepted.steps.find((other) => other.id === step.id);
    if (!acc) return true;
    if (removedSet.has(step.id)) return true;
    const contentDirty =
      step.instruction !== acc.instruction ||
      step.duration !== acc.duration ||
      step.temperature !== acc.temperature ||
      step.ingredientIds.join("\u0000") !== acc.ingredientIds.join("\u0000");
    return contentDirty || positionDirtyIds.has(step.id);
  };
  const hasContent = Boolean(
    working.title.value.trim() ||
      working.servings.value.trim() ||
      working.totalTime.value.trim() ||
      working.ingredients.length > 0 ||
      working.steps.length > 0 ||
      composer.trim(),
  );
  const anyUnsaved =
    factsDirty ||
    composerDirty ||
    working.ingredients.some((row) => ingDirty(row)) ||
    working.steps.some((step) => stepDirty(step));

  function patchFact(key: (typeof factKeys)[number], value: string): void {
    setWorking((current) => ({ ...current, [key]: { value, evidence: { kind: "user" } } }));
  }

  function patchIng(id: string, field: "raw" | "quantity" | "unit" | "name" | "preparation" | "group", value: string): void {
    setWorking((current) => ({
      ...current,
      ingredients: current.ingredients.map((row) => (row.id === id ? { ...row, [field]: value, evidence: { kind: "user" } } : row)),
    }));
  }

  function patchStep(id: string, patch: Partial<Pick<WStep, "instruction" | "duration" | "temperature" | "ingredientIds">>): void {
    setWorking((current) => ({
      ...current,
      steps: current.steps.map((step) => (step.id === id ? { ...step, ...patch, evidence: { kind: "user" } } : step)),
    }));
  }

  function addIng(stepId?: string): void {
    const row: WIng = { id: crypto.randomUUID(), raw: "", quantity: "", unit: "", name: "", preparation: "", group: "", evidence: { kind: "user" } };
    setWorking((current) => ({
      ...current,
      ingredients: [...current.ingredients, row],
      steps: stepId
        ? current.steps.map((step) =>
            step.id === stepId ? { ...step, ingredientIds: [...step.ingredientIds, row.id], evidence: { kind: "user" } } : step,
          )
        : current.steps,
    }));
    setEditingIng(row.id);
  }

  function addStepAfter(id?: string): void {
    const step: WStep = { id: crypto.randomUUID(), instruction: "", duration: "", temperature: "", ingredientIds: [], evidence: { kind: "user" } };
    setWorking((current) => {
      const at = id ? current.steps.findIndex((row) => row.id === id) : current.steps.length - 1;
      const steps = [...current.steps];
      steps.splice(at + 1, 0, step);
      return { ...current, steps };
    });
    setFocusStep(step.id);
  }

  function delStep(id: string): void {
    // An accepted beat is marked for removal — struck, with its own tick/cross
    // — so the deletion is explicit and reversible. A new unticked beat just
    // disappears from the working copy.
    if (!accepted.steps.some((step) => step.id === id)) {
      setWorking((current) => ({ ...current, steps: current.steps.filter((step) => step.id !== id) }));
      return;
    }
    setRemovedIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
  }

  function moveStep(id: string, dir: -1 | 1): void {
    setWorking((current) => {
      const from = current.steps.findIndex((step) => step.id === id);
      const to = from + dir;
      if (from < 0 || to < 0 || to >= current.steps.length) return current;
      const steps = [...current.steps];
      steps.splice(to, 0, ...steps.splice(from, 1));
      return { ...current, steps };
    });
  }

  function placeOn(ingId: string, stepId: string): void {
    const step = working.steps.find((row) => row.id === stepId);
    if (!step || step.ingredientIds.includes(ingId)) return;
    patchStep(stepId, { ingredientIds: [...step.ingredientIds, ingId] });
  }

  // Each tick starts from the accepted copy and merges only the selected unit
  // (plus any brand-new ingredients the ticked beat references): unrelated
  // dirty edits stay working-only and disappear on reload. The composer tick
  // merges the new beat. Returns the ids that were absorbed into the posted
  // draft so the working copy can be canonicalized after success.
  function buildPostDraft(unit: string, extra?: WStep): { draft: RecipeDraftV1; absorbedIds: string[] } | { error: string } {
    const draft: RecipeDraftV1 = { version: 1, ingredients: [], steps: [] };
    const absorbedIds: string[] = [];
    const mergeFacts = unit === "facts";
    const title = mergeFacts ? factToDraft(working.title, accepted.title) : factToDraft(accepted.title, accepted.title);
    if (title) {
      draft.title = title.value;
      draft.titleEvidence = title.evidence;
    }
    const servings = mergeFacts ? factToDraft(working.servings, accepted.servings) : factToDraft(accepted.servings, accepted.servings);
    if (servings) {
      draft.servings = servings.value;
      draft.servingsEvidence = servings.evidence;
    }
    const totalTime = mergeFacts ? factToDraft(working.totalTime, accepted.totalTime) : factToDraft(accepted.totalTime, accepted.totalTime);
    if (totalTime) {
      draft.totalTime = totalTime.value;
      draft.totalTimeEvidence = totalTime.evidence;
    }
    draft.ingredients = accepted.ingredients.map((row) => ingToDraft(row));
    if (unit.startsWith("ing:")) {
      const row = working.ingredients.find((other) => other.id === unit.slice(4));
      if (!row) return { error: "That ingredient is no longer on the score." };
      const merged = ingToDraft(row);
      draft.ingredients = draft.ingredients.some((other) => other.id === merged.id)
        ? draft.ingredients.map((other) => (other.id === merged.id ? merged : other))
        : [...draft.ingredients, merged];
      absorbedIds.push(merged.id);
    }
    const postedIngredientIds = new Set(draft.ingredients.map((row) => row.id));

    if (unit === "composer" && extra) {
      draft.steps = accepted.steps.map((step) => stepToDraft(step, postedIngredientIds));
      draft.steps.push(stepToDraft(extra, postedIngredientIds));
      absorbedIds.push(extra.id);
    } else if (unit.startsWith("step:")) {
      const id = unit.slice(5);
      const wStep = working.steps.find((step) => step.id === id);
      if (!wStep) return { error: "That beat is no longer on the score." };
      if (removedSet.has(id)) {
        // The ticked unit is the removal itself: post the accepted beats
        // without it.
        draft.steps = accepted.steps.filter((step) => !removedSet.has(step.id)).map((step) => stepToDraft(step, postedIngredientIds));
      } else {
        // The ticked beat may reference brand-new ingredients (Place on N);
        // include those working rows so the write validates.
        for (const ref of wStep.ingredientIds) {
          if (postedIngredientIds.has(ref)) continue;
          const dep = working.ingredients.find((other) => other.id === ref);
          if (!dep || !dep.name.trim()) return { error: "Finish the ingredient before saving this beat." };
          const merged = ingToDraft(dep);
          draft.ingredients.push(merged);
          postedIngredientIds.add(merged.id);
          absorbedIds.push(merged.id);
        }
        if (!acceptedStepIds.includes(id)) {
          if (orderDirty) {
            // A move is pending elsewhere; append the new beat without
            // applying that move.
            draft.steps = [
              ...accepted.steps.filter((step) => !removedSet.has(step.id)).map((step) => stepToDraft(step, postedIngredientIds)),
              stepToDraft(wStep, postedIngredientIds),
            ];
          } else {
            const placed: RecipeStepV1[] = [];
            let inserted = false;
            for (const step of working.steps) {
              const acc = accepted.steps.find((other) => other.id === step.id);
              if (step.id === id) {
                placed.push(stepToDraft(wStep, postedIngredientIds));
                inserted = true;
              } else if (acc && !removedSet.has(step.id)) {
                placed.push(stepToDraft(acc, postedIngredientIds));
              }
            }
            if (!inserted) placed.push(stepToDraft(wStep, postedIngredientIds));
            draft.steps = placed;
          }
        } else if (positionDirtyIds.has(id)) {
          // Move: accepted beats in working order, contents from the accepted
          // copy except the ticked beat; unticked new beats stay working-only.
          draft.steps = working.steps
            .filter((step) => acceptedStepIds.includes(step.id) && !removedSet.has(step.id))
            .map((step) => {
              const acc = accepted.steps.find((other) => other.id === step.id)!;
              return step.id === id ? stepToDraft(wStep, postedIngredientIds) : stepToDraft(acc, postedIngredientIds);
            });
        } else {
          draft.steps = accepted.steps.map((step) =>
            step.id === id ? stepToDraft(wStep, postedIngredientIds) : stepToDraft(step, postedIngredientIds),
          );
        }
      }
      absorbedIds.push(id);
    } else {
      draft.steps = accepted.steps.map((step) => stepToDraft(step, postedIngredientIds));
    }
    if (draft.ingredients.length === 0 && draft.steps.length === 0) {
      return { error: "Add an ingredient or a beat before saving." };
    }
    return { draft, absorbedIds };
  }

  // Document-level review action: confirm the whole score as it is on screen.
  // Complete working rows are included, pending removals are dropped, and
  // incomplete new rows are omitted.
  function buildFullDraft(): RecipeDraftV1 | { error: string } {
    const draft: RecipeDraftV1 = { version: 1, ingredients: [], steps: [] };
    const title = factToDraft(working.title, accepted.title);
    if (title) {
      draft.title = title.value;
      draft.titleEvidence = title.evidence;
    }
    const servings = factToDraft(working.servings, accepted.servings);
    if (servings) {
      draft.servings = servings.value;
      draft.servingsEvidence = servings.evidence;
    }
    const totalTime = factToDraft(working.totalTime, accepted.totalTime);
    if (totalTime) {
      draft.totalTime = totalTime.value;
      draft.totalTimeEvidence = totalTime.evidence;
    }
    for (const row of working.ingredients) {
      if (row.name.trim()) draft.ingredients.push(ingToDraft(row));
      else {
        // An accepted ingredient mid-edit keeps its saved version; the
        // half-typed edit stays pending here.
        const acc = accepted.ingredients.find((other) => other.id === row.id);
        if (acc) draft.ingredients.push(ingToDraft(acc));
      }
    }
    const ingredientIds = new Set(draft.ingredients.map((row) => row.id));
    for (const step of working.steps) {
      if (removedSet.has(step.id)) continue;
      if (step.instruction.trim()) draft.steps.push(stepToDraft(step, ingredientIds));
      else {
        const acc = accepted.steps.find((other) => other.id === step.id);
        if (acc) draft.steps.push(stepToDraft(acc, ingredientIds));
      }
    }
    if (draft.ingredients.length === 0 && draft.steps.length === 0) {
      return { error: "Add an ingredient or a beat before saving." };
    }
    return draft;
  }

  async function saveFailed(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    setErr(message);
    // A stale revision or a span that no longer matches means the caption
    // changed under us; keep the working copy and surface the comparison.
    if (/mismatch|conflict|409|span/i.test(message)) {
      try {
        const fresh = await api.kitchenItem(data.item.id);
        setPendingFreshItem(fresh.item);
      } catch {
        /* keep the current item */
      }
      setStale(true);
    }
  }

  async function acceptUnit(unit: string): Promise<void> {
    if (saving) return;
    setErr(null);
    if (unit.startsWith("ing:")) {
      const row = working.ingredients.find((other) => other.id === unit.slice(4));
      if (row && !row.name.trim()) {
        if (!accepted.ingredients.some((other) => other.id === row.id)) {
          rejectUnit(unit); // an empty new row has nothing to save
          return;
        }
        setErr("Give the ingredient a name first.");
        return;
      }
    }
    if (unit.startsWith("step:")) {
      const step = working.steps.find((other) => other.id === unit.slice(5));
      if (step && !removedIds.includes(step.id) && !step.instruction.trim()) {
        if (!accepted.steps.some((other) => other.id === step.id)) {
          rejectUnit(unit);
          return;
        }
        setErr("Write the beat first.");
        return;
      }
    }
    let extra: WStep | undefined;
    let extraName = "";
    if (unit === "composer") {
      const text = composer.trim();
      if (!text) return;
      extraName = text;
      extra = { id: crypto.randomUUID(), instruction: text, duration: "", temperature: "", ingredientIds: [], evidence: { kind: "user" } };
    }
    const built = buildPostDraft(unit, extra);
    if ("error" in built) {
      setErr(built.error);
      return;
    }
    setSaving(unit);
    try {
      const expectedSourceRevision = await captionRevisionOf(liveItem);
      const { document: saved } = await api.saveRecipe(data.item.id, { expectedSourceRevision, status: "draft", draft: built.draft });
      const savedDraft = normalizeDraft(saved.draft);
      setDoc(saved);
      setAccepted(savedDraft);
      // Canonicalize exactly the units that were absorbed into the write so
      // their pending ticks clear; unrelated edits stay pending in working.
      const wasRemoval = unit.startsWith("step:") && removedIds.includes(unit.slice(5));
      setWorking((current) => {
        let steps = current.steps;
        let ingredients = current.ingredients;
        for (const id of built.absorbedIds) {
          const savedStep = savedDraft.steps.find((row) => row.id === id);
          if (savedStep) steps = steps.map((row) => (row.id === id ? savedStep : row));
          const savedIng = savedDraft.ingredients.find((row) => row.id === id);
          if (savedIng) ingredients = ingredients.map((row) => (row.id === id ? savedIng : row));
        }
        if (unit === "composer" && extra) {
          const savedStep = savedDraft.steps.find((row) => row.id === extra!.id);
          if (savedStep && !steps.some((row) => row.id === extra!.id)) steps = [...steps, savedStep];
        }
        if (wasRemoval) steps = steps.filter((row) => row.id !== unit.slice(5));
        return {
          ...current,
          ingredients,
          steps,
          title: unit === "facts" ? { ...savedDraft.title } : current.title,
          servings: unit === "facts" ? { ...savedDraft.servings } : current.servings,
          totalTime: unit === "facts" ? { ...savedDraft.totalTime } : current.totalTime,
        };
      });
      if (wasRemoval) setRemovedIds((ids) => ids.filter((value) => value !== unit.slice(5)));
      if (unit === "composer") {
        setComposer("");
        setComposerReset((key) => key + 1);
      }
      if (unit.startsWith("ing:")) setEditingIng(null);
      setStale(false);
      setLocalNotice(
        unit === "facts"
          ? "Saved facts"
          : unit === "composer"
            ? `Saved “${extraName.slice(0, 40)}”`
            : unit.startsWith("ing:")
              ? "Saved ingredient"
              : wasRemoval
                ? "Beat removed"
                : "Saved this beat",
      );
    } catch (error) {
      await saveFailed(error);
    } finally {
      setSaving(null);
    }
  }

  function rejectUnit(unit: string): void {
    setErr(null);
    if (unit === "composer") {
      setComposer("");
      setComposerReset((key) => key + 1);
      setLocalNotice("Discarded");
      return;
    }
    if (unit === "facts") {
      setWorking((current) => ({
        ...current,
        title: { ...accepted.title },
        servings: { ...accepted.servings },
        totalTime: { ...accepted.totalTime },
      }));
      setFactsReset((key) => key + 1);
      setLocalNotice("Reverted facts");
      return;
    }
    if (unit.startsWith("ing:")) {
      const id = unit.slice(4);
      const acc = accepted.ingredients.find((other) => other.id === id);
      setWorking((current) =>
        acc
          ? { ...current, ingredients: current.ingredients.map((row) => (row.id === id ? { ...acc } : row)) }
          : {
              ...current,
              ingredients: current.ingredients.filter((row) => row.id !== id),
              steps: current.steps.map((step) => ({ ...step, ingredientIds: step.ingredientIds.filter((ref) => ref !== id) })),
            },
      );
      setEditingIng(null);
      setLocalNotice(acc ? "Reverted ingredient" : "Discarded ingredient");
      return;
    }
    if (unit.startsWith("step:")) {
      const id = unit.slice(5);
      setRemovedIds((ids) => ids.filter((value) => value !== id));
      const acc = accepted.steps.find((other) => other.id === id);
      setWorking((current) => {
        if (!acc) return { ...current, steps: current.steps.filter((step) => step.id !== id) };
        const byId = new Map(current.steps.map((step) => [step.id, step]));
        const acceptedOrder = accepted.steps.map((step) => {
          const value = step.id === id ? acc : byId.get(step.id) ?? step;
          return { ...value, ingredientIds: [...value.ingredientIds] };
        });
        const acceptedIds = new Set(accepted.steps.map((step) => step.id));
        return { ...current, steps: [...acceptedOrder, ...current.steps.filter((step) => !acceptedIds.has(step.id))] };
      });
      setStepResets((resets) => ({ ...resets, [id]: (resets[id] ?? 0) + 1 }));
      setLocalNotice(acc ? "Reverted beat" : "Discarded beat");
    }
  }

  async function saveReviewed(): Promise<void> {
    if (saving) return;
    setErr(null);
    const built = buildFullDraft();
    if ("error" in built) {
      setErr(built.error);
      return;
    }
    setSaving("reviewed");
    try {
      const expectedSourceRevision = await captionRevisionOf(liveItem);
      await api.saveRecipe(data.item.id, { expectedSourceRevision, status: "reviewed", draft: built });
      onDone();
    } catch (error) {
      await saveFailed(error);
    } finally {
      setSaving(null);
    }
  }

  async function removeStructure(): Promise<void> {
    const hasUserEvidence =
      doc?.status === "reviewed" ||
      [accepted.title.evidence, accepted.servings.evidence, accepted.totalTime.evidence]
        .concat(accepted.ingredients.map((row) => row.evidence), accepted.steps.map((row) => row.evidence))
        .some((evidence) => evidence?.kind === "user");
    if (hasUserEvidence && !window.confirm("Remove the structured recipe? Your entered facts will be lost.")) return;
    try {
      await api.removeRecipe(data.item.id);
      onRemoved();
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    }
  }

  const acceptBtns = (unit: string): React.ReactNode => (
    <span className="kitchen-accept">
      <button
        type="button"
        className="kitchen-tick"
        disabled={saving !== null}
        aria-label="Save this change"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void acceptUnit(unit)}
      >
        ✓
      </button>
      <button
        type="button"
        className="kitchen-cross"
        disabled={saving !== null}
        aria-label="Discard this change"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => rejectUnit(unit)}
      >
        ✕
      </button>
    </span>
  );

  const placeOnBtns = (ingId: string): React.ReactNode =>
    working.steps.length === 0 ? (
      <span className="kitchen-place-hint">Add a beat first, then place it.</span>
    ) : (
      <span className="kitchen-place-on">
        <span>Place on</span>
        {working.steps.map((step, index) => (
          <button
            key={step.id}
            type="button"
            aria-label={`Place on step ${index + 1}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => placeOn(ingId, step.id)}
          >
            {index + 1}
          </button>
        ))}
      </span>
    );

  const ingRow = (row: WIng, opts: { showGroup: boolean; placeable?: boolean }): React.ReactNode => {
    const dirty = ingDirty(row);
    const editing = editingIng === row.id;
    const main = ingMain(row);
    const raw = row.raw.trim();
    return (
      <li key={row.id} className={`kitchen-ing${dirty ? " pending" : ""}${editing ? " editing" : ""}`}>
        {opts.showGroup && row.group ? <span className="kitchen-ing-group">{row.group}</span> : null}
        <button type="button" className="kitchen-ing-read" onClick={() => setEditingIng(row.id)}>
          <span className="kitchen-ing-text">
            {main || "Untitled"}
            {raw && raw !== main ? <span className="kitchen-ing-raw"> · {raw}</span> : null}
          </span>
        </button>
        <span
          className="kitchen-ing-edit"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setEditingIng(null);
          }}
        >
          <input
            className="q"
            aria-label="Quantity"
            enterKeyHint="done"
            value={row.quantity}
            onChange={(event) => patchIng(row.id, "quantity", event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (!ingDirty(row)) setEditingIng(null);
              else void acceptUnit(`ing:${row.id}`);
            }}
          />
          <input
            className="u"
            aria-label="Unit"
            enterKeyHint="done"
            value={row.unit}
            onChange={(event) => patchIng(row.id, "unit", event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (!ingDirty(row)) setEditingIng(null);
              else void acceptUnit(`ing:${row.id}`);
            }}
          />
          <input
            className="n"
            aria-label="Name"
            enterKeyHint="done"
            value={row.name}
            onChange={(event) => patchIng(row.id, "name", event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (!ingDirty(row)) setEditingIng(null);
              else void acceptUnit(`ing:${row.id}`);
            }}
          />
        </span>
        <EvidenceMark evidence={row.evidence} />
        {opts.placeable ? placeOnBtns(row.id) : null}
        {dirty ? acceptBtns(`ing:${row.id}`) : null}
      </li>
    );
  };

  const firstUse = new Map<string, string>();
  for (const step of working.steps) {
    for (const id of step.ingredientIds) if (!firstUse.has(id)) firstUse.set(id, step.id);
  }
  const unplaced = working.ingredients.filter((row) => !firstUse.has(row.id));

  const stateChip = doc ? (doc.status === "reviewed" ? "Reviewed" : "Draft") : hasContent ? "Draft" : null;
  const provText = doc
    ? doc.provenance === "generated"
      ? "AI-generated suggestion — not the creator’s original recipe"
      : doc.provenance === "caption"
        ? "Prepared from the captured caption"
        : "Edited by you"
    : hasContent
      ? "Draft"
      : "Start from a blank score";

  return (
    <section className="kitchen-detail kitchen-edit">
      <DetailHeader
        data={data}
        stateChip={stateChip}
        tonightButton={tonightButton}
        titleSlot={
          <h1 className="kitchen-edit-title">
            <Editable
              as="span"
              value={working.title.value}
              resetKey={factsReset}
              placeholder="Name this recipe"
              label="Recipe title"
              dataEdit="title"
              onInput={(value) => patchFact("title", value)}
            />
          </h1>
        }
        factsSlot={
          <div className={`kitchen-facts-edit${factsDirty ? " pending" : ""}`}>
            <Editable
              value={working.servings.value}
              resetKey={factsReset}
              placeholder="servings"
              label="Servings"
              className="kitchen-edit-fact"
              dataEdit="servings"
              onInput={(value) => patchFact("servings", value)}
            />
            <span className="kitchen-facts-dot">·</span>
            <Editable
              value={working.totalTime.value}
              resetKey={factsReset}
              placeholder="total time"
              label="Total time"
              className="kitchen-edit-fact"
              dataEdit="totalTime"
              onInput={(value) => patchFact("totalTime", value)}
            />
            {factsDirty ? acceptBtns("facts") : null}
          </div>
        }
      >
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            if (anyUnsaved && !window.confirm("Leave edit mode? Only ticked changes were saved.")) return;
            onDone();
          }}
        >
          Done
        </button>
        <button type="button" className="btn" disabled={saving !== null} onClick={() => void saveReviewed()}>
          Save as reviewed
        </button>
        {doc ? (
          <details className="kitchen-more">
            <summary aria-label="Recipe actions">Recipe actions</summary>
            <button type="button" className="btn danger" onClick={() => void removeStructure()}>
              Remove structure
            </button>
          </details>
        ) : null}
      </DetailHeader>
      <p className="kitchen-notice" role="status" aria-live="polite">
        {localNotice || notice}
      </p>
      {err ? (
        <p className="bad" role="alert">
          {err}
        </p>
      ) : null}
      {stale || (doc?.sourceChanged && !changedDismissed) ? (
        <div className="kitchen-changed" role="alert">
          <p>The caption changed since this recipe was saved. Your draft is untouched.</p>
          <details>
            <summary>Compare</summary>
            <p className="kitchen-compare-old">{doc?.sourceCaption ?? "(no saved recipe)"}</p>
            <p className="kitchen-compare-new">{normalizeCaption(pendingFreshItem?.body ?? data.caption) || "(no caption captured)"}</p>
          </details>
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (pendingFreshItem) setLiveItem(pendingFreshItem);
              setPendingFreshItem(null);
              setStale(false);
              setChangedDismissed(true);
            }}
          >
            Keep editing
          </button>
        </div>
      ) : null}
      <p className={`kitchen-provenance${doc && doc.provenance !== "user" ? ` kitchen-provenance-${doc.provenance}` : ""}`}>{provText}</p>
      <div className="kitchen-score kitchen-score-edit" data-layout="vertical-timeline">
        <div className="kitchen-score-heading kitchen-score-heading-ing">
          <h2>Ingredients</h2>
        </div>
        <div className="kitchen-score-heading kitchen-score-heading-method">
          <h2>Method</h2>
        </div>
        <ol className="kitchen-score-flow" aria-label="Recipe timeline">
          {working.steps.map((step, index) => {
            const dirty = stepDirty(step);
            const removing = removedSet.has(step.id);
            const arrivals = working.ingredients.filter((row) => firstUse.get(row.id) === step.id);
            return (
              <li key={step.id} className="kitchen-score-row">
                <div className="kitchen-score-ing">
                  {arrivals.length > 0 ? (
                    <ul aria-label={`Ingredients first used in step ${index + 1}`}>
                      {arrivals.map((row, ingIndex) =>
                        ingRow(row, { showGroup: Boolean(row.group) && row.group !== arrivals[ingIndex - 1]?.group }),
                      )}
                    </ul>
                  ) : null}
                  <button type="button" className="kitchen-ghost-add" onMouseDown={(event) => event.preventDefault()} onClick={() => addIng(step.id)}>
                    + ingredient
                  </button>
                </div>
                <div className="kitchen-score-spine">
                  <span className="kitchen-step-node" role="img" aria-label={`Step ${index + 1}`}>
                    {index + 1}
                  </span>
                </div>
                <article className={`kitchen-step${dirty ? " pending" : ""}${removing ? " removing" : ""}`}>
                  <span className="kitchen-beat-tools">
                    <button
                      type="button"
                      aria-label="Move beat up"
                      disabled={index === 0 || structLocked || saving !== null}
                      onClick={() => moveStep(step.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label="Move beat down"
                      disabled={index === working.steps.length - 1 || structLocked || saving !== null}
                      onClick={() => moveStep(step.id, 1)}
                    >
                      ↓
                    </button>
                    <button type="button" aria-label="Add a beat below" disabled={structLocked || saving !== null} onClick={() => addStepAfter(step.id)}>
                      +
                    </button>
                    <button type="button" aria-label="Remove beat" disabled={structLocked || saving !== null} onClick={() => delStep(step.id)}>
                      ×
                    </button>
                  </span>
                  <Editable
                    value={step.instruction}
                    resetKey={stepResets[step.id] ?? 0}
                    placeholder="What happens in this beat?"
                    label={`Step ${index + 1}`}
                    multiline
                    className="kitchen-step-text"
                    dataEdit={step.id}
                    onInput={(value) => patchStep(step.id, { instruction: value })}
                  />
                  <div className="kitchen-step-meta">
                    <input
                      className="kitchen-step-time"
                      aria-label="Duration"
                      placeholder="+ time"
                      value={step.duration}
                      onChange={(event) => patchStep(step.id, { duration: event.target.value })}
                    />
                    <input
                      className="kitchen-step-temp"
                      aria-label="Temperature"
                      placeholder="+ temperature"
                      value={step.temperature}
                      onChange={(event) => patchStep(step.id, { temperature: event.target.value })}
                    />
                    <EvidenceMark evidence={step.evidence} />
                  </div>
                  {dirty ? acceptBtns(`step:${step.id}`) : null}
                </article>
              </li>
            );
          })}
          <li className="kitchen-score-row kitchen-composer">
            <div className="kitchen-score-ing">
              <button type="button" className="kitchen-ghost-add" onMouseDown={(event) => event.preventDefault()} onClick={() => addIng()}>
                + unplaced ingredient
              </button>
            </div>
            <div className="kitchen-score-spine">
              <span className={`kitchen-step-node${composerDirty ? " live" : ""}`} aria-hidden="true">
                {composerDirty ? working.steps.length + 1 : "+"}
              </span>
            </div>
            <article className={`kitchen-step${composerDirty ? " pending" : ""}`}>
              <Editable
                value={composer}
                resetKey={composerReset}
                placeholder={working.steps.length ? "What happens next?" : "What happens first?"}
                label="Next beat"
                multiline
                className="kitchen-step-text"
                dataEdit="composer"
                onInput={setComposer}
              />
              {composerDirty ? acceptBtns("composer") : null}
            </article>
          </li>
        </ol>
        {unplaced.length > 0 ? (
          <section className="kitchen-score-unplaced">
            <h3>Not placed in a step</h3>
            <ul>
              {unplaced.map((row, index) =>
                ingRow(row, { showGroup: Boolean(row.group) && row.group !== unplaced[index - 1]?.group, placeable: true }),
              )}
            </ul>
          </section>
        ) : null}
      </div>
      <details className="kitchen-source-caption">
        <summary>Source caption</summary>
        <p>{doc?.sourceCaption ?? (normalizeCaption(data.caption) || "(no caption captured)")}</p>
      </details>
    </section>
  );
}

function evidenceExcerpt(evidence: RecipeEvidence): string | null {
  if (evidence.kind !== "caption") return null;
  const text = evidence.spans.map((span) => span.text).join(" … ");
  return text ? `“${text}”` : null;
}

function EvidenceMark({ evidence }: { evidence: RecipeEvidence }) {
  if (evidence.kind === "user") return <span className="kitchen-usermark">Added by you</span>;
  if (evidence.kind === "generated") return <span className="kitchen-generatedmark">AI suggestion</span>;
  const excerpt = evidenceExcerpt(evidence);
  return <span className="kitchen-captionmark">{excerpt ? `From caption: ${excerpt}` : "From caption"}</span>;
}

function useLayoutScrollRestore(page: unknown): void {
  const [ready, setReady] = useState(page !== null);
  useEffect(() => {
    if (page !== null) setReady(true);
  }, [page]);
  useEffect(() => {
    if (!ready) return;
    const id = window.requestAnimationFrame(() => {
      try {
        const raw = sessionStorage.getItem(`${INDEX_KEY}:scroll`);
        const top = raw ? Number(raw) : 0;
        if (Number.isFinite(top) && top > 0) window.scrollTo(0, top);
      } catch {
        /* ignore */
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [ready]);
  useEffect(() => {
    const onHide = () => {
      try {
        sessionStorage.setItem(`${INDEX_KEY}:scroll`, String(window.scrollY));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      onHide();
      window.removeEventListener("pagehide", onHide);
    };
  }, []);
}

function readIndexQuery(): { q: string; source: string } {
  try {
    const raw = sessionStorage.getItem(INDEX_KEY);
    if (!raw) return { q: "", source: "" };
    const value = JSON.parse(raw) as Partial<{ q: string; source: string }>;
    return {
      q: typeof value.q === "string" ? value.q : "",
      source: typeof value.source === "string" ? value.source : "",
    };
  } catch {
    return { q: "", source: "" };
  }
}

function writeIndexQuery(query: { q: string; source: string }): void {
  try {
    sessionStorage.setItem(INDEX_KEY, JSON.stringify(query));
  } catch {
    /* ignore */
  }
}

function indexQueryString(query: { q: string; source: string }, cursor?: string): string {
  const params = new URLSearchParams();
  if (query.q.trim()) params.set("q", query.q.trim());
  if (query.source) params.set("source", query.source);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

function shownSources(page: KitchenIndex | null, selected: string): string[] {
  const present = new Set<string>(page?.sources ?? []);
  if (selected) present.add(selected);
  return [...present].filter(Boolean).sort();
}
