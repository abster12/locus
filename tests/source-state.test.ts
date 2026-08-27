import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySourceAccount } from "../server/source-state.ts";

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
