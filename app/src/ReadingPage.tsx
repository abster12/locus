import { useEffect, useState } from "react";
import { api, type ItemCard } from "./api.ts";
import { isReadingItem } from "../../core/sanitize.ts";
import { hostOf, pubLabel } from "./item-content.ts";
import { sourceLabel } from "./source-icons.ts";
import { usefulPreview, useLinkPreview } from "./link-preview.ts";
import { firstStageDestination } from "./stage-navigation.ts";
function savedFrom(source: string): string {
  return sourceLabel(source);
}
function readingTarget(item: ItemCard): string | undefined {
  return firstStageDestination(item);
}

export function ReadingPage({ onOpen }: { onOpen: (item: ItemCard, page?: string) => void }) {
  const [items, setItems] = useState<ItemCard[]>([]);
  const [sort, setSort] = useState<"pub" | "date">("pub");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .allItems("", controller.signal)
      .then((all) => setItems(all.filter((it) => isReadingItem(it.body, it.url))))
      .catch((e: unknown) => { if (!controller.signal.aborted) setErr(e instanceof Error ? e.message : String(e)); });
    return () => controller.abort();
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
        <h2>Reading</h2>
        <span className="count">
          {rows.length} save{rows.length === 1 ? "" : "s"} · {pubs} source{pubs === 1 ? "" : "s"}
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
      <p className="pagesub">Articles, videos, and other links from your saves.</p>
      {err && <p className="bad">{err}</p>}
      {rows.length === 0 ? (
        <p className="empty">No reading saved yet.</p>
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

function ClipCard({ item, url, host, onOpen }: { item: ItemCard; url: string; host: string; onOpen: (item: ItemCard, page?: string) => void }) {
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
        onOpen(item, url);
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
