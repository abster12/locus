import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../db/open.ts";
import { issueToken, lookupToken, startSession } from "../server/capture/ingest.ts";
import { heartbeat, resetJobsForTest } from "../server/capture/jobs.ts";
import { markDone, markRunning, setProgress } from "../runner/index.ts";

process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_READING_WORKER = "0";
process.env.LOCUS_PORT = "8823";
const { listen } = await import("../server/http/server.ts");

type RunSummary = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  coverage: string | null;
  status: string;
  errorCode: string | null;
};

type Overview = {
  account: { mode: string };
  sources?: unknown;
  settings?: unknown;
  extension: { state: string; lastSeenAt: string | null; alive?: unknown };
  connections: {
    source: string;
    label: string;
    state: string;
    accounts?: unknown;
    liveAccount: { id: string; externalId: string; displayName: string | null } | null;
    progress: { phase: string; message: string; previewJpeg?: string } | null;
    latestAttempt: RunSummary | null;
    lastSuccessfulCapture: RunSummary | null;
  }[];
  imports: { id: string; source: string; label: string; importedAt: string; itemCount: number }[];
  preferences: { captureOnOpen: boolean };
};

test.describe("sources overview", { concurrency: false }, () => {
  test("GET /api/sources returns one connection per Source for the screenshot mix", async () => {
    resetJobsForTest();
    const database = openDb(join(mkdtempSync(join(tmpdir(), "locus-sources-overview-")), "t.db"));
    seedScreenshotMix(database);
    const app = listen(database);
    const base = `http://127.0.0.1:${app.port}`;
    try {
      const sessionResponse = await fetch(`${base}/api/session`);
      const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      const response = await fetch(`${base}/api/sources`, { headers: { cookie } });
      assert.equal(response.status, 200);
      const body = (await response.json()) as Overview;
      assert.deepEqual(body.account, { mode: "local" });
      assert.equal("sources" in body, false);
      assert.equal("settings" in body, false);
      assert.deepEqual(
        body.connections.map((connection) => connection.source),
        ["x", "instagram", "youtube", "reddit"],
      );
      assert.equal(body.connections.length, 4);
      for (const connection of body.connections) {
        assert.equal("accounts" in connection, false, connection.source);
      }

      const connection = (source: string) => {
        const match = body.connections.find((entry) => entry.source === source);
        assert.ok(match, source);
        return match;
      };
      const x = connection("x");
      const instagram = connection("instagram");
      const youtube = connection("youtube");
      const reddit = connection("reddit");
      assert.equal(x.liveAccount?.displayName, "@abhigyan898");
      assert.equal(x.liveAccount?.id, "x-live");
      assert.equal(x.state, "connected");
      assert.equal(x.latestAttempt?.startedAt, "2026-08-20T00:00:00Z");
      assert.equal(x.latestAttempt?.coverage, "complete");
      assert.equal(x.latestAttempt?.status, "complete");
      assert.equal(x.lastSuccessfulCapture?.id, "x-live-run");
      assert.equal(x.lastSuccessfulCapture?.finishedAt, "2026-08-20T00:01:00Z");
      assert.equal(instagram.liveAccount?.displayName, "abhigyan.k");
      assert.equal(instagram.liveAccount?.id, "ig-live");
      assert.equal(instagram.state, "connected");
      assert.equal(youtube.liveAccount?.id, "yt-pending");
      assert.equal(youtube.state, "connecting");
      assert.equal(reddit.liveAccount, null);
      assert.equal(reddit.latestAttempt, null);
      assert.equal(reddit.lastSuccessfulCapture, null);
      assert.equal(reddit.state, "not_connected");
      assert.deepEqual(
        body.imports.map((entry) => ({ id: entry.id, source: entry.source, label: entry.label, importedAt: entry.importedAt, itemCount: entry.itemCount })),
        [
          { id: "reddit-imported", source: "reddit", label: "Reddit export", importedAt: "2026-08-29T00:00:00Z", itemCount: 2 },
          { id: "x-imported", source: "x", label: "X export", importedAt: "2026-08-28T00:00:00Z", itemCount: 1 },
          { id: "ig-imported", source: "instagram", label: "Instagram export", importedAt: "2026-08-04T00:00:00Z", itemCount: 0 },
        ],
      );
      assert.equal(body.preferences.captureOnOpen, false);
      assert.equal(body.extension.state, "not_paired");
      assert.equal(body.extension.lastSeenAt, null);

      const importedHealth = await fetch(`${base}/api/sources/x/health?accountId=x-imported`, { headers: { cookie } });
      assert.equal(importedHealth.status, 404);
      const redditHealth = await fetch(`${base}/api/sources/reddit/health`, { headers: { cookie } });
      assert.equal(redditHealth.status, 200);
      const redditBody = (await redditHealth.json()) as { health: { account: unknown; lastRun: unknown; connectionState: string } };
      assert.equal(redditBody.health.account, null);
      assert.equal(redditBody.health.lastRun, null);
      assert.equal(redditBody.health.connectionState, "not_connected");

      const before = database.prepare(`SELECT COUNT(*) AS n FROM source_accounts`).get() as { n: number };
      const csrf = (await sessionResponse.json()) as { csrf: string };
      const pairing = await fetch(`${base}/api/extension/pair`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf.csrf },
        body: "{}",
      });
      assert.equal(pairing.status, 200);
      const paired = (await pairing.json()) as { token: string; origin: string };
      assert.match(paired.token, /^loc_/);
      assert.equal(paired.origin, base);
      const after = database.prepare(`SELECT COUNT(*) AS n FROM source_accounts`).get() as { n: number };
      assert.equal(after.n, before.n);
    } finally {
      await app.close();
      database.close();
      resetJobsForTest();
    }
  });

  test("import history keeps repeated imports and survives disconnect", async () => {
    process.env.LOCUS_PORT = "8825";
    resetJobsForTest();
    const database = openDb(join(mkdtempSync(join(tmpdir(), "locus-sources-imports-")), "t.db"));
    seedScreenshotMix(database);
    database.prepare(
      `INSERT INTO source_accounts (id, source, external_id, display_name, created_at, account_kind) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("reddit-imported-2", "reddit", "reddit-export-2", "u/imported-2", "2026-08-30T00:00:00Z", "imported");
    const app = listen(database);
    const base = `http://127.0.0.1:${app.port}`;
    try {
      const sessionResponse = await fetch(`${base}/api/session`);
      const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      const csrf = (await sessionResponse.json()) as { csrf: string };
      const before = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as Overview;
      assert.equal(before.connections.length, 4);
      assert.equal(before.connections.find((entry) => entry.source === "reddit")?.state, "not_connected");
      assert.equal(before.imports.filter((entry) => entry.source === "reddit").length, 2);
      const disconnect = await fetch(`${base}/api/sources/x/disconnect`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf.csrf },
        body: JSON.stringify({ accountId: "x-live" }),
      });
      assert.equal(disconnect.status, 200);
      const after = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as Overview;
      assert.equal(after.connections.length, 4);
      assert.deepEqual(
        after.imports.map((entry) => entry.id),
        ["reddit-imported-2", "reddit-imported", "x-imported", "ig-imported"],
      );
    } finally {
      await app.close();
      database.close();
      resetJobsForTest();
    }
  });

  test("empty import history is an empty list", async () => {
    process.env.LOCUS_PORT = "8826";
    resetJobsForTest();
    const database = openDb(join(mkdtempSync(join(tmpdir(), "locus-sources-empty-")), "t.db"));
    const app = listen(database);
    const base = `http://127.0.0.1:${app.port}`;
    try {
      const sessionResponse = await fetch(`${base}/api/session`);
      const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      const body = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as Overview;
      assert.deepEqual(body.imports, []);
      assert.equal(body.connections.length, 4);
      assert.deepEqual(body.account, { mode: "local" });
    } finally {
      await app.close();
      database.close();
      resetJobsForTest();
    }
  });

  test("import history counts distinct live Items, not source records", async () => {
    process.env.LOCUS_PORT = "8836";
    resetJobsForTest();
    const database = openDb(join(mkdtempSync(join(tmpdir(), "locus-sources-item-counts-")), "t.db"));
    insertAccount(database, { id: "reddit-dup", source: "reddit", externalId: "reddit-export-dup", kind: "imported", createdAt: "2026-08-30T00:00:00Z" });
    insertAccount(database, { id: "reddit-other", source: "reddit", externalId: "reddit-export-other", kind: "imported", createdAt: "2026-08-29T00:00:00Z" });
    insertAccount(database, { id: "reddit-live", source: "reddit", externalId: "u-live", kind: "live", createdAt: "2026-08-28T00:00:00Z" });
    insertAccount(database, { id: "x-imported", source: "x", externalId: "x-export", kind: "imported", createdAt: "2026-08-27T00:00:00Z" });
    insertItem(database, "shared-item", "2026-08-30T00:00:00Z");
    insertItem(database, "other-item", "2026-08-29T00:00:00Z");
    insertItem(database, "x-item", "2026-08-27T00:00:00Z");
    insertItem(database, "live-item", "2026-08-28T00:00:00Z");
    insertRecord(database, "reddit-dup-a", "reddit-dup", "t3_a", "shared-item", "2026-08-30T00:00:00Z");
    insertRecord(database, "reddit-dup-b", "reddit-dup", "t3_b", "shared-item", "2026-08-30T00:00:00Z");
    insertRecord(database, "reddit-dup-null", "reddit-dup", "t3_null", null, "2026-08-30T00:00:00Z");
    insertRecord(database, "reddit-dup-ghost", "reddit-dup", "t3_ghost", "missing-item", "2026-08-30T00:00:00Z");
    insertRecord(database, "reddit-other-a", "reddit-other", "t3_c", "other-item", "2026-08-29T00:00:00Z");
    insertRecord(database, "x-imported-a", "x-imported", "x-1", "x-item", "2026-08-27T00:00:00Z");
    insertRecord(database, "reddit-live-a", "reddit-live", "t3_live", "live-item", "2026-08-28T00:00:00Z");
    const app = listen(database);
    const base = `http://127.0.0.1:${app.port}`;
    try {
      const sessionResponse = await fetch(`${base}/api/session`);
      const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      const body = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as Overview;
      assert.equal(body.connections.find((entry) => entry.source === "reddit")?.state, "connected");
      assert.equal(body.connections.find((entry) => entry.source === "reddit")?.liveAccount?.id, "reddit-live");
      assert.deepEqual(
        body.imports.map((entry) => ({ id: entry.id, itemCount: entry.itemCount })),
        [
          { id: "reddit-dup", itemCount: 1 },
          { id: "reddit-other", itemCount: 1 },
          { id: "x-imported", itemCount: 1 },
        ],
      );
    } finally {
      await app.close();
      database.close();
      resetJobsForTest();
    }
  });

  test("last successful capture stays on the live account and ignores later failures and imports", async () => {
    process.env.LOCUS_PORT = "8835";
    resetJobsForTest();
    const database = openDb(join(mkdtempSync(join(tmpdir(), "locus-sources-last-capture-")), "t.db"));
    insertAccount(database, { id: "x-live", source: "x", externalId: "abhigyan898", kind: "live", createdAt: "2026-08-01T00:00:00Z", displayName: "@abhigyan898" });
    insertAccount(database, { id: "x-imported", source: "x", externalId: "x-export", kind: "imported", createdAt: "2026-08-02T00:00:00Z" });
    insertAccount(database, { id: "ig-live", source: "instagram", externalId: "abhigyan.k", kind: "live", createdAt: "2026-08-01T00:00:00Z", displayName: "abhigyan.k" });
    insertAccount(database, { id: "yt-live", source: "youtube", externalId: "yt-user", kind: "live", createdAt: "2026-08-01T00:00:00Z" });
    insertAccount(database, { id: "reddit-imported", source: "reddit", externalId: "reddit-export", kind: "imported", createdAt: "2026-08-06T00:00:00Z" });
    insertCollection(database, "x-live-col", "x-live", "bookmarks", "Bookmarks", "2026-08-01T00:00:00Z");
    insertCollection(database, "x-imported-col", "x-imported", "bookmarks", "Bookmarks", "2026-08-02T00:00:00Z");
    insertCollection(database, "ig-live-col", "ig-live", "saved", "Saved", "2026-08-01T00:00:00Z");
    insertCollection(database, "yt-live-col", "yt-live", "watch-later", "Watch Later", "2026-08-01T00:00:00Z");
    insertCollection(database, "reddit-imported-col", "reddit-imported", "saved", "Saved", "2026-08-06T00:00:00Z");
    insertRun(database, { id: "x-success", collectionId: "x-live-col", startedAt: "2026-08-20T00:00:00Z", finishedAt: "2026-08-20T00:01:00Z", coverage: "complete", status: "ok" });
    insertRun(database, { id: "x-fail", collectionId: "x-live-col", startedAt: "2026-08-21T00:00:00Z", finishedAt: "2026-08-21T00:01:00Z", coverage: "partial", status: "error", errorCode: "logged-out" });
    insertRun(database, { id: "x-imported-run", collectionId: "x-imported-col", startedAt: "2026-08-28T00:00:00Z", finishedAt: "2026-08-28T00:01:00Z", coverage: "complete", status: "complete" });
    insertRun(database, { id: "ig-success", collectionId: "ig-live-col", startedAt: "2026-08-10T00:00:00Z", finishedAt: "2026-08-10T00:01:00Z", coverage: "complete", status: "complete" });
    insertRun(database, { id: "yt-fail", collectionId: "yt-live-col", startedAt: "2026-08-11T00:00:00Z", finishedAt: "2026-08-11T00:01:00Z", coverage: "partial", status: "error", errorCode: "logged-out" });
    insertRun(database, { id: "reddit-imported-run", collectionId: "reddit-imported-col", startedAt: "2026-08-29T00:00:00Z", finishedAt: "2026-08-29T00:01:00Z", coverage: "complete", status: "complete" });
    const app = listen(database);
    const base = `http://127.0.0.1:${app.port}`;
    try {
      const sessionResponse = await fetch(`${base}/api/session`);
      const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      const body = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as Overview;
      const x = body.connections.find((entry) => entry.source === "x")!;
      const instagram = body.connections.find((entry) => entry.source === "instagram")!;
      const youtube = body.connections.find((entry) => entry.source === "youtube")!;
      const reddit = body.connections.find((entry) => entry.source === "reddit")!;
      assert.equal(x.state, "needs_attention");
      assert.equal(x.latestAttempt?.id, "x-fail");
      assert.equal(x.latestAttempt?.status, "error");
      assert.equal(x.lastSuccessfulCapture?.id, "x-success");
      assert.equal(x.lastSuccessfulCapture?.status, "ok");
      assert.equal(instagram.state, "connected");
      assert.equal(instagram.latestAttempt?.id, "ig-success");
      assert.equal(instagram.lastSuccessfulCapture?.id, "ig-success");
      assert.equal(youtube.state, "needs_attention");
      assert.equal(youtube.latestAttempt?.id, "yt-fail");
      assert.equal(youtube.lastSuccessfulCapture, null);
      assert.equal(reddit.state, "not_connected");
      assert.equal(reddit.latestAttempt, null);
      assert.equal(reddit.lastSuccessfulCapture, null);

      setProgress("x", "x-live", { phase: "done", message: "Previous capture complete", previewJpeg: "stale" });
      const stale = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as Overview;
      const xStale = stale.connections.find((entry) => entry.source === "x")!;
      assert.equal(xStale.state, "needs_attention");
      assert.equal(xStale.progress, null);

      markRunning("x", "x-live");
      setProgress("x", "x-live", { phase: "capturing", message: "Reading bookmarks…", previewJpeg: "live", seen: 4 });
      const capturing = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as Overview;
      const xCapturing = capturing.connections.find((entry) => entry.source === "x")!;
      assert.equal(xCapturing.state, "capturing");
      assert.equal(xCapturing.progress?.phase, "capturing");
      assert.equal(xCapturing.progress?.previewJpeg, "live");
      assert.equal(xCapturing.lastSuccessfulCapture?.id, "x-success");
      assert.equal(xCapturing.latestAttempt?.id, "x-fail");
    } finally {
      markDone("x", "x-live");
      await app.close();
      database.close();
      resetJobsForTest();
    }
  });

  test("pending Source identity is replaced by the discovered handle", async () => {
    process.env.LOCUS_PORT = "8838";
    resetJobsForTest();
    const database = openDb(join(mkdtempSync(join(tmpdir(), "locus-sources-identity-")), "t.db"));
    insertAccount(database, { id: "x-pending", source: "x", externalId: "pending:x-pending", kind: "live", createdAt: "2026-08-03T00:00:00Z", displayName: "X" });
    insertAccount(database, { id: "ig-pending", source: "instagram", externalId: "pending:ig-pending", kind: "live", createdAt: "2026-08-03T00:00:00Z", displayName: "Instagram" });
    const xTok = lookupToken(database, issueToken(database, "x", "x-pending").token)!;
    startSession(database, xTok, {
      protocolVersion: 1,
      source: "x",
      producer: { id: "locus.extension", version: "0.1.0" },
      accountExternalId: "abhigyan898",
      collection: { externalId: "bookmarks", name: "Bookmarks" },
      mode: "incremental",
      observedAt: "2026-08-20T00:00:00.000Z",
    });
    const igTok = lookupToken(database, issueToken(database, "instagram", "ig-pending").token)!;
    startSession(database, igTok, {
      protocolVersion: 1,
      source: "instagram",
      producer: { id: "locus.runner", version: "0.1.0" },
      accountExternalId: "abhigyan.k",
      collection: { externalId: "saved", name: "Saved" },
      mode: "incremental",
      observedAt: "2026-08-20T00:00:00.000Z",
    });
    const app = listen(database);
    const base = `http://127.0.0.1:${app.port}`;
    try {
      const sessionResponse = await fetch(`${base}/api/session`);
      const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      const body = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as Overview;
      const x = body.connections.find((entry) => entry.source === "x")!;
      const instagram = body.connections.find((entry) => entry.source === "instagram")!;
      assert.equal(x.liveAccount?.externalId, "abhigyan898");
      assert.equal(x.liveAccount?.displayName, "abhigyan898");
      assert.equal(instagram.liveAccount?.externalId, "abhigyan.k");
      assert.equal(instagram.liveAccount?.displayName, "abhigyan.k");
    } finally {
      await app.close();
      database.close();
      resetJobsForTest();
    }
  });

  test("lastSuccessfulCapture is the newest terminal error-free live capture", async () => {
    process.env.LOCUS_PORT = "8839";
    resetJobsForTest();
    const database = openDb(join(mkdtempSync(join(tmpdir(), "locus-sources-success-")), "t.db"));
    insertAccount(database, { id: "x-live", source: "x", externalId: "abhigyan898", kind: "live", createdAt: "2026-08-01T00:00:00Z", displayName: "X" });
    insertAccount(database, { id: "x-imported", source: "x", externalId: "x-export", kind: "imported", createdAt: "2026-08-02T00:00:00Z" });
    insertAccount(database, { id: "yt-live", source: "youtube", externalId: "yt-user", kind: "live", createdAt: "2026-08-01T00:00:00Z" });
    insertAccount(database, { id: "ig-live", source: "instagram", externalId: "abhigyan.k", kind: "live", createdAt: "2026-08-01T00:00:00Z", displayName: "abhigyan.k" });
    insertCollection(database, "x-live-col", "x-live", "bookmarks", "Bookmarks", "2026-08-01T00:00:00Z");
    insertCollection(database, "x-imported-col", "x-imported", "bookmarks", "Bookmarks", "2026-08-02T00:00:00Z");
    insertCollection(database, "yt-live-col", "yt-live", "watch-later", "Watch Later", "2026-08-01T00:00:00Z");
    insertCollection(database, "ig-live-col", "ig-live", "saved", "Saved", "2026-08-01T00:00:00Z");
    insertRun(database, { id: "x-complete", collectionId: "x-live-col", startedAt: "2026-08-20T00:00:00Z", finishedAt: "2026-08-20T00:01:00Z", coverage: "complete", status: "ok" });
    insertRun(database, { id: "x-partial", collectionId: "x-live-col", startedAt: "2026-08-21T00:00:00Z", finishedAt: "2026-08-21T00:01:00Z", coverage: "partial", status: "ok" });
    insertRun(database, { id: "x-fail", collectionId: "x-live-col", startedAt: "2026-08-22T00:00:00Z", finishedAt: "2026-08-22T00:01:00Z", coverage: "partial", status: "error", errorCode: "logged-out" });
    insertRun(database, { id: "x-imported-run", collectionId: "x-imported-col", startedAt: "2026-08-28T00:00:00Z", finishedAt: "2026-08-28T00:01:00Z", coverage: "complete", status: "complete" });
    insertRun(database, { id: "yt-partial", collectionId: "yt-live-col", startedAt: "2026-08-10T00:00:00Z", finishedAt: "2026-08-10T00:01:00Z", coverage: "partial", status: "complete" });
    insertRun(database, { id: "ig-success", collectionId: "ig-live-col", startedAt: "2026-08-11T00:00:00Z", finishedAt: "2026-08-11T00:01:00Z", coverage: "complete", status: "complete" });
    insertRun(database, { id: "ig-cancelled", collectionId: "ig-live-col", startedAt: "2026-08-12T00:00:00Z", finishedAt: "2026-08-12T00:01:00Z", coverage: "partial", status: "cancelled", errorCode: "interrupted" });
    const app = listen(database);
    const base = `http://127.0.0.1:${app.port}`;
    try {
      const sessionResponse = await fetch(`${base}/api/session`);
      const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      const body = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as Overview;
      const x = body.connections.find((entry) => entry.source === "x")!;
      const youtube = body.connections.find((entry) => entry.source === "youtube")!;
      const instagram = body.connections.find((entry) => entry.source === "instagram")!;
      const reddit = body.connections.find((entry) => entry.source === "reddit")!;
      assert.equal(x.liveAccount?.externalId, "abhigyan898");
      assert.equal(x.liveAccount?.displayName, null);
      assert.equal(x.state, "needs_attention");
      assert.equal(x.lastSuccessfulCapture?.id, "x-partial");
      assert.equal(x.lastSuccessfulCapture?.coverage, "partial");
      assert.equal(x.lastSuccessfulCapture?.status, "ok");
      assert.equal(x.latestAttempt?.id, "x-fail");
      assert.equal(youtube.state, "connected");
      assert.equal(youtube.lastSuccessfulCapture?.id, "yt-partial");
      assert.equal(youtube.lastSuccessfulCapture?.coverage, "partial");
      assert.equal(youtube.latestAttempt?.id, "yt-partial");
      assert.equal(instagram.lastSuccessfulCapture?.id, "ig-success");
      assert.equal(instagram.lastSuccessfulCapture?.coverage, "complete");
      assert.equal(instagram.latestAttempt?.id, "ig-cancelled");
      assert.equal(instagram.latestAttempt?.status, "cancelled");
      assert.equal(reddit.state, "not_connected");
      assert.equal(reddit.lastSuccessfulCapture, null);
      assert.equal(reddit.latestAttempt, null);
    } finally {
      await app.close();
      database.close();
      resetJobsForTest();
    }
  });

  test("extension health uses last heartbeat, not pairing output", async () => {
    process.env.LOCUS_PORT = "8837";
    resetJobsForTest();
    const database = openDb(join(mkdtempSync(join(tmpdir(), "locus-sources-extension-")), "t.db"));
    const app = listen(database);
    const base = `http://127.0.0.1:${app.port}`;
    try {
      const sessionResponse = await fetch(`${base}/api/session`);
      const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      const csrf = (await sessionResponse.json()) as { csrf: string };
      const pair = await fetch(`${base}/api/extension/pair`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf.csrf },
        body: "{}",
      });
      assert.equal(pair.status, 200);
      const unseen = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as Overview;
      assert.equal(unseen.extension.state, "not_paired");
      assert.equal(unseen.extension.lastSeenAt, null);

      const seenAt = Date.now();
      heartbeat(seenAt);
      const paired = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as Overview;
      assert.equal(paired.extension.state, "paired");
      assert.equal(paired.extension.lastSeenAt, new Date(seenAt).toISOString());

      heartbeat(seenAt - 60_000);
      const stale = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as Overview;
      assert.equal(stale.extension.state, "needs_attention");
      assert.equal(stale.extension.lastSeenAt, new Date(seenAt - 60_000).toISOString());
    } finally {
      await app.close();
      database.close();
      resetJobsForTest();
    }
  });
});

function seedScreenshotMix(database: Db): void {
  const insert = database.prepare(
    `INSERT INTO source_accounts (id, source, external_id, display_name, created_at, account_kind) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insert.run("x-live", "x", "abhigyan898", "@abhigyan898", "2026-08-01T00:00:00Z", "live");
  insert.run("x-imported", "x", "abhigyan898-export", "@abhigyan898", "2026-08-02T00:00:00Z", "imported");
  insert.run("x-pending", "x", "pending:x-pending", "X", "2026-08-03T00:00:00Z", "live");
  insert.run("ig-live", "instagram", "abhigyan.k", "abhigyan.k", "2026-08-01T00:00:00Z", "live");
  insert.run("ig-imported", "instagram", "ig-export", "abhigyan.k", "2026-08-04T00:00:00Z", "imported");
  insert.run("yt-pending", "youtube", "pending:yt-pending", "YouTube", "2026-08-05T00:00:00Z", "live");
  insert.run("reddit-imported", "reddit", "reddit-export", "u/imported", "2026-08-06T00:00:00Z", "imported");

  insertCollection(database, "x-live-col", "x-live", "bookmarks", "Bookmarks", "2026-08-01T00:00:00Z");
  insertCollection(database, "x-imported-col", "x-imported", "bookmarks", "Bookmarks", "2026-08-02T00:00:00Z");
  insertCollection(database, "reddit-imported-col", "reddit-imported", "saved", "Saved", "2026-08-06T00:00:00Z");

  insertRun(database, { id: "x-live-run", collectionId: "x-live-col", startedAt: "2026-08-20T00:00:00Z", finishedAt: "2026-08-20T00:01:00Z", coverage: "complete", status: "complete" });
  insertRun(database, { id: "x-imported-run", collectionId: "x-imported-col", startedAt: "2026-08-28T00:00:00Z", finishedAt: "2026-08-28T00:01:00Z", coverage: "partial", status: "error", errorCode: "logged-out" });
  insertRun(database, { id: "reddit-imported-run", collectionId: "reddit-imported-col", startedAt: "2026-08-29T00:00:00Z", finishedAt: "2026-08-29T00:01:00Z", coverage: "complete", status: "complete" });
  insertItem(database, "x-item-1", "2026-08-02T00:00:00Z");
  insertItem(database, "reddit-item-1", "2026-08-06T00:00:00Z");
  insertItem(database, "reddit-item-2", "2026-08-06T00:00:00Z");
  insertRecord(database, "x-imported-sr", "x-imported", "x-1", "x-item-1", "2026-08-02T00:00:00Z");
  insertRecord(database, "reddit-imported-sr-1", "reddit-imported", "t3_a", "reddit-item-1", "2026-08-06T00:00:00Z");
  insertRecord(database, "reddit-imported-sr-2", "reddit-imported", "t3_b", "reddit-item-2", "2026-08-06T00:00:00Z");
}

function insertAccount(database: Db, row: { id: string; source: string; externalId: string; kind: string; createdAt: string; displayName?: string }): void {
  database.prepare(
    `INSERT INTO source_accounts (id, source, external_id, display_name, created_at, account_kind) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.source, row.externalId, row.displayName ?? row.externalId, row.createdAt, row.kind);
}

function insertCollection(database: Db, id: string, accountId: string, externalId: string, name: string, createdAt: string): void {
  database.prepare(
    `INSERT INTO source_collections (id, source_account_id, external_id, name, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, accountId, externalId, name, createdAt);
}

function insertRun(database: Db, row: { id: string; collectionId: string; startedAt: string; finishedAt: string; coverage: string; status: string; errorCode?: string }): void {
  if (row.errorCode) {
    database
      .prepare(
        `INSERT INTO capture_runs (id, source_collection_id, producer_id, producer_version, started_at, finished_at, coverage, status, error_code) VALUES (?, ?, 'test', '1', ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.collectionId, row.startedAt, row.finishedAt, row.coverage, row.status, row.errorCode);
    return;
  }
  database
    .prepare(
      `INSERT INTO capture_runs (id, source_collection_id, producer_id, producer_version, started_at, finished_at, coverage, status) VALUES (?, ?, 'test', '1', ?, ?, ?, ?)`,
    )
    .run(row.id, row.collectionId, row.startedAt, row.finishedAt, row.coverage, row.status);
}

function insertItem(database: Db, id: string, at: string): void {
  database.prepare(
    `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at) VALUES (?, 'post', ?, ?, ?, ?, '[]', ?, ?)`,
  ).run(id, id, id, `https://example.com/${id}`, at, at, at);
}

function insertRecord(database: Db, id: string, accountId: string, externalId: string, itemId: string | null, at: string): void {
  database.prepare(
    `INSERT INTO source_records (id, source_account_id, external_id, item_id, first_observed_at, last_observed_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, accountId, externalId, itemId, at, at);
}
