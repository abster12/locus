import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api, type ReadingPage as ReadingIndex, type ReadingSummary } from "./api.ts";
import { pubLabel } from "./item-content.ts";
import { SourceMark } from "./SourceMark.tsx";

type View = "queue" | "finished";
type Sort = "recent" | "oldest" | "shortest" | "longest" | "publication";

interface IndexQuery {
  view: View;
  q: string;
  sort: Sort;
  kind: string;
  source: string;
}

const INDEX_KEY = "locus-reading-index";
const EMPTY_QUERY: IndexQuery = {
  view: "queue",
  q: "",
  sort: "recent",
  kind: "",
  source: "",
};

export function ReadingPage() {
  return <ReadingIndexView />;
}

function ReadingIndexView() {
  const [query, setQuery] = useState<IndexQuery>(() => readIndexQuery());
  const [draftQ, setDraftQ] = useState(query.q);
  const [page, setPage] = useState<ReadingIndex | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [undo, setUndo] = useState<{ token: string; title: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const searchTimer = useRef<number | null>(null);

  useEffect(() => {
    writeIndexQuery(query);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    setPage(null);
    api
      .reading(queryString(query), controller.signal)
      .then((result) => {
        setPage(result);
        setErr(null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
  }, [query]);

  useLayoutEffect(() => {
    if (!page) return;
    const id = window.requestAnimationFrame(() => restoreScroll());
    return () => window.cancelAnimationFrame(id);
  }, [page]);

  useEffect(() => {
    const onPoint = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      for (const menu of document.querySelectorAll("details.reading-menu[open]")) {
        if (!menu.contains(target)) menu.removeAttribute("open");
      }
    };
    document.addEventListener("pointerdown", onPoint);
    return () => document.removeEventListener("pointerdown", onPoint);
  }, []);

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

  const counts = page?.counts;
  const hasFilters = Boolean(query.q || query.kind || query.source);
  const queueUnread = page?.unread.items ?? [];
  const unreadCount = page?.counts.unread ?? 0;
  const visibleCount =
    (page?.preparing.preview.length ?? 0) +
    queueUnread.length +
    (page?.items.length ?? 0);
  const total = counts ? counts.unread + counts.preparing + counts.finished : 0;
  const emptyLibrary = page && counts && total === 0 && !hasFilters;
  const queueCleared =
    page &&
    query.view === "queue" &&
    counts &&
    counts.unread === 0 &&
    counts.reading === 0 &&
    counts.preparing === 0 &&
    counts.finished > 0 &&
    !hasFilters;
  const noFilterMatches = page && hasFilters && visibleCount === 0;

  const loadMoreCursor = query.view === "queue" ? page?.unread.nextCursor : page?.nextCursor;

  async function loadMore(): Promise<void> {
    if (!loadMoreCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api.reading(queryString(query, loadMoreCursor));
      setPage((prev) => {
        if (!prev) return next;
        if (query.view === "queue") {
          return {
            ...next,
            preparing: prev.preparing,
            unread: { items: [...prev.unread.items, ...next.unread.items], nextCursor: next.unread.nextCursor },
          };
        }
        return { ...next, items: [...prev.items, ...next.items] };
      });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  function patch(partial: Partial<IndexQuery>): void {
    setQuery((prev) => ({ ...prev, ...partial }));
  }

  async function onRemove(doc: ReadingSummary): Promise<void> {
    setBusyId(doc.id);
    try {
      const result = await api.removeReading(doc.id);
      setUndo({ token: result.undoToken, title: doc.title });
      setQuery((prev) => ({ ...prev }));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function onProgress(doc: ReadingSummary, op: "unread" | "finished"): Promise<void> {
    setBusyId(doc.id);
    try {
      await api.readingProgress(doc.id, { op });
      setQuery((prev) => ({ ...prev }));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  function onOpened(doc: ReadingSummary): void {
    if (doc.progress?.state === "finished") return;
    const already = doc.progress?.state === "reading";
    void api.readingProgress(doc.id, { op: "advance" }).then((result) => {
      const progress = result.progress;
      if (!progress) return;
      setPage((prev) => {
        if (!prev) return prev;
        const patch = (row: ReadingSummary): ReadingSummary =>
          row.id === doc.id ? { ...row, progress: { state: progress.state, progress: progress.progress } } : row;
        return {
          ...prev,
          unread: { ...prev.unread, items: prev.unread.items.map(patch) },
          items: prev.items.map(patch),
          counts: already ? prev.counts : { ...prev.counts, reading: prev.counts.reading + 1 },
        };
      });
    }, () => {});
  }

  async function onRetry(doc: ReadingSummary): Promise<void> {
    setBusyId(doc.id);
    try {
      await api.retryReading(doc.id);
      setQuery((prev) => ({ ...prev }));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="reading-page">
      <section className="reading-index">
        <div className="pagehead">
          <h1>Reading</h1>
          {counts ? (
            <span className="count">
              {counts.unread} unread
              {counts.reading ? ` · ${counts.reading} opened` : ""}
              {counts.preparing ? ` · ${counts.preparing} preparing` : ""}
              {` · ${counts.finished} finished`}
            </span>
          ) : null}
        </div>
        <p className="pagesub">A queue of writing saved from your library. Locus never pretends a blocked page is an article.</p>
        <div className="reading-controls">
          <label className="reading-search">
            <span className="visually-hidden">Search reading</span>
            <input
              type="search"
              value={draftQ}
              placeholder="Search reading"
              onChange={(e) => {
                const value = e.target.value;
                setDraftQ(value);
                if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
                searchTimer.current = window.setTimeout(() => patch({ q: value }), 250);
              }}
            />
          </label>
          <div className="sorter" role="radiogroup" aria-label="Reading view">
            {(["queue", "finished"] as const).map((view) => (
              <button
                key={view}
                type="button"
                role="radio"
                aria-checked={query.view === view}
                className={query.view === view ? "active" : ""}
                onClick={() => patch({ view })}
              >
                {view === "queue" ? "Unread" : "Finished"}
              </button>
            ))}
          </div>
          <label className="reading-sort">
            <span className="visually-hidden">Sort reading</span>
            <select value={query.sort} onChange={(e) => patch({ sort: e.target.value as Sort })}>
              <option value="recent">Recently saved</option>
              <option value="oldest">Oldest saved</option>
              <option value="shortest">Shortest first</option>
              <option value="longest">Longest first</option>
              <option value="publication">Publication</option>
            </select>
          </label>
          <button
            type="button"
            className="reading-filter-toggle"
            aria-expanded={filtersOpen}
            aria-controls="reading-filters"
            onClick={() => setFiltersOpen((open) => !open)}
          >
            Filters
          </button>
        </div>
        {err ? (
          <p className="bad" role="alert">
            {err}{" "}
            <button type="button" className="btn" onClick={() => setQuery((prev) => ({ ...prev }))}>
              Retry
            </button>
          </p>
        ) : null}
        <div aria-live="polite" className="quiet">
          {!page && !err ? "Loading reading…" : null}
        </div>
        {undo ? (
          <p className="reading-undo" role="status">
            Removed “{undo.title}”.{" "}
            <button
              type="button"
              className="btn"
              onClick={() => {
                api
                  .undoRemoveReading(undo.token)
                  .then(() => {
                    setUndo(null);
                    setQuery((prev) => ({ ...prev }));
                  })
                  .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
              }}
            >
              Undo
            </button>
          </p>
        ) : null}
        {emptyLibrary ? (
          <p className="empty">
            No readable links yet. Articles linked from future captures will appear here.{" "}
            <a href="#/recent">Desk</a> · <a href="#/sources">Sources</a>
          </p>
        ) : null}
        {queueCleared ? (
          <p className="empty">
            Queue cleared. <button type="button" className="btn" onClick={() => patch({ view: "finished" })}>Finished</button> ·{" "}
            <a href="#/recent">Desk</a>
          </p>
        ) : null}
        {noFilterMatches ? (
          <p className="empty">
            No reading matches these filters.{" "}
            <button type="button" className="btn" onClick={() => { setDraftQ(""); setQuery({ ...EMPTY_QUERY, view: query.view }); }}>
              Clear filters
            </button>
          </p>
        ) : null}
        {query.view === "queue" && page && queueUnread.length ? (
          <ReadingSection title="Unread" count={unreadCount}>
            {queueUnread.map((doc) => (
              <ReadingRow
                key={doc.id}
                doc={doc}
                busy={busyId === doc.id}
                onRemove={onRemove}
                onProgress={onProgress}
                onOpened={onOpened}
                onRetry={onRetry}
              />
            ))}
          </ReadingSection>
        ) : null}
        {query.view === "finished" && page?.items.length ? (
          <ReadingSection title="Finished" count={page.items.length}>
            {page.items.map((doc) => (
              <ReadingRow
                key={doc.id}
                doc={doc}
                busy={busyId === doc.id}
                onRemove={onRemove}
                onProgress={onProgress}
                onOpened={onOpened}
                onRetry={onRetry}
              />
            ))}
          </ReadingSection>
        ) : null}
        {loadMoreCursor ? (
          <p className="load-more">
            <button type="button" className="btn" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </p>
        ) : null}
      </section>
      <aside
        className={`reading-rail${filtersOpen ? " filters-open" : ""}${query.view === "queue" && page?.preparing.count ? " has-prep" : ""}`}
      >
        <ReadingFilters id="reading-filters" query={query} onChange={patch} />
        {query.view === "queue" && page?.preparing.count ? (
          <section className="reading-sec reading-prep-sec">
            <h2>
              Preparing <span className="count">{page.preparing.count}</span>
            </h2>
            <ul className="reading-prep-list">
              {page.preparing.preview.map((doc) => (
                <PreparingRow key={doc.id} doc={doc} />
              ))}
            </ul>
          </section>
        ) : null}
      </aside>
    </div>
  );
}

function ReadingFilters({
  id,
  query,
  onChange,
}: {
  id: string;
  query: IndexQuery;
  onChange: (partial: Partial<IndexQuery>) => void;
}) {
  return (
    <aside id={id} className="reading-filters">
      <h2>Filters</h2>
      <label>
        Kind
        <select value={query.kind} onChange={(e) => onChange({ kind: e.target.value })}>
          <option value="">Any</option>
          <option value="article">Article</option>
          <option value="documentation">Documentation</option>
          <option value="repository">Repository</option>
        </select>
      </label>
      <label>
        Source
        <select value={query.source} onChange={(e) => onChange({ source: e.target.value })}>
          <option value="">Any</option>
          <option value="x">X</option>
          <option value="instagram">Instagram</option>
          <option value="youtube">YouTube</option>
          <option value="reddit">Reddit</option>
        </select>
      </label>
    </aside>
  );
}

function ReadingSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="reading-sec">
      <h2>
        {title} <span className="count">{count}</span>
      </h2>
      <ul className="reading-list">{children}</ul>
    </section>
  );
}

function PreparingRow({ doc }: { doc: ReadingSummary }) {
  return (
    <li>
      <article className="reading-row reading-prep">
        <div>
          <span className="reading-title">{doc.title}</span>
          <p className="reading-skel" aria-hidden="true" />
          <p className="reading-meta">
            <span>{doc.publication || doc.host}</span>
            <span className="reading-avail">◌ Preparing saved copy</span>
          </p>
        </div>
      </article>
    </li>
  );
}

function ReadingRow({
  doc,
  busy,
  onRemove,
  onProgress,
  onOpened,
  onRetry,
}: {
  doc: ReadingSummary;
  busy: boolean;
  onRemove: (doc: ReadingSummary) => void;
  onProgress: (doc: ReadingSummary, op: "unread" | "finished") => void;
  onOpened: (doc: ReadingSummary) => void;
  onRetry: (doc: ReadingSummary) => void;
}) {
  const availability = availabilityLabel(doc);
  return (
    <li>
      <article className="reading-row">
        <div className="reading-card-acts">
          {doc.progress?.state !== "finished" ? (
            <button
              type="button"
              className="reading-done"
              title="Mark finished"
              aria-label="Mark finished"
              disabled={busy}
              onClick={() => onProgress(doc, "finished")}
            >
              ✓
            </button>
          ) : null}
        <details className="reading-menu">
          <summary aria-label="Actions">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <circle cx="12" cy="5" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="12" cy="19" r="2" />
            </svg>
          </summary>
          <div className="reading-menu-list" onClick={(event) => {
            if ((event.target as HTMLElement).closest("button, a")) {
              event.currentTarget.closest("details")?.removeAttribute("open");
            }
          }}>
            {doc.progress?.state === "finished" || doc.progress?.state === "reading" ? (
              <button type="button" disabled={busy} onClick={() => onProgress(doc, "unread")}>
                Mark unread
              </button>
            ) : null}
            <button type="button" disabled={busy} onClick={() => onRemove(doc)}>
              Remove from Reading
            </button>
            {canOpenOriginal(doc) ? (
              <ExternalLink href={doc.canonicalUrl}>Open original in a new tab</ExternalLink>
            ) : null}
            {doc.originalStatus !== "gone" ? (
              doc.availability === "ready" ? (
                <button type="button" disabled={busy} onClick={() => onRetry(doc)}>
                  Refresh saved copy
                </button>
              ) : doc.failureCode !== "gone" && doc.availability !== "pending" ? (
                <button type="button" disabled={busy} onClick={() => onRetry(doc)}>
                  Retry
                </button>
              ) : null
            ) : null}
          </div>
        </details>
        </div>
        <CardLink doc={doc} onOpen={onOpened}>
          {doc.heroAssetId ? (
            <img className="reading-thumb" src={`/api/reading/${doc.id}/assets/${doc.heroAssetId}`} alt="" />
          ) : null}
          <div>
            <span className="reading-title">{doc.title}</span>
            {doc.subtitle || doc.excerpt ? <p className="reading-excerpt">{doc.subtitle || doc.excerpt}</p> : null}
            <p className="reading-meta">
              {doc.progress?.state === "reading" ? <span className="reading-opened">Opened</span> : null}
              {doc.byline ? <span>{doc.byline}</span> : null}
              <span>{doc.publication || doc.host}</span>
              <span>{kindLabel(doc.kind)}</span>
              {doc.readingMinutes ? <span>{doc.readingMinutes} min</span> : null}
              <span>{pubLabel(doc.lastSavedAt)}</span>
              {doc.savedCount > 1 ? <span>Saved {doc.savedCount} times</span> : null}
              {doc.sources.map((source) => (
                <SourceMark key={source} source={source} named={doc.sources.length < 3} />
              ))}
              {availability ? (
                <span className="reading-avail">
                  {availability.icon} {availability.text}
                </span>
              ) : null}
            </p>
          </div>
        </CardLink>
      </article>
    </li>
  );
}

function availabilityLabel(doc: ReadingSummary): { icon: string; text: string } | null {
  if (doc.availability === "pending") return { icon: "◌", text: "Preparing saved copy" };
  return null;
}

function queryString(query: IndexQuery, cursor?: string): string {
  const params = new URLSearchParams();
  params.set("view", query.view);
  if (query.q.trim()) params.set("q", query.q.trim());
  if (query.sort !== "recent") params.set("sort", query.sort);
  if (query.kind) params.set("kind", query.kind);
  if (query.source) params.set("source", query.source);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

function readIndexQuery(): IndexQuery {
  try {
    const raw = sessionStorage.getItem(INDEX_KEY);
    if (!raw) return { ...EMPTY_QUERY };
    const value = JSON.parse(raw) as Partial<IndexQuery>;
    return {
      view: value.view === "finished" ? "finished" : "queue",
      q: typeof value.q === "string" ? value.q : "",
      sort:
        value.sort === "oldest" || value.sort === "shortest" || value.sort === "longest" || value.sort === "publication"
          ? value.sort
          : "recent",
      kind: typeof value.kind === "string" ? value.kind : "",
      source: typeof value.source === "string" ? value.source : "",
    };
  } catch {
    return { ...EMPTY_QUERY };
  }
}

function writeIndexQuery(query: IndexQuery): void {
  try {
    sessionStorage.setItem(INDEX_KEY, JSON.stringify(query));
  } catch {
    /* ignore */
  }
}

function restoreScroll(): void {
  try {
    const raw = sessionStorage.getItem(`${INDEX_KEY}:scroll`);
    const top = raw ? Number(raw) : 0;
    if (Number.isFinite(top) && top > 0) window.scrollTo(0, top);
  } catch {
    /* ignore */
  }
}

function canOpenOriginal(doc: ReadingSummary): boolean {
  return doc.originalStatus !== "gone" && doc.failureCode !== "gone" && doc.failureCode !== "unsafe_target";
}

function kindLabel(kind: string): string {
  if (kind === "documentation") return "Documentation";
  if (kind === "repository") return "Repository";
  if (kind === "pdf") return "PDF";
  if (kind === "unknown") return "Unknown";
  return "Article";
}

function safeHttpUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function CardLink({
  doc,
  children,
  onOpen,
}: {
  doc: ReadingSummary;
  children: ReactNode;
  onOpen?: (doc: ReadingSummary) => void;
}) {
  const href = canOpenOriginal(doc) ? safeHttpUrl(doc.canonicalUrl) : null;
  if (!href) return <div className="reading-open">{children}</div>;
  return (
    <a
      className="reading-open"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${doc.title} (opens in a new tab)`}
      onClick={() => onOpen?.(doc)}
    >
      {children}
    </a>
  );
}

function ExternalLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const safe = safeHttpUrl(href);
  if (!safe) return <>{children}</>;
  return (
    <a href={safe} className={className} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
