import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  api,
  boot,
  type ItemCard,
} from "./api.ts";
import { canOpenInStage, neverFrame } from "../../core/sanitize.ts";
import { Stage, frameDenied, isEmbedUrl } from "./Stage.tsx";
import { SourceMark } from "./SourceMark.tsx";
import { SourcesPage } from "./SourcesPage.tsx";
import { ItemList } from "./DeskPage.tsx";
import { ReadingPage } from "./ReadingPage.tsx";
import { AtlasPage } from "./AtlasPage.tsx";
import { KitchenPage, KitchenDetail } from "./KitchenPage.tsx";
import { CollectionsPage } from "./CollectionsPage.tsx";
import { SummaryPage } from "./SummaryPage.tsx";
import { canMountLiveFrame, firstStageDestination } from "./stage-navigation.ts";
import { localDay } from "../../core/dates.ts";
import { LIBRARY_CHANGED_EVENT, notifyLibraryChanged } from "./library-events.ts";

type Route =
  | { name: "recent"; shelf: string }
  | { name: "inbox"; shelf: string }
  | { name: "search"; q: string }
  | { name: "collections" }
  | { name: "collection"; id: string }
  | { name: "sources" }
  | { name: "reading" }
  | { name: "atlas" }
  | { name: "kitchen" }
  | { name: "kitchenItem"; id: string; mode: "auto" | "watch" | "edit" }
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
  // Reading is an index only. Ignore any stale/native-reader document segment
  // so `#/reading/:id` renders the ordinary index and shell chrome.
  if (a === "reading") return { name: "reading" };
  if (a === "atlas") return { name: "atlas" };
  if (a === "kitchen") {
    if (b) {
      const mode = parts[2] === "edit" ? "edit" : parts[2] === "watch" ? "watch" : "auto";
      return { name: "kitchenItem", id: b, mode };
    }
    return { name: "kitchen" };
  }
  if (a === "shelves") {
    // Shelves moved into the Desk rail. Replace in place so old links and
    // restored hashes land on Desk without adding a history step.
    history.replaceState(null, "", `${location.pathname}${location.search}#/recent`);
    return { name: "recent", shelf };
  }
  if (a === "summary" && parts[1] === "day") return { name: "summary", scope: "day", ref: parts[2] || today() };
  if (a === "summary" && parts[1] === "collection" && parts[2]) return { name: "summary", scope: "collection", ref: parts[2] };
  return { name: "recent", shelf };
}

function today(): string {
  return localDay(new Date());
}

function go(hash: string): void {
  location.hash = hash;
}

function replaceHash(hash: string): void {
  const url = `${location.pathname}${location.search}${hash}`;
  history.replaceState(null, "", url);
}

function pushHash(hash: string): void {
  const url = `${location.pathname}${location.search}${hash}`;
  history.pushState(null, "", url);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
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
  const initialRoute = parseHash();
  const [route, setRoute] = useState<Route>(parseHash);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inbox, setInbox] = useState<number | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() => readStoredTheme() ?? systemTheme());
  const [stageItem, setStageItem] = useState<ItemCard | null>(null);
  const [stagePage, setStagePage] = useState<string | null>(null);
  const stageOpenRequest = useRef(0);
  const [searchText, setSearchText] = useState(() => (initialRoute.name === "search" ? initialRoute.q : ""));
  const searchTimer = useRef<number | null>(null);
  const closeStage = () => {
    stageOpenRequest.current++;
    setStageItem(null);
    setStagePage(null);
  };
  const openStage = async (item: ItemCard, page?: string) => {
    const request = ++stageOpenRequest.current;
    const dest = page ?? firstStageDestination(item);
    if (!dest) {
      setStageItem(item);
      setStagePage(null);
      return;
    }
    try {
      const u = new URL(dest);
      const href = u.toString();
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        setStageItem(item);
        setStagePage(null);
        return;
      }
      if (isEmbedUrl(href)) {
        setStageItem(item);
        setStagePage(href);
        return;
      }
      if (!canOpenInStage(href, item.url) || frameDenied(href) || neverFrame(href)) {
        window.open(href, "_blank", "noopener,noreferrer");
        closeStage();
        return;
      }
      const framed = await api.frameCheck(href).then((result) => result.framed).catch(() => "unknown" as const);
      if (request !== stageOpenRequest.current) return;
      if (!canMountLiveFrame(framed)) {
        window.open(href, "_blank", "noopener,noreferrer");
        closeStage();
        return;
      }
      setStageItem(item);
      setStagePage(href);
    } catch {
      setStageItem(item);
      setStagePage(null);
    }
  };
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
    if (!ready) return;
    let alive = true;
    const refresh = () => {
      api.itemCounts("view=inbox").then((r) => {
        if (alive) setInbox(r.counts.inbox);
      }).catch(() => {});
    };
    refresh();
    const onChange = () => refresh();
    window.addEventListener(LIBRARY_CHANGED_EVENT, onChange);
    const timer = window.setInterval(refresh, 2000);
    return () => {
      alive = false;
      window.removeEventListener(LIBRARY_CHANGED_EVENT, onChange);
      window.clearInterval(timer);
    };
  }, [ready]);

  useEffect(() => {
    if (route.name === "search") setSearchText(route.q);
    else setSearchText("");
  }, [route]);

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
          <p className="lede">Your saves, in one place.</p>
        </div>
        <div className="mast-right">
          <div className="datebox">
            <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.6" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 3v3M12 18v3M3 12h3M18 12h3M12 8l1.8 4L12 16l-1.8-4z" />
            </svg>
            <span>{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</span>
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
                placeholder="Search saves"
                value={searchText}
                onChange={(e) => {
                  const value = e.target.value;
                  setSearchText(value);
                  if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
                  if (!value.trim()) {
                    replaceHash("#/recent");
                    setRoute(parseHash());
                    return;
                  }
                  // Replace while composing so Back does not walk every letter.
                  replaceHash(`#/search?q=${encodeURIComponent(value)}`);
                  searchTimer.current = window.setTimeout(() => {
                    setRoute(parseHash());
                  }, 250);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || !searchText.trim()) return;
                  e.preventDefault();
                  pushHash(`#/search?q=${encodeURIComponent(searchText.trim())}`);
                }}
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
        <Tab href="#/kitchen" active={route.name === "kitchen" || route.name === "kitchenItem"}>
          Kitchen
        </Tab>
        <Tab href="#/atlas" active={route.name === "atlas"}>
          Atlas
        </Tab>
        <Tab href="#/reading" active={route.name === "reading"}>
          Reading
        </Tab>
        <Tab href="#/sources" active={route.name === "sources"}>
          Sources
        </Tab>
      </nav>
      {route.name === "recent" && <ItemList view="recent" initialShelf={route.shelf} onOpen={openStage} />}
      {route.name === "inbox" && <ItemList view="inbox" initialShelf={route.shelf} onOpen={openStage} />}
      {route.name === "search" && <ItemList view="search" initialQ={route.q} onOpen={openStage} />}
      {route.name === "collections" && <CollectionsPage />}
      {route.name === "collection" && <ItemList view="collection" collectionId={route.id} onOpen={openStage} />}
      {route.name === "sources" && <SourcesPage />}
      {route.name === "reading" && <ReadingPage />}
      {route.name === "atlas" && <AtlasPage onOpen={openStage} />}
      {route.name === "kitchen" && <KitchenPage />}
      {route.name === "kitchenItem" && <KitchenDetail itemId={route.id} mode={route.mode} />}
      {route.name === "summary" && <SummaryPage scope={route.scope} scopeRef={route.ref} />}
      <Stage
        key={`${stageItem?.id ?? "closed"}:${stagePage ?? ""}`}
        item={stageItem}
        startPage={stagePage}
        onItemChange={(item) => {
          setStageItem(item);
          notifyLibraryChanged(item);
        }}
        onClose={closeStage}
      />
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
      {line} <a href="#/sources">Open Sources</a> to continue.
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
