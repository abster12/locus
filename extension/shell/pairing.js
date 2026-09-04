// Verify + store a device pairing handed to us by the desk page (auto-pair).
// Split from sw.js so tests can drive it without a running Chrome.
/**
 * The desk must echo the same token back from /capture/v1/hello, which also
 * marks the extension as seen. Local desks mint a fresh token for unknown
 * input, so the echo check is what proves the token we were handed really is
 * this desk's device token and not junk.
 */
export async function verifyPairing({ origin, token, fetchImpl = fetch, storage }) {
  if (typeof origin !== "string" || !/^https?:\/\//.test(origin)) throw new Error("bad origin");
  if (typeof token !== "string" || !/^loc_[0-9a-f]{32}$/.test(token)) throw new Error("bad pairing code");
  const res = await fetchImpl(`${origin}/capture/v1/hello`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.token !== token) throw new Error("the desk did not accept this pairing");
  await storage.set({ origin, token });
}
