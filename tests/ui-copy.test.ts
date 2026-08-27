import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shelfCounts } from "../app/src/ShelvesPage.tsx";

test("Shelves tolerates a missing or older counts response", () => {
  assert.deepEqual(shelfCounts(undefined), {});
  assert.deepEqual(shelfCounts({ counts: { shelves: { travel: 3 } } }), { travel: 3 });
});

test("visible page copy does not expose implementation language", () => {
  const files = ["ShelvesPage.tsx", "AtlasPage.tsx", "ReadingPage.tsx", "SourcesPage.tsx", "SummaryPage.tsx", "Stage.tsx", "DeskPage.tsx"];
  const copy = files
    .map((file) => readFileSync(new URL(`../app/src/${file}`, import.meta.url), "utf8").replace(/^import .*$/gm, ""))
    .join("\n");
  for (const phrase of ["core/categories.ts", "deterministic blocks", "Imported provenance", "silent cron", "Capture Protocol JSONL"]) {
    assert.doesNotMatch(copy, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});
