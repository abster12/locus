import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  exportFileName,
  exportTripHtml,
  exportTripIcs,
  exportTripText,
  projectTripForExport,
  type ExportTrip,
} from "./trips.ts";
import { formatDate } from "./trips-format.ts";
import { api, type TripDocument, type TripShareSnapshot, type TripShareState, type TripShareStop } from "./api.ts";

const SHARE_KIND_LABEL: Record<TripShareStop["kind"], string> = {
  item: "Saved item",
  place: "Place",
  outside: "Outside",
  hole: "Unresolved",
};

export function ShareSnapshotPreview({ snapshot }: { snapshot: TripShareSnapshot }) {
  return (
    <div className="trip-share-preview">
      <p className="trip-share-meta">
        {snapshot.destination} ·{" "}
        {snapshot.startDate && snapshot.endDate
          ? `${formatDate(snapshot.startDate)} – ${formatDate(snapshot.endDate)}`
          : `${snapshot.durationDays} days · dates open`}
        {snapshot.timezone ? ` · ${snapshot.timezone}` : ""}
      </p>
      {[...snapshot.days, { label: "Unscheduled", date: null, stops: snapshot.unscheduled }].map((day) => (
        <section key={day.label} className="trip-share-day">
          <h4>{day.label}</h4>
          {day.stops.length === 0 ? (
            <p className="trip-share-nostops">No confirmed stops.</p>
          ) : (
            <ul>
              {day.stops.map((stop, index) => (
                <li key={`${stop.name}-${index}`}>
                  <span className="chip trip-share-kind">{SHARE_KIND_LABEL[stop.kind]}</span> <b>{stop.name}</b>
                  {stop.timeWindow ? <span className="trip-share-time">{stop.timeWindow}</span> : null}
                  {stop.durationMinutes ? <span className="trip-share-time">{stop.durationMinutes} min</span> : null}
                  {stop.notes ? <span className="trip-share-notes">{stop.notes}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

async function copyPlain(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      return document.execCommand("copy");
    } finally {
      area.remove();
    }
  }
}

export function downloadFile(name: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Local export seam (ticket 12): text copy, print/PDF, self-contained HTML,
 * and ICS generated in the browser from data the page already has. The user
 * picks the source — the private revision or the sanitized snapshot — and the
 * active projection is named before any action. No export call leaves the
 * origin; the snapshot source reuses the share preview endpoint. */
export function ExportControl({ trip }: { trip: TripDocument }) {
  const [source, setSource] = useState<"private" | "snapshot">("private");
  const [shared, setShared] = useState<TripShareState | null>(null);
  const [snapshot, setSnapshot] = useState<TripShareSnapshot | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [printHtml, setPrintHtml] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSource("private");
    setSnapshot(null);
    setShared(null);
    setNotice("");
    api
      .shareState(trip.id)
      .then((result) => {
        if (alive) setShared(result.shared);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [trip.id, trip.revision]);

  const input: ExportTrip = source === "snapshot" && snapshot ? snapshot : projectTripForExport(trip);
  const updatedAt = source === "snapshot" ? shared?.updatedAt ?? null : trip.updatedAt;
  const projection =
    source === "snapshot"
      ? `Sanitized snapshot — public fields only${shared ? ` · shared revision ${shared.revision}` : " · not published yet"}`
      : `Current private revision ${trip.revision} — public notes, drafts included`;

  async function pick(next: "private" | "snapshot"): Promise<void> {
    setSource(next);
    if (next !== "snapshot" || snapshot) return;
    setBusy(true);
    try {
      const result = await api.sharePreview(trip.id);
      setShared(result.shared);
      setSnapshot(result.snapshot);
    } catch (e: unknown) {
      setNotice(e instanceof Error ? e.message : String(e));
      setSource("private");
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    const ok = await copyPlain(exportTripText(input));
    setNotice(ok ? "Itinerary copied as text." : "Copying is blocked by the browser.");
  }

  function openPrint(): void {
    setPrintHtml(exportTripHtml(input, { updatedAt }));
    setNotice("Print view opened — choose Save as PDF there.");
  }

  return (
    <section className="trip-export" aria-label="Export">
      <fieldset className="trip-export-source">
        <legend>Export source</legend>
        <label>
          <input type="radio" name={`trip-export-${trip.id}`} checked={source === "private"} onChange={() => void pick("private")} />
          Current private revision
        </label>
        <label>
          <input type="radio" name={`trip-export-${trip.id}`} checked={source === "snapshot"} onChange={() => void pick("snapshot")} />
          Sanitized snapshot
        </label>
      </fieldset>
      <p className="trip-export-projection" role="status">
        Exporting: {projection}
      </p>
      <p className="trip-export-actions">
        <button type="button" className="btn trip-export-copy" disabled={busy} onClick={() => void copy()}>
          Copy text
        </button>
        <button type="button" className="btn trip-export-print" disabled={busy} onClick={openPrint}>
          Print / PDF
        </button>
        <button
          type="button"
          className="btn trip-export-html"
          disabled={busy}
          onClick={() => downloadFile(exportFileName(input.title, "html"), "text/html", exportTripHtml(input, { updatedAt }))}
        >
          Download HTML
        </button>
        <button
          type="button"
          className="btn trip-export-ics"
          disabled={busy}
          onClick={() => downloadFile(exportFileName(input.title, "ics"), "text/calendar", exportTripIcs(input, { stamp: updatedAt }))}
        >
          Download calendar
        </button>
      </p>
      <p className="trip-export-notice">{notice}</p>
      {printHtml ? (
        <iframe
          className="trip-print-frame"
          title="Print view"
          aria-hidden="true"
          srcDoc={printHtml}
          onLoad={(event) => event.currentTarget.contentWindow?.print()}
        />
      ) : null}
    </section>
  );
}

function shareUrl(token: string): string {
  return `${location.origin}/s/${token}`;
}

function shareLinkKey(tripId: string): string {
  return `locus-trip-share-${tripId}`;
}

function readStoredShareLink(tripId: string): string | null {
  try {
    return localStorage.getItem(shareLinkKey(tripId));
  } catch {
    return null;
  }
}

function writeStoredShareLink(tripId: string, url: string): void {
  try {
    localStorage.setItem(shareLinkKey(tripId), url);
  } catch {
    /* ignore */
  }
}

function clearStoredShareLink(tripId: string): void {
  try {
    localStorage.removeItem(shareLinkKey(tripId));
  } catch {
    /* ignore */
  }
}

/** Human-only share: first Share previews; later Share copies this browser's
 * stored capability URL (localStorage, so tabs and sessions keep it). The raw
 * token exists only in the publish response; the database stores a hash. */
export function useTripShare(trip: TripDocument | null) {
  const [shared, setShared] = useState<TripShareState | null>(null);
  const [panel, setPanel] = useState<{ snapshot: TripShareSnapshot; digest: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [fallback, setFallback] = useState<string | null>(null);
  const tripId = trip?.id ?? "";
  const revision = trip?.revision ?? 0;

  useEffect(() => {
    if (!tripId) return;
    let alive = true;
    setPanel(null);
    setNotice("");
    setFallback(null);
    setErr(null);
    const stored = readStoredShareLink(tripId);
    setLink(stored);
    setShared(null);
    api
      .shareState(tripId)
      .then((result) => {
        if (!alive) return;
        setShared(result.shared);
        if (!result.shared) {
          clearStoredShareLink(tripId);
          setLink(null);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tripId, revision]);

  async function act(action: () => Promise<void>) {
    if (busy || !trip) return;
    setBusy(true);
    setErr(null);
    try {
      await action();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(url: string, copied: string) {
    const ok = await copyPlain(url);
    setFallback(url);
    setNotice(ok ? copied : "Copying is blocked by the browser. Select the link and copy it.");
  }

  const preview = () =>
    act(async () => {
      if (!trip) return;
      const result = await api.sharePreview(trip.id);
      setShared(result.shared);
      setPanel({ snapshot: result.snapshot, digest: result.digest });
    });

  const primary = () => {
    if (busy) return;
    if (shared) {
      if (link) void copyLink(link, "Share link copied.");
      else setNotice("The share link is only available in this browser. Update the snapshot to create a new link.");
      return;
    }
    void preview();
  };

  const confirmPublish = () =>
    act(async () => {
      if (!trip || !panel) return;
      const updating = Boolean(shared);
      const result = await api.sharePublish(trip.id, trip.revision, panel.digest);
      setShared({ revision: result.revision, updatedAt: result.updatedAt });
      if (!result.token) {
        setPanel(null);
        setNotice(updating ? "Shared version updated." : "Share link created.");
        return;
      }
      const url = shareUrl(result.token);
      writeStoredShareLink(trip.id, url);
      setLink(url);
      await copyLink(url, updating ? "Shared version updated and copied." : "Read-only link created and copied.");
      setPanel(null);
    });

  const revoke = () =>
    act(async () => {
      if (!trip) return;
      if (!window.confirm("Revoke this shared link? It will stop working immediately.")) return;
      await api.shareRevoke(trip.id, trip.revision);
      clearStoredShareLink(trip.id);
      setShared(null);
      setLink(null);
      setFallback(null);
      setNotice("Share link revoked.");
    });

  return {
    shared,
    panel,
    busy,
    err,
    notice,
    fallback,
    primary,
    preview,
    confirmPublish,
    cancel: () => setPanel(null),
    revoke,
  };
}

export function ShareButton({ share }: { share: ReturnType<typeof useTripShare> }) {
  return (
    <span className="trip-share">
      {share.shared ? <span className="chip trip-share-on">Shared · rev {share.shared.revision}</span> : null}
      <button
        type="button"
        className="btn trip-share-btn"
        aria-haspopup="dialog"
        aria-expanded={Boolean(share.panel)}
        onClick={share.primary}
      >
        Share
      </button>
    </span>
  );
}

export function SharePreviewPanel({ share }: { share: ReturnType<typeof useTripShare> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const panel = share.panel;

  useLayoutEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const trigger = document.querySelector(".trip-share-btn");
    const previouslyFocused = trigger instanceof HTMLElement ? trigger : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!el.open) el.showModal();
    titleRef.current?.focus();
    return () => {
      if (el.open) el.close();
      previouslyFocused?.focus();
    };
  }, []);

  if (!panel) return null;
  const title = share.shared ? "Update the shared itinerary" : "Create a read-only link";
  return (
    <dialog
      ref={dialog}
      className="trip-add-dialog trip-share-panel"
      aria-labelledby="trip-share-title"
      aria-describedby="trip-share-copy"
      aria-busy={share.busy || undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!share.busy) share.cancel();
      }}
    >
      <div className="trip-add-head">
        <h2 id="trip-share-title" ref={titleRef} tabIndex={-1}>
          {title}
        </h2>
      </div>
      <p id="trip-share-copy" className="trip-place-hint">
        This is the exact snapshot a public link will show. Cancel keeps it private.
      </p>
      <ShareSnapshotPreview snapshot={panel.snapshot} />
      <span className="trip-share-actions">
        <button type="button" className="btn primary" disabled={share.busy} onClick={share.confirmPublish}>
          {share.shared ? "Update shared version" : "Create and copy link"}
        </button>
        <button type="button" className="btn" disabled={share.busy} onClick={share.cancel}>
          Cancel
        </button>
      </span>
    </dialog>
  );
}

export function ShareStatus({ share }: { share: ReturnType<typeof useTripShare> }) {
  return (
    <>
      {share.fallback ? (
        <p className="trip-share-fallback">
          <label>
            Share link
            <input className="trip-share-link" readOnly value={share.fallback} onFocus={(event) => event.currentTarget.select()} />
          </label>
        </p>
      ) : null}
      {share.notice ? (
        <p className="trip-share-notice" role="status">
          {share.notice}
        </p>
      ) : null}
      {share.err ? (
        <p className="bad" role="alert">
          {share.err}
        </p>
      ) : null}
    </>
  );
}
