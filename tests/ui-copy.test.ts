import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("visible page copy does not expose implementation language", () => {
  const files = ["KitchenPage.tsx", "AtlasPage.tsx", "ReadingPage.tsx", "SourcesPage.tsx", "SummaryPage.tsx", "Stage.tsx", "DeskPage.tsx"];
  const copy = files
    .map((file) => readFileSync(new URL(`../app/src/${file}`, import.meta.url), "utf8").replace(/^import .*$/gm, ""))
    .join("\n");
  for (const phrase of ["core/categories.ts", "deterministic blocks", "Imported provenance", "silent cron", "Capture Protocol JSONL"]) {
    assert.doesNotMatch(copy, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("Kitchen replaces Shelves in primary navigation with an in-place redirect", () => {
  const app = readFileSync(new URL("../app/src/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /ShelvesPage/);
  assert.match(app, /a === "shelves"/);
  assert.match(app, /history\.replaceState\(null, "", `\$\{location\.pathname\}\$\{location\.search\}#\/recent`\)/);
  assert.match(app, /name: "kitchen"/);
  // Tab order: Desk · Kitchen · Atlas · Reading · Sources.
  const tabs = [...app.matchAll(/<Tab href="(#[^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ["#/recent", "#/kitchen", "#/atlas", "#/reading", "#/sources"]);
});
