import { test } from "node:test";
import assert from "node:assert/strict";
import type { CaptureContext } from "../site-packs/shared.ts";
import { isXCollectionUrl, xPack } from "../site-packs/x/index.ts";

test("X treats current bookmarks and history URLs as the same collection", () => {
  assert.equal(isXCollectionUrl("https://x.com/i/bookmarks"), true);
  assert.equal(isXCollectionUrl("https://x.com/i/history"), true);
  assert.equal(isXCollectionUrl("https://twitter.com/i/bookmarks"), true);
  assert.equal(isXCollectionUrl("https://x.com/home"), false);
  assert.equal(isXCollectionUrl("https://x.com/i/jf/onboarding/web?redirect_after_login=%2Fi%2Fbookmarks"), false);
});

test("X pack detect follows the live bookmarks → history redirect", () => {
  const hit = xPack.detect({ url: "https://x.com/i/history", title: "History / X" });
  assert.ok(hit);
  assert.equal(hit.kind, "collection");
  assert.equal(hit.collectionExternalId, "bookmarks");
});

type NodeSpec = string | { tag: string; attrs?: Record<string, string>; children?: NodeSpec[]; innerText?: string };

function textOf(n: { nodeType: number; textContent?: string; innerText?: string; childNodes: unknown[] }): string {
  if (n.nodeType === 3) return n.textContent ?? "";
  if (n.innerText) return n.innerText;
  return (n.childNodes as { nodeType: number; textContent?: string; innerText?: string; childNodes: unknown[] }[])
    .map((c) => textOf(c))
    .join("");
}

function nodeOf(spec: NodeSpec): {
  nodeType: number;
  nodeName?: string;
  textContent?: string;
  childNodes: unknown[];
  innerText?: string;
  getAttribute: (k: string) => string | null;
  querySelector: (sel: string) => unknown;
  querySelectorAll: (sel: string) => unknown[];
} {
  if (typeof spec === "string") {
    return {
      nodeType: 3,
      textContent: spec,
      childNodes: [],
      getAttribute: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    };
  }
  const attrs = spec.attrs ?? {};
  const el = {
    nodeType: 1,
    nodeName: spec.tag.toUpperCase(),
    childNodes: [] as unknown[],
    innerText: spec.innerText,
    getAttribute: (k: string) => attrs[k] ?? null,
    querySelector(sel: string) {
      return findOne(this, sel);
    },
    querySelectorAll(sel: string) {
      return findAll(this, sel);
    },
  };
  el.childNodes = (spec.children ?? []).map(nodeOf);
  if (spec.innerText === undefined) el.innerText = textOf(el);
  return el;
}

function matches(el: { nodeName?: string; getAttribute: (k: string) => string | null }, sel: string): boolean {
  if (sel === "a" || sel === "A") return el.nodeName === "A";
  if (sel.startsWith("a[href")) return el.nodeName === "A" && Boolean(el.getAttribute("href"));
  if (sel.includes("/status/")) return el.nodeName === "A" && (el.getAttribute("href") || "").includes("/status/");
  const testid = sel.match(/data-testid="([^"]+)"/)?.[1];
  if (testid) return el.getAttribute("data-testid") === testid;
  if (sel === "time") return el.nodeName === "TIME";
  return false;
}

function findAll(root: { childNodes: unknown[]; nodeName?: string; getAttribute: (k: string) => string | null }, sel: string): unknown[] {
  const out: unknown[] = [];
  const walk = (n: { nodeType?: number; childNodes?: unknown[]; nodeName?: string; getAttribute?: (k: string) => string | null }) => {
    if (n.nodeType === 1 && n.getAttribute && matches(n as { nodeName?: string; getAttribute: (k: string) => string | null }, sel)) {
      out.push(n);
    }
    for (const c of n.childNodes ?? []) walk(c as typeof n);
  };
  walk(root);
  return out;
}

function findOne(root: { childNodes: unknown[]; getAttribute: (k: string) => string | null }, sel: string): unknown {
  return findAll(root, sel)[0] ?? null;
}

function permalinkTweet(args: {
  id: string;
  handle: string;
  name: string;
  text: NodeSpec[];
  extraAnchors?: NodeSpec[];
}) {
  const status = {
    tag: "a",
    attrs: { href: `/${args.handle}/status/${args.id}` },
    children: ["permalink"],
  };
  const article = nodeOf({
    tag: "article",
    attrs: { "data-testid": "tweet" },
    children: [
      status,
      {
        tag: "div",
        attrs: { "data-testid": "tweetText" },
        children: args.text,
      },
      {
        tag: "div",
        attrs: { "data-testid": "User-Name" },
        innerText: `${args.name}\n@${args.handle}`,
        children: [{ tag: "a", attrs: { href: `/${args.handle}` }, children: [`@${args.handle}`] }],
      },
      { tag: "time", attrs: { datetime: "2024-01-01T00:00:00.000Z" } },
      ...(args.extraAnchors ?? []),
    ],
  });
  Object.defineProperty(globalThis, "location", {
    value: { href: `https://x.com/${args.handle}/status/${args.id}`, pathname: `/${args.handle}/status/${args.id}` },
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: {
      title: "",
      body: { innerText: "" },
      querySelector: () => article,
      querySelectorAll: (sel: string) => (sel.includes("tweet") || sel.includes("cellInnerDiv") ? [article] : findAll(article, sel)),
    },
    configurable: true,
  });
}

function fakeCtx(): CaptureContext {
  return {
    url: async () => location.href,
    title: async () => "",
    evaluate: async (fn) => fn(),
    goto: async () => {},
    scrollBy: async () => {},
    wait: async () => {},
    cancelled: () => false,
  };
}

test("X keeps a full URL that X wrapped onto two lines", async () => {
  permalinkTweet({
    id: "99",
    handle: "ada",
    name: "Ada",
    text: [
      "see ",
      {
        tag: "a",
        attrs: { href: "https://t.co/xyz" },
        innerText: "https://example.com/very/long/\npath-to-article",
        children: [
          { tag: "span", children: ["https://example.com/very/long/"] },
          { tag: "br" },
          { tag: "span", children: ["path-to-article"] },
        ],
      },
    ],
  });
  const post = await xPack.readPage(fakeCtx());
  assert.ok(post);
  assert.equal(post.text, "see https://example.com/very/long/path-to-article");
});

test("X uses the anchor title when X shows a wrapped display URL", async () => {
  permalinkTweet({
    id: "99",
    handle: "ada",
    name: "Ada",
    text: [
      {
        tag: "a",
        attrs: { href: "https://t.co/xyz", title: "https://www.example.com/full/path" },
        innerText: "example.com/full/\npath",
        children: [
          { tag: "span", children: ["example.com/full/"] },
          { tag: "br" },
          { tag: "span", children: ["path"] },
        ],
      },
    ],
  });
  const post = await xPack.readPage(fakeCtx());
  assert.ok(post);
  assert.equal(post.text, "https://www.example.com/full/path");
});

test("X still keeps a real line break that is not a wrapped URL", async () => {
  permalinkTweet({
    id: "99",
    handle: "ada",
    name: "Ada",
    text: ["hello", { tag: "br" }, "world"],
  });
  const post = await xPack.readPage(fakeCtx());
  assert.ok(post);
  assert.equal(post.text, "hello\nworld");
});
