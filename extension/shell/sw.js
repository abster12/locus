// Everyday Chrome (the user's browser). Pairing + jobs live here.
// Site-pack logic is in pack.js (built from site-packs/). This file only:
//   - implements CaptureContext with chrome.tabs / chrome.scripting
//   - talks Capture Protocol to the desk (sessions, batches)
import { packFor, packForUrl } from "./pack.js";

let listening = false;
chrome.runtime.onInstalled.addListener(() => {
  listen();
});
chrome.runtime.onStartup.addListener(() => {
  listen();
});
listen();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "import-page") {
    runImport(msg)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((e) => sendResponse({ ok: false, text: e instanceof Error ? e.message : String(e) }));
    return true;
  }
  if (msg?.type === "save-item") {
    runSaveItem(msg)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((e) => sendResponse({ ok: false, text: e instanceof Error ? e.message : String(e) }));
    return true;
  }
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

/**
 * CaptureContext for this Chrome. evaluate() injects a pack function into the tab.
 * goto() opens a background tab so Connect does not leave the user's saved list
 * (Instagram / Reddit open each new post).
 */
function tabContext(listTabId, cancelled) {
  let currentTabId = listTabId;
  let workTabId = null;
  return {
    url: async () => (await chrome.tabs.get(currentTabId)).url,
    title: async () => (await chrome.tabs.get(currentTabId)).title,
    evaluate: async (fn) => {
      const [got] = await chrome.scripting.executeScript({ target: { tabId: currentTabId }, func: fn });
      return got?.result;
    },
    goto: async (url) => {
      if (currentTabId === listTabId) {
        const t = await chrome.tabs.create({ url, active: false });
        currentTabId = t.id;
        workTabId = t.id;
      } else {
        await chrome.tabs.update(currentTabId, { url });
      }
      await waitTab(currentTabId);
    },
    scrollBy: async (y) => {
      await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        func: (dy) => window.scrollBy(0, dy),
        args: [y],
      });
    },
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    cancelled,
    dispose: async () => {
      if (workTabId) await chrome.tabs.remove(workTabId).catch(() => {});
    },
  };
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

function postToChange(post, i) {
  return {
    kind: "upsert",
    externalId: post.id,
    sourcePosition: i,
    item: {
      contentType: post.contentType,
      title: post.title,
      body: post.text,
      url: post.url,
      authorName: post.authorName,
      authorHandle: post.authorHandle,
      publishedAt: post.publishedAt,
      media: post.media,
    },
  };
}

async function flush(origin, token, sessionId, sequence, posts, start) {
  const SIZE = 100; // protocol max per batch
  for (let i = 0; i < posts.length; i += SIZE) {
    const slice = posts.slice(i, i + SIZE);
    await postJson(origin, token, "/capture/v1/batches", {
      sessionId,
      sequence,
      idempotencyKey: `${sessionId}:${sequence}`,
      changes: slice.map((post, j) => postToChange(post, start + i + j)),
    });
    sequence += 1;
  }
  return sequence;
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
  const pack = packFor(job.source);
  const tab = await chrome.tabs.create({ url: job.url, active: true });
  const stop = { v: false };
  const poll = setInterval(() => {
    jobCancelled(origin, token, job.id).then((c) => {
      if (c) stop.v = true;
    });
  }, 1000);
  const ctx = tabContext(tab.id, () => stop.v);
  try {
    for (let i = 0; i < 1800; i++) {
      if (stop.v || (await jobCancelled(origin, token, job.id))) throw new Error("cancelled");
      const state = await pack.pageState(ctx).catch(() => "unknown");
      if (state === "ready" || state === "empty") break;
      if (i > 30 && state === "loading") break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const text = await runImport({ tabId: tab.id, tabUrl: job.url, origin, token, pack, ctx });
    await postJson(origin, token, `/capture/v1/jobs/${job.id}/finish`, { message: text });
    say(text);
  } finally {
    clearInterval(poll);
    // leave the tab — user may still be looking at it
  }
}

async function runSaveItem(msg) {
  const { tabId, tabUrl, origin, token } = msg;
  const pack = packForUrl(tabUrl);
  if (!pack) throw new Error("This page is not a known post.");
  const ctx = tabContext(tabId, () => false);
  const post = await pack.readPage(ctx);
  if (!post) throw new Error("This page is not a known post.");
  const account = (await pack.accountId(ctx).catch(() => null)) || "pending";
  const session = await postJson(origin, token, "/capture/v1/sessions", {
    protocolVersion: 1,
    source: pack.manifest.id,
    producer: { id: "locus.extension", version: "0.1.0" },
    accountExternalId: account,
    collection: {
      externalId: pack.manifest.collectionExternalId,
      name: pack.manifest.collectionName,
      url: tabUrl,
    },
    mode: "incremental",
    observedAt: new Date().toISOString(),
  });
  await flush(origin, token, session.sessionId, 1, [post], 0);
  await postJson(origin, token, "/capture/v1/finish", { sessionId: session.sessionId, coverage: "partial" });
  return "Saved 1 record to Locus.";
}

async function runImport(msg) {
  const { tabId, tabUrl, origin, token } = msg;
  const pack = msg.pack || packForUrl(tabUrl);
  if (!pack) throw new Error("This page is not a known saved-items or post page.");
  const target = pack.detect({ url: tabUrl, title: "" });
  if (!target || target.kind !== "collection") throw new Error("This page is not a known saved-items or post page.");

  say("Scrolling to load every saved post…");
  const ctx = msg.ctx || tabContext(tabId, () => false);
  try {
    const account = (await pack.accountId(ctx).catch(() => null)) || "pending";
    const known = await getKnown(origin, token, pack.manifest.id);
    const posts = [];
    for await (const post of pack.readList(ctx, known)) posts.push(post);
    if (posts.length === 0) return known.length ? "Nothing new to save." : "No records on this page.";
    const session = await postJson(origin, token, "/capture/v1/sessions", {
      protocolVersion: 1,
      source: pack.manifest.id,
      producer: { id: "locus.extension", version: "0.1.0" },
      accountExternalId: account,
      collection: { externalId: target.collectionExternalId, name: target.collectionName, url: tabUrl },
      mode: "incremental",
      observedAt: new Date().toISOString(),
    });

    let sequence = 1;
    let pending = [];
    let sent = 0;
    for (const post of posts) {
      pending.push(post);
      if (pending.length >= 8) {
        sequence = await flush(origin, token, session.sessionId, sequence, pending, sent);
        sent += pending.length;
        pending = [];
      }
    }
    await flush(origin, token, session.sessionId, sequence, pending, sent);
    await postJson(origin, token, "/capture/v1/finish", { sessionId: session.sessionId, coverage: "partial" });
    return `Saved ${posts.length} record(s) to Locus.${known.length ? ` Skipped already saved.` : ""}`;
  } finally {
    await ctx.dispose();
  }
}
