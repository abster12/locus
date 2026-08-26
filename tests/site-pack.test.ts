import { test } from "node:test";
import assert from "node:assert/strict";
import type { CaptureContext } from "../site-packs/shared.ts";
import { xPack } from "../site-packs/x/index.ts";
import { youtubePack } from "../site-packs/youtube/index.ts";
import { redditPack } from "../site-packs/reddit/index.ts";
import { instagramPack } from "../site-packs/instagram/index.ts";

function page(url: string, extra: { querySelector?: (sel: string) => unknown; querySelectorAll?: (sel: string) => unknown[] } = {}) {
  Object.defineProperty(globalThis, "location", { value: { href: url, pathname: new URL(url).pathname }, configurable: true });
  Object.defineProperty(globalThis, "document", {
    value: {
      title: "",
      body: { innerText: "", scrollHeight: 0 },
      documentElement: { scrollTo() {}, scrollHeight: 0, clientHeight: 0, scrollTop: 0 },
      scrollingElement: { scrollTo() {}, scrollHeight: 0, clientHeight: 0, scrollTop: 0 },
      querySelector: extra.querySelector ?? (() => null),
      querySelectorAll: extra.querySelectorAll ?? (() => []),
    },
    configurable: true,
  });
  (globalThis as unknown as { getComputedStyle: () => { overflowY: string } }).getComputedStyle = () => ({ overflowY: "visible" });
}

function tweetEl(t: { id: string; handle: string; name: string; text: string }) {
  const textEl = {
    nodeType: 1,
    nodeName: "DIV",
    childNodes: [{ nodeType: 3, textContent: t.text, childNodes: [] }],
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    innerText: t.text,
  };
  const statusA = { nodeType: 1, nodeName: "A", getAttribute: (k: string) => (k === "href" ? `/${t.handle}/status/${t.id}` : null) };
  const userEl = {
    innerText: `${t.name}\n@${t.handle}`,
    querySelector: () => null,
    querySelectorAll: () => [{ getAttribute: () => `/${t.handle}` }],
  };
  return {
    querySelector: (sel: string) => {
      if (sel === '[data-testid="tweetText"]') return textEl;
      if (sel === '[data-testid="User-Name"]') return userEl;
      if (sel === "time") return { getAttribute: () => "2024-01-01T00:00:00.000Z" };
      if (sel.includes("/status/")) return statusA;
      return null;
    },
    querySelectorAll: (sel: string) => {
      if (sel.includes("/status/") || sel === "a") return [statusA];
      return [];
    },
  };
}

function xPage(url: string, tweets: { id: string; handle: string; name: string; text: string }[]) {
  const articles = tweets.map(tweetEl);
  page(url, {
    querySelector: (sel) => (sel.includes("tweet") ? (articles[0] ?? null) : null),
    querySelectorAll: (sel) => (sel.includes("tweet") || sel.includes("cellInnerDiv") ? articles : []),
  });
}

function fakeCtx(gotos: string[] = []): CaptureContext {
  return {
    url: async () => location.href,
    title: async () => document.title,
    evaluate: async (fn) => fn(),
    goto: async (url) => {
      gotos.push(url);
      Object.defineProperty(globalThis, "location", { value: { href: url, pathname: new URL(url).pathname }, configurable: true });
    },
    scrollBy: async () => {},
    wait: async () => {},
    cancelled: () => false,
  };
}

test("homepage feed is not a saved list even when posts are on the page", async () => {
  const ctx = fakeCtx();
  xPage("https://x.com/home", [{ id: "1", handle: "a", name: "A", text: "hi" }]);
  assert.equal(xPack.detect({ url: "https://x.com/home", title: "" }), null);
  assert.equal(await xPack.pageState(ctx), "wrong-page");

  page("https://www.reddit.com/");
  assert.equal(redditPack.detect({ url: "https://www.reddit.com/", title: "" }), null);
  assert.equal(await redditPack.pageState(ctx), "wrong-page");

  page("https://www.instagram.com/");
  assert.equal(instagramPack.detect({ url: "https://www.instagram.com/", title: "" }), null);
  assert.equal(await instagramPack.pageState(ctx), "wrong-page");

  page("https://www.youtube.com/");
  assert.equal(youtubePack.detect({ url: "https://www.youtube.com/", title: "" }), null);
  assert.equal(await youtubePack.pageState(ctx), "wrong-page");

  xPage("https://x.com/i/bookmarks", [{ id: "1", handle: "a", name: "A", text: "hi" }]);
  assert.equal(await xPack.pageState(ctx), "ready");
});

test("readPage returns the one post on a permalink", async () => {
  xPage("https://x.com/a/status/99", [{ id: "99", handle: "a", name: "Ada", text: "hello" }]);
  const post = await xPack.readPage(fakeCtx());
  assert.ok(post);
  assert.equal(post.id, "99");
  assert.equal(post.text, "hello");
  assert.equal(post.url, "https://x.com/a/status/99");
  assert.equal(post.authorHandle, "a");
});

test("readList does not open a post the desk already has", async () => {
  const gotos: string[] = [];
  const ctx = fakeCtx(gotos);
  page("https://www.instagram.com/saves/all-posts/", {
    querySelector: () => null,
    querySelectorAll: () => [{ href: "https://www.instagram.com/p/OLD/", querySelector: () => null, getAttribute: () => null }],
  });
  const got = [];
  for await (const post of instagramPack.readList(ctx, ["OLD"])) got.push(post);
  assert.deepEqual(
    got.map((p) => p.id),
    [],
  );
  assert.deepEqual(gotos, []);
});

test("readList skips ids the desk already has", async () => {
  xPage("https://x.com/i/bookmarks", [
    { id: "1", handle: "a", name: "A", text: "one" },
    { id: "2", handle: "b", name: "B", text: "two" },
  ]);
  const got = [];
  for await (const post of xPack.readList(fakeCtx(), ["1"])) got.push(post);
  assert.deepEqual(
    got.map((p) => p.id),
    ["2"],
  );
});
