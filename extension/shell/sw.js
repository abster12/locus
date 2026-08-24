import { detectListState, extractCurrent, extractPage } from "./extract.js";

chrome.runtime.onInstalled.addListener(() => {
  listen();
});
chrome.runtime.onStartup.addListener(() => {
  listen();
});
listen();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "import-page") return;
  runImport(msg)
    .then((text) => sendResponse({ ok: true, text }))
    .catch((e) => sendResponse({ ok: false, text: e instanceof Error ? e.message : String(e) }));
  return true;
});

function say(text) {
  chrome.runtime.sendMessage({ type: "import-status", text }).catch(() => {});
}

function waitTab(tabId) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpd);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 12000);
    function onUpd(id, info) {
      if (id === tabId && info.status === "complete") setTimeout(finish, 800);
    }
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

async function inject(tabId, fn) {
  const [got] = await chrome.scripting.executeScript({ target: { tabId }, func: fn });
  return got?.result;
}

async function postJson(origin, token, path, body) {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${path} failed`);
  return data;
}

async function getKnown(origin, token, source) {
  const q = source ? `?source=${encodeURIComponent(source)}` : "";
  const res = await fetch(`${origin}/capture/v1/known${q}`, { headers: { authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return [];
  return Array.isArray(data.done) ? data.done : [];
}

async function scrapeAway(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitTab(tab.id);
    return await inject(tab.id, extractCurrent);
  } finally {
    if (tab.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function flush(origin, token, sessionId, sequence, cards) {
  if (cards.length === 0) return sequence;
  await postJson(origin, token, "/capture/v1/batches", {
    sessionId,
    sequence,
    idempotencyKey: `${sessionId}:${sequence}`,
    changes: cards.map((card, i) => ({
      kind: "upsert",
      externalId: card.externalId,
      sourcePosition: i,
      item: card.item,
    })),
  });
  return sequence + 1;
}

async function ensurePaired() {
  const stored = await chrome.storage.local.get(["origin", "token"]);
  const origin = stored.origin || "http://127.0.0.1:8787";
  const res = await fetch(`${origin}/capture/v1/hello`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: stored.token || "" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) throw new Error(data.error || "desk is not running");
  await chrome.storage.local.set({ origin: data.origin || origin, token: data.token });
  return { origin: data.origin || origin, token: data.token };
}

let listening = false;

async function listen() {
  if (listening) return;
  listening = true;
  while (true) {
    try {
      const { origin, token } = await ensurePaired();
      const res = await fetch(`${origin}/capture/v1/jobs/wait`, { headers: { authorization: `Bearer ${token}` } });
      if (res.status === 204) continue;
      const job = await res.json().catch(() => null);
      if (!job?.id) continue;
      await runJob(origin, token, job).catch((e) =>
        postJson(origin, token, `/capture/v1/jobs/${job.id}/finish`, {
          error: e instanceof Error ? e.message : String(e),
          message: e instanceof Error ? e.message : String(e),
        }).catch(() => {}),
      );
    } catch {
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
}

async function jobCancelled(origin, token, id) {
  const res = await fetch(`${origin}/capture/v1/jobs/${id}`, { headers: { authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  return data.status === "cancelled";
}

async function runJob(origin, token, job) {
  say(`Opening ${job.source}…`);
  await postJson(origin, token, `/capture/v1/jobs/${job.id}/progress`, {
    phase: "waiting-login",
    message: "Waiting for the saved page. Log in if the site asks.",
  });
  const tab = await chrome.tabs.create({ url: job.url, active: true });
  try {
    for (let i = 0; i < 1800; i++) {
      if (await jobCancelled(origin, token, job.id)) throw new Error("cancelled");
      const state = await inject(tab.id, detectListState).catch(() => "unknown");
      if (state === "ready" || (i > 30 && state === "loading")) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const text = await runImport({ tabId: tab.id, tabUrl: job.url, origin, token });
    await postJson(origin, token, `/capture/v1/jobs/${job.id}/finish`, { message: text });
    say(text);
  } finally {
    // leave the tab — user may still be looking at it
  }
}

async function runImport(msg) {
  const { tabId, tabUrl, origin, token } = msg;
  say("Scrolling to load every saved post…");
  const listed = await inject(tabId, extractPage);
  if (!listed) throw new Error("This page is not a known saved-items or post page.");
  const startCards = listed.cards || (listed.externalId ? [{ externalId: listed.externalId, item: listed.item }] : []);
  if (startCards.length === 0) {
    return "No records on this page.";
  }
  const done = new Set(await getKnown(origin, token, listed.source));
  const need = startCards.filter((c) => !done.has(c.externalId));
  const skipped = startCards.length - need.length;

  const session = await postJson(origin, token, "/capture/v1/sessions", {
    protocolVersion: 1,
    source: listed.source,
    producer: { id: "locus.extension", version: "0.1.0" },
    accountExternalId: listed.account || "pending",
    collection: { externalId: listed.collection, name: listed.collectionName, url: tabUrl },
    mode: "incremental",
    observedAt: new Date().toISOString(),
  });

  const walk = listed.source === "instagram" || listed.source === "reddit";
  let sequence = 1;
  let pending = [];
  let saved = 0;
  const push = async (card) => {
    pending.push(card);
    saved += 1;
    if (pending.length >= 8) {
      sequence = await flush(origin, token, session.sessionId, sequence, pending);
      pending = [];
    }
  };

  if (!walk) {
    sequence = await flush(origin, token, session.sessionId, sequence, startCards);
    saved = startCards.length;
  } else if (need.length === 0) {
    saved = 0;
  } else {
    say(`${need.length} to read, ${skipped} already saved. Your tab stays put.`);
    for (let i = 0; i < need.length; i++) {
      const skinny = need[i];
      say(`Reading ${i + 1}/${need.length} in the background…`);
      try {
        const one = await scrapeAway(skinny.item.url);
        await push(one?.item ? { externalId: one.externalId || skinny.externalId, item: { ...skinny.item, ...one.item } } : skinny);
      } catch {
        await push(skinny);
      }
    }
  }

  sequence = await flush(origin, token, session.sessionId, sequence, pending);
  await postJson(origin, token, "/capture/v1/finish", { sessionId: session.sessionId, coverage: "partial" });
  const extra = skipped ? ` Skipped ${skipped} already saved.` : "";
  return `Saved ${saved} record(s) to Locus.${extra}`;
}
