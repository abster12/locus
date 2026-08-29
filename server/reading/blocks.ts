import { createHash } from "node:crypto";
import { cleanupUrl } from "./policy.ts";

export const CONTENT_BLOCKS_VERSION = 1;
export const MAX_BLOCKS = 200;
export const MAX_SEARCH_TEXT = 100_000;
export const MAX_TABLE_ROWS = 40;
export const MAX_TABLE_COLS = 12;
export const WORDS_PER_MINUTE = 230;

export type ReadingMark =
  | { type: "em" }
  | { type: "strong" }
  | { type: "code" }
  | { type: "link"; href: string };

export interface ReadingInline {
  text: string;
  marks: ReadingMark[];
}

export type ReadingBlock =
  | { id: string; type: "heading"; level: 2 | 3 | 4; inlines: ReadingInline[] }
  | { id: string; type: "paragraph"; inlines: ReadingInline[] }
  | { id: string; type: "list"; ordered: boolean; items: { id: string; blocks: ReadingBlock[] }[] }
  | { id: string; type: "quote"; blocks: ReadingBlock[] }
  | { id: string; type: "code"; language: string | null; text: string }
  | { id: string; type: "hr" }
  | {
      id: string;
      type: "table";
      rows: { id: string; cells: { id: string; header: boolean; inlines: ReadingInline[] }[] }[];
    }
  | { id: string; type: "image"; assetId: string; alt: string; caption: string | null };

export interface ReadingContent {
  version: 1;
  blocks: ReadingBlock[];
}

export interface ReadingTocEntry {
  id: string;
  level: 2 | 3 | 4;
  text: string;
}

export function readingMinutes(wordCount: number | null | undefined): number | null {
  if (wordCount == null || wordCount <= 0) return null;
  return Math.ceil(wordCount / WORDS_PER_MINUTE);
}

export function blockIdentity(kind: string, text: string): string {
  return createHash("sha256").update(`${kind}\n${text}`).digest("hex").slice(0, 10);
}

/** Identity plus occurrence — not global order — so a refresh can remap surviving blocks. */
export function blockId(kind: string, occurrence: number, text: string): string {
  return `${blockIdentity(kind, text)}-${occurrence}`;
}

export function blockIdentityFromId(id: string): string {
  const parts = id.split("-");
  if (parts.length < 2) return id;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (/^\d+$/.test(first) && parts[1] && !/^\d+$/.test(parts[1])) return parts.slice(1).join("-");
  if (/^\d+$/.test(last)) return parts.slice(0, -1).join("-");
  return id;
}

export function remapAnchor(
  anchor: { blockId: string; offset: number } | null,
  blocks: ReadingBlock[],
): { blockId: string; offset: number } | null {
  if (!anchor) return null;
  const ids: string[] = [];
  walk(blocks, (block) => ids.push(block.id));
  if (ids.includes(anchor.blockId)) return { blockId: anchor.blockId, offset: anchor.offset };
  const ident = blockIdentityFromId(anchor.blockId);
  const match = ids.find((id) => blockIdentityFromId(id) === ident);
  if (match) return { blockId: match, offset: anchor.offset };
  return null;
}

export function contentHash(content: ReadingContent): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export function inlineText(inlines: ReadingInline[]): string {
  return inlines.map((part) => part.text).join("");
}

export function blockText(block: ReadingBlock): string {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return inlineText(block.inlines);
    case "list":
      return block.items.map((item) => item.blocks.map(blockText).join(" ")).join(" ");
    case "quote":
      return block.blocks.map(blockText).join(" ");
    case "code":
      return block.text;
    case "table":
      return block.rows.flatMap((row) => row.cells.map((cell) => inlineText(cell.inlines))).join(" ");
    case "image":
      return [block.alt, block.caption].filter(Boolean).join(" ");
    default:
      return "";
  }
}

export function collectText(blocks: ReadingBlock[]): string {
  return blocks.map(blockText).join("\n").replace(/\s+/g, " ").trim();
}

export function wordCountOf(text: string): number {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  return parts.length;
}

export function tocFrom(blocks: ReadingBlock[]): ReadingTocEntry[] {
  const toc: ReadingTocEntry[] = [];
  walk(blocks, (block) => {
    if (block.type === "heading") toc.push({ id: block.id, level: block.level, text: inlineText(block.inlines).trim() });
  });
  return toc;
}

export function hasBlockId(blocks: ReadingBlock[], id: string): boolean {
  let found = false;
  walk(blocks, (block) => {
    if (block.id === id) found = true;
  });
  return found;
}

export function validateContent(raw: unknown): ReadingContent | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as { version?: unknown; blocks?: unknown };
  if (rec.version !== CONTENT_BLOCKS_VERSION || !Array.isArray(rec.blocks)) return null;
  const blocks = rec.blocks.map((block) => validateBlock(block));
  if (blocks.some((block) => !block)) return null;
  const tree = { version: 1 as const, blocks: blocks as ReadingBlock[] };
  if (countBlocks(tree.blocks) > MAX_BLOCKS) return null;
  return tree;
}

/** Drop image blocks whose assets are not in this archive/library. Other blocks stay. */
export function dropMissingImages(content: ReadingContent, assetIds: Set<string>): ReadingContent {
  return { version: 1, blocks: filterImageBlocks(content.blocks, assetIds) };
}

function filterImageBlocks(blocks: ReadingBlock[], assetIds: Set<string>): ReadingBlock[] {
  const out: ReadingBlock[] = [];
  for (const block of blocks) {
    if (block.type === "image") {
      if (assetIds.has(block.assetId)) out.push(block);
      continue;
    }
    if (block.type === "list") {
      out.push({
        ...block,
        items: block.items.map((item) => ({ ...item, blocks: filterImageBlocks(item.blocks, assetIds) })),
      });
      continue;
    }
    if (block.type === "quote") {
      out.push({ ...block, blocks: filterImageBlocks(block.blocks, assetIds) });
      continue;
    }
    out.push(block);
  }
  return out;
}

function validateBlock(raw: unknown): ReadingBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== "string" || rec.id.length === 0 || rec.id.length > 80) return null;
  switch (rec.type) {
    case "heading": {
      const level = rec.level;
      if (level !== 2 && level !== 3 && level !== 4) return null;
      const inlines = validateInlines(rec.inlines);
      return inlines ? { id: rec.id, type: "heading", level, inlines } : null;
    }
    case "paragraph": {
      const inlines = validateInlines(rec.inlines);
      return inlines ? { id: rec.id, type: "paragraph", inlines } : null;
    }
    case "list": {
      if (typeof rec.ordered !== "boolean" || !Array.isArray(rec.items)) return null;
      const items = rec.items.map((item) => {
        if (!item || typeof item !== "object") return null;
        const row = item as { id?: unknown; blocks?: unknown };
        if (typeof row.id !== "string" || !Array.isArray(row.blocks)) return null;
        const nested = row.blocks.map((block) => validateBlock(block));
        if (nested.some((block) => !block)) return null;
        return { id: row.id, blocks: nested as ReadingBlock[] };
      });
      if (items.some((item) => !item)) return null;
      return { id: rec.id, type: "list", ordered: rec.ordered, items: items as { id: string; blocks: ReadingBlock[] }[] };
    }
    case "quote": {
      if (!Array.isArray(rec.blocks)) return null;
      const nested = rec.blocks.map((block) => validateBlock(block));
      if (nested.some((block) => !block)) return null;
      return { id: rec.id, type: "quote", blocks: nested as ReadingBlock[] };
    }
    case "code": {
      if (typeof rec.text !== "string") return null;
      if (rec.language !== null && typeof rec.language !== "string") return null;
      return { id: rec.id, type: "code", language: rec.language, text: rec.text.slice(0, 50_000) };
    }
    case "hr":
      return { id: rec.id, type: "hr" };
    case "table": {
      if (!Array.isArray(rec.rows) || rec.rows.length > MAX_TABLE_ROWS) return null;
      const rows = rec.rows.map((row) => {
        if (!row || typeof row !== "object") return null;
        const r = row as { id?: unknown; cells?: unknown };
        if (typeof r.id !== "string" || !Array.isArray(r.cells) || r.cells.length > MAX_TABLE_COLS) return null;
        const cells = r.cells.map((cell) => {
          if (!cell || typeof cell !== "object") return null;
          const c = cell as { id?: unknown; header?: unknown; inlines?: unknown };
          const inlines = validateInlines(c.inlines);
          if (typeof c.id !== "string" || !inlines) return null;
          return { id: c.id, header: c.header === true, inlines };
        });
        if (cells.some((cell) => !cell)) return null;
        return { id: r.id, cells: cells as { id: string; header: boolean; inlines: ReadingInline[] }[] };
      });
      if (rows.some((row) => !row)) return null;
      return { id: rec.id, type: "table", rows: rows as ReadingBlock extends { type: "table" } ? ReadingBlock["rows"] : never };
    }
    case "image": {
      if (typeof rec.assetId !== "string" || !rec.assetId || /[:/\\]/.test(rec.assetId) || /^https?:/i.test(rec.assetId)) {
        return null;
      }
      if (typeof rec.alt !== "string") return null;
      if (rec.caption !== null && typeof rec.caption !== "string") return null;
      return { id: rec.id, type: "image", assetId: rec.assetId, alt: rec.alt, caption: rec.caption };
    }
    default:
      return null;
  }
}

function validateInlines(raw: unknown): ReadingInline[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ReadingInline[] = [];
  for (const part of raw) {
    if (!part || typeof part !== "object") return null;
    const rec = part as { text?: unknown; marks?: unknown };
    if (typeof rec.text !== "string") return null;
    if (!Array.isArray(rec.marks)) return null;
    const marks: ReadingMark[] = [];
    for (const mark of rec.marks) {
      if (!mark || typeof mark !== "object") return null;
      const m = mark as { type?: unknown; href?: unknown };
      if (m.type === "em" || m.type === "strong" || m.type === "code") marks.push({ type: m.type });
      else if (m.type === "link" && typeof m.href === "string") {
        const href = cleanupUrl(m.href)?.canonicalUrl;
        if (!href) return null;
        marks.push({ type: "link", href });
      } else return null;
    }
    out.push({ text: rec.text, marks });
  }
  return out;
}

function countBlocks(blocks: ReadingBlock[]): number {
  let n = 0;
  walk(blocks, () => {
    n += 1;
  });
  return n;
}

function walk(blocks: ReadingBlock[], visit: (block: ReadingBlock) => void): void {
  for (const block of blocks) {
    visit(block);
    if (block.type === "list") {
      for (const item of block.items) walk(item.blocks, visit);
    } else if (block.type === "quote") {
      walk(block.blocks, visit);
    }
  }
}
