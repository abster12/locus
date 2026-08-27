import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../app/src/styles.css", import.meta.url), "utf8");

test("mobile layout prevents overflow at its containers instead of clipping the page", () => {
  assert.doesNotMatch(css, /html\s*,\s*body\s*\{[^}]*overflow-x\s*:\s*hidden/i);
  assert.match(css, /\.shell\s*\{[^}]*width\s*:\s*100%[^}]*min-width\s*:\s*0/i);
  assert.match(css, /\.masthead\s*>\s*\*[^}]*\.atlas-top\s*>\s*\*[^}]*\{[^}]*min-width\s*:\s*0/i);
  assert.match(css, /img\s*,\s*video\s*,\s*iframe\s*\{[^}]*max-width\s*:\s*100%/i);
});

test("narrow layouts collapse grids and the viewer within the viewport", () => {
  const mobile = css.match(/@media \(max-width:\s*480px\)\s*\{([\s\S]*)\}\s*$/)?.[1] ?? "";
  assert.match(mobile, /\.clippings[^}]*grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/i);
  assert.match(mobile, /\.region-head\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/i);
  assert.match(mobile, /\.stage\s*\{[^}]*left\s*:\s*8px[^}]*right\s*:\s*8px[^}]*min-width\s*:\s*0/i);
});
