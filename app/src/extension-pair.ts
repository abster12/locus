// Page half of the extension auto-pair handshake. The relay on the extension
// side is extension/shell/content.js (plain JS, so the message shapes below are
// duplicated there on purpose — keep the two in sync).
//
// Flow on Pair extension: the page mints a device token, posts it to the window,
// the content script forwards it to the service worker, and the service worker
// verifies it with the desk before storing. The page resolves true only when the
// extension confirmed; otherwise the caller falls back to the copy-paste code.
export const PAIR_REQUEST_TYPE = "locus:pair";
export const PAIR_ACK_TYPE = "locus:pair-ack";
export const PAIR_REPLY_TYPE = "locus:paired";
export const PAGE_SOURCE = "locus-web";
export const EXTENSION_SOURCE = "locus-extension";

export type PairRequestMessage = {
  source: typeof PAGE_SOURCE;
  type: typeof PAIR_REQUEST_TYPE;
  requestId: string;
  token: string;
  origin: string;
};

export type PairReplyMessage = {
  source: typeof EXTENSION_SOURCE;
  type: typeof PAIR_REPLY_TYPE;
  requestId: string;
  ok: boolean;
};

export type PairAckMessage = {
  source: typeof EXTENSION_SOURCE;
  type: typeof PAIR_ACK_TYPE;
  requestId: string;
};

export function pairRequestMessage(token: string, origin: string, requestId: string): PairRequestMessage {
  return { source: PAGE_SOURCE, type: PAIR_REQUEST_TYPE, requestId, token, origin };
}

export function isPairReply(value: unknown, requestId: string): value is PairReplyMessage {
  if (typeof value !== "object" || value === null) return false;
  const msg = value as Partial<PairReplyMessage>;
  return msg.source === EXTENSION_SOURCE && msg.type === PAIR_REPLY_TYPE && msg.requestId === requestId && typeof msg.ok === "boolean";
}

export function isPairAck(value: unknown, requestId: string): value is PairAckMessage {
  if (typeof value !== "object" || value === null) return false;
  const msg = value as Partial<PairAckMessage>;
  return msg.source === EXTENSION_SOURCE && msg.type === PAIR_ACK_TYPE && msg.requestId === requestId;
}

/**
 * Offers `token` to the Locus extension on this page's origin, in two phases.
 *
 * Phase 1 — presence: the content script acks receipt (locus:pair-ack) as soon
 * as it accepts the request. No ack within ackTimeoutMs means nobody is home —
 * no extension, or no content script on this page — and resolves false fast so
 * the copy-paste code shows right away instead of holding the page hostage.
 *
 * Phase 2 — verify: the worker's { ok } (locus:paired) can be slow (cold
 * service worker, desk fetch), so verifyTimeoutMs is a generous abort.
 * Resolving false early here would show the copy-paste code while the
 * extension is about to confirm — the page would flip from code to "Paired".
 *
 * One cap per phase: the short cap is only ever "nobody home", the generous
 * cap only ever "hello is slow".
 */
export async function pairViaExtension(
  win: Window,
  token: string,
  ackTimeoutMs = 1000,
  verifyTimeoutMs = 30_000,
): Promise<boolean> {
  const requestId = `pair-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    let acked = false;
    let timer = setTimeout(onNobodyHome, ackTimeoutMs);
    function onNobodyHome() {
      cleanup();
      resolve(false);
    }
    function onSlowVerify() {
      cleanup();
      resolve(false);
    }
    function cleanup() {
      clearTimeout(timer);
      win.removeEventListener("message", onMessage);
    }
    function onMessage(event: MessageEvent) {
      if (event.source !== win || event.origin !== win.location.origin) return;
      if (!acked && isPairAck(event.data, requestId)) {
        acked = true;
        // The verify cap starts only now: the short presence cap must not fire
        // while the worker is still verifying under the generous cap.
        clearTimeout(timer);
        timer = setTimeout(onSlowVerify, verifyTimeoutMs);
        return;
      }
      if (!isPairReply(event.data, requestId)) return;
      cleanup();
      resolve(event.data.ok);
    }
    win.addEventListener("message", onMessage);
    win.postMessage(pairRequestMessage(token, win.location.origin, requestId), win.location.origin);
  });
}
