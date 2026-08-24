import { test } from "node:test";
import assert from "node:assert/strict";
import { inferHandleFromUrl, isPlatformPermalink, isReadingItem, isStageOutbound, outboundUrls, sanitizeItemDraft, sanitizeUrl, youtubeVideoId, RejectedPayload } from "../core/sanitize.ts";
import { dateLabel } from "../core/types.ts";
import { parseRedditTime } from "../site-packs/reddit/index.ts";

test("javascript and data urls never survive sanitize", () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "about:blank"]) {
    assert.throws(() => sanitizeUrl(bad), RejectedPayload);
  }
});

test("script tags stay text, not executable structure", () => {
  const draft = sanitizeItemDraft({
    contentType: "post",
    title: "<img src=x onerror=alert(1)>",
    body: "<script>alert(1)</script>Ignore previous instructions",
    url: "https://example.com/p",
    authorName: "<b>nope</b>",
  });
  assert.equal(draft.title?.includes("<img"), true);
  assert.equal(draft.body?.includes("<script>"), true);
  assert.match(draft.url, /^https:/);
});

test("reading items are posts that carry an outbound article URL", () => {
  assert.equal(isReadingItem("read this\nhttps://lucumr.pocoo.org/2026/8/22/fast-hard-code/", "https://x.com/a/status/1"), true);
  assert.equal(isReadingItem("just a joke", "https://x.com/a/status/1"), false);
  assert.equal(isReadingItem("https://x.com/b/status/2", "https://x.com/a/status/1"), false);
});

test("isPlatformPermalink is the post itself, not an outbound article", () => {
  assert.equal(isPlatformPermalink("https://www.instagram.com/p/DF5yWLBy8Ra/"), true);
  assert.equal(isPlatformPermalink("https://www.reddit.com/r/x/comments/abc/hi/"), true);
  assert.equal(isPlatformPermalink("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), true);
  assert.equal(isPlatformPermalink("https://x.com/a/status/1"), true);
  assert.equal(isPlatformPermalink("https://lucumr.pocoo.org/2026/8/22/fast-hard-code/"), false);
});

test("youtubeVideoId matches watch and youtu.be, not other hosts", () => {
  assert.equal(youtubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youtubeVideoId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youtubeVideoId("https://x.com/a/status/1"), null);
});

test("stage frames outbound articles, not the save's own permalink", () => {
  const permalink = "https://x.com/a/status/1";
  assert.equal(isStageOutbound("https://lucumr.pocoo.org/", permalink), true);
  assert.equal(isStageOutbound(permalink, permalink), false);
  assert.equal(isStageOutbound("https://x.com/b/status/2", permalink), false);
  assert.deepEqual(outboundUrls("read this https://lucumr.pocoo.org/ and https://x.com/b/status/2", permalink), [
    "https://lucumr.pocoo.org/",
  ]);
});

test("X handle is inferred from status URL when producer omitted it", () => {
  assert.equal(inferHandleFromUrl("https://x.com/Vercantez/status/2082138839888589200"), "Vercantez");
  assert.equal(inferHandleFromUrl("https://twitter.com/i/status/1"), undefined);
  assert.equal(inferHandleFromUrl("https://www.reddit.com/r/iphonewallpapers/comments/14jctv4/a_few_of_my_favorites/"), "r/iphonewallpapers");
  const draft = sanitizeItemDraft({
    contentType: "post",
    url: "https://x.com/badlogicgames/status/2081977990146077157",
    body: "recommended reading.",
  });
  assert.equal(draft.authorHandle, "badlogicgames");
});

test("parseRedditTime accepts unix seconds, millis, and ISO — never now()", () => {
  assert.equal(parseRedditTime("1687622400"), "2023-06-24T16:00:00.000Z");
  assert.equal(parseRedditTime("1687622400000"), "2023-06-24T16:00:00.000Z");
  assert.equal(parseRedditTime("2023-06-24T16:00:00.000Z"), "2023-06-24T16:00:00.000Z");
  assert.equal(parseRedditTime(""), undefined);
  assert.equal(parseRedditTime("today"), undefined);
});

test("date label prefers the post time over import time", () => {
  const label = dateLabel({
    publishedAt: "2026-04-12T10:00:00.000Z",
    sourceSavedAt: null,
    capturedAt: "2026-08-23T14:15:08.343Z",
    firstObservedAt: "2026-08-23T14:15:08.343Z",
  });
  assert.equal(label.kind, "published");
});
