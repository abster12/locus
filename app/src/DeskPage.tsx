import { Fragment, useEffect, useRef, useState, type MouseEvent } from "react";
import { api, type ItemCard, type LinkPreview } from "./api.ts";
import { isPlatformPermalink, isReadingItem } from "../../core/sanitize.ts";
import { SHELVES, shelfOfTag } from "../../core/categories.ts";
import { sourceIcon, sourceLabel } from "./source-icons.ts";
import { cardTitle, extractLinks, firstVisual, hostOf, pathOf, pubLabel, who } from "./item-content.ts";
import { SourceMark } from "./SourceMark.tsx";
import { useItemList } from "./use-item-list.ts";
import { usefulPreview, useLinkPreview } from "./link-preview.ts";
import { CapturedMedia, Poster } from "./ItemVisuals.tsx";
import { ClassificationWhy } from "./ClassificationWhy.tsx";
import { localDay } from "../../core/dates.ts";
import { RUNTIME } from "./runtime.ts";
import { useProse } from "./use-prose.ts";
import { previewOpensInStage } from "./stage-navigation.ts";
function previewUrls(item: ItemCard): { text: string; links: string[] } {
  const extracted = extractLinks(item.body);
  if (isPlatformPermalink(item.url)) {
    const text = (item.body || "").replace(/(https?:\/\/)\s+/g, "$1").trim();
    return { text, links: extracted.links.filter((u) => u !== item.url) };
  }
  if (extracted.links.length) return extracted;
  return { ...extracted, links: [item.url] };
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

function pickLink(
  e: MouseEvent<HTMLAnchorElement>,
  url: string,
  permalink: string,
  onPick: (url: string) => void,
) {
  e.stopPropagation();
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  // Hosted Stage never mounts a live page, and a save's own permalink (or a
  // social URL) cannot sit in a frame. Leave the <a> alone so the preview
  // opens the URL instead of a Stage that cannot show it.
  if (RUNTIME === "hosted" || !previewOpensInStage(url, permalink)) return;
  e.preventDefault();
  onPick(url);
}

function LinkCards({ links, permalink, onPick }: { links: string[]; permalink: string; onPick: (url: string) => void }) {
  if (links.length === 0) return null;
  return (
    <div className="linkcards">
      {links.map((u) => (
        <LinkPreviewCard key={u} url={u} permalink={permalink} onPick={onPick} />
      ))}
    </div>
  );
}

function LinkPreviewCard({ url, permalink, onPick }: { url: string; permalink: string; onPick: (url: string) => void }) {
  const card = useRef<HTMLAnchorElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  useEffect(() => {
    const node = card.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // Keep the cheap host/path placeholder available for distant cards, and do
  // not ask the server for metadata until the card is near the viewport.
  const { preview: p } = useLinkPreview(nearViewport ? url : null);
  const host = hostOf(url);
  const mono = (
    <span className="lc-mono" style={{ ["--h" as string]: hueFor(host) }}>
      {host.charAt(0).toUpperCase()}
    </span>
  );
  if (p && usefulPreview(p, url)) {
    return (
      <a ref={card} className="linkcard rich" href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => pickLink(e, url, permalink, onPick)}>
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
    <a ref={card} className="linkcard" href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => pickLink(e, url, permalink, onPick)}>
      {mono}
      <span className="lc-text">
        <span className="lc-host">{host}</span>
        {pathOf(url) ? <span className="lc-path">{pathOf(url)}</span> : null}
      </span>
      <span className="lc-arrow">↗</span>
    </a>
  );
}

function wallAt(item: ItemCard): string | null {
  return item.publishedAt || item.sourceSavedAt || item.capturedAt || item.firstObservedAt;
}

function dayHeading(key: string): string {
  if (key === "undated") return "Undated";
  if (key === localDay(new Date())) return "Today";
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (key === localDay(y)) return "Yesterday";
  const date = new Date(`${key}T12:00:00`);
  const options: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" };
  if (key.slice(0, 4) !== String(new Date().getFullYear())) options.year = "numeric";
  return date.toLocaleDateString(undefined, options);
}

function sortAt(item: ItemCard): string {
  return wallAt(item) ?? "";
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

export function ItemList({
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
  onOpen: (item: ItemCard, page?: string) => void;
}) {
  const {
    source, setSource, shelfKey, setShelf, theme, setTheme, activeShelf, shelfTags,
    items: shown, counts, loading, err, tagMsg, tagging, statusBusy, statusMessages,
    listMessage, loadMoreRef, onStatus, autoTag,
  } = useItemList({ view, collectionId, initialQ, initialShelf });
  return (
    <section>
      <div className="desk">
        <aside className="rail">
          <p className="rail-label">Shelves</p>
          <button type="button" className={`shelfbtn ${shelfKey ? "" : "active"}`} style={{ ["--c" as string]: "var(--ink)" }} onClick={() => setShelf("")}>
            <span className="dot" />
            <span className="nm">All saves</span>
            <span className="n">{counts.total}</span>
          </button>
          {SHELVES.map((shelf) => (
            <button
              key={shelf.key}
              type="button"
              className={`shelfbtn ${shelfKey === shelf.key ? "active" : ""}`}
              style={{ ["--c" as string]: shelf.color }}
              onClick={() => setShelf(shelfKey === shelf.key ? "" : shelf.key)}
            >
              <span className="dot" />
              <span className="nm">{shelf.name}</span>
              <span className="n">{counts.shelves[shelf.key] ?? 0}</span>
            </button>
          ))}
          <p className="rail-foot">
            <a href="#/collections">Collections</a>
          </p>
        </aside>
        <div>
          <div className="toolbar">
            <div className="filters">
              {["", "you", "x", "instagram", "youtube", "reddit"].map((s) => (
                <button key={s || "all"} className={`chip ${s && sourceIcon(s) ? `src-${s}` : ""} ${source === s ? "active" : ""}`} onClick={() => setSource(s)}>
                  {s && sourceIcon(s) ? <span className="ico" dangerouslySetInnerHTML={{ __html: sourceIcon(s) }} /> : null}
                  {s ? sourceLabel(s) : "All"}
                </button>
              ))}
              {RUNTIME !== "hosted" ? (
                <button
                  className="chip copper autotag"
                  disabled={tagging}
                  title="Tag untagged saves"
                  onClick={autoTag}
                >
                  {tagging ? "Tagging…" : "Auto-tag"}
                </button>
              ) : null}
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
          {listMessage ? <p className={listMessage.kind === "bad" ? "action-error" : "action-ok"} role={listMessage.kind === "bad" ? "alert" : "status"}>{listMessage.text}</p> : null}
          {shown.length === 0 ? (
            <p className="empty">{view === "inbox" ? "Inbox is clear." : "No saves found."}</p>
          ) : (
            <div className="wall">
              {groupByDay(shown).map(([day, list]) => (
                <Fragment key={day}>
                  <h2 className="day-head">{dayHeading(day)}</h2>
                  {list.map((item) => (
                    <PostCard
                      key={item.id}
                      item={item}
                      onStatus={onStatus}
                      onTag={setTheme}
                      onOpen={onOpen}
                      busy={statusBusy.has(item.id)}
                      statusMessage={statusMessages[item.id]}
                    />
                  ))}
                </Fragment>
              ))}
            </div>
          )}
          <div ref={loadMoreRef} className="load-more" aria-live="polite">{loading && shown.length > 0 ? "Loading more…" : null}</div>
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
  const { prose, error, busy, generate } = useProse("item", id);
  return (
    <>
      <button
        type="button"
        className="more"
        disabled={busy}
        title="Summarize this save"
        onClick={() => void generate()}
      >
        {busy ? "Summarizing…" : prose ? "Again" : "Summary"}
      </button>
      {error ? <p className="action-error" role="alert">{error}</p> : null}
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

function PostCard({
  item,
  onStatus,
  onTag,
  onOpen,
  busy = false,
  statusMessage,
}: {
  item: ItemCard;
  onStatus: (id: string, status: string) => void;
  onTag: (name: string) => void;
  onOpen: (item: ItemCard, page?: string) => void;
  busy?: boolean;
  statusMessage?: { kind: "ok" | "bad"; text: string };
}) {
  const { text, links } = previewUrls(item);
  const title = cardTitle(item);
  const showTitle = Boolean(title && (!text || !text.startsWith(title.slice(0, 40))));
  const reading = isReadingItem(item.body, item.url);
  const visual = firstVisual(item);
  return (
    <article
      className={item.source ? `post src-${item.source}` : "post"}
      tabIndex={0}
      aria-label={`${cardTitle(item) || "Saved item"} by ${who(item) || hostOf(item.url)}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button")) return;
        e.currentTarget.focus();
        onOpen(item);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(item);
        }
      }}
    >
      <header className="byline">
        <Avatar item={item} />
        <div className="by-who">
          <span className="handle">{who(item) || hostOf(item.url)}</span>
          <span className="by-date">{pubLabel(wallAt(item))}</span>
        </div>
        {item.intakeActor === "user" ? <span className="intake-mark">Added by you</span> : item.intakeActor === "agent" ? <span className="intake-mark">Added by agent</span> : <SourceMark source={item.source} />}
      </header>
      {showTitle ? <h3>{title}</h3> : null}
      {text ? <Excerpt text={text} /> : null}
      {visual ? <CapturedMedia item={item} /> : links.length ? <LinkCards links={links} permalink={item.url} onPick={(url) => onOpen(item, url)} /> : <Poster {...deskPoster(item)} />}
      {visual ? <LinkCards links={links} permalink={item.url} onPick={(url) => onOpen(item, url)} /> : null}
      <footer className="post-foot">
        <div className="tags">
          {item.status !== "inbox" ? <span className={`status status-${item.status}`}>{item.status === "accepted" ? "Accepted" : item.status}</span> : null}
          {item.tags.map((t) => (
            <button key={t.id} type="button" className="tag" onClick={() => onTag(t.name)}>
              {t.name}
            </button>
          ))}
          {RUNTIME !== "hosted" && reading ? <ReadingSummary id={item.id} /> : null}
        </div>
        <div className="acts">
          <button type="button" title="Accept" aria-label="Accept" disabled={busy || item.status === "accepted"} onClick={() => onStatus(item.id, "accepted")}>
            ✓
          </button>
          <button type="button" title="Archive" aria-label="Archive" disabled={busy} onClick={() => onStatus(item.id, "archived")}>
            ⌄
          </button>
          <a title="Open original" href={item.url} target="_blank" rel="noopener noreferrer">
            ↗
          </a>
        </div>
      </footer>
      <ClassificationWhy item={item} />
      {statusMessage ? <p className={statusMessage.kind === "bad" ? "action-error" : "action-ok"} role="status">{statusMessage.text}</p> : null}
    </article>
  );
}
