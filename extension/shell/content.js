// Runs only on the desk's own pages (see manifest content_scripts). This file is
// the auto-pair bridge: the Locus Account page posts a pairing message into the
// page, we relay it to the service worker (sw.js), and report the result back.
// Capture itself never touches this file — sessions, jobs, and site packs live
// in sw.js / pack.js.
window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const msg = event.data;
  if (!msg || msg.source !== "locus-web" || msg.type !== "locus:pair") return;
  if (typeof msg.requestId !== "string") return;
  // Only ever pair this page's own origin, and only a real device token.
  // Token shape mirrors issueToken (server/capture/ingest.ts): loc_ + 32 hex.
  if (msg.origin !== location.origin) return;
  if (typeof msg.token !== "string" || !/^loc_[0-9a-f]{32}$/.test(msg.token)) return;
  // Ack immediately so the page splits presence from verify: the short cap is
  // only ever "nobody home", the generous cap only ever "the worker's verify
  // (below) is slow". Shape must match app/src/extension-pair.ts (isPairAck).
  window.postMessage({ source: "locus-extension", type: "locus:pair-ack", requestId: msg.requestId }, location.origin);
  chrome.runtime.sendMessage({ type: "locus-pair", origin: msg.origin, token: msg.token }, (reply) => {
    const failed = Boolean(chrome.runtime.lastError);
    // Pairing succeeded only when the worker answered ok — a delivered reply of
    // { ok: false } means it refused the token. Reply must match
    // app/src/extension-pair.ts (isPairReply).
    window.postMessage(
      { source: "locus-extension", type: "locus:paired", requestId: msg.requestId, ok: !failed && reply?.ok === true },
      location.origin,
    );
  });
});
