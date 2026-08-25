import { test } from "node:test";
import assert from "node:assert/strict";
import { detectListState } from "../extension/shell/extract.js";

function page(href: string, hasPosts: boolean) {
  Object.defineProperty(globalThis, "location", { value: { href }, configurable: true });
  Object.defineProperty(globalThis, "document", {
    value: { querySelector: () => (hasPosts ? {} : null) },
    configurable: true,
  });
}

test("homepage feed is not a saved list even when posts are on the page", () => {
  page("https://x.com/home", true);
  assert.equal(detectListState(), "unknown");
  page("https://www.reddit.com/", true);
  assert.equal(detectListState(), "unknown");
  page("https://www.instagram.com/", true);
  assert.equal(detectListState(), "unknown");
  page("https://x.com/i/bookmarks", true);
  assert.equal(detectListState(), "ready");
  page("https://www.reddit.com/user/me/saved/", true);
  assert.equal(detectListState(), "ready");
  page("https://www.instagram.com/saves/all-posts/", true);
  assert.equal(detectListState(), "ready");
});
