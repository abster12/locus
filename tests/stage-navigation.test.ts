import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { canMountLiveFrame, firstStageDestination, previewOpensInStage } from "../app/src/stage-navigation.ts";
import { StageText } from "../app/src/Stage.tsx";

test("cards lead with their outbound link instead of the saved-item prompt", () => {
  const permalink = "https://x.com/example/status/123";
  assert.equal(
    firstStageDestination({ url: permalink, body: `Read this https://www.nytimes.com/story` }),
    "https://www.nytimes.com/story",
  );
  assert.equal(firstStageDestination({ url: permalink, body: `Only the permalink ${permalink}` }), undefined);
  assert.equal(
    firstStageDestination({ url: "https://example.com/article", body: "A saved article with no URL in its description." }),
    "https://example.com/article",
  );
});

test("links inside the saved-item viewer stay under Locus control so external handoff closes the viewer", () => {
  const html = renderToStaticMarkup(
    createElement(StageText, {
      text: "Read https://www.nytimes.com/story",
      permalink: "https://x.com/example/status/123",
      onOutbound: () => {},
    }),
  );
  assert.match(html, /href="https:\/\/www\.nytimes\.com\/story"/);
  assert.doesNotMatch(html, /target="_blank"/);
});

test("link previews open in Stage only when Stage will show the page", () => {
  const tweet = "https://x.com/example/status/123";
  const article = "https://example.com/article";
  assert.equal(previewOpensInStage("https://www.nytimes.com/story", tweet), true);
  assert.equal(previewOpensInStage("https://www.youtube.com/watch?v=dQw4w9WgXcQ", tweet), true);
  assert.equal(previewOpensInStage(article, article), false);
  assert.equal(previewOpensInStage("https://x.com/b/status/2", tweet), false);
  assert.equal(previewOpensInStage("https://www.reddit.com/r/x/comments/abc/hi/", tweet), false);
});

test("live pages mount only after a positive frameability check", () => {
  assert.equal(canMountLiveFrame("yes"), true);
  assert.equal(canMountLiveFrame("no"), false);
  assert.equal(canMountLiveFrame("unknown"), false);
});
