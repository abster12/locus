import { sourceIcon, sourceLabel } from "./source-icons.ts";

export function SourceMark({ source, named = true }: { source: string; named?: boolean }) {
  const name = sourceLabel(source);
  return (
    <span className={`sourcemark src-${source}`} title={name}>
      <span className="ico" dangerouslySetInnerHTML={{ __html: sourceIcon(source) }} />
      {named ? <span className="sourcemark-name">{name}</span> : null}
    </span>
  );
}
