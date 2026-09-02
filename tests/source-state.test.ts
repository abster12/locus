import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySourceAccount, pickConnectionAccount, sourceConnectionState } from "../server/source-state.ts";

test("an old progress record is not mistaken for an active extension capture", () => {
  assert.equal(
    classifySourceAccount({
      accountKind: "live",
      externalId: "account-1",
      captureRunning: false,
      extensionConnected: true,
      runnerProfileExists: false,
    }),
    "connected",
  );
});

test("source state distinguishes imported, pending, extension, and runner accounts", () => {
  assert.equal(classifySourceAccount({ accountKind: "imported", externalId: "account-1", captureRunning: false, extensionConnected: false, runnerProfileExists: false }), "imported");
  assert.equal(classifySourceAccount({ accountKind: "live", externalId: "pending:account-1", captureRunning: false, extensionConnected: false, runnerProfileExists: false }), "pending");
  assert.equal(classifySourceAccount({ accountKind: "live", externalId: "account-1", captureRunning: true, extensionConnected: true, runnerProfileExists: false }), "extension");
  assert.equal(classifySourceAccount({ accountKind: "live", externalId: "account-1", captureRunning: true, extensionConnected: false, runnerProfileExists: true }), "runner");
});

test("a resolved live account is selected ahead of pending and imported rows", () => {
  const live = { id: "live", accountKind: "live" as const, externalId: "abhigyan898", createdAt: "2026-08-01T00:00:00Z" };
  const pending = { id: "pending", accountKind: "live" as const, externalId: "pending:stale", createdAt: "2026-08-03T00:00:00Z" };
  const imported = { id: "imported", accountKind: "imported" as const, externalId: "abhigyan898", createdAt: "2026-08-04T00:00:00Z" };
  assert.equal(pickConnectionAccount([imported, pending, live])?.id, "live");
  assert.equal(pickConnectionAccount([pending, imported])?.id, "pending");
  assert.equal(pickConnectionAccount([imported]), undefined);
  assert.equal(pickConnectionAccount([]), undefined);
  const disconnected = { id: "gone", accountKind: "disconnected" as const, externalId: "abhigyan898", createdAt: "2026-08-05T00:00:00Z" };
  assert.equal(pickConnectionAccount([disconnected, imported]), undefined);
});

test("the newest resolved live account wins when several exist", () => {
  const older = { id: "older", accountKind: "live" as const, externalId: "old", createdAt: "2026-08-01T00:00:00Z" };
  const newer = { id: "newer", accountKind: "live" as const, externalId: "new", createdAt: "2026-08-02T00:00:00Z" };
  assert.equal(pickConnectionAccount([older, newer])?.id, "newer");
});

test("connection presentation maps live, pending, running, and recovery into one status", () => {
  assert.equal(sourceConnectionState({ hasLiveAccount: false, pending: false, running: false, hasRecovery: false }), "not_connected");
  assert.equal(sourceConnectionState({ hasLiveAccount: true, pending: true, running: false, hasRecovery: false }), "connecting");
  assert.equal(sourceConnectionState({ hasLiveAccount: true, pending: false, running: false, hasRecovery: false }), "connected");
  assert.equal(sourceConnectionState({ hasLiveAccount: true, pending: false, running: true, hasRecovery: false }), "capturing");
  assert.equal(sourceConnectionState({ hasLiveAccount: true, pending: false, running: false, hasRecovery: true }), "needs_attention");
  assert.equal(sourceConnectionState({ hasLiveAccount: true, pending: true, running: true, hasRecovery: false }), "capturing");
});
