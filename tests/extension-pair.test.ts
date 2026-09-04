import { test } from "node:test";
import assert from "node:assert/strict";
import { pairRequestMessage, pairViaExtension } from "../app/src/extension-pair.ts";

const ORIGIN = "http://127.0.0.1:8824";
const TOKEN = "loc_0f1e2d3c4b5a69788796a5b4c3d2e1f0";

type Listener = (event: { data: unknown; origin: string; source: unknown }) => void;
type Delivery = { data: unknown; origin?: string } | undefined;

/**
 * Fake window plus a stand-in for extension/shell/content.js: postMessage hands
 * the payload to `relay`, which models the content script — the ack it returns
 * is delivered back immediately (the content script posts it before the worker
 * sees anything), and verify (when present) is delivered on a later turn, like
 * the real ack-then-worker-reply gap. Reply literals are spelled out here (not
 * imported from the module) so a one-sided rename of the protocol breaks loudly.
 */
function fakeWindow(
  relay: (data: unknown) => { ack: Delivery; verify?: { data: unknown; origin?: string; delay?: number } },
  origin = ORIGIN,
) {
  const listeners = new Set<Listener>();
  const win = {
    location: { origin },
    addEventListener: (_type: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_type: string, fn: Listener) => listeners.delete(fn),
    postMessage: (data: unknown, targetOrigin: string) => {
      const reply = relay(data);
      if (reply.ack !== undefined) {
        for (const fn of [...listeners]) {
          fn({ data: reply.ack.data, origin: reply.ack.origin ?? targetOrigin, source: win });
        }
      }
      const verify = reply.verify;
      if (verify !== undefined) {
        setTimeout(() => {
          for (const fn of [...listeners]) {
            fn({ data: verify.data, origin: verify.origin ?? targetOrigin, source: win });
          }
        }, verify.delay ?? 0);
      }
    },
  };
  return win as unknown as Window;
}

test("pairing resolves true when the extension acks then the worker echoes the request id", async () => {
  const win = fakeWindow((data) => {
    const req = data as { source: string; type: string; requestId: string; token: string; origin: string };
    assert.equal(req.source, "locus-web");
    assert.equal(req.type, "locus:pair");
    assert.equal(req.token, TOKEN);
    assert.equal(req.origin, ORIGIN);
    return {
      ack: { data: { source: "locus-extension", type: "locus:pair-ack", requestId: req.requestId } },
      verify: { data: { source: "locus-extension", type: "locus:paired", requestId: req.requestId, ok: true } },
    };
  });
  assert.equal(await pairViaExtension(win, TOKEN, 250, 250), true);
});

test("pairing resolves false when the worker refuses the token", async () => {
  const win = fakeWindow((data) => {
    const req = data as { requestId: string };
    return {
      ack: { data: { source: "locus-extension", type: "locus:pair-ack", requestId: req.requestId } },
      verify: { data: { source: "locus-extension", type: "locus:paired", requestId: req.requestId, ok: false } },
    };
  });
  assert.equal(await pairViaExtension(win, TOKEN, 250, 250), false);
});

test("no content script means no ack resolves false fast", async () => {
  const win = fakeWindow(() => ({ ack: undefined }));
  assert.equal(await pairViaExtension(win, TOKEN, 30), false);
});

test("a slow worker verify within the generous cap still resolves true", async () => {
  // The verify cap starts only after the ack, so the 10ms presence cap must
  // not fire while the worker is still verifying.
  const win = fakeWindow((data) => {
    const req = data as { requestId: string };
    return {
      ack: { data: { source: "locus-extension", type: "locus:pair-ack", requestId: req.requestId } },
      verify: {
        data: { source: "locus-extension", type: "locus:paired", requestId: req.requestId, ok: true },
        delay: 20,
      },
    };
  });
  assert.equal(await pairViaExtension(win, TOKEN, 10, 200), true);
});

test("an ack with a worker verify that never comes back resolves false on the generous abort", async () => {
  const win = fakeWindow((data) => {
    const req = data as { requestId: string };
    return {
      ack: { data: { source: "locus-extension", type: "locus:pair-ack", requestId: req.requestId } },
    };
  });
  assert.equal(await pairViaExtension(win, TOKEN, 30, 50), false);
});

test("acks and verifies from other origins, sources, or request ids are ignored", async () => {
  const crossOriginAck = fakeWindow((data) => {
    const req = data as { requestId: string };
    return {
      ack: {
        data: { source: "locus-extension", type: "locus:pair-ack", requestId: req.requestId },
        origin: "https://evil.example",
      },
    };
  });
  assert.equal(await pairViaExtension(crossOriginAck, TOKEN, 30, 30), false);

  const crossOriginVerify = fakeWindow((data) => {
    const req = data as { requestId: string };
    return {
      ack: { data: { source: "locus-extension", type: "locus:pair-ack", requestId: req.requestId } },
      verify: {
        data: { source: "locus-extension", type: "locus:paired", requestId: req.requestId, ok: true },
        origin: "https://evil.example",
      },
    };
  });
  assert.equal(await pairViaExtension(crossOriginVerify, TOKEN, 30, 30), false);

  const wrongSourceAck = fakeWindow((data) => {
    const req = data as { requestId: string };
    return {
      ack: { data: { source: "something-else", type: "locus:pair-ack", requestId: req.requestId } },
    };
  });
  assert.equal(await pairViaExtension(wrongSourceAck, TOKEN, 30, 30), false);

  const wrongVerifyRequestId = fakeWindow((data) => {
    const req = data as { requestId: string };
    return {
      ack: { data: { source: "locus-extension", type: "locus:pair-ack", requestId: req.requestId } },
      verify: { data: { source: "locus-extension", type: "locus:paired", requestId: "not-mine", ok: true } },
    };
  });
  assert.equal(await pairViaExtension(wrongVerifyRequestId, TOKEN, 30, 30), false);
});

test("pairRequestMessage targets this page's origin", () => {
  assert.deepEqual(pairRequestMessage(TOKEN, ORIGIN, "pair-abc"), {
    source: "locus-web",
    type: "locus:pair",
    requestId: "pair-abc",
    token: TOKEN,
    origin: ORIGIN,
  });
});
