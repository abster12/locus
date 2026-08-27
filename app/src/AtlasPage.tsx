import { useEffect, useState } from "react";
import { api, type ItemCard } from "./api.ts";
import { shelfOfTag } from "../../core/categories.ts";
import { detectPlaces, regionByName, type PlaceHit, type Region } from "../../core/places.ts";
import { cardTitle, firstVisual, hostOf, pubLabel, who } from "./item-content.ts";
import { CapturedMedia, Poster } from "./ItemVisuals.tsx";
import { useLinkPreview } from "./link-preview.ts";
import { firstStageDestination } from "./stage-navigation.ts";
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

export function AtlasPage({ onOpen }: { onOpen: (item: ItemCard, page?: string) => void }) {
  const [items, setItems] = useState<ItemCard[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .allItems("", controller.signal)
      .then((all) => setItems(all.filter((it) => it.tags.some((t) => shelfOfTag(t.name).key === "travel"))))
      .catch((e: unknown) => { if (!controller.signal.aborted) setErr(e instanceof Error ? e.message : String(e)); });
    return () => controller.abort();
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
  const scrollToRegion = (id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    if (target instanceof HTMLDetailsElement) target.open = true;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  };

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
              {items.length} save{items.length === 1 ? "" : "s"} · {ordered.length} region{ordered.length === 1 ? "" : "s"}
            </span>
          </div>
          <p className="pagesub">Travel saves grouped by place.</p>
        </div>
      </div>
      {err && <p className="bad">{err}</p>}
      {items.length === 0 ? (
        <p className="empty">No travel saves yet.</p>
      ) : (
        <>
          <nav className="atlas-nav" aria-label="Regions">
            {ordered.map((s) => (
              <button key={s.region.slug} type="button" onClick={() => scrollToRegion(`rg-${s.region.slug}`)}>
                <span className="sw" style={{ ["--c" as string]: s.region.color }} />
                {s.region.name.split(" &")[0]}
              </button>
            ))}
            {unplaced.length > 0 ? (
              <button className="unp" type="button" onClick={() => scrollToRegion("rg-unplaced")}>
                Unplaced · {unplaced.length}
              </button>
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
                Unplaced · {unplaced.length}
              </summary>
              <div className="inner">
                {unplaced.map((it) => (
                  <div key={it.id}>
                    • {who(it) || hostOf(it.url)} — {cardTitle(it) || it.body?.slice(0, 80) || it.url}
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
  return firstStageDestination(item) ?? null;
}

function AtlasCard({ item, region, hits, onOpen }: { item: ItemCard; region: Region; hits: PlaceHit[]; onOpen: (item: ItemCard, page?: string) => void }) {
  const word = hits.find((h) => h.region === region.name)?.place || item.title?.split(/\s+/)[0] || "travel";
  const caption = item.title || item.body?.replace(/\s+/g, " ").trim().slice(0, 120) || who(item) || item.url;
  return (
    <article
      className="place-card"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button")) return;
        onOpen(item, atlasPreviewUrl(item) ?? undefined);
      }}
    >
      <AtlasMedia item={item} region={region} word={word} />
      <div className="caption">
        <span className="cap-text">
          {caption}
          <small>{who(item) || hostOf(item.url)}</small>
        </span>
        <span className="cap-date">{pubLabel(item.publishedAt)}</span>
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
