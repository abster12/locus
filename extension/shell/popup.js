const status = document.getElementById("status");
const originEl = document.getElementById("origin");
const tokenEl = document.getElementById("token");
const manual = document.getElementById("manual");

chrome.storage.local.get(["origin", "token"], (got) => {
  if (got.origin) originEl.value = got.origin;
  if (got.token) tokenEl.value = got.token;
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "import-status") status.textContent = msg.text;
});

hello();

async function hello() {
  try {
    const stored = await chrome.storage.local.get(["origin", "token"]);
    const origin = originEl.value.trim() || stored.origin || "http://127.0.0.1:8787";
    const res = await fetch(`${origin}/capture/v1/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: stored.token || tokenEl.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok || !data.token) throw new Error(data.error || "desk is not running");
    await chrome.storage.local.set({ origin: data.origin || origin, token: data.token });
    originEl.value = data.origin || origin;
    tokenEl.value = data.token;
    manual.classList.add("hidden");
    status.textContent = `Paired with ${data.origin || origin}.`;
  } catch (e) {
    manual.classList.remove("hidden");
    status.textContent = e instanceof Error ? e.message : String(e);
  }
}

document.getElementById("changePair").onclick = async () => {
  await chrome.storage.local.remove(["origin", "token"]);
  originEl.value = "";
  tokenEl.value = "";
  manual.classList.remove("hidden");
  status.textContent = "Unpaired. Paste the staging origin and loc_ token from Account.";
};

function pairing() {
  return {
    origin: originEl.value.trim() || "http://127.0.0.1:8787",
    token: tokenEl.value.trim(),
  };
}

document.getElementById("savePair").onclick = () => {
  const { origin, token } = pairing();
  if (!token) {
    status.textContent = "Paste the loc_ token from Sources first.";
    return;
  }
  chrome.storage.local.set({ origin, token }, () => {
    status.textContent = "Paired. Open a saved-items page, then Import this page.";
  });
};

document.getElementById("saveItem").onclick = () => saveOne();
document.getElementById("importPage").onclick = () => importPage();

async function creds() {
  const fields = pairing();
  const stored = await new Promise((resolve) => chrome.storage.local.get(["origin", "token"], resolve));
  const origin = fields.origin || stored.origin || "";
  const token = fields.token || stored.token || "";
  if (!token) throw new Error("Desk is not running, or paste a loc_ token and Save pairing.");
  chrome.storage.local.set({ origin, token });
  return { origin, token };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new Error("No active tab.");
  return tab;
}

async function saveOne() {
  try {
    status.textContent = "Saving…";
    const tab = await activeTab();
    const { origin, token } = await creds();
    const reply = await chrome.runtime.sendMessage({
      type: "save-item",
      tabId: tab.id,
      tabUrl: tab.url,
      origin,
      token,
    });
    status.textContent = reply?.text || "Done.";
  } catch (e) {
    status.textContent = e instanceof Error ? e.message : String(e);
  }
}

async function importPage() {
  try {
    status.textContent = "Importing… Instagram/Reddit open each post. You can close this popup.";
    const tab = await activeTab();
    const { origin, token } = await creds();
    const reply = await chrome.runtime.sendMessage({
      type: "import-page",
      tabId: tab.id,
      tabUrl: tab.url,
      origin,
      token,
    });
    status.textContent = reply?.text || "Done.";
  } catch (e) {
    status.textContent = e instanceof Error ? e.message : String(e);
  }
}
