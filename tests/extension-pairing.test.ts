import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPairing } from "../extension/shell/pairing.js";

const ORIGIN = "http://127.0.0.1:8824";
const TOKEN = "loc_0f1e2d3c4b5a69788796a5b4c3d2e1f0";

function fakeDesk(response: { status: number; body: unknown }, calls: { url: string; body: unknown }[] = []) {
  return async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    };
  };
}

function fakeStorage() {
  const written: { origin: string; token: string }[] = [];
  return { written, set: async (value: { origin: string; token: string }) => void written.push(value) };
}

test("a desk that echoes the token back is stored", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const storage = fakeStorage();
  await verifyPairing({
    origin: ORIGIN,
    token: TOKEN,
    fetchImpl: fakeDesk({ status: 200, body: { token: TOKEN, origin: ORIGIN } }, calls),
    storage,
  });
  assert.deepEqual(calls[0]?.body, { token: TOKEN });
  assert.deepEqual(storage.written, [{ origin: ORIGIN, token: TOKEN }]);
});

test("a desk that mints a different token (unknown input) is refused", async () => {
  const storage = fakeStorage();
  await assert.rejects(
    verifyPairing({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: fakeDesk({ status: 200, body: { token: "loc_" + "f".repeat(32), origin: ORIGIN } }),
      storage,
    }),
    /did not accept/,
  );
  assert.equal(storage.written.length, 0);
});

test("a desk that rejects the token is refused", async () => {
  const storage = fakeStorage();
  await assert.rejects(
    verifyPairing({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: fakeDesk({ status: 401, body: { error: "invalid token" } }),
      storage,
    }),
    /did not accept/,
  );
  assert.equal(storage.written.length, 0);
});

test("malformed tokens and origins never reach the desk", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = fakeDesk({ status: 200, body: {} }, calls);
  const storage = fakeStorage();
  await assert.rejects(verifyPairing({ origin: ORIGIN, token: "not-a-token", fetchImpl, storage }), /bad pairing code/);
  await assert.rejects(verifyPairing({ origin: "ftp://x", token: TOKEN, fetchImpl, storage }), /bad origin/);
  await assert.rejects(verifyPairing({ origin: ORIGIN, token: `loc_${"g".repeat(32)}`, fetchImpl, storage }), /bad pairing code/);
  assert.equal(calls.length, 0);
  assert.equal(storage.written.length, 0);
});
