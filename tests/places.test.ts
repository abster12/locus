import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPlaces } from "../core/places.ts";

test("finds Japan, Barcelona, and Kerala in sample text", () => {
  const hits = detectPlaces("Japan, Barcelona, Kerala", "notes from the road");
  const places = hits.map((h) => h.place);
  const regions = new Set(hits.map((h) => h.region));
  assert.ok(places.includes("Japan"));
  assert.ok(places.includes("Barcelona"));
  assert.ok(places.includes("Kerala"));
  assert.ok(regions.has("Japan"));
  assert.ok(regions.has("Spain"));
  assert.ok(regions.has("India"));
});

test("returns [] for no-hit text", () => {
  assert.deepEqual(detectPlaces("just a joke about cooking", "no geography here"), []);
  assert.deepEqual(detectPlaces(null, null), []);
});

test("word-boundary safety: Usain does not match USJ, Indiana does not match India", () => {
  assert.deepEqual(detectPlaces("Usain Bolt wins again", null), []);
  assert.deepEqual(detectPlaces("Indiana Jones", null), []);
  assert.equal(detectPlaces("USJ tickets", null).some((h) => h.place === "USJ"), true);
  assert.equal(detectPlaces("back to India next year", null).some((h) => h.place === "India"), true);
});
