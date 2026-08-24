export type SummaryScope = "day" | "collection" | "selection" | "item";

export interface CitedItemV1 {
  id: string;
  title: string | null;
  body: string | null;
  url: string;
  authorName: string | null;
  authorHandle: string | null;
  source: string;
  contentType: string;
}

export type DeterministicBlockV1 =
  | { kind: "captures-by-source"; title: string; rows: { source: string; count: number; itemIds: string[] }[] }
  | { kind: "new-creators"; title: string; rows: { name: string; count: number; itemIds: string[] }[] }
  | { kind: "common-tags"; title: string; rows: { tag: string; count: number; itemIds: string[] }[] }
  | { kind: "collection-adds"; title: string; rows: { collection: string; count: number; itemIds: string[] }[] }
  | { kind: "inbox"; title: string; count: number; itemIds: string[] }
  | { kind: "excerpts"; title: string; rows: { itemId: string; excerpt: string }[] }
  | { kind: "citations"; title: string; itemIds: string[] };

export interface SummarySnapshotV1 {
  scope: SummaryScope;
  scopeRef: string;
  generatedAt: string;
  blocks: DeterministicBlockV1[];
  items: CitedItemV1[];
}

export interface ProseSummaryV1 {
  generatorId: string;
  generatorVersion: string;
  prose: string;
  citations: string[];
}

export interface SummaryGenerator {
  id: string;
  version: string;
  generate(snapshot: SummarySnapshotV1): Promise<ProseSummaryV1>;
}

export function excerptOf(body: string | null, title: string | null): string {
  const text = (body || title || "").replace(/\s+/g, " ").trim();
  if (text.length <= 180) return text;
  return `${text.slice(0, 177)}…`;
}

export function filterCitations(proseCitations: string[], snapshotItemIds: string[]): string[] {
  const allowed = new Set(snapshotItemIds);
  return proseCitations.filter((id) => allowed.has(id));
}
