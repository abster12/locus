import { Worker } from "node:worker_threads";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import {
  blockId,
  blockIdentity,
  collectText,
  MAX_BLOCKS,
  MAX_SEARCH_TEXT,
  MAX_TABLE_COLS,
  MAX_TABLE_ROWS,
  validateContent,
  wordCountOf,
  type ReadingBlock,
  type ReadingContent,
  type ReadingInline,
  type ReadingMark,
} from "./blocks.ts";
import { cleanupUrl, hostOf, type ReadingKind } from "./policy.ts";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type Child = DefaultTreeAdapterMap["childNode"];

type ExtractCtx = { seen: Map<string, number>; title: string; baseUrl: string };

function nextBlockId(ctx: ExtractCtx, kind: string, text: string): string {
  const ident = blockIdentity(kind, text);
  const n = (ctx.seen.get(ident) ?? 0) + 1;
  ctx.seen.set(ident, n);
  return blockId(kind, n, text);
}

const SKIP = new Set([
  "script",
  "style",
  "noscript",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "svg",
  "math",
  "template",
  "canvas",
  "video",
  "audio",
  "source",
  "track",
  "applet",
  "frame",
  "frameset",
  "link",
  "meta",
  "head",
]);

const CHROME = new Set(["nav", "footer"]);
const NOISE_CLASS =
  /\b(cookie|consent|gdpr|paywall|subscribe|newsletter|related-posts|advert|adsbygoogle|social-share|comments?)\b/i;

export interface ExtractedPage {
  title: string | null;
  subtitle: string | null;
  byline: string | null;
  publication: string | null;
  publishedAt: string | null;
  language: string | null;
  canonical: string | null;
  excerpt: string | null;
  heroUrl: string | null;
  content: ReadingContent | null;
  searchText: string;
  wordCount: number;
  kind: ReadingKind;
  hasArticle: boolean;
  scriptCount: number;
  linkCount: number;
  linkedWordCount: number;
  formControlCount: number;
  commerceSignals: number;
  text: string;
}

export async function extractPageBounded(
  html: string,
  finalUrl: string,
  fallbackTitle: string | null,
  timeoutMs = 2_000,
): Promise<ExtractedPage> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./extract-task.ts", import.meta.url), {
      workerData: { html, finalUrl, fallbackTitle },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("reading extraction timed out"));
    }, timeoutMs);
    worker.once("message", (message: { ok: boolean; value?: ExtractedPage; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (message.ok && message.value) resolve(message.value);
      else reject(new Error(message.error || "reading extraction failed"));
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function extractPage(html: string, finalUrl: string, fallbackTitle: string | null): ExtractedPage {
  const document = parse(html, { scriptingEnabled: false });
  const htmlEl = findTag(document, "html");
  const head = htmlEl ? findTag(htmlEl, "head") : findTag(document, "head");
  const body = htmlEl ? findTag(htmlEl, "body") : findTag(document, "body");
  const meta = readMeta(head, finalUrl);
  const scriptCount = countTags(document, "script");
  const articleRoot = pickArticle(body);
  const hasArticle = Boolean(articleRoot && (articleRoot.tagName === "article" || classOf(articleRoot).includes("markdown-body")));
  const linkCount = countTags(articleRoot ?? body ?? document, "a");
  const linkedWordCount = wordCountOf(textInTags(articleRoot ?? body ?? document, "a"));
  const formControlCount = ["form", "input", "button", "select", "textarea"].reduce(
    (total, tag) => total + countTags(articleRoot ?? body ?? document, tag),
    0,
  );
  const title = meta.title || fallbackTitle;
  const blocks: ReadingBlock[] = [];
  const ctx: ExtractCtx = { seen: new Map(), title: title ?? "", baseUrl: finalUrl };
  if (articleRoot) mapChildren(articleRoot, blocks, ctx);
  const trimmed = blocks.slice(0, MAX_BLOCKS);
  const content = trimmed.length ? validateContent({ version: 1, blocks: trimmed }) : null;
  const text = content ? collectText(content.blocks) : visibleText(articleRoot ?? body);
  const wordCount = wordCountOf(text);
  const excerpt = (meta.description || text).replace(/\s+/g, " ").trim().slice(0, 400) || null;
  const commerceSignals = commerceEvidence(articleRoot ?? body, text);
  return {
    title,
    subtitle: meta.subtitle,
    byline: meta.byline,
    publication: meta.publication || hostOf(finalUrl),
    publishedAt: meta.publishedAt,
    language: meta.language || langOf(htmlEl),
    canonical: meta.canonical,
    excerpt,
    heroUrl: meta.image,
    content,
    searchText: text.slice(0, MAX_SEARCH_TEXT),
    wordCount,
    kind: inferKind(finalUrl, meta.ogType, classOf(articleRoot)),
    hasArticle,
    scriptCount,
    linkCount,
    linkedWordCount,
    formControlCount,
    commerceSignals,
    text,
  };
}

export function qualifiesAsReadable(extracted: ExtractedPage): boolean {
  if (!extracted.content) return false;
  // Publisher chrome (nav, related-reading) often lives inside <article>. A long
  // extracted body is enough; link-ratio is for directories without article markup.
  if (extracted.hasArticle && extracted.wordCount >= 200) return true;
  const linkDominated =
    extracted.linkCount >= 10 && extracted.linkedWordCount / Math.max(1, extracted.wordCount) > 0.45;
  if (linkDominated || (!extracted.hasArticle && extracted.formControlCount >= 3)) return false;
  if (!extracted.hasArticle && extracted.commerceSignals >= 2) return false;
  if (extracted.wordCount >= 200) return true;
  const codeChars = extracted.content
    ? extracted.content.blocks.reduce((n, block) => n + (block.type === "code" ? block.text.length : 0), 0)
    : 0;
  if (codeChars >= 400) return true;
  if (extracted.wordCount >= 80 && extracted.hasArticle && extracted.title) return true;
  return false;
}

function inferKind(url: string, ogType: string | null, articleClass: string): ReadingKind {
  try {
    const parsed = new URL(url);
    const host = hostOf(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (/(^|\.)(github|gitlab)\.com$/i.test(host) && parts.length === 2) return "repository";
    if (parts[0] === "docs" || host.startsWith("docs.") || articleClass.includes("markdown-body") && parts[0] === "docs") {
      return "documentation";
    }
  } catch {
    // ignore
  }
  if (ogType && /documentation|tech|guide/i.test(ogType)) return "documentation";
  return "article";
}

function readMeta(head: Element | null, baseUrl: string): {
  title: string | null;
  subtitle: string | null;
  byline: string | null;
  publication: string | null;
  publishedAt: string | null;
  language: string | null;
  canonical: string | null;
  description: string | null;
  image: string | null;
  ogType: string | null;
} {
  const titleEl = head ? findTag(head, "title") : null;
  const titleText = titleEl ? collapse(textOf(titleEl)) : null;
  const meta = (names: string[]): string | null => {
    if (!head) return null;
    for (const child of head.childNodes) {
      if (!isElement(child) || child.tagName !== "meta") continue;
      const key = (attr(child, "property") ?? attr(child, "name") ?? "").toLowerCase();
      if (names.includes(key)) {
        const content = attr(child, "content")?.trim();
        if (content) return content;
      }
    }
    return null;
  };
  let canonical: string | null = null;
  if (head) {
    for (const child of head.childNodes) {
      if (!isElement(child) || child.tagName !== "link") continue;
      if ((attr(child, "rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")) {
        const href = attr(child, "href");
        if (href) {
          try {
            canonical = cleanupUrl(new URL(href, baseUrl).toString())?.canonicalUrl ?? null;
          } catch {
            canonical = null;
          }
        }
      }
    }
  }
  const imageRaw = meta(["og:image", "og:image:url", "twitter:image", "twitter:image:src"]);
  let image: string | null = null;
  if (imageRaw) {
    try {
      image = cleanupUrl(new URL(imageRaw, baseUrl).toString())?.canonicalUrl ?? null;
    } catch {
      image = null;
    }
  }
  const published = meta(["article:published_time", "og:article:published_time", "date", "dc.date"]);
  return {
    title: meta(["og:title", "twitter:title"]) || titleText,
    subtitle: meta(["og:description"]) ? null : meta(["article:subtitle"]),
    byline: meta(["author", "article:author", "og:article:author", "dc.creator"]),
    publication: meta(["og:site_name", "application-name"]),
    publishedAt: published && !Number.isNaN(Date.parse(published)) ? new Date(published).toISOString() : null,
    language: meta(["og:locale", "language"]),
    canonical,
    description: meta(["og:description", "twitter:description", "description"]),
    image,
    ogType: meta(["og:type"]),
  };
}

function pickArticle(body: Element | null): Element | null {
  if (!body) return null;
  return (
    findMatch(body, (el) => el.tagName === "article") ??
    findMatch(body, (el) => (attr(el, "role") ?? "").toLowerCase() === "main") ??
    findTag(body, "main") ??
    findMatch(body, (el) => /\b(markdown-body|entry-content|post-content|article-body|post-body)\b/i.test(classOf(el))) ??
    body
  );
}

function mapChildren(parent: Element, out: ReadingBlock[], ctx: ExtractCtx): void {
  for (const child of parent.childNodes) {
    if (out.length >= MAX_BLOCKS) return;
    if (!isElement(child)) {
      const text = collapse(child.nodeName === "#text" ? child.value : "");
      if (text) pushParagraph(out, ctx, [{ text, marks: [] }]);
      continue;
    }
    mapElement(child, out, ctx);
  }
}

function mapElement(el: Element, out: ReadingBlock[], ctx: ExtractCtx): void {
  if (out.length >= MAX_BLOCKS) return;
  if (SKIP.has(el.tagName) || hidden(el) || noisy(el)) return;
  if (CHROME.has(el.tagName) && el.tagName !== "header") return;
  if ((attr(el, "role") ?? "").toLowerCase() === "navigation") return;

  if (/^h[1-6]$/.test(el.tagName)) {
    const inlines = collectInlines(el, ctx);
    const text = collapse(inlines.map((part) => part.text).join(""));
    if (!text) return;
    if (el.tagName === "h1" && normalize(text) === normalize(ctx.title)) return;
    const level = el.tagName === "h1" || el.tagName === "h2" ? 2 : el.tagName === "h3" ? 3 : 4;
    out.push({ id: nextBlockId(ctx, "heading", text), type: "heading", level, inlines });
    return;
  }
  if (el.tagName === "p") {
    const inlines = collectInlines(el, ctx);
    if (collapse(inlines.map((part) => part.text).join(""))) pushParagraph(out, ctx, inlines);
    return;
  }
  if (el.tagName === "ul" || el.tagName === "ol") {
    const items: { id: string; blocks: ReadingBlock[] }[] = [];
    for (const child of el.childNodes) {
      if (!isElement(child) || child.tagName !== "li") continue;
      const nested: ReadingBlock[] = [];
      const hasBlockChildren = child.childNodes.some(
        (node) => isElement(node) && /^(p|div|section|article|h[1-6]|ul|ol|blockquote|pre|hr|table)$/.test(node.tagName),
      );
      if (hasBlockChildren) {
        mapChildren(child, nested, ctx);
      } else {
        const inlines = collectInlines(child, ctx);
        if (collapse(inlines.map((part) => part.text).join(""))) pushParagraph(nested, ctx, inlines);
      }
      if (nested.length === 0) continue;
      items.push({ id: nextBlockId(ctx, "li", nested.map((block) => block.id).join(",")), blocks: nested });
    }
    if (!items.length) return;
    out.push({ id: nextBlockId(ctx, "list", items.map((item) => item.id).join(",")), type: "list", ordered: el.tagName === "ol", items });
    return;
  }
  if (el.tagName === "blockquote") {
    const nested: ReadingBlock[] = [];
    mapChildren(el, nested, ctx);
    if (!nested.length) return;
    out.push({ id: nextBlockId(ctx, "quote", nested.map((block) => block.id).join(",")), type: "quote", blocks: nested });
    return;
  }
  if (el.tagName === "pre") {
    const text = rawText(el).replace(/\n$/, "");
    if (!text.trim()) return;
    const language = languageOf(el);
    out.push({ id: nextBlockId(ctx, "code", text.slice(0, 80)), type: "code", language, text: text.slice(0, 50_000) });
    return;
  }
  if (el.tagName === "hr") {
    out.push({ id: nextBlockId(ctx, "hr", ""), type: "hr" });
    return;
  }
  if (el.tagName === "table") {
    const table = mapTable(el, ctx);
    if (table) out.push(table);
    return;
  }
  if (el.tagName === "img" || el.tagName === "figure" || el.tagName === "picture") return;
  mapChildren(el, out, ctx);
}

function mapTable(el: Element, ctx: ExtractCtx): ReadingBlock | null {
  const rows: { id: string; cells: { id: string; header: boolean; inlines: ReadingInline[] }[] }[] = [];
  const walkRows = (node: Element): void => {
    for (const child of node.childNodes) {
      if (!isElement(child)) continue;
      if (child.tagName === "tr") {
        if (rows.length >= MAX_TABLE_ROWS) return;
        const cells: { id: string; header: boolean; inlines: ReadingInline[] }[] = [];
        for (const cell of child.childNodes) {
          if (!isElement(cell) || (cell.tagName !== "td" && cell.tagName !== "th")) continue;
          if (cells.length >= MAX_TABLE_COLS) break;
          const inlines = collectInlines(cell, ctx);
          cells.push({ id: nextBlockId(ctx, "cell", inlines.map((part) => part.text).join("")), header: cell.tagName === "th", inlines });
        }
        if (!cells.length) continue;
        rows.push({ id: nextBlockId(ctx, "row", cells.map((cell) => cell.id).join(",")), cells });
      } else walkRows(child);
    }
  };
  walkRows(el);
  if (!rows.length) return null;
  return { id: nextBlockId(ctx, "table", rows.map((row) => row.id).join(",")), type: "table", rows };
}

function pushParagraph(out: ReadingBlock[], ctx: ExtractCtx, inlines: ReadingInline[]): void {
  const cleaned = inlines.map((part) => ({ ...part, text: part.text.replace(/\s+/g, " ") })).filter((part) => part.text);
  if (!cleaned.length || !collapse(cleaned.map((part) => part.text).join(""))) return;
  out.push({ id: nextBlockId(ctx, "p", cleaned.map((part) => part.text).join("")), type: "paragraph", inlines: cleaned });
}

function collectInlines(el: Element, ctx: ExtractCtx, marks: ReadingMark[] = []): ReadingInline[] {
  const out: ReadingInline[] = [];
  const push = (text: string, next: ReadingMark[]): void => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && sameMarks(last.marks, next)) last.text += text;
    else out.push({ text, marks: next });
  };
  for (const child of el.childNodes) {
    if (child.nodeName === "#text") {
      push(textValue(child), marks);
      continue;
    }
    if (!isElement(child) || SKIP.has(child.tagName) || hidden(child)) continue;
    if (child.tagName === "br") {
      push(" ", marks);
      continue;
    }
    if (child.tagName === "a") {
      const href = safeHref(attr(child, "href"), ctx.baseUrl);
      const next = href ? [...marks, { type: "link" as const, href }] : marks;
      for (const part of collectInlines(child, ctx, next)) push(part.text, part.marks);
      continue;
    }
    const extra: ReadingMark | null =
      child.tagName === "em" || child.tagName === "i"
        ? { type: "em" }
        : child.tagName === "strong" || child.tagName === "b"
          ? { type: "strong" }
          : child.tagName === "code" || child.tagName === "samp"
            ? { type: "code" }
            : null;
    const next = extra ? [...marks, extra] : marks;
    for (const part of collectInlines(child, ctx, next)) push(part.text, part.marks);
  }
  return out;
}

function safeHref(raw: string | null, baseUrl: string): string | null {
  if (!raw) return null;
  try {
    return cleanupUrl(new URL(raw, baseUrl).toString())?.canonicalUrl ?? null;
  } catch {
    return null;
  }
}

function sameMarks(a: ReadingMark[], b: ReadingMark[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function hidden(el: Element): boolean {
  if (attr(el, "hidden") !== null) return true;
  if ((attr(el, "aria-hidden") ?? "").toLowerCase() === "true") return true;
  const style = (attr(el, "style") ?? "").toLowerCase();
  return /display\s*:\s*none/.test(style) || /visibility\s*:\s*hidden/.test(style);
}

function noisy(el: Element): boolean {
  return NOISE_CLASS.test(`${attr(el, "id") ?? ""} ${classOf(el)}`);
}

function languageOf(el: Element): string | null {
  const cls = `${classOf(el)} ${classOf(el.childNodes.find((child): child is Element => isElement(child) && child.tagName === "code") ?? el)}`;
  const match = cls.match(/language-([a-z0-9_+-]+)/i);
  return match?.[1] ?? null;
}

function isElement(node: Node | Child): node is Element {
  return "tagName" in node && Array.isArray((node as Element).childNodes);
}

function textValue(node: Child): string {
  return "value" in node && typeof node.value === "string" ? node.value : "";
}

function attr(el: Element, name: string): string | null {
  const found = el.attrs.find((item) => item.name === name);
  return found ? found.value : null;
}

function classOf(el: Element | null | undefined): string {
  return el ? attr(el, "class") ?? "" : "";
}

function findTag(parent: { childNodes: Child[] } | null, tag: string): Element | null {
  if (!parent) return null;
  return findMatch(parent, (el) => el.tagName === tag);
}

function findMatch(parent: { childNodes: Child[] }, test: (el: Element) => boolean): Element | null {
  for (const child of parent.childNodes) {
    if (!isElement(child)) continue;
    if (test(child)) return child;
    const nested = findMatch(child, test);
    if (nested) return nested;
  }
  return null;
}

function countTags(parent: { childNodes: Child[] }, tag: string): number {
  let n = 0;
  for (const child of parent.childNodes) {
    if (!isElement(child)) continue;
    if (child.tagName === tag) n += 1;
    n += countTags(child, tag);
  }
  return n;
}

function textInTags(parent: { childNodes: Child[] }, tag: string): string {
  const chunks: string[] = [];
  for (const child of parent.childNodes) {
    if (!isElement(child)) continue;
    if (child.tagName === tag) chunks.push(textOf(child));
    else chunks.push(textInTags(child, tag));
  }
  return chunks.join(" ");
}

function commerceEvidence(root: Element | null, text: string): number {
  const labels = root ? `${classOf(root)} ${attr(root, "id") ?? ""}` : "";
  const sample = `${labels} ${text.slice(0, 20_000)}`;
  return [
    /\badd to (?:cart|bag)\b/i,
    /\bbuy now\b/i,
    /\b(?:product|product-grid|product-list|shopping-cart)\b/i,
    /(?:^|\s)[$€£]\s?\d+(?:[.,]\d{2})?\b/,
  ].reduce((count, pattern) => count + Number(pattern.test(sample)), 0);
}

function textOf(el: Element): string {
  let out = "";
  for (const child of el.childNodes) {
    if (child.nodeName === "#text") out += textValue(child);
    else if (isElement(child) && !SKIP.has(child.tagName)) out += textOf(child);
  }
  return out;
}

function rawText(el: Element): string {
  let out = "";
  for (const child of el.childNodes) {
    if (child.nodeName === "#text") out += textValue(child);
    else if (isElement(child)) out += rawText(child);
  }
  return out;
}

function visibleText(el: Element | null): string {
  if (!el) return "";
  return collapse(textOf(el));
}

function langOf(el: Element | null): string | null {
  const lang = el ? attr(el, "lang") : null;
  return lang?.trim() || null;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function normalize(s: string): string {
  return collapse(s).toLowerCase();
}
