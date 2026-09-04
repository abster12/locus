import { test } from "node:test";
import assert from "node:assert/strict";

// extension/shell/content.js registers a window message listener at import time
// and touches the globals window, location, and chrome. Stub them before the
// dynamic import; the query string gives each case its own module instance.
const ORIGIN = "http://127.0.0.1:8824";
const TOKEN = "loc_0f1e2d3c4b5a69788796a5b4c3d2e1f0";

type Listener = (event: { source: unknown; origin: string; data: unknown }) => void;

function fakeGlobals(reply: { ok: boolean } | undefined, fail = false) {
  const listeners = new Set<Listener>();
  const sent: unknown[] = [];
  const posted: unknown[] = [];
  const log: string[] = [];
  const win = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Listener) => {
      if (type === "message") listeners.add(fn);
    },
    removeEventListener: () => {},
    postMessage: (data: unknown) => {
      posted.push(data);
      log.push((data as { type: string }).type === "locus:paired" ? "paired" : "ack");
    },
  };
  const chromeStub = {
    runtime: {
      sendMessage: (msg: unknown, cb: (r: { ok: boolean } | undefined) => void) => {
        sent.push(msg);
        log.push("sent");
        if (fail) (chromeStub.runtime as { lastError?: unknown }).lastError = new Error("no receiver");
        cb(reply);
        delete (chromeStub.runtime as { lastError?: unknown }).lastError;
      },
    },
  };
  (globalThis as { window?: unknown }).window = win;
  (globalThis as { location?: unknown }).location = win.location;
  (globalThis as { chrome?: unknown }).chrome = chromeStub;
  return {
    win,
    listeners,
    sent,
    posted,
    log,
    dispatch(data: unknown, origin = ORIGIN, source: unknown = win) {
      for (const fn of [...listeners]) fn({ data, origin, source });
    },
  };
}

function loadContent() {
  return import(`../extension/shell/content.js?case=${Math.random().toString(36).slice(2)}`);
}

function pairRequest(requestId: string, overrides: Record<string, unknown> = {}) {
  return { source: "locus-web", type: "locus:pair", requestId, token: TOKEN, origin: ORIGIN, ...overrides };
}

test("a valid pairing request is acked, then relayed to the service worker and confirmed", async () => {
  const g = fakeGlobals({ ok: true });
  await loadContent();
  g.dispatch(pairRequest("pair-1"));
  // The ack is presence — it must go out immediately, before the request
  // reaches the service worker.
  assert.deepEqual(g.log, ["ack", "sent", "paired"]);
  assert.deepEqual(g.sent, [{ type: "locus-pair", origin: ORIGIN, token: TOKEN }]);
  assert.deepEqual(g.posted, [
    { source: "locus-extension", type: "locus:pair-ack", requestId: "pair-1" },
    { source: "locus-extension", type: "locus:paired", requestId: "pair-1", ok: true },
  ]);
});

test("a service worker failure is reported back as not paired", async () => {
  const g = fakeGlobals(undefined, true);
  await loadContent();
  g.dispatch(pairRequest("pair-2"));
  assert.deepEqual(g.posted, [
    { source: "locus-extension", type: "locus:pair-ack", requestId: "pair-2" },
    { source: "locus-extension", type: "locus:paired", requestId: "pair-2", ok: false },
  ]);
});

test("a worker reply of ok:false with no lastError is reported back as not paired", async () => {
  // The service worker answers { ok: false } via a successful sendResponse when
  // it refuses the token, so lastError is unset — the reply itself must decide.
  const g = fakeGlobals({ ok: false });
  await loadContent();
  g.dispatch(pairRequest("pair-3"));
  assert.deepEqual(g.sent, [{ type: "locus-pair", origin: ORIGIN, token: TOKEN }]);
  assert.deepEqual(g.posted, [
    { source: "locus-extension", type: "locus:pair-ack", requestId: "pair-3" },
    { source: "locus-extension", type: "locus:paired", requestId: "pair-3", ok: false },
  ]);
});

test("junk requests are dropped before the service worker sees them", async () => {
  const g = fakeGlobals({ ok: true });
  await loadContent();
  g.dispatch(pairRequest("pair-3", { token: "not-a-token" }));
  g.dispatch(pairRequest("pair-3", { origin: "https://evil.example" }));
  g.dispatch(pairRequest("pair-3", { source: "someone-else", type: "locus:pair" }));
  g.dispatch(pairRequest("pair-3"), "https://evil.example"); // event origin spoof
  g.dispatch(pairRequest("pair-3"), ORIGIN, { other: "window" }); // from another frame
  assert.equal(g.sent.length, 0);
  assert.equal(g.posted.length, 0);
});
