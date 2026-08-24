import { test } from "node:test";
import assert from "node:assert/strict";
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
