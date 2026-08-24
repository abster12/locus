import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  api,
  boot,
  type Collection,
  type ItemCard,
  type LinkPreview,
  type SourceGroup,
  type SourceHealth,
  type SourceId,
  type SummarySnapshot,
} from "./api.ts";
import { isPlatformPermalink, isReadingItem, isStageOutbound, outboundUrls, youtubeVideoId } from "../../core/sanitize.ts";
import { SHELVES, shelfOfTag, shelvesWithCounts, tagsForShelf } from "../../core/categories.ts";
import { detectPlaces, REGIONS, regionByName, type PlaceHit, type Region } from "../../core/places.ts";
import { motif, motifIcon } from "./motifs.ts";
import { sourceIcon, sourceLabel } from "./source-icons.ts";

type Route =
  | { name: "recent"; shelf: string }
  | { name: "inbox"; shelf: string }
  | { name: "search"; q: string }
  | { name: "collections" }
  | { name: "collection"; id: string }
  | { name: "sources" }
  | { name: "reading" }
  | { name: "atlas" }
  | { name: "shelves" }
  | { name: "summary"; scope: "day" | "collection"; ref: string };

function parseHash(): Route {
  const raw = location.hash.replace(/^#/, "") || "/recent";
  const [path, qs] = raw.split("?");
  const parts = (path || "").split("/").filter(Boolean);
  const q = new URLSearchParams(qs || "");
  const a = parts[0];
  const b = parts[1];
  const shelf = q.get("shelf") || "";
  if (a === "inbox") return { name: "inbox", shelf };
  if (a === "search") return { name: "search", q: q.get("q") || "" };
  if (a === "collections" && b) return { name: "collection", id: b };
  if (a === "collections") return { name: "collections" };
  if (a === "sources") return { name: "sources" };
  if (a === "reading") return { name: "reading" };
  if (a === "atlas") return { name: "atlas" };
  if (a === "shelves") return { name: "shelves" };
  if (a === "summary" && parts[1] === "day") return { name: "summary", scope: "day", ref: parts[2] || today() };
  if (a === "summary" && parts[1] === "collection" && parts[2]) return { name: "summary", scope: "collection", ref: parts[2] };
  return { name: "recent", shelf };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function go(hash: string): void {
  location.hash = hash;
}

function readStoredTheme(): "light" | "dark" | null {
  try {
    const s = localStorage.getItem("locus-theme");
    if (s === "dark" || s === "light") return s;
  } catch {
    /* ignore */
  }
  return null;
}

function systemTheme(): "light" | "dark" {
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inbox, setInbox] = useState<number | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() => readStoredTheme() ?? systemTheme());
  const [stageItem, setStageItem] = useState<ItemCard | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    boot()
      .then(() => setReady(true))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (ready) api.items("view=inbox").then((r) => setInbox(r.items.length)).catch(() => {});
  }, [ready]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (!readStoredTheme()) setTheme(mq.matches ? "dark" : "light");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const searchValue = route.name === "search" ? route.q : "";
  const deskActive = route.name === "recent" || route.name === "inbox";

  if (error) {
    return (
      <div className="shell">
        <p className="bad">{error}</p>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="shell">
        <p className="quiet">Opening the desk…</p>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="masthead">
        <div>
          <p className="wordmark">Locus</p>
          <p className="lede">A local desk for the things you already saved. No model required.</p>
        </div>
        <div className="mast-right">
          <div className="datebox">
            <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.6" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 3v3M12 18v3M3 12h3M18 12h3M12 8l1.8 4L12 16l-1.8-4z" />
            </svg>
            <span>{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</span>
            <a href={`#/summary/day/${today()}`}>Today’s summary</a>
          </div>
          <div className="mast-row">
            <label className="globalsearch">
              <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                ref={searchRef}
                type="search"
                placeholder="Search everything — titles, bodies, notes, tags"
                value={searchValue}
                onChange={(e) => go(`#/search?q=${encodeURIComponent(e.target.value)}`)}
              />
              <kbd>/</kbd>
            </label>
            <button
              type="button"
              className="themebtn"
              title="Toggle dark mode"
              aria-label="Toggle dark mode"
              onClick={() => {
                const next = theme === "dark" ? "light" : "dark";
                try {
                  localStorage.setItem("locus-theme", next);
                } catch {
                  /* ignore */
                }
                setTheme(next);
              }}
            >
              <span className="ico" dangerouslySetInnerHTML={{ __html: theme === "dark" ? SUN : MOON }} />
            </button>
          </div>
        </div>
      </header>
      <CaptureBanner />
      <nav className="tabs">
        <Tab href="#/recent" active={deskActive}>
          Desk
          {inbox ? (
            <span
              className="badge"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                go("#/inbox");
              }}
            >
              {inbox}
            </span>
          ) : null}
        </Tab>
        <Tab href="#/reading" active={route.name === "reading"}>
          Reading
        </Tab>
        <Tab href="#/atlas" active={route.name === "atlas"}>
          Atlas
        </Tab>
        <Tab href="#/shelves" active={route.name === "shelves"}>
          Shelves
        </Tab>
        <Tab href="#/sources" active={route.name === "sources"}>
          Sources
        </Tab>
      </nav>
      {route.name === "recent" && <ItemList view="recent" initialShelf={route.shelf} onOpen={setStageItem} />}
      {route.name === "inbox" && <ItemList view="inbox" initialShelf={route.shelf} onOpen={setStageItem} />}
      {route.name === "search" && <ItemList view="search" initialQ={route.q} onOpen={setStageItem} />}
      {route.name === "collections" && <CollectionsPage />}
      {route.name === "collection" && <ItemList view="collection" collectionId={route.id} onOpen={setStageItem} />}
      {route.name === "sources" && <SourcesPage />}
      {route.name === "reading" && <ReadingPage onOpen={setStageItem} />}
      {route.name === "atlas" && <AtlasPage onOpen={setStageItem} />}
      {route.name === "shelves" && <ShelvesPage />}
      {route.name === "summary" && <SummaryPage scope={route.scope} scopeRef={route.ref} />}
      <Stage item={stageItem} onClose={() => setStageItem(null)} />
    </div>
  );
}

const SUN = `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></svg>`;
const MOON = `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>`;

function CaptureBanner() {
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const d = await api.sources();
        const waiting = d.sources.flatMap((g) => g.accounts).find((a) => a.running && a.progress?.phase === "waiting-login");
        if (!alive) return;
        setLine(waiting ? waiting.progress?.message ?? null : null);
      } catch {
        if (alive) setLine(null);
      }
    }
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  if (!line) return null;
  return (
    <div className="banner">
      {line} <a href="#/sources">Open Sources</a> and log in in the Chrome window Locus opened — not your everyday Chrome.
    </div>
  );
}

function Tab({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <a href={href} className={active ? "active" : undefined}>
      {children}
    </a>
  );
}

function SourceMark({ source, named = true }: { source: string; named?: boolean }) {
  const name = sourceLabel(source);
  return (
    <span className={`sourcemark src-${source}`} title={name}>
      <span className="ico" dangerouslySetInnerHTML={{ __html: sourceIcon(source) }} />
      {named ? <span className="sourcemark-name">{name}</span> : null}
    </span>
  );
}

function who(item: ItemCard): string {
  const h = item.authorHandle?.replace(/^@/, "");
  if (h) return h.includes("/") ? h : `@${h}`;
  return item.authorName || "";
}

function firstVisual(item: ItemCard): { kind: string; url: string } | null {
  let pics = (item.media || []).filter((m) => m.kind === "image" || m.kind === "video");
  pics = pics.filter((m) => !/t51\.2885-19|s150x150|s206x206|s50x50|cdn\.fbsbx\.com/i.test(m.url));
  if (item.source === "instagram") pics = pics.slice(0, 1);
  return pics[0] ?? null;
}

function MotifSvg({ name, icon }: { name: string; icon?: boolean }) {
  return <span dangerouslySetInnerHTML={{ __html: icon ? motifIcon(name) : motif(name) }} />;
}

function Poster({ color, ink, motifName, word }: { color: string; ink: string; motifName: string; word: string }) {
  return (
    <div className="media poster" style={{ ["--pbg" as string]: color, ["--pfg" as string]: ink } as CSSProperties}>
      <MotifSvg name={motifName} />
      <span className="poster-word">{word}</span>
    </div>
  );
}

function CapturedMedia({ item }: { item: ItemCard }) {
  const m = firstVisual(item);
  if (!m) return null;
  return (
    <div className="media">
      {m.kind === "video" ? (
        <video src={m.url} muted playsInline preload="metadata" />
      ) : (
        <img src={m.url} alt="" referrerPolicy="no-referrer" />
      )}
    </div>
  );
}

function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function Avatar({ item }: { item: ItemCard }) {
  const name = (item.authorName || item.authorHandle || "?").replace(/^@/, "").trim();
  return <span className="avatar">{name.charAt(0).toUpperCase() || "?"}</span>;
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

function pathOf(u: string): string {
  try {
    const p = new URL(u).pathname.replace(/\/$/, "");
    return p.length > 46 ? p.slice(0, 46) + "…" : p;
  } catch {
    return "";
  }
}

const URL_RE = /https?:\/\/[^\s)>"']+/g;

function extractLinks(body: string | null): { text: string; links: string[] } {
  if (!body) return { text: "", links: [] };
  const norm = body.replace(/(https?:\/\/)\s+/g, "$1");
  const links = [...new Set(norm.match(URL_RE) ?? [])].slice(0, 3);
  const text = norm
    .replace(URL_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { text, links };
}

function previewUrls(item: ItemCard): { text: string; links: string[] } {
  const extracted = extractLinks(item.body);
  if (isPlatformPermalink(item.url)) {
    const text = (item.body || "").replace(/(https?:\/\/)\s+/g, "$1").trim();
    return { text, links: extracted.links.filter((u) => u !== item.url) };
  }
  if (extracted.links.length) return extracted;
  return { ...extracted, links: [item.url] };
}

function cardTitle(item: ItemCard): string | null {
  if (item.title) return item.title;
  if (/instagram\.com\/reel\//i.test(item.url)) return "Reel";
  if (/instagram\.com\/p\//i.test(item.url)) return "Post";
  return null;
}

function usefulPreview(p: LinkPreview, url: string): boolean {
  if (p.status !== "ok" || !(p.title || p.description)) return false;
  const t = (p.title || "").trim().toLowerCase();
  return t !== hostOf(url) && t !== "reddit" && t !== "instagram" && t !== "x" && t !== "youtube";
}

function useLinkPreview(url: string | null): { preview: LinkPreview | null; done: boolean } {
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [done, setDone] = useState(!url);
  useEffect(() => {
    if (!url) {
      setPreview(null);
      setDone(true);
      return;
    }
    let alive = true;
    setDone(false);
    setPreview(null);
    api
      .linkPreview(url)
      .then((r) => {
        if (alive) setPreview(r.preview);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setDone(true);
      });
    return () => {
      alive = false;
    };
  }, [url]);
  return { preview, done };
}

function LinkCards({ links }: { links: string[] }) {
  if (links.length === 0) return null;
  return (
    <div className="linkcards">
      {links.map((u) => (
        <LinkPreviewCard key={u} url={u} />
      ))}
    </div>
  );
}

function LinkPreviewCard({ url }: { url: string }) {
  const { preview: p } = useLinkPreview(url);
  const host = hostOf(url);
  const mono = (
    <span className="lc-mono" style={{ ["--h" as string]: hueFor(host) }}>
      {host.charAt(0).toUpperCase()}
    </span>
  );
  if (p && usefulPreview(p, url)) {
    return (
      <a className="linkcard rich" href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
        {p.image ? <img className="lc-img" src={p.image} alt="" referrerPolicy="no-referrer" loading="lazy" /> : mono}
        <span className="lc-text">
          <span className="lc-host">{p.siteName || host}</span>
          {p.title ? <span className="lc-title">{p.title}</span> : null}
          {p.description ? <span className="lc-desc">{p.description}</span> : null}
        </span>
        <span className="lc-arrow">↗</span>
      </a>
    );
  }
  return (
    <a className="linkcard" href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
      {mono}
      <span className="lc-text">
        <span className="lc-host">{host}</span>
        {pathOf(url) ? <span className="lc-path">{pathOf(url)}</span> : null}
      </span>
      <span className="lc-arrow">↗</span>
    </a>
  );
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function wallAt(item: ItemCard): string | null {
  return item.publishedAt;
}

function dayHeading(key: string): string {
  if (key === "undated") return "Undated";
  if (key === localDay(new Date())) return "Today";
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (key === localDay(y)) return "Yesterday";
  return new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function sortAt(item: ItemCard): string {
  return item.publishedAt || item.firstObservedAt;
}

function pubLabel(iso: string | null): string {
  if (!iso) return "Undated";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function groupByDay(items: ItemCard[]): [string, ItemCard[]][] {
  const groups = new Map<string, ItemCard[]>();
  for (const it of items) {
    const at = wallAt(it);
    const key = at ? localDay(new Date(at)) : "undated";
    const arr = groups.get(key);
    if (arr) arr.push(it);
    else groups.set(key, [it]);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => sortAt(b).localeCompare(sortAt(a)));
  }
  return [...groups].sort((a, b) => {
    if (a[0] === "undated") return 1;
    if (b[0] === "undated") return -1;
    return b[0].localeCompare(a[0]);
  });
}

function ItemList({
  view,
  collectionId,
  initialQ = "",
  initialShelf = "",
  onOpen,
}: {
  view: "recent" | "inbox" | "search" | "collection";
  collectionId?: string;
  initialQ?: string;
  initialShelf?: string;
  onOpen: (item: ItemCard) => void;
}) {
  const [source, setSource] = useState<string>("");
  const [shelfKey, setShelfKey] = useState(initialShelf);
  const [theme, setTheme] = useState<string>("");
  const [items, setItems] = useState<ItemCard[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [tagMsg, setTagMsg] = useState<string | null>(null);
  const [tagging, setTagging] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setShelfKey(initialShelf);
  }, [initialShelf]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (view === "inbox") params.set("view", "inbox");
    if (source) params.set("source", source);
    if (view === "search" && initialQ) params.set("q", initialQ);
    if (collectionId) params.set("collectionId", collectionId);
    api
      .items(params.toString())
      .then((r) => setItems(r.items))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, [view, source, initialQ, collectionId, nonce]);

  const counts = useMemo(
    () => shelvesWithCounts(items.map((it) => ({ tags: it.tags.map((t) => t.name) }))),
    [items],
  );

  const shown = items.filter((it) => {
    if (theme) return it.tags.some((t) => t.name === theme);
    if (shelfKey) return it.tags.some((t) => shelfOfTag(t.name).key === shelfKey);
    return true;
  });

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
    api.status(id, status).then((r) =>
      setItems((cur) =>
        view === "inbox" && status !== "inbox" ? cur.filter((i) => i.id !== id) : cur.map((i) => (i.id === id ? r.item : i)),
      ),
    );
  };

  return (
    <section>
      <div className="desk">
        <aside className="rail">
          <p className="rail-label">Shelves</p>
          <button type="button" className={`shelfbtn ${shelfKey ? "" : "active"}`} style={{ ["--c" as string]: "var(--ink)" }} onClick={() => setShelf("")}>
            <span className="dot" />
            <span className="nm">All saves</span>
            <span className="n">{items.length}</span>
          </button>
          {counts.map(({ shelf, count }) => (
            <button
              key={shelf.key}
              type="button"
              className={`shelfbtn ${shelfKey === shelf.key ? "active" : ""}`}
              style={{ ["--c" as string]: shelf.color }}
              onClick={() => setShelf(shelfKey === shelf.key ? "" : shelf.key)}
            >
              <span className="dot" />
              <span className="nm">{shelf.name}</span>
              <span className="n">{count}</span>
            </button>
          ))}
          <p className="rail-foot">Cards show the photo you captured when there is one. The flat poster is the fallback for text-only saves — it never replaces a real image.</p>
        </aside>
        <div>
          <div className="toolbar">
            <div className="filters">
              {["", "x", "instagram", "youtube", "reddit"].map((s) => (
                <button key={s || "all"} className={`chip ${s ? `src-${s}` : ""} ${source === s ? "active" : ""}`} onClick={() => setSource(s)}>
                  {s ? <span className="ico" dangerouslySetInnerHTML={{ __html: sourceIcon(s) }} /> : null}
                  {s ? sourceLabel(s) : "All"}
                </button>
              ))}
              <button
                className="chip copper autotag"
                disabled={tagging}
                title="Sends untagged saves to your Pi-connected model. User-chosen extra."
                onClick={() => {
                  setTagging(true);
                  setTagMsg("Talking to your Pi login… this can take a minute.");
                  api
                    .autoTag()
                    .then((r) => {
                      setTagMsg(r.tagged > 0 ? `Pi tagged ${r.tagged} saves.` : "Everything already has tags.");
                      if (r.tagged > 0) setNonce((n) => n + 1);
                    })
                    .catch((e: unknown) => setTagMsg(e instanceof Error ? e.message : String(e)))
                    .finally(() => setTagging(false));
                }}
              >
                {tagging ? "Tagging…" : "Auto-tag"}
              </button>
            </div>
          </div>
          {activeShelf && (
            <div className="ctx-tags">
              <span className="lbl">Inside {activeShelf.name} ·</span>
              {shelfTags.map(([name, n]) => (
                <button key={name} type="button" className={`tchip ${theme === name ? "active" : ""}`} onClick={() => setTheme(theme === name ? "" : name)}>
                  {name} · {n}
                </button>
              ))}
              <button type="button" className="ctx-clear" onClick={() => setShelf("")}>
                clear
              </button>
            </div>
          )}
          {tagMsg && <p className="quiet">{tagMsg}</p>}
          {err && <p className="bad">{err}</p>}
          {shown.length === 0 ? (
            <p className="empty">{view === "inbox" ? "Inbox zero. Nothing waiting." : "Nothing on the blotter."}</p>
          ) : (
            <div className="wall">
              {groupByDay(shown).map(([day, list]) => (
                <Fragment key={day}>
                  <h2 className="day-head">{dayHeading(day)}</h2>
                  {list.map((item) => (
                    <PostCard key={item.id} item={item} onStatus={onStatus} onTag={setTheme} onOpen={onOpen} />
                  ))}
                </Fragment>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function needsMore(text: string): boolean {
  return text.length > 240 || (text.match(/\n/g)?.length ?? 0) >= 5;
}

function Excerpt({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const more = needsMore(text);
  return (
    <>
      <p className={open || !more ? "excerpt open" : "excerpt"}>{text}</p>
      {more && !open ? (
        <button
          type="button"
          className="more"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }}
        >
          Read more
        </button>
      ) : null}
    </>
  );
}

function ReadingSummary({ id }: { id: string }) {
  const [prose, setProse] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        type="button"
        className="more"
        disabled={busy}
        title="Uses your Pi login. User-chosen extra."
        onClick={() => {
          setBusy(true);
          setErr(null);
          api
            .prose("item", id)
            .then((r) => setProse(r.prose.prose))
            .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Summarizing…" : prose ? "Again" : "Summary"}
      </button>
      {err ? <p className="quiet">{err}</p> : null}
      {prose ? <p className="excerpt open">{prose}</p> : null}
    </>
  );
}

function deskPoster(item: ItemCard): { color: string; ink: string; motifName: string; word: string } {
  const first = item.tags[0];
  const shelf = first ? shelfOfTag(first.name) : shelfOfTag("else");
  return {
    color: shelf.color,
    ink: "#f2f3f0",
    motifName: shelf.motif,
    word: first?.name || "save",
  };
}

function PostCard({ item, onStatus, onTag, onOpen }: { item: ItemCard; onStatus: (id: string, status: string) => void; onTag: (name: string) => void; onOpen: (item: ItemCard) => void }) {
  const { text, links } = previewUrls(item);
  const title = cardTitle(item);
  const showTitle = Boolean(title && (!text || !text.startsWith(title.slice(0, 40))));
  const reading = isReadingItem(item.body, item.url);
  const visual = firstVisual(item);
  return (
    <article
      className={`post src-${item.source}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button")) return;
        onOpen(item);
      }}
    >
      <header className="byline">
        <Avatar item={item} />
        <div className="by-who">
          <span className="handle">{who(item) || hostOf(item.url)}</span>
          <span className="by-date">{pubLabel(wallAt(item))}</span>
        </div>
        <SourceMark source={item.source} />
      </header>
      {showTitle ? <h3>{title}</h3> : null}
      {text ? <Excerpt text={text} /> : null}
      {visual ? <CapturedMedia item={item} /> : links.length ? <LinkCards links={links} /> : <Poster {...deskPoster(item)} />}
      {visual ? <LinkCards links={links} /> : null}
      <footer className="post-foot">
        <div className="tags">
          {item.tags.map((t) => (
            <button key={t.id} type="button" className="tag" onClick={() => onTag(t.name)}>
              {t.name}
            </button>
          ))}
          {reading ? <ReadingSummary id={item.id} /> : null}
        </div>
        <div className="acts">
          <button type="button" title="Accept" onClick={() => onStatus(item.id, "accepted")}>
            ✓
          </button>
          <button type="button" title="Archive" onClick={() => onStatus(item.id, "archived")}>
            ⌄
          </button>
          <a title="Open original" href={item.url} target="_blank" rel="noopener noreferrer">
            ↗
          </a>
        </div>
      </footer>
    </article>
  );
}

function savedFrom(source: string): string {
  return `saved from ${sourceLabel(source)}`;
}

function readingTarget(item: ItemCard): string | undefined {
  return outboundUrls(item.body, item.url)[0];
}

function ReadingPage({ onOpen }: { onOpen: (item: ItemCard) => void }) {
  const [items, setItems] = useState<ItemCard[]>([]);
  const [sort, setSort] = useState<"pub" | "date">("pub");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .items("")
      .then((r) => setItems(r.items.filter((it) => isReadingItem(it.body, it.url))))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const rows = items.flatMap((item) => {
    const url = readingTarget(item);
    if (!url) return [];
    return [{ item, url, host: hostOf(url) }];
  });
  const pubs = new Set(rows.map((r) => r.host)).size;

  return (
    <section>
      <div className="pagehead">
        <h2>The reading pile</h2>
        <span className="count">
          {rows.length} clipping{rows.length === 1 ? "" : "s"} · {pubs} publication{pubs === 1 ? "" : "s"}
        </span>
        <div className="sorter" role="group" aria-label="Sort reading pile">
          <button type="button" className={sort === "pub" ? "active" : ""} onClick={() => setSort("pub")}>
            By publication
          </button>
          <button type="button" className={sort === "date" ? "active" : ""} onClick={() => setSort("date")}>
            By recency
          </button>
        </div>
      </div>
      <p className="pagesub">
        Everything you saved that points somewhere worth sitting with — essays, docs, repos, talks. Titles and descriptions come from the
        link fetches Locus already made; where a fetch captured an image, it shows above the title. Nothing new leaves this machine.
      </p>
      {err && <p className="bad">{err}</p>}
      {rows.length === 0 ? (
        <p className="empty">Nothing in the reading pile.</p>
      ) : sort === "date" ? (
        <div className="clippings">
          {[...rows]
            .sort((a, b) => b.item.firstObservedAt.localeCompare(a.item.firstObservedAt))
            .map((r) => (
              <ClipCard key={r.item.id} item={r.item} url={r.url} host={r.host} onOpen={onOpen} />
            ))}
        </div>
      ) : (
        groupReading(rows).map(([host, clips]) => (
          <div className="pub" key={host}>
            <PubHead host={host} count={clips.length} sampleUrl={clips[0]?.url ?? ""} />
            <div className="clippings">
              {clips.map((c) => (
                <ClipCard key={c.item.id} item={c.item} url={c.url} host={c.host} onOpen={onOpen} />
              ))}
            </div>
          </div>
        ))
      )}
      {rows.length > 0 ? <div className="orn">❦ ❦ ❦</div> : null}
    </section>
  );
}

function groupReading(rows: { item: ItemCard; url: string; host: string }[]): [string, typeof rows][] {
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = groups.get(r.host);
    if (arr) arr.push(r);
    else groups.set(r.host, [r]);
  }
  return [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

function PubHead({ host, count, sampleUrl }: { host: string; count: number; sampleUrl: string }) {
  const { preview } = useLinkPreview(sampleUrl);
  const name = (preview && usefulPreview(preview, sampleUrl) && (preview.siteName || preview.title)) || host;
  return (
    <div className="pub-head">
      <span className="pub-mono">{host.charAt(0).toUpperCase()}</span>
      <div>
        <div className="pub-name">{name}</div>
        <div className="pub-meta">
          {host} · {count}
        </div>
      </div>
    </div>
  );
}

function ClipCard({ item, url, host, onOpen }: { item: ItemCard; url: string; host: string; onOpen: (item: ItemCard) => void }) {
  const { preview } = useLinkPreview(url);
  const rich = preview && usefulPreview(preview, url);
  const title = (rich && preview.title) || item.title || host;
  const desc = (rich && preview.description) || null;
  const img = preview?.status === "ok" ? preview.image : null;
  const date = item.publishedAt ? pubLabel(item.publishedAt) : item.dateLabel.text;
  return (
    <article
      className="clip"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button")) return;
        onOpen(item);
      }}
    >
      {img ? (
        <div className="media">
          <img src={img} alt="" referrerPolicy="no-referrer" loading="lazy" />
        </div>
      ) : null}
      <span className="clip-title">{title}</span>
      {desc ? <span className="clip-desc">{desc}</span> : null}
      <span className="clip-foot">
        <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{host}</span>·<span>{savedFrom(item.source)}</span>·<span>{date}</span>
        <a className="arrow" href={url} target="_blank" rel="noopener noreferrer">
          ↗
        </a>
      </span>
    </article>
  );
}

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

function AtlasPage({ onOpen }: { onOpen: (item: ItemCard) => void }) {
  const [items, setItems] = useState<ItemCard[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .items("")
      .then((r) => setItems(r.items.filter((it) => it.tags.some((t) => shelfOfTag(t.name).key === "travel"))))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const sections = new Map<string, { region: Region; entries: { item: ItemCard; hits: PlaceHit[] }[] }>();
  const unplaced: ItemCard[] = [];
  for (const item of items) {
    const hits = detectPlaces(item.title, item.body);
    if (hits.length === 0) {
      unplaced.push(item);
      continue;
    }
    const seen = new Set<string>();
    for (const hit of hits) {
      if (seen.has(hit.region)) continue;
      seen.add(hit.region);
      const region = regionByName(hit.region);
      if (!region) continue;
      const bucket = sections.get(region.slug);
      if (bucket) bucket.entries.push({ item, hits });
      else sections.set(region.slug, { region, entries: [{ item, hits }] });
    }
  }
  const ordered = [...sections.values()].sort((a, b) => b.entries.length - a.entries.length || a.region.name.localeCompare(b.region.name));

  return (
    <section>
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
            <span className="count">
              {items.length} save{items.length === 1 ? "" : "s"} · {ordered.length} region{ordered.length === 1 ? "" : "s"} · matched locally
            </span>
          </div>
          <p className="pagesub">
            Travel saves arranged by place. Each region inks its own poster plate; captured photos always win over poster art. A small local
            gazetteer reads the titles and captions you already captured — offline, deterministic, no model. What it can’t place waits honestly
            in “Unplaced”.
          </p>
        </div>
      </div>
      {err && <p className="bad">{err}</p>}
      {items.length === 0 ? (
        <p className="empty">No travel saves yet.</p>
      ) : (
        <>
          <nav className="atlas-nav" aria-label="Regions">
            {ordered.map((s) => (
              <a key={s.region.slug} href={`#rg-${s.region.slug}`}>
                <span className="sw" style={{ ["--c" as string]: s.region.color }} />
                {s.region.name.split(" &")[0]}
              </a>
            ))}
            {unplaced.length > 0 ? (
              <a className="unp" href="#rg-unplaced">
                Unplaced · {unplaced.length}
              </a>
            ) : null}
          </nav>
          {ordered.map((s, i) => {
            const cities = uniqueCities(s.entries, s.region.name);
            return (
              <div className="region" id={`rg-${s.region.slug}`} key={s.region.slug}>
                <div className="region-head">
                  <span className="region-no">PLATE {ROMAN[i] ?? String(i + 1)}</span>
                  <h3 className="region-name">{s.region.name}</h3>
                  <span className="region-count">
                    {s.entries.length} save{s.entries.length === 1 ? "" : "s"}
                  </span>
                </div>
                <hr className="region-rule" />
                <hr className="region-rule2" />
                {cities.length > 0 ? (
                  <div className="cities">
                    Cities & places —{" "}
                    {cities.map((c, idx) => (
                      <span key={c}>
                        {idx > 0 ? " · " : ""}
                        <b>{c}</b>
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="plates">
                  {s.entries.map(({ item, hits }) => (
                    <AtlasCard key={item.id} item={item} region={s.region} hits={hits} onOpen={onOpen} />
                  ))}
                </div>
              </div>
            );
          })}
          {unplaced.length > 0 ? (
            <details className="unplaced" id="rg-unplaced">
              <summary>
                Unplaced — {unplaced.length} save{unplaced.length === 1 ? "" : "s"} the gazetteer couldn’t name a place for
              </summary>
              <div className="inner">
                {unplaced.map((it) => (
                  <div key={it.id}>
                    • {who(it) || hostOf(it.url)} — {cardTitle(it) || it.body?.slice(0, 80) || it.url} (no place named)
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

function uniqueCities(entries: { hits: PlaceHit[] }[], regionName: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    for (const h of e.hits) {
      if (h.region !== regionName || h.place === regionName || seen.has(h.place)) continue;
      seen.add(h.place);
      out.push(h.place);
    }
  }
  return out;
}

function atlasPreviewUrl(item: ItemCard): string | null {
  const out = outboundUrls(item.body, item.url)[0];
  if (out) return out;
  if (!isPlatformPermalink(item.url)) return item.url;
  return null;
}

function AtlasCard({ item, region, hits, onOpen }: { item: ItemCard; region: Region; hits: PlaceHit[]; onOpen: (item: ItemCard) => void }) {
  const word = hits.find((h) => h.region === region.name)?.place || item.title?.split(/\s+/)[0] || "travel";
  const caption = item.title || item.body?.replace(/\s+/g, " ").trim().slice(0, 120) || who(item) || item.url;
  return (
    <article
      className="place-card"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button")) return;
        onOpen(item);
      }}
    >
      <AtlasMedia item={item} region={region} word={word} />
      <div className="caption">
        <span className="cap-text">
          {caption}
          <small>{who(item) || hostOf(item.url)}</small>
        </span>
        <span className="cap-date">{pubLabel(wallAt(item))}</span>
      </div>
    </article>
  );
}

function AtlasMedia({ item, region, word }: { item: ItemCard; region: Region; word: string }) {
  const visual = firstVisual(item);
  const previewUrl = visual ? null : atlasPreviewUrl(item);
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
  return <Poster color={region.color} ink={region.ink} motifName={region.motif} word={word} />;
}

function ShelvesPage() {
  const [items, setItems] = useState<ItemCard[]>([]);
  useEffect(() => {
    api.items("").then((r) => setItems(r.items));
  }, []);
  const counts = shelvesWithCounts(items.map((it) => ({ tags: it.tags.map((t) => t.name) })));
  const tagN = new Set(items.flatMap((it) => it.tags.map((t) => t.name))).size;
  return (
    <section>
      <div className="pagehead">
        <h2>Shelves</h2>
        <span className="count">
          {SHELVES.length} shelves · {tagN} tags filed away
        </span>
      </div>
      <p className="pagesub">
        The whole library, sorted the way you’d shelve books. Every shelf is a plain mapping from your existing tags — nothing was re-tagged,
        and any tag can be moved by editing one table in <code style={{ fontFamily: "var(--mono)", fontSize: ".85em" }}>core/categories.ts</code>.
      </p>
      <div className="shelf-grid">
        {counts.map(({ shelf, count }) => (
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
              <span className="n">{count}</span>
            </span>
            <span className="sample">{tagsForShelf(shelf.key).slice(0, 5).join(" · ")}</span>
          </button>
        ))}
      </div>
      <p className="shelf-note">
        Long-tail tags — <em>airfryer·1, barber·1, bhangra·1, nsfw·1…</em> — stay filed inside their shelf and in search. They never surface as
        top-level choices again.
      </p>
      <p className="shelf-note">
        <a href="#/collections">Collections</a> are still here if you use them.
      </p>
    </section>
  );
}

function CollectionsPage() {
  const [cols, setCols] = useState<Collection[]>([]);
  const [name, setName] = useState("");
  useEffect(() => {
    api.collections().then((r) => setCols(r.collections));
  }, []);
  return (
    <section>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          api.createCollection(name).then((r) => {
            setCols(r.collections);
            setName("");
          });
        }}
      >
        <input className="search" value={name} onChange={(e) => setName(e.target.value)} placeholder="New collection" />
        <button className="btn primary" type="submit">
          Create
        </button>
      </form>
      <div className="grid">
        {cols.map((c) => (
          <a key={c.id} className="card src-neutral" href={`#/collections/${c.id}`}>
            <h3>{c.name}</h3>
            <p className="quiet">{c.count} items</p>
            <p>
              <a href={`#/summary/collection/${c.id}`} onClick={(e) => e.stopPropagation()}>
                Summary
              </a>
            </p>
          </a>
        ))}
      </div>
    </section>
  );
}

function SourcesPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.sources>> | null>(null);
  const [pair, setPair] = useState<{ text: string; source: SourceId } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function reload() {
    setData(await api.sources());
  }
  useEffect(() => {
    reload();
    const t = setInterval(reload, 1500);
    return () => clearInterval(t);
  }, []);

  if (!data) return <p className="quiet">Loading sources…</p>;

  return (
    <section className="stack">
      <p className="quiet">
        Connect opens a tab in this Chrome when the extension is running, otherwise a Locus-owned window. Log in on the real site. Locus never sees your password, cookies, or tokens.
      </p>
      {msg && <div className="banner">{msg}</div>}
      <div className="source-grid">
        {data.sources.map((g) => {
          const lives = g.accounts.filter((a) => a.account && !a.account.externalId.startsWith("fixture"));
          const shown = lives.length > 0
            ? lives
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
              onConnect={async () => {
                const r = await api.connect(g.source, health.account?.id);
                setMsg(r.copy);
                reload();
              }}
              onCancel={() => health.account && api.cancel(g.source, health.account.id).then(reload)}
              onResume={() => health.account && api.resume(g.source, health.account.id).then(reload)}
              onDisconnect={() => {
                if (health.account && confirm(`Disconnect ${g.label}? This revokes the token and deletes the capture-browser profile.`)) {
                  api.disconnect(g.source, health.account.id).then(reload);
                }
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
          <p className="quiet">Paste origin + token into the Locus extension popup. Shown once.</p>
          <textarea readOnly value={pair.text} />
        </div>
      )}
      <div className="block">
        <h2>Desk</h2>
        <label className="stack">
          <span>
            <input type="checkbox" checked={data.settings.refreshOnOpen} onChange={(e) => api.settings(e.target.checked).then(reload)} />{" "}
            Refresh when I open Locus (headed window you can see — not a silent cron)
          </span>
        </label>
        <p className="quiet">{data.extension.alive ? "Extension is connected. Connect opens a tab here." : "Extension not seen — reload it, then Connect. Falls back to a Locus Chrome window."}</p>
        <p className="quiet">{data.pi.detail}</p>
        {!data.pi.available && (
          <p className="quiet">
            Summaries and Auto-tag use a model you already pay for. Install{" "}
            <a href="https://pi.dev" target="_blank" rel="noopener noreferrer">
              Pi
            </a>
            , run <code>pi</code>, then <code>/login</code>. Refresh this page. Locus does not store provider keys.
          </p>
        )}
        <div className="filters">
          <button
            className="btn"
            onClick={async () => {
              const lib = await api.exportLibrary();
              const blob = new Blob([JSON.stringify(lib, null, 2)], { type: "application/json" });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = "locus-library.json";
              a.click();
            }}
          >
            Export JSON
          </button>
          <button
            className="btn danger"
            onClick={() => {
              if (confirm("Delete the entire local library?")) api.deleteLibrary().then(reload);
            }}
          >
            Delete library
          </button>
        </div>
        <ImportPanel />
      </div>
    </section>
  );
}

function SourceCard({
  group,
  health,
  onConnect,
  onCancel,
  onResume,
  onDisconnect,
  onPair,
}: {
  group: SourceGroup;
  health: SourceHealth;
  onConnect: () => void;
  onCancel: () => void;
  onResume: () => void;
  onDisconnect: () => void;
  onPair: () => void;
}) {
  const running = health.running;
  const progress = health.progress;
  const last = health.lastRun;
  const connected = Boolean(health.account && !health.account.externalId.startsWith("fixture") && !health.account.externalId.startsWith("pending:"));
  return (
    <article className={`source-card src-${group.source}`}>
      <h3 className="source-name">
        <SourceMark source={group.source} named={false} />
        {group.label}
      </h3>
      <p className="quiet">{health.account?.displayName || health.account?.externalId || "Not connected"}</p>
      {running && progress && (
        <>
          <div className="bar">
            <span style={{ ["--w" as string]: `${Math.min(100, 8 + progress.seen * 3)}%` }} />
          </div>
          <p>{progress.message}</p>
          {progress.pageUrl && <p className="cite">{progress.pageUrl}</p>}
          {progress.previewJpeg && (
            <img alt="The Locus capture window" src={`data:image/jpeg;base64,${progress.previewJpeg}`} style={{ width: "100%", border: "1px solid var(--rule)" }} />
          )}
          <button className="btn danger" onClick={onCancel}>
            Stop
          </button>
        </>
      )}
      {!running && (
        <div className="filters">
          <button className="btn primary" onClick={onConnect}>
            {connected ? "Refresh" : "Connect"}
          </button>
          {last?.errorCode === "challenge" && health.account && (
            <button className="btn copper" onClick={onResume}>
              Resume
            </button>
          )}
          {health.account && !health.account.externalId.startsWith("fixture") && (
            <button className="btn danger" onClick={onDisconnect}>
              Disconnect
            </button>
          )}
          <button className="btn" onClick={onPair}>
            Pair extension
          </button>
        </div>
      )}
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
  return (
    <div className="stack" style={{ marginTop: 16 }}>
      <h2 style={{ fontFamily: "var(--display)" }}>Import</h2>
      <textarea value={jsonl} onChange={(e) => setJsonl(e.target.value)} placeholder="Capture Protocol JSONL" />
      <div className="filters">
        <button className="btn" onClick={() => api.importJsonl(jsonl, true).then((r) => setOut(JSON.stringify(r)))}>
          Dry-run JSONL
        </button>
        <button className="btn" onClick={() => api.importJsonl(jsonl, false).then((r) => setOut(JSON.stringify(r)))}>
          Import JSONL
        </button>
      </div>
      <textarea value={posts} onChange={(e) => setPosts(e.target.value)} placeholder="Reddit saved_posts.csv" />
      <textarea value={comments} onChange={(e) => setComments(e.target.value)} placeholder="Reddit saved_comments.csv" />
      <div className="filters">
        <button className="btn" onClick={() => api.importReddit(posts, comments, true).then((r) => setOut(JSON.stringify(r)))}>
          Dry-run Reddit export
        </button>
        <button className="btn" onClick={() => api.importReddit(posts, comments, false).then((r) => setOut(JSON.stringify(r)))}>
          Import Reddit export
        </button>
      </div>
      {out && <pre className="cite">{out}</pre>}
    </div>
  );
}

function SummaryPage({ scope, scopeRef }: { scope: "day" | "collection"; scopeRef: string }) {
  const [snap, setSnap] = useState<SummarySnapshot | null>(null);
  const [pi, setPi] = useState("");
  const [prose, setProse] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.summary(scope, scopeRef).then((r) => {
      setSnap(r.snapshot);
      setPi(r.pi.detail);
    });
  }, [scope, scopeRef]);
  const cited = useMemo(() => new Map(snap?.items.map((i) => [i.id, i]) ?? []), [snap]);
  if (!snap) return <p className="quiet">Building blocks…</p>;
  return (
    <section className="summary">
      <p className="quiet">Deterministic blocks from the local library. {pi}</p>
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
        <h2>Write as prose</h2>
        <p className="quiet">
          User-chosen extra. Selected items leave this machine toward the connected model. Citations must stay inside this snapshot. Claude through Pi is billed as extra usage, not plan allowance.
        </p>
        <button
          className="btn copper"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api.prose(scope, scopeRef);
              setProse(r.prose.prose);
            } catch (e) {
              setProse(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Write as prose
        </button>
        {prose && <p className="prose">{prose}</p>}
      </article>
    </section>
  );
}

function readStageSize(): { w: number; h: number } | null {
  try {
    const s = localStorage.getItem("locus-stage-size");
    if (!s) return null;
    const j = JSON.parse(s) as { w?: unknown; h?: unknown };
    if (typeof j.w === "number" && typeof j.h === "number") return { w: j.w, h: j.h };
  } catch {
    /* ignore */
  }
  return null;
}

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

function frameLooksEmbedded(threw: boolean, href: string | null | undefined): boolean {
  if (threw) return true;
  if (!href) return false;
  return href !== "about:blank" && !href.startsWith("about:");
}

function inspectFrame(el: HTMLIFrameElement): boolean {
  try {
    return frameLooksEmbedded(false, el.contentWindow?.location.href ?? null);
  } catch {
    return true;
  }
}

function instagramEmbed(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (!/(^|\.)instagram\.com$/i.test(host)) return null;
    const m = u.pathname.match(/\/(p|reel|tv)\/([^/?#]+)/i);
    const kind = m?.[1];
    const code = m?.[2];
    return kind && code ? `https://www.instagram.com/${kind.toLowerCase()}/${code}/embed` : null;
  } catch {
    return null;
  }
}

function Stage({ item, onClose }: { item: ItemCard | null; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<string | null>(null);
  const [frame, setFrame] = useState<"checking" | "wait" | "ok" | "blocked" | "declined">("wait");
  const [playing, setPlaying] = useState(false);
  const [igOn, setIgOn] = useState(false);
  const [prose, setProse] = useState<string | null>(null);
  const [proseErr, setProseErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [notes, setNotes] = useState(item?.notes ?? []);

  useEffect(() => {
    setPage(null);
    setFrame("wait");
    setPlaying(false);
    setIgOn(false);
    setProse(null);
    setProseErr(null);
    setBusy(false);
    setNoteOpen(false);
    setNote("");
    setNotes(item?.notes ?? []);
  }, [item?.id]);

  useLayoutEffect(() => {
    const el = box.current;
    const sz = readStageSize();
    if (el && sz) {
      el.style.width = `${sz.w}px`;
      el.style.height = `${sz.h}px`;
    }
  }, [item]);

  useEffect(() => {
    if (!page) return;
    setFrame("checking");
    let alive = true;
    api
      .frameCheck(page)
      .then((r) => {
        if (!alive) return;
        setFrame(r.framed === "no" ? "blocked" : "wait");
      })
      .catch(() => {
        if (alive) setFrame("wait");
      });
    return () => {
      alive = false;
    };
  }, [page]);

  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onClose]);

  if (!item) return null;

  const ytId = youtubeVideoId(item.url);
  const ig = instagramEmbed(item.url);
  const visual = firstVisual(item);
  const title = cardTitle(item);
  const body = (item.body || "").replace(/(https?:\/\/)\s+/g, "$1");
  const live = Boolean(page);
  const orig = live ? page! : item.url;

  const pushPage = (url: string) => {
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
      if (!isStageOutbound(u.toString(), item.url)) return;
      setPage(u.toString());
      setFrame("checking");
      setPlaying(false);
      setIgOn(false);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="stage" ref={box} role="dialog" aria-label="Save viewer">
      <button
        type="button"
        className="stage-grip"
        title="Drag to resize"
        aria-label="Resize"
        onPointerDown={(e) => {
          e.preventDefault();
          const el = box.current;
          if (!el) return;
          const grip = e.currentTarget;
          grip.setPointerCapture(e.pointerId);
          const r = el.getBoundingClientRect();
          const x0 = e.clientX;
          const y0 = e.clientY;
          const w0 = r.width;
          const h0 = r.height;
          const move = (ev: PointerEvent) => {
            el.style.width = `${clamp(w0 + (x0 - ev.clientX), 320, window.innerWidth - 32)}px`;
            el.style.height = `${clamp(h0 + (y0 - ev.clientY), 280, window.innerHeight - 72)}px`;
          };
          const up = () => {
            const next = el.getBoundingClientRect();
            try {
              localStorage.setItem("locus-stage-size", JSON.stringify({ w: next.width, h: next.height }));
            } catch {
              /* ignore */
            }
            grip.removeEventListener("pointermove", move);
            grip.removeEventListener("pointerup", up);
          };
          grip.addEventListener("pointermove", move);
          grip.addEventListener("pointerup", up);
        }}
      />
      <header className="stage-bar">
        {live ? (
          <button type="button" className="stage-icon" title="Back to the save" onClick={() => setPage(null)}>
            ←
          </button>
        ) : null}
        <div className="stage-who">
          <span className="handle">{live ? hostOf(page!) : who(item) || hostOf(item.url)}</span>
          <span className="by-date">{live ? "live page" : sourceLabel(item.source)}</span>
        </div>
        <a className="stage-icon" href={orig} target="_blank" rel="noopener noreferrer" title="Open original">
          ↗
        </a>
        <button type="button" className="stage-icon" title="Close" onClick={onClose}>
          ×
        </button>
      </header>
      {live ? (
        <div className="stage-body web">
          {frame === "checking" ? (
            <div className="stage-consent">
              <p>Opening {hostOf(page!)}…</p>
            </div>
          ) : frame === "blocked" || frame === "declined" ? (
            <div className="stage-consent">
              <p>This page won’t sit in a frame.</p>
              <p className="host">{hostOf(page!)}</p>
              {frame === "blocked" ? (
                <div className="stage-ai-row">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      window.open(page!, "_blank", "noopener,noreferrer");
                      setPage(null);
                      setFrame("wait");
                    }}
                  >
                    Open in new tab
                  </button>
                  <button type="button" onClick={() => setFrame("declined")}>
                    Not now
                  </button>
                </div>
              ) : (
                <p className="host">Use ↗ to open it outside Locus.</p>
              )}
            </div>
          ) : (
            <iframe
              key={page!}
              className="stage-wv"
              src={page!}
              title={hostOf(page!)}
              onError={() => setFrame("blocked")}
              onLoad={(e) => {
                const el = e.currentTarget;
                // ponytail: about:blank vs SecurityError. chrome-error:// pages look like success; ↗ still works.
                window.setTimeout(() => {
                  if (!el.isConnected) return;
                  setFrame(inspectFrame(el) ? "ok" : "blocked");
                }, 50);
              }}
            />
          )}
        </div>
      ) : (
        <div className="stage-body">
          {ytId && playing ? (
            <iframe
              className="stage-wv"
              style={{ minHeight: 0, aspectRatio: "16 / 9", maxHeight: "55%", flex: "none" }}
              src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(ytId)}`}
              title="YouTube"
              allow="accelerometer; autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          ) : ytId ? (
            <button
              type="button"
              className={`stage-play${visual ? " has-thumb" : ""}`}
              style={visual ? { backgroundImage: `url(${visual.url})` } : undefined}
              onClick={() => setPlaying(true)}
            >
              <span className="tri" />
              Play here
            </button>
          ) : visual ? (
            visual.kind === "video" ? (
              <video className="stage-shot video" src={visual.url} controls playsInline preload="metadata" />
            ) : (
              <img className={ig ? "stage-ig" : "stage-shot"} src={visual.url} alt="" referrerPolicy="no-referrer" />
            )
          ) : null}
          {ig && !igOn ? (
            <button type="button" className="stage-try" onClick={() => setIgOn(true)}>
              Try embed
            </button>
          ) : null}
          {ig && igOn ? (
            <iframe
              className="stage-wv"
              style={{ minHeight: 0, aspectRatio: "9 / 16", maxHeight: "45%", flex: "none" }}
              src={ig}
              title="Instagram"
            />
          ) : null}
          <div className="stage-copy">
            {title ? <h3>{title}</h3> : null}
            {body ? <StageText text={body} permalink={item.url} onOutbound={pushPage} /> : null}
            <p className="honest">
              {ytId
                ? "Play here is an official YouTube embed. Public videos play. Private or age-gated videos fail in the frame — use ↗."
                : ig
                  ? "instagram.com will not sit in a frame. Try embed is a postcard; Reels often refuse. Captured still + ↗ is the fallback."
                  : outboundUrls(item.body, item.url).length
                    ? "The save is local. Click a link to open it here. If the site refuses the frame, Locus will ask before opening a tab."
                    : "The text Locus already captured. Live X, Instagram, and Reddit pages are not framed here."}
            </p>
          </div>
        </div>
      )}
      <div className="stage-ai">
        <div className="stage-ai-row">
          <button
            type="button"
            className="primary"
            disabled={busy}
            title="Uses your Pi login. User-chosen extra."
            onClick={() => {
              setBusy(true);
              setProseErr(null);
              api
                .prose("item", item.id)
                .then((r) => setProse(r.prose.prose))
                .catch((e: unknown) => setProseErr(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Summarizing…" : prose ? "Again" : "Summary"}
          </button>
          <button type="button" onClick={() => setNoteOpen(true)}>
            {noteOpen || notes.length ? "Note" : "Add note"}
          </button>
        </div>
        {proseErr ? <p className="stage-notes">{proseErr}</p> : null}
        {prose ? <p className="stage-prose">{prose}</p> : null}
        {notes.map((n) => (
          <p key={n.id} className="stage-notes">
            {n.body}
          </p>
        ))}
        {noteOpen ? (
          <>
            <textarea className="stage-note" placeholder="A note stays on this machine." value={note} onChange={(e) => setNote(e.target.value)} />
            <button
              type="button"
              className="primary"
              onClick={() => {
                const bodyText = note.trim();
                if (!bodyText) return;
                api.addNote(item.id, bodyText).then((r) => {
                  setNotes(r.item.notes);
                  setNote("");
                });
              }}
            >
              Save note
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function StageText({ text, permalink, onOutbound }: { text: string; permalink: string; onOutbound: (url: string) => void }) {
  const parts = text.split(/(https?:\/\/[^\s)>"']+)/g);
  return (
    <p>
      {parts.map((part, i) => {
        if (!/^https?:\/\//i.test(part)) return <Fragment key={i}>{part}</Fragment>;
        const label = part.replace(/^https?:\/\//, "");
        if (isStageOutbound(part, permalink)) {
          return (
            <a
              key={i}
              href={part}
              onClick={(e) => {
                e.preventDefault();
                onOutbound(part);
              }}
            >
              {label}
            </a>
          );
        }
        return (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer">
            {label}
          </a>
        );
      })}
    </p>
  );
}
