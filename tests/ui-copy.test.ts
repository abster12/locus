import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("visible page copy does not expose implementation language", () => {
  const files = ["KitchenPage.tsx", "AtlasPage.tsx", "ReadingPage.tsx", "SourcesPage.tsx", "SummaryPage.tsx", "Stage.tsx", "DeskPage.tsx", "TripsPage.tsx", "App.tsx"];
  const copy = files
    .map((file) => readFileSync(new URL(`../app/src/${file}`, import.meta.url), "utf8").replace(/^import .*$/gm, ""))
    .join("\n");
  for (const phrase of ["core/categories.ts", "deterministic blocks", "Imported provenance", "silent cron", "Capture Protocol JSONL"]) {
    assert.doesNotMatch(copy, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("Reading asks for the browser agent honestly, discloses the data flow, and labels agent-authored reasons", () => {
  const page = readFileSync(new URL("../app/src/ReadingPage.tsx", import.meta.url), "utf8");
  assert.match(page, /Your browser agent can help with your reading/i);
  assert.match(page, /search your saved articles, compare them, or recommend what to read next/i);
  assert.match(page, /saved Reading metadata and stored article text/i);
  assert.doesNotMatch(page, /ask agent/i);
  assert.doesNotMatch(page, /Want a pick from your queue|reading-moods|reading-mood/);
  assert.match(page, /Agent:/);
  assert.match(page, /Dismiss recommendations/);
  assert.match(page, /reading-recs-live/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /webmcpReady \? \(/);
});

test("Atlas page uses the locked kit and does not match geography in the client", () => {
  const page = readFileSync(new URL("../app/src/AtlasPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /detectPlaces|core\/places|Southeast Asia|Unplaced/);
  assert.match(page, /Needs a place/);
  assert.match(page, /Change place/);
  assert.match(page, /Choose exact place/);
  assert.match(page, /Change home/);
  assert.match(page, /Not for Atlas/);
  assert.match(page, /role="dialog"/);
  assert.match(page, /atlas-alert/);
});

test("Trips index copy stays a Locus section, not an overlay or workspace", () => {
  const page = ["TripsPage.tsx", "trips-index.tsx", "trips-document.tsx", "trips-overview.tsx", "trips-schedule.tsx", "trips-stops.tsx", "trips-advisories.tsx", "trips-recommendations.tsx", "trips-share.tsx"]
    .map((file) => readFileSync(new URL(`../app/src/${file}`, import.meta.url), "utf8"))
    .join("\n");
  assert.match(page, /Plan a trip/);
  assert.match(page, /Trip Documents/);
  assert.doesNotMatch(page, /Scratch Pad|overlay|direction picker|Kitchen board/i);
});

test("Kitchen replaces Shelves in primary navigation with an in-place redirect", () => {
  const app = readFileSync(new URL("../app/src/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /ShelvesPage/);
  assert.match(app, /a === "shelves"/);
  assert.match(app, /history\.replaceState\(null, "", `\$\{location\.pathname\}\$\{location\.search\}#\/recent`\)/);
  assert.match(app, /name: "kitchen"/);
  // Tab order: Desk · Kitchen · Atlas · Trips · Reading · Account.
  const tabs = [...app.matchAll(/<Tab href="(#[^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ["#/recent", "#/kitchen", "#/atlas", "#/trips", "#/reading", "#/account"]);
  assert.match(app, /\+ New/);
  assert.match(app, /Plan a trip/);
  assert.match(app, /Save a link/);
  assert.match(app, /Make a saved dish cookable/);
  assert.doesNotMatch(app, /Scratch Pad|hamburger|direction picker/i);
});
