import type { CSSProperties } from "react";
import type { ItemCard } from "./api.ts";
import { motif, motifIcon } from "./motifs.ts";
import { firstVisual } from "./item-content.ts";

export function MotifSvg({ name, icon }: { name: string; icon?: boolean }) {
  return <span dangerouslySetInnerHTML={{ __html: icon ? motifIcon(name) : motif(name) }} />;
}

export function Poster({ color, ink, motifName, word }: { color: string; ink: string; motifName: string; word: string }) {
  return (
    <div className="media poster" style={{ ["--pbg" as string]: color, ["--pfg" as string]: ink } as CSSProperties}>
      <MotifSvg name={motifName} />
      <span className="poster-word">{word}</span>
    </div>
  );
}

export function CapturedMedia({ item }: { item: ItemCard }) {
  const m = firstVisual(item);
  if (!m) return null;
  return (
    <div className="media">
      {m.kind === "video" ? (
        <video src={m.url} muted playsInline preload="metadata" />
      ) : (
        <img src={m.url} alt="" referrerPolicy="no-referrer" loading="lazy" />
      )}
    </div>
  );
}
