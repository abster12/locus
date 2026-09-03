import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  enterExample,
  exampleRequest,
  exitExample,
  isExampleActive,
  resetExample,
} from "../app/src/example-library.ts";

afterEach(() => {
  exitExample();
});

test("seed has twelve Items, London home, Lisbon hole, empty Tonight", async () => {
  enterExample();
  const items = await exampleRequest<{ items: { id: string }[] }>("/api/items");
  assert.equal(items.items.length, 12);
  const kitchen = await exampleRequest<{ counts: { foodSaves: number; tonight: number } }>("/api/kitchen");
  assert.equal(kitchen.counts.foodSaves, 4);
  assert.equal(kitchen.counts.tonight, 0);
  const tonight = await exampleRequest<{ revision: number; entries: unknown[] }>("/api/kitchen/tonight/state");
  assert.equal(tonight.entries.length, 0);
  const atlas = await exampleRequest<{
    home: { place: { name: string } | null };
    needsPlace: { count: number };
  }>("/api/atlas");
  assert.equal(atlas.home.place?.name, "London");
  assert.equal(atlas.needsPlace.count, 1);
  const trips = await exampleRequest<{ trips: { id: string; holeCount: number }[] }>("/api/trips");
  assert.equal(trips.trips[0]?.id, "lisbon");
  assert.equal(trips.trips[0]?.holeCount, 1);
  const reading = await exampleRequest<{ counts: { unread: number; finished: number } }>("/api/reading");
  assert.equal(reading.counts.unread, 2);
  assert.equal(reading.counts.finished, 1);
});

test("Tonight mutations stay in the tab and reset restores the seed", async () => {
  enterExample();
  await exampleRequest("/api/kitchen/tonight/apply", {
    method: "POST",
    body: JSON.stringify({
      expectedRevision: 1,
      clientMutationId: "m1",
      operations: [{ op: "add", itemId: "cacio" }],
    }),
  });
  const after = await exampleRequest<{ entries: { itemId: string }[]; revision: number }>("/api/kitchen/tonight/state");
  assert.deepEqual(after.entries.map((row) => row.itemId), ["cacio"]);
  resetExample();
  const restored = await exampleRequest<{ entries: unknown[] }>("/api/kitchen/tonight/state");
  assert.equal(restored.entries.length, 0);
});

test("exit drops the in-tab library", async () => {
  enterExample();
  assert.equal(isExampleActive(), true);
  exitExample();
  assert.equal(isExampleActive(), false);
  await assert.rejects(() => exampleRequest("/api/items"), /example library is not open/);
});

test("life-column rooms set a hash when location exists", () => {
  enterExample("kitchen");
  assert.equal(isExampleActive(), true);
});
