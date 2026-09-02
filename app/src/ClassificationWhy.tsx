import type { ItemCard } from "./api.ts";

export function ClassificationWhy({ item }: { item: ItemCard }) {
  const rows = item.classifications?.flatMap((entry) => {
    const tag = item.tags.find((current) => current.id === entry.tagId);
    return tag ? [{ entry, tag }] : [];
  }) ?? [];
  if (!rows.length) return null;
  return (
    <ul className="intake-why" aria-label="Why these tags">
      {rows.map(({ entry, tag }) => (
        <li key={entry.tagId}>
          <span className="intake-why-tag">{tag.name}</span>
          {entry.rationale}
          {entry.evidence.map((basis) => (
            <span className="intake-why-evidence" key={`${basis.field}:${basis.text}`}>
              {basis.field}: {basis.text}
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}
