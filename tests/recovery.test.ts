import { test } from "node:test";
import assert from "node:assert/strict";
import { recoveryText } from "../core/types.ts";

test("recovery copy exists for the required capture errors", () => {
  const codes = [
    "logged-out",
    "login-timeout",
    "session-expired",
    "challenge",
    "wrong-page",
    "permission-denied",
    "site-changed",
    "scan-stalled",
    "tab-closed",
    "server-unreachable",
    "storage-full",
    "interrupted",
  ] as const;
  for (const code of codes) {
    const text = recoveryText(code);
    assert.ok(text.length > 10, code);
  }
  assert.match(recoveryText("challenge"), /complete the check/i);
  assert.match(recoveryText("logged-out"), /never sees your password/i);
  assert.match(recoveryText("site-changed"), /source changed/i);
});
