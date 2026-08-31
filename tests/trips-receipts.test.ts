import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../db/open.ts";
import { SCHEMA_VERSION } from "../db/schema.ts";
import { RejectedPayload } from "../core/sanitize.ts";
import { createTrip, deleteTrip, getTrip, listTrips } from "../server/trips/module.ts";

const TS = "2026-09-01T09:00:00.000Z";

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-trips-receipts-")), "t.db"));
}

function setup(clientMutationId: string, extra: Record<string, unknown> = {}) {
  return { destination: "Kyoto", durationDays: 2, clientMutationId, ...extra };
}

function count(db: Db, sql: string) {
  return (db.prepare(sql).get() as { n: number }).n;
}

test("v20: receipts are owner-scoped and do not cascade with the trip", () => {
  const db = mem();
  assert.equal((db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version, SCHEMA_VERSION);
  const cols = db.prepare(`PRAGMA table_info(trip_mutation_receipts)`).all() as { name: string }[];
  assert.ok(cols.some((column) => column.name === "library_id"));
  assert.equal((db.prepare(`PRAGMA foreign_key_list(trip_mutation_receipts)`).all() as unknown[]).length, 0);
});

test("create: first write, exact retry, lost-response retry, and conflicting payload", () => {
  const db = mem();
  const first = createTrip(db, "local", setup("c1"), TS);
  assert.equal(first.destination, "Kyoto");
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM trips`), 1);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM trip_mutation_receipts WHERE library_id = 'local'`), 1);

  const replay = createTrip(db, "local", setup("c1"), TS);
  assert.equal(replay.id, first.id, "exact retry returns the original trip");
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM trips`), 1);

  const lost = createTrip(db, "local", setup("c1"), TS);
  assert.equal(lost.id, first.id, "a lost-response retry does not insert another trip");
  assert.equal(listTrips(db, "local").length, 1);

  assert.throws(
    () => createTrip(db, "local", setup("c1", { destination: "Osaka" }), TS),
    (error: unknown) => error instanceof RejectedPayload && (error as Error).message.includes("already used"),
  );
  assert.equal(getTrip(db, "local", first.id)!.destination, "Kyoto");
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM trips`), 1);
});

test("delete: first delete, exact retry after gone, conflicting reuse, new id on absent trip", () => {
  const db = mem();
  const trip = createTrip(db, "local", setup("c-del"), TS);
  assert.equal(deleteTrip(db, "local", trip.id, { expectedRevision: 1, clientMutationId: "d1", confirm: "DELETE" }), true);
  assert.equal(getTrip(db, "local", trip.id), null);
  assert.equal(
    count(db, `SELECT COUNT(*) AS n FROM trip_mutation_receipts WHERE library_id = 'local' AND client_mutation_id = 'd1'`),
    1,
    "the delete receipt survives the trip",
  );

  assert.equal(
    deleteTrip(db, "local", trip.id, { expectedRevision: 1, clientMutationId: "d1", confirm: "DELETE" }),
    true,
    "exact retry after the trip is gone returns the original success",
  );

  assert.throws(
    () => deleteTrip(db, "local", trip.id, { expectedRevision: 2, clientMutationId: "d1", confirm: "DELETE" }),
    (error: unknown) => error instanceof RejectedPayload && (error as Error).message.includes("already used"),
  );

  assert.equal(
    deleteTrip(db, "local", trip.id, { expectedRevision: 1, clientMutationId: "d2", confirm: "DELETE" }),
    false,
    "a new deletion mutation against an already absent trip is not-found",
  );
});

test("rollback: a failed write leaves no trip and no receipt", () => {
  const db = mem();
  db.exec(`CREATE TRIGGER fail_trips BEFORE INSERT ON trips BEGIN SELECT RAISE(FAIL, 'nope'); END`);
  assert.throws(() => createTrip(db, "local", setup("c-fail"), TS));
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM trips`), 0);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM trip_mutation_receipts`), 0);
});

test("rollback: a failed receipt leaves no trip", () => {
  const db = mem();
  db.exec(`CREATE TRIGGER fail_receipts BEFORE INSERT ON trip_mutation_receipts BEGIN SELECT RAISE(FAIL, 'nope'); END`);
  assert.throws(() => createTrip(db, "local", setup("c-fail-r"), TS));
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM trips`), 0);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM trip_mutation_receipts`), 0);
});

test("owner-scoped mutation ids cannot replay a different Trip's receipt", () => {
  const db = mem();
  const first = createTrip(db, "local", setup("c-a"), TS);
  const second = createTrip(db, "local", setup("c-b"), TS);
  assert.equal(deleteTrip(db, "local", first.id, { expectedRevision: 1, clientMutationId: "d-shared", confirm: "DELETE" }), true);
  assert.throws(
    () => deleteTrip(db, "local", second.id, { expectedRevision: 1, clientMutationId: "d-shared", confirm: "DELETE" }),
    (error: unknown) => error instanceof RejectedPayload && (error as Error).message.includes("already used"),
  );
  assert.ok(getTrip(db, "local", second.id), "the second trip is unchanged");
});

test("legacy receipt hashes still replay when the stored trip matches", () => {
  const db = mem();
  const trip = createTrip(db, "local", setup("c-legacy"), TS);
  assert.equal(deleteTrip(db, "local", trip.id, { expectedRevision: 1, clientMutationId: "d-legacy", confirm: "DELETE" }), true);
  const legacy = createHash("sha256")
    .update(JSON.stringify({ kind: "delete", expectedRevision: 1, payload: { confirm: "DELETE" } }))
    .digest("hex");
  db.prepare(`UPDATE trip_mutation_receipts SET payload_hash = ? WHERE client_mutation_id = 'd-legacy'`).run(legacy);
  assert.equal(
    deleteTrip(db, "local", trip.id, { expectedRevision: 1, clientMutationId: "d-legacy", confirm: "DELETE" }),
    true,
    "exact retry after upgrade still returns the original success",
  );
});

test("v19 receipts that reused a mutation id across trips still migrate", () => {
  const path = join(mkdtempSync(join(tmpdir(), "locus-trips-receipts-v19-")), "t.db");
  const db = openDb(path);
  const first = createTrip(db, "local", setup("c-a"), TS);
  const second = createTrip(db, "local", setup("c-b"), TS);
  db.exec(`
    DROP TABLE trip_mutation_receipts;
    CREATE TABLE trip_mutation_receipts (
      trip_id TEXT NOT NULL,
      client_mutation_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      result_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(trip_id, client_mutation_id),
      FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
    );
  `);
  db.prepare(
    `INSERT INTO trip_mutation_receipts (trip_id, client_mutation_id, payload_hash, result_json, result_revision, created_at) VALUES (?, 'shared', 'h1', 'true', 1, ?)`,
  ).run(first.id, TS);
  db.prepare(
    `INSERT INTO trip_mutation_receipts (trip_id, client_mutation_id, payload_hash, result_json, result_revision, created_at) VALUES (?, 'shared', 'h2', 'true', 1, ?)`,
  ).run(second.id, "2026-09-02T09:00:00.000Z");
  db.exec(`PRAGMA user_version = 19`);
  db.close();

  const migrated = openDb(path);
  assert.equal((migrated.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version, SCHEMA_VERSION);
  assert.equal(
    (migrated.prepare(`SELECT COUNT(*) AS n FROM trip_mutation_receipts WHERE client_mutation_id = 'shared'`).get() as { n: number }).n,
    1,
  );
  assert.ok(getTrip(migrated, "local", first.id));
  assert.ok(getTrip(migrated, "local", second.id));
  migrated.close();
});

test("rollback: a failed delete leaves the trip and no delete receipt", () => {
  const db = mem();
  const trip = createTrip(db, "local", setup("c-keep"), TS);
  db.exec(`CREATE TRIGGER fail_delete BEFORE DELETE ON trips BEGIN SELECT RAISE(FAIL, 'nope'); END`);
  assert.throws(() => deleteTrip(db, "local", trip.id, { expectedRevision: 1, clientMutationId: "d-fail", confirm: "DELETE" }));
  assert.ok(getTrip(db, "local", trip.id));
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM trip_mutation_receipts WHERE client_mutation_id = 'd-fail'`), 0);
});
