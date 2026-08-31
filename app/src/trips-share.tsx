import { useEffect, useState } from "react";
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

/** Human-only share seam: preview → publish/cancel → copy link → revoke.
 * The link exists only in the publish response (the database stores a hash),
 * so it is kept for this tab in sessionStorage and re-minted on republish. */
export function ShareControl({ trip }: { trip: TripDocument }) {
  const [shared, setShared] = useState<TripShareState | null>(null);
  const [panel, setPanel] = useState<{ snapshot: TripShareSnapshot; digest: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const linkKey = `locus-trip-share-${trip.id}`;

  useEffect(() => {
    let alive = true;
    setPanel(null);
    setLink(null);
    setShared(null);
    try {
      const stored = sessionStorage.getItem(linkKey);
      if (stored) setLink(stored);
    } catch {
      /* sessionStorage unavailable: the link is simply not re-shown */
    }
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

  async function act(action: () => Promise<void>) {
    if (busy) return;
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

  const preview = () =>
    act(async () => {
      const result = await api.sharePreview(trip.id);
      setShared(result.shared);
      setPanel({ snapshot: result.snapshot, digest: result.digest });
    });

  const publish = () =>
    act(async () => {
      if (!panel) return;
      const result = await api.sharePublish(trip.id, trip.revision, panel.digest);
      const url = `${location.origin}/s/${result.token}`;
      try {
        sessionStorage.setItem(linkKey, url);
      } catch {
        /* ignore */
      }
      setShared({ revision: result.revision, updatedAt: result.updatedAt });
      setLink(url);
      setPanel(null);
    });

  const revoke = () =>
    act(async () => {
      if (!window.confirm("Revoke this shared link? It will stop working immediately.")) return;
      await api.shareRevoke(trip.id, trip.revision);
      try {
        sessionStorage.removeItem(linkKey);
      } catch {
        /* ignore */
      }
      setShared(null);
      setLink(null);
    });

  return (
    <span className="trip-share">
      {shared ? (
        <span className="chip trip-share-on">Shared · rev {shared.revision}</span>
      ) : null}
      {panel ? (
        <span className="trip-share-panel">
          <ShareSnapshotPreview snapshot={panel.snapshot} />
          <span className="trip-share-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={publish}>
              {shared ? "Update shared version" : "Publish"}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setPanel(null)}>
              Cancel
            </button>
          </span>
        </span>
      ) : (
        <button type="button" className="btn" disabled={busy} onClick={preview}>
          {shared ? "Update shared version" : "Share"}
        </button>
      )}
      {link ? (
        <a className="trip-share-link" href={link}>
          Open share link
        </a>
      ) : null}
      {shared ? (
        <button type="button" className="btn danger" disabled={busy} onClick={revoke}>
          Revoke
        </button>
      ) : null}
      {err ? (
        <span className="bad" role="alert">
          {err}
        </span>
      ) : null}
    </span>
  );
}
