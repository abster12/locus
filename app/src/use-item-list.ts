import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { api, type ItemCard } from "./api.ts";
import { SHELVES, tagsForShelf } from "../../core/categories.ts";
import { LIBRARY_CHANGED_EVENT, notifyLibraryChanged } from "./library-events.ts";

type ItemListView = "recent" | "inbox" | "search" | "collection";

export type ItemListOptions = {
  view: ItemListView;
  collectionId?: string;
  initialQ?: string;
  initialShelf?: string;
};

type ItemListQuery = {
  view: ItemListView;
  source?: string;
  q?: string;
  collectionId?: string;
  shelf?: string;
};

type Counts = { total: number; inbox: number; shelves: Record<string, number> };
type ActionMessage = { kind: "ok" | "bad"; text: string };

function itemListQuery(filter: ItemListQuery, options: { cursor?: string; limit?: number } = {}): string {
  const params = new URLSearchParams();
  if (filter.view === "inbox") params.set("view", "inbox");
  if (filter.source) params.set("source", filter.source);
  if (filter.view === "search" && filter.q) params.set("q", filter.q);
  if (filter.collectionId) params.set("collectionId", filter.collectionId);
  if (filter.shelf) params.set("shelf", filter.shelf);
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  return params.toString();
}

function go(hash: string): void {
  location.hash = hash;
}

export type ItemListModel = {
  source: string;
  setSource: (source: string) => void;
  shelfKey: string;
  setShelf: (key: string) => void;
  theme: string;
  setTheme: (theme: string) => void;
  activeShelf: (typeof SHELVES)[number] | undefined;
  shelfTags: [string, number][];
  items: ItemCard[];
  counts: Counts;
  loading: boolean;
  err: string | null;
  tagMsg: string | null;
  tagging: boolean;
  statusBusy: Set<string>;
  statusMessages: Record<string, ActionMessage>;
  listMessage: ActionMessage | null;
  loadMoreRef: RefObject<HTMLDivElement | null>;
  onStatus: (id: string, status: string) => void;
  autoTag: () => void;
};

/**
 * Owns the Item list state machine: query identity, cancellation, cursor
 * pagination, optimistic status changes, and library-change reconciliation.
 * ItemList only renders this model and supplies the card interaction seam.
 */
export function useItemList({ view, collectionId, initialQ = "", initialShelf = "" }: ItemListOptions): ItemListModel {
  const [source, setSource] = useState("");
  const [shelfKey, setShelfKey] = useState(initialShelf);
  const [theme, setTheme] = useState("");
  const [items, setItems] = useState<ItemCard[]>([]);
  const [counts, setCounts] = useState<Counts>({ total: 0, inbox: 0, shelves: {} });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tagMsg, setTagMsg] = useState<string | null>(null);
  const [tagging, setTagging] = useState(false);
  const [statusBusy, setStatusBusy] = useState<Set<string>>(() => new Set());
  const [statusMessages, setStatusMessages] = useState<Record<string, ActionMessage>>({});
  const [listMessage, setListMessage] = useState<ActionMessage | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  useEffect(() => {
    setShelfKey(initialShelf);
  }, [initialShelf]);

  useEffect(() => {
    const onLibraryChange = (event: Event) => {
      const changed = (event as CustomEvent<ItemCard | undefined>).detail;
      if (!changed) {
        setReloadNonce((n) => n + 1);
        return;
      }
      const hide = changed.status === "archived" || changed.status === "rejected" || (view === "inbox" && changed.status !== "inbox");
      setItems((current) => hide ? current.filter((item) => item.id !== changed.id) : current.map((item) => item.id === changed.id ? changed : item));
    };
    window.addEventListener(LIBRARY_CHANGED_EVENT, onLibraryChange);
    return () => window.removeEventListener(LIBRARY_CHANGED_EVENT, onLibraryChange);
  }, [view]);

  const filterKey = `${view}|${source}|${shelfKey}|${initialQ}|${collectionId ?? ""}`;

  useEffect(() => {
    const filter = { view, source, q: initialQ, collectionId, shelf: shelfKey } satisfies ItemListQuery;
    const query = itemListQuery(filter, { limit: 50 });
    const controller = new AbortController();
    const id = ++requestId.current;
    setItems([]);
    setNextCursor(null);
    setCounts({ total: 0, inbox: 0, shelves: {} });
    setErr(null);
    setLoading(true);
    api.items(query, controller.signal)
      .then((r) => {
        if (id !== requestId.current) return;
        setItems(r.items ?? []);
        setNextCursor(r.nextCursor ?? null);
        setCounts(r.counts ?? { total: r.items?.length ?? 0, inbox: 0, shelves: {} });
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted || id !== requestId.current) return;
        setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
    return () => controller.abort();
  }, [filterKey, reloadNonce]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || !nextCursor || loading) return;
      const filter = { view, source, q: initialQ, collectionId, shelf: shelfKey } satisfies ItemListQuery;
      const query = itemListQuery(filter, { cursor: nextCursor, limit: 50 });
      const controller = new AbortController();
      const id = ++requestId.current;
      setLoading(true);
      api.items(query, controller.signal)
        .then((r) => {
          if (id !== requestId.current) return;
          setItems((current) => {
            const seen = new Set(current.map((item) => item.id));
            return [...current, ...(r.items ?? []).filter((item) => !seen.has(item.id))];
          });
          setNextCursor(r.nextCursor ?? null);
          if (r.counts) setCounts(r.counts);
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted && id === requestId.current) setErr(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (id === requestId.current) setLoading(false);
        });
      return () => controller.abort();
    }, { rootMargin: "600px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [nextCursor, loading, filterKey]);

  const activeShelf = SHELVES.find((s) => s.key === shelfKey);
  const shelfTags = useMemo(() => {
    if (!activeShelf) return [];
    const allowed = new Set(tagsForShelf(activeShelf.key));
    const m = new Map<string, number>();
    for (const it of items) {
      for (const t of it.tags) {
        if (!allowed.has(t.name)) continue;
        m.set(t.name, (m.get(t.name) ?? 0) + 1);
      }
    }
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [items, activeShelf]);

  const setShelf = (key: string) => {
    setShelfKey(key);
    setTheme("");
    if (view === "recent") go(key ? `#/recent?shelf=${encodeURIComponent(key)}` : "#/recent");
    if (view === "inbox") go(key ? `#/inbox?shelf=${encodeURIComponent(key)}` : "#/inbox");
  };

  const onStatus = (id: string, status: string) => {
    if (statusBusy.has(id)) return;
    const previous = items;
    setListMessage(null);
    setStatusBusy((current) => new Set(current).add(id));
    setStatusMessages((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    const shouldHide = status === "archived" || status === "rejected" || (view === "inbox" && status !== "inbox");
    setItems((current) => shouldHide ? current.filter((item) => item.id !== id) : current.map((item) => item.id === id ? { ...item, status: status as ItemCard["status"] } : item));
    api.status(id, status)
      .then((r) => {
        setItems((current) => shouldHide ? current : current.map((item) => item.id === id ? r.item : item));
        const message = status === "accepted" ? "Accepted" : status === "archived" ? "Archived" : "Saved";
        if (shouldHide) setListMessage({ kind: "ok", text: message });
        else setStatusMessages((current) => ({ ...current, [id]: { kind: "ok", text: message } }));
        notifyLibraryChanged(r.item);
        const filter = { view, source, q: initialQ, collectionId, shelf: shelfKey } satisfies ItemListQuery;
        api.itemCounts(itemListQuery(filter)).then((next) => setCounts(next.counts)).catch(() => {});
      })
      .catch((e: unknown) => {
        setItems(previous);
        const message = e instanceof Error ? e.message : String(e);
        if (shouldHide) setListMessage({ kind: "bad", text: message });
        else setStatusMessages((current) => ({ ...current, [id]: { kind: "bad", text: message } }));
      })
      .finally(() => setStatusBusy((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      }));
  };

  const autoTag = () => {
    setTagging(true);
    setTagMsg("Tagging saves…");
    api.autoTag()
      .then((r) => {
        setTagMsg(r.tagged > 0 ? `Tagged ${r.tagged} saves.` : "Everything already has tags.");
        if (r.tagged > 0) setReloadNonce((n) => n + 1);
      })
      .catch((e: unknown) => setTagMsg(e instanceof Error ? e.message : String(e)))
      .finally(() => setTagging(false));
  };

  const shown = items.filter((it) => !theme || it.tags.some((t) => t.name === theme));
  return {
    source, setSource, shelfKey, setShelf, theme, setTheme, activeShelf, shelfTags,
    items: shown, counts, loading, err, tagMsg, tagging, statusBusy, statusMessages,
    listMessage, loadMoreRef, onStatus, autoTag,
  };
}
