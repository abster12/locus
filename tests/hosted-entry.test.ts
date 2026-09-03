import assert from "node:assert/strict";
import { test } from "node:test";
import { hostedDefaultHash } from "../app/src/hosted-entry.ts";

test("empty Library with no room hash opens Account", () => {
  assert.equal(hostedDefaultHash("", 0), "#/account");
  assert.equal(hostedDefaultHash("#", 0), "#/account");
  assert.equal(hostedDefaultHash("#/", 0), "#/account");
});

test("Library with Items and no room hash opens Desk", () => {
  assert.equal(hostedDefaultHash("", 3), "#/recent");
  assert.equal(hostedDefaultHash("#/", 1), "#/recent");
});

test("an explicit room hash stays", () => {
  assert.equal(hostedDefaultHash("#/kitchen", 0), "#/kitchen");
  assert.equal(hostedDefaultHash("#/account", 12), "#/account");
  assert.equal(hostedDefaultHash("#/recent", 0), "#/recent");
  assert.equal(hostedDefaultHash("#/trips?filter=archived", 0), "#/trips?filter=archived");
});
