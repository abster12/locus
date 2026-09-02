import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCOUNT_CALLBACK,
  consumeCallbackError,
  loadSession,
  LOCAL_LIBRARY_LABEL,
  signOutHosted,
  startGoogleSignIn,
} from "../app/src/session.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const hostedOk = {
  csrfToken: "hosted-csrf",
  user: { id: "u1", name: "Ada", email: "ada@example.com", image: null },
  session: { expiresAt: "2026-09-03T00:00:00.000Z" },
  library: { id: "lib-1", name: "Ada's Library", role: "owner" },
};

test("local success normalizes csrf and Local account label", async () => {
  const state = await loadSession("local", async () => jsonResponse(200, { csrf: "local-csrf", port: 8787, libraryId: "local" }));
  assert.deepEqual(state, {
    kind: "local-ready",
    csrfToken: "local-csrf",
    library: { id: "local", name: LOCAL_LIBRARY_LABEL },
  });
});

test("hosted success keeps user, library, and csrfToken", async () => {
  const state = await loadSession("hosted", async () => jsonResponse(200, hostedOk));
  assert.deepEqual(state, {
    kind: "hosted-ready",
    csrfToken: "hosted-csrf",
    user: hostedOk.user,
    session: hostedOk.session,
    library: hostedOk.library,
  });
});

test("hosted 401 is signed out, not a load failure", async () => {
  const state = await loadSession("hosted", async () => jsonResponse(401, { error: "Unauthorized" }));
  assert.deepEqual(state, { kind: "hosted-signed-out" });
});

test("hosted 403 is access denied, not signed out", async () => {
  const state = await loadSession("hosted", async () => jsonResponse(403, { error: "Forbidden" }));
  assert.deepEqual(state, { kind: "hosted-access-denied" });
});

test("local 401 is a load failure, not hosted signed-out", async () => {
  const state = await loadSession("local", async () => jsonResponse(401, { error: "Unauthorized" }));
  assert.deepEqual(state, { kind: "load-failed" });
});

test("malformed hosted body is a load failure", async () => {
  const state = await loadSession("hosted", async () => jsonResponse(200, { csrfToken: "x" }));
  assert.deepEqual(state, { kind: "load-failed" });
});

test("network failure is a load failure, not signed out", async () => {
  const state = await loadSession("hosted", async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.deepEqual(state, { kind: "load-failed" });
});

test("hosted 5xx is a load failure, not signed out", async () => {
  const state = await loadSession("hosted", async () => jsonResponse(500, { error: "Internal server error" }));
  assert.deepEqual(state, { kind: "load-failed" });
});

test("Google sign-in posts the allowlisted Account callback", async () => {
  let body = "";
  const result = await startGoogleSignIn(async (_url, init) => {
    body = String(init?.body ?? "");
    return jsonResponse(200, { url: "https://accounts.google.com/o/oauth2/v2/auth" });
  });
  assert.deepEqual(result, { ok: true, url: "https://accounts.google.com/o/oauth2/v2/auth" });
  assert.deepEqual(JSON.parse(body), { provider: "google", callbackURL: ACCOUNT_CALLBACK });
});

test("sign-out posts JSON to the hosted endpoint", async () => {
  let method = "";
  let body = "";
  const result = await signOutHosted(async (_url, init) => {
    method = init?.method ?? "";
    body = String(init?.body ?? "");
    return jsonResponse(200, { success: true });
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(method, "POST");
  assert.equal(body, "{}");
});

test("sign-out non-2xx is a failure", async () => {
  const result = await signOutHosted(async () => jsonResponse(500, { error: "Internal server error" }));
  assert.deepEqual(result, { ok: false });
});

test("callback error params are stripped from the visible URL", () => {
  const url = new URL("https://locus.example/?error=access_denied&error_description=denied#/account");
  let replaced = "";
  assert.equal(consumeCallbackError(url, (href) => {
    replaced = href;
  }), true);
  assert.equal(replaced, "/#/account");
  assert.equal(url.searchParams.has("error"), false);
});
