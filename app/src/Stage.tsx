import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type Collection, type ItemCard } from "./api.ts";
import { canOpenInStage, instagramEmbedUrl, neverFrame, youtubeVideoId } from "../../core/sanitize.ts";
import { cardTitle, firstVisual, hostOf, who } from "./item-content.ts";
import { sourceLabel } from "./source-icons.ts";
import { canMountLiveFrame } from "./stage-navigation.ts";
import { useProse } from "./use-prose.ts";

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
type StageKind = "phone" | "book";

function readStageSize(kind: StageKind): { w: number; h: number } | null {
  try {
    const s = localStorage.getItem(`locus-stage-size-${kind}`);
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

export function isEmbedUrl(url: string): boolean {
  return Boolean(youtubeVideoId(url) || instagramEmbedUrl(url));
}

export function frameDenied(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const list = JSON.parse(localStorage.getItem("locus-frame-no") || "[]") as unknown;
    return Array.isArray(list) && list.includes(host);
  } catch {
    return false;
  }
}

function ejectToTab(url: string, rememberDenied = true) {
  if (rememberDenied) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      const raw = JSON.parse(localStorage.getItem("locus-frame-no") || "[]") as unknown;
      const list = Array.isArray(raw) ? (raw as string[]) : [];
      if (!list.includes(host)) localStorage.setItem("locus-frame-no", JSON.stringify([...list, host]));
    } catch {
      /* ignore */
    }
  }
  return window.open(url, "_blank", "noopener,noreferrer");
}

export function Stage({ item, startPage, onClose, onItemChange }: {
  item: ItemCard | null;
  startPage?: string | null;
  onClose: () => void;
  onItemChange: (item: ItemCard) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const [page, setPage] = useState<string | null>(startPage ?? null);
  const [frame, setFrame] = useState<"checking" | "wait" | "ok">("wait");
  const { prose, error: proseErr, busy, generate: generateProse } = useProse("item", item?.id ?? "");
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [notes, setNotes] = useState(item?.notes ?? []);
  const [tagText, setTagText] = useState("");
  const [availableCollections, setAvailableCollections] = useState<Collection[]>([]);
  const [selectedCollection, setSelectedCollection] = useState("");
  const [organizationBusy, setOrganizationBusy] = useState(false);
  const [organizationError, setOrganizationError] = useState<string | null>(null);
  const [organizationMessage, setOrganizationMessage] = useState<string | null>(null);
  const [snoozeDate, setSnoozeDate] = useState("");

  useEffect(() => {
    setPage(startPage ?? null);
    setFrame("wait");
    setNoteOpen(false);
    setNote("");
    setNotes(item?.notes ?? []);
    setTagText("");
    setSelectedCollection("");
    setOrganizationError(null);
    setOrganizationMessage(null);
    setSnoozeDate("");
  }, [item?.id]);

  useEffect(() => {
    if (!item) return;
    api.collections().then((r) => setAvailableCollections(r.collections)).catch(() => {});
  }, [item?.id]);

  useLayoutEffect(() => {
    if (!item) return;
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const backdrop = box.current?.parentElement;
    const shell = backdrop?.parentElement;
    const siblings = shell ? [...shell.children].filter((child) => child !== backdrop) : [];
    const wasInert = siblings.map((element) => element.hasAttribute("inert"));
    siblings.forEach((element) => element.setAttribute("inert", ""));
    document.body.style.overflow = "hidden";
    const focus = () => {
      const target = box.current?.querySelector<HTMLElement>("[data-stage-title], button, a, input, textarea, select");
      target?.focus();
    };
    const id = window.requestAnimationFrame(focus);
    return () => {
      window.cancelAnimationFrame(id);
      document.body.style.overflow = previousOverflow;
      siblings.forEach((element, index) => {
        if (!wasInert[index]) element.removeAttribute("inert");
      });
      origin.current?.focus();
      origin.current = null;
    };
  }, [item?.id]);

  const kind: StageKind = page && !isEmbedUrl(page) ? "book" : "phone";

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const sz = readStageSize(kind);
    if (sz) {
      el.style.width = `${clamp(sz.w, 320, window.innerWidth - 32)}px`;
      el.style.height = `${clamp(sz.h, 280, window.innerHeight - 72)}px`;
    } else {
      el.style.width = "";
      el.style.height = "";
    }
  }, [item, kind]);

  const dropLive = (url: string, rememberDenied = true) => {
    ejectToTab(url, rememberDenied);
    onClose();
  };

  if (!item) return null;

  const pageYt = page ? youtubeVideoId(page) : null;
  const pageIg = page ? instagramEmbedUrl(page) : null;
  const ytId = pageYt || (!page ? youtubeVideoId(item.url) : null);
  const ig = pageIg || (!page ? instagramEmbedUrl(item.url) : null);
  const visual = firstVisual(item);
  const title = cardTitle(item);
  const body = (item.body || "").replace(/(https?:\/\/)\s+/g, "$1");
  const live = Boolean(page) && !pageYt && !pageIg;
  const orig = page || item.url;

  const pushPage = (url: string) => {
    try {
      const u = new URL(url);
      const href = u.toString();
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
      if (isEmbedUrl(href)) {
        setPage(href);
        return;
      }
      if (!canOpenInStage(href, item.url) || frameDenied(href) || neverFrame(href)) {
        window.open(href, "_blank", "noopener,noreferrer");
        onClose();
        return;
      }
      api.frameCheck(href)
        .then((result) => {
          if (canMountLiveFrame(result.framed)) {
            setPage(href);
            setFrame("wait");
            return;
          }
          dropLive(href, result.framed === "no");
        })
        .catch(() => dropLive(href, false));
    } catch {
      /* ignore */
    }
  };

  const focusables = () => [...(box.current?.querySelectorAll<HTMLElement>("button, a, input, textarea, select, [tabindex]:not([tabindex='-1'])") ?? [])].filter((el) => !el.hasAttribute("disabled"));
  const applyOrganization = async (work: Promise<{ item: ItemCard }>, success: string): Promise<boolean> => {
    setOrganizationBusy(true);
    setOrganizationError(null);
    setOrganizationMessage(null);
    try {
      const result = await work;
      onItemChange(result.item);
      setNotes(result.item.notes);
      setOrganizationMessage(success);
      return true;
    } catch (e) {
      setOrganizationError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setOrganizationBusy(false);
    }
  };

  return (
    <div className="stage-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className={`stage${kind === "book" ? " book" : ""}`}
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="stage-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
            return;
          }
          if (e.key !== "Tab") return;
          const list = focusables();
          if (!list.length) return;
          const first = list[0]!;
          const last = list[list.length - 1]!;
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
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
              localStorage.setItem(`locus-stage-size-${kind}`, JSON.stringify({ w: next.width, h: next.height }));
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
        {page ? (
          <button type="button" className="stage-icon" title="Back to the save" onClick={() => setPage(null)}>
            ←
          </button>
        ) : null}
        <div className="stage-who">
          <h2 id="stage-title" data-stage-title className="stage-title" tabIndex={-1}>{title || "Saved item"}</h2>
          <span className="handle">{page ? hostOf(page) : who(item) || hostOf(item.url)}</span>
          <span className="by-date">{pageYt ? "YouTube" : live ? "live page" : sourceLabel(item.source)}</span>
        </div>
        <a className="stage-icon" href={orig} target="_blank" rel="noopener noreferrer" title="Open original">
          ↗
        </a>
        <button type="button" className="stage-icon" title="Close" aria-label="Close viewer" onClick={onClose}>
          ×
        </button>
      </header>
      {live ? (
        <div className="stage-body web">
          <iframe
            key={page!}
            className="stage-wv"
            src={page!}
            title={hostOf(page!)}
            onError={() => dropLive(page!)}
            onLoad={(e) => {
              const el = e.currentTarget;
              window.setTimeout(() => {
                if (!el.isConnected) return;
                if (inspectFrame(el)) setFrame("ok");
                else dropLive(page!);
              }, 50);
            }}
          />
        </div>
      ) : (
        <div className={ig ? "stage-body web" : "stage-body"}>
          {ig ? (
            <iframe className="stage-wv" src={ig} title="Instagram" />
          ) : (
            <>
              {ytId ? (
                <iframe
                  className="stage-wv"
                  style={{ minHeight: 0, aspectRatio: "16 / 9", maxHeight: "55%", flex: "none" }}
                  src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(ytId)}`}
                  title="YouTube"
                  allow="accelerometer; autoplay; encrypted-media; picture-in-picture"
                  allowFullScreen
                />
              ) : visual ? (
                visual.kind === "video" ? (
                  <video className="stage-shot video" src={visual.url} controls playsInline preload="metadata" />
                ) : (
                  <img className="stage-shot" src={visual.url} alt="" referrerPolicy="no-referrer" />
                )
              ) : null}
              <div className="stage-copy">
                {title ? <h3>{title}</h3> : null}
                {body ? <StageText text={body} permalink={item.url} onOutbound={pushPage} /> : null}
              </div>
            </>
          )}
        </div>
      )}
      <div className="stage-ai">
        <div className="stage-ai-row">
          <button
            type="button"
            className="primary"
            disabled={busy}
            title="Summarize this save"
            onClick={() => void generateProse()}
          >
            {busy ? "Summarizing…" : prose ? "Again" : "Summary"}
          </button>
          <button type="button" onClick={() => setNoteOpen(true)}>
            {noteOpen || notes.length ? "Note" : "Add note"}
          </button>
        </div>
        <div className="stage-organize" aria-label="Organize item">
          <div className="stage-organize-row">
            <label htmlFor="stage-tag">Tag</label>
            <input id="stage-tag" value={tagText} placeholder="Add a tag" onChange={(e) => { setTagText(e.target.value); setOrganizationError(null); }} />
            <button
              type="button"
              disabled={organizationBusy || !tagText.trim()}
              onClick={() => {
                const value = tagText.trim();
                if (!value) return;
                void applyOrganization(api.addTag(item.id, value), "Tag added").then((ok) => { if (ok) setTagText(""); });
              }}
            >Add</button>
          </div>
          <div className="stage-tags">
            {item.tags.map((tag) => (
              <span className="stage-token" key={tag.id}>
                {tag.name}
                <button type="button" aria-label={`Remove tag ${tag.name}`} disabled={organizationBusy} onClick={() => void applyOrganization(api.removeTag(item.id, tag.id), "Tag removed")}>×</button>
              </span>
            ))}
          </div>
          <div className="stage-organize-row">
            <label htmlFor="stage-collection">Collection</label>
            <select id="stage-collection" value={selectedCollection} onChange={(e) => setSelectedCollection(e.target.value)}>
              <option value="">Choose collection</option>
              {availableCollections.filter((collection) => !item.collections.some((current) => current.id === collection.id)).map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
            </select>
            <button type="button" disabled={organizationBusy || !selectedCollection} onClick={() => void applyOrganization(api.addToCollection(item.id, selectedCollection), "Added to collection").then((ok) => { if (ok) setSelectedCollection(""); })}>Add</button>
          </div>
          <div className="stage-tags">
            {item.collections.map((collection) => (
              <span className="stage-token" key={collection.id}>
                {collection.name}
                <button type="button" aria-label={`Remove from ${collection.name}`} disabled={organizationBusy} onClick={() => void applyOrganization(api.removeFromCollection(item.id, collection.id), "Removed from collection")}>×</button>
              </span>
            ))}
          </div>
          <div className="stage-statuses" role="group" aria-label="Item status">
            {(["inbox", "accepted", "snoozed", "archived", "rejected"] as const).map((status) => (
              <button key={status} type="button" className={item.status === status ? "active" : ""} disabled={organizationBusy || item.status === status} onClick={() => {
                if (status === "snoozed") {
                  if (!snoozeDate) {
                    setOrganizationError("Choose a snooze date first");
                    return;
                  }
                  const parsed = new Date(`${snoozeDate}T23:59:59`);
                  if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
                        setOrganizationError("Choose a future date");
                    return;
                  }
                  void applyOrganization(api.status(item.id, status, parsed.toISOString()), "Snoozed");
                  return;
                }
                void applyOrganization(api.status(item.id, status), status === "accepted" ? "Accepted" : status === "archived" ? "Archived" : status === "rejected" ? "Rejected" : "Moved to Inbox");
              }}>{status === "snoozed" ? "Snooze" : status.charAt(0).toUpperCase() + status.slice(1)}</button>
            ))}
            <label className="snooze-date" htmlFor="snooze-date">until <input id="snooze-date" type="date" min={today()} value={snoozeDate} onChange={(e) => { setSnoozeDate(e.target.value); setOrganizationError(null); }} /></label>
          </div>
          {organizationError ? <p className="action-error" role="alert">{organizationError}</p> : null}
          {organizationMessage ? <p className="action-ok" role="status">{organizationMessage}</p> : null}
        </div>
        {proseErr ? <p className="action-error" role="alert">{proseErr}</p> : null}
        {prose ? <p className="stage-prose">{prose}</p> : null}
        {notes.map((n) => (
          <p key={n.id} className="stage-notes">
            {n.body}
          </p>
        ))}
        {noteOpen ? (
          <>
            <textarea className="stage-note" placeholder="Write a note" value={note} onChange={(e) => { setNote(e.target.value); setOrganizationError(null); }} />
            <button
              type="button"
              className="primary"
              disabled={organizationBusy || !note.trim()}
              onClick={() => {
                const bodyText = note.trim();
                if (!bodyText) {
                  setOrganizationError("Note body is required");
                  return;
                }
                void applyOrganization(api.addNote(item.id, bodyText), "Note saved").then((ok) => { if (ok) setNote(""); });
              }}
            >
              Save note
            </button>
          </>
        ) : null}
      </div>
      </div>
    </div>
  );
}

export function StageText({ text, permalink: _permalink, onOutbound }: { text: string; permalink: string; onOutbound: (url: string) => void }) {
  const parts = text.split(/(https?:\/\/[^\s)>"']+)/g);
  return (
    <p>
      {parts.map((part, i) => {
        if (!/^https?:\/\//i.test(part)) return <Fragment key={i}>{part}</Fragment>;
        const label = part.replace(/^https?:\/\//, "");
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
      })}
    </p>
  );
}
