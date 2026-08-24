export async function extractPage() {
  const parseWhen = (raw) => {
    if (!raw) return undefined;
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      const ms = raw.length <= 10 ? n * 1000 : n;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    }
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  };
  const whenOf = (el) =>
    parseWhen(
      el.getAttribute("created-timestamp") ||
        el.getAttribute("created") ||
        el.querySelector("faceplate-time-ago")?.getAttribute("ts") ||
        el.querySelector("faceplate-time-ago")?.getAttribute("seconds") ||
        el.querySelector("time")?.getAttribute("datetime"),
    );

  const readXTweet = (el) => {
    const a = el.querySelector("a[href*='/status/']");
    const href = (a?.getAttribute("href") || "").split("?")[0];
    const m = href.match(/\/([^/?#]+)\/status\/(\d+)/);
    if (!m) return null;
    const url = href.startsWith("http") ? href : `https://x.com${href}`;
    const textEl = el.querySelector('[data-testid="tweetText"]');
    let body = "";
    const walk = (n) => {
      if (n.nodeType === 3) {
        body += n.textContent || "";
        return;
      }
      if (n.nodeType !== 1) return;
      if (n.nodeName === "A") {
        const title = n.getAttribute("title") || "";
        const h = n.getAttribute("href") || "";
        body += /^https?:\/\//.test(title) ? title : /^https?:\/\//.test(h) && !/t\.co\//.test(h) ? h : n.innerText || "";
        return;
      }
      if (n.nodeName === "IMG") {
        body += n.getAttribute("alt") || "";
        return;
      }
      if (n.nodeName === "BR") {
        body += "\n";
        return;
      }
      for (const c of n.childNodes) walk(c);
    };
    if (textEl) walk(textEl);
    body = body.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    for (const a of el.querySelectorAll("a")) {
      const extra = a.getAttribute("title") || "";
      const href = a.getAttribute("href") || "";
      const u = /^https?:\/\//.test(extra) ? extra : /^https?:\/\//.test(href) && !/t\.co\//.test(href) ? href : "";
      if (!u || body.includes(u) || u === url) continue;
      if (/(x|twitter)\.com\/(i|intent|share)\//i.test(u)) continue;
      const quoted = u.match(/\/status\/(\d+)/)?.[1];
      if (quoted === m[2]) continue;
      body = body ? `${body}\n${u}` : u;
    }
    const user = el.querySelector('[data-testid="User-Name"]');
    const name = user?.innerText?.split("\n").map((s) => s.trim()).find((s) => s && !s.startsWith("@") && s !== "·");
    let handle = m[1] !== "i" ? m[1] : "";
    for (const link of user?.querySelectorAll("a[href^='/']") || []) {
      const path = (link.getAttribute("href") || "").split("?")[0];
      if (/^\/[A-Za-z0-9_]{1,15}$/.test(path)) {
        handle = path.slice(1);
        break;
      }
    }
    const media = [];
    for (const img of el.querySelectorAll(
      'img[src*="pbs.twimg.com/media"], img[src*="pbs.twimg.com/ext_tw_video"], img[src*="pbs.twimg.com/amplify_video"]',
    )) {
      const src = img.getAttribute("src") || "";
      if (!src || media.some((x) => x.url === src)) continue;
      media.push({ kind: "image", url: src.replace(/([?&])name=\w+/, "$1name=small") });
    }
    return {
      externalId: m[2],
      item: {
        contentType: "post",
        body: body || undefined,
        url,
        authorName: name,
        authorHandle: handle || undefined,
        publishedAt: el.querySelector("time")?.getAttribute("datetime") || undefined,
        media,
      },
    };
  };

  const url = location.href;
  const scrollerOf = (el) => {
    let n = el;
    while (n && n !== document.body && n !== document.documentElement) {
      const s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 40) return n;
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cards = [];
  if (/x\.com|twitter\.com/.test(url)) {
    if (!/\/i\/(bookmarks|history)|\/status\//.test(url) && !document.querySelector('article[data-testid="tweet"]')) {
      return null;
    }
    const takeX = () => {
      for (const el of document.querySelectorAll('article[data-testid="tweet"]')) {
        const card = readXTweet(el);
        if (card && !cards.some((c) => c.externalId === card.externalId)) cards.push(card);
      }
    };
    if (/\/i\/(bookmarks|history)/.test(url)) {
      const first = document.querySelector('article[data-testid="tweet"]');
      const box = first ? scrollerOf(first) : document.scrollingElement || document.documentElement;
      let last = 0;
      let stagnant = 0;
      for (let i = 0; i < 200 && stagnant < 8; i++) {
        takeX();
        if (cards.length <= last) stagnant += 1;
        else stagnant = 0;
        last = cards.length;
        box.scrollTop = box.scrollHeight;
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(650);
      }
    } else takeX();
    return { source: "x", collection: "bookmarks", collectionName: "Bookmarks", cards };
  }
  if (/youtube\.com\/playlist/.test(url)) {
    const takeYt = () => {
      for (const row of document.querySelectorAll("ytd-playlist-video-renderer")) {
        const a = row.querySelector("a#video-title");
        const href = a?.href || "";
        const id = href ? new URL(href, location.origin).searchParams.get("v") : null;
        if (!id || cards.some((c) => c.externalId === id)) continue;
        cards.push({
          externalId: id,
          item: { contentType: "video", title: (a.textContent || "").trim(), url: `https://www.youtube.com/watch?v=${id}` },
        });
      }
    };
    const first = document.querySelector("ytd-playlist-video-renderer");
    const box = first ? scrollerOf(first) : document.scrollingElement || document.documentElement;
    let last = 0;
    let stagnant = 0;
    for (let i = 0; i < 200 && stagnant < 8; i++) {
      takeYt();
      if (cards.length <= last) stagnant += 1;
      else stagnant = 0;
      last = cards.length;
      box.scrollTop = box.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(650);
    }
    const list = new URL(url).searchParams.get("list") || "WL";
    return { source: "youtube", collection: list, collectionName: list === "WL" ? "Watch Later" : "Playlist", cards };
  }
  if (/reddit\.com/.test(url)) {
    const takeRd = () => {
      for (const el of document.querySelectorAll("shreddit-post")) {
        const id = el.getAttribute("id") || "";
        const permalink = el.getAttribute("permalink") || "";
        if (!id && !permalink) continue;
        const ext = id.startsWith("t3_") ? id : `t3_${id}`;
        if (cards.some((c) => c.externalId === ext)) continue;
        const postUrl = permalink.startsWith("http") ? permalink : `https://www.reddit.com${permalink}`;
        const text = (el.querySelector("[slot='text']")?.innerText || "").trim();
        const outbound = el.getAttribute("content-href") || undefined;
        cards.push({
          externalId: ext,
          item: {
            contentType: "post",
            title: el.getAttribute("post-title") || undefined,
            url: postUrl,
            body: [text, outbound].filter(Boolean).join("\n\n") || undefined,
            authorHandle: el.getAttribute("author") || undefined,
            publishedAt: whenOf(el),
          },
        });
      }
      for (const el of document.querySelectorAll("shreddit-profile-comment, shreddit-comment")) {
        const id = el.getAttribute("thingid") || el.getAttribute("comment-id") || el.getAttribute("id") || "";
        if (!id) continue;
        const ext = id.startsWith("t1_") ? id : `t1_${id.replace(/^t1_/, "")}`;
        if (cards.some((c) => c.externalId === ext)) continue;
        const permalink = el.getAttribute("permalink") || el.querySelector("a[href*='/comment/']")?.getAttribute("href") || "";
        cards.push({
          externalId: ext,
          item: {
            contentType: "comment",
            title: "Comment",
            url: permalink
              ? permalink.startsWith("http")
                ? permalink
                : `https://www.reddit.com${permalink}`
              : `https://www.reddit.com/${id}`,
            body: (el.querySelector("[slot='comment']")?.innerText || el.innerText || "").trim().slice(0, 800) || undefined,
            authorHandle: el.getAttribute("author") || undefined,
            publishedAt: whenOf(el),
          },
        });
      }
    };
    if (/reddit\.com\/(user\/[^/]+\/saved|saved\/?(\?|$))/.test(url)) {
      const first = document.querySelector("shreddit-post, shreddit-profile-comment");
      const box = first ? scrollerOf(first) : document.scrollingElement || document.documentElement;
      let last = 0;
      let stagnant = 0;
      for (let i = 0; i < 200 && stagnant < 8; i++) {
        takeRd();
        if (cards.length <= last) stagnant += 1;
        else stagnant = 0;
        last = cards.length;
        box.scrollTop = box.scrollHeight;
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(650);
      }
    } else takeRd();
    return { source: "reddit", collection: "saved", collectionName: "Saved", cards };
  }
  if (/instagram\.com/.test(url)) {
    const takeIg = () => {
      for (const a of document.querySelectorAll("a[href*='/p/'], a[href*='/reel/']")) {
        const href = a.href || "";
        const post = href.match(/\/p\/([A-Za-z0-9_-]+)/);
        const reel = href.match(/\/reel\/([A-Za-z0-9_-]+)/);
        const code = post?.[1] || reel?.[1];
        if (!code || cards.some((c) => c.externalId === code)) continue;
        const img = a.querySelector("img");
        const src = img?.currentSrc || img?.getAttribute("src") || "";
        const alt = (img?.getAttribute("alt") || "").trim();
        const by = alt.match(/^(?:Photo|Video)(?: shared)? by (.+?) on /i)?.[1]?.trim();
        cards.push({
          externalId: code,
          item: {
            contentType: reel ? "reel" : "post",
            url: post ? `https://www.instagram.com/p/${code}/` : `https://www.instagram.com/reel/${code}/`,
            title: alt && !/^instagram$/i.test(alt) ? alt.slice(0, 200) : undefined,
            authorName: by,
            authorHandle: by,
            media: /^https?:\/\//.test(src) ? [{ kind: "image", url: src }] : undefined,
          },
        });
      }
    };
    if (/instagram\.com\/(saves|[^/]+\/saved)/.test(url)) {
      const first = document.querySelector("a[href*='/p/'], a[href*='/reel/']");
      const box = first ? scrollerOf(first) : document.scrollingElement || document.documentElement;
      let last = 0;
      let stagnant = 0;
      for (let i = 0; i < 200 && stagnant < 8; i++) {
        takeIg();
        if (cards.length <= last) stagnant += 1;
        else stagnant = 0;
        last = cards.length;
        box.scrollTop = box.scrollHeight;
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(650);
      }
    } else takeIg();
    return { source: "instagram", collection: "saved", collectionName: "Saved", cards };
  }
  return null;
}

export function extractCurrent() {
  const parseWhen = (raw) => {
    if (!raw) return undefined;
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      const ms = raw.length <= 10 ? n * 1000 : n;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    }
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  };
  const url = location.href;
  if (/x\.com|twitter\.com/.test(url)) {
    const m = url.match(/status\/(\d+)/);
    if (!m) return null;
    const el = document.querySelector('article[data-testid="tweet"]');
    const text = el?.querySelector('[data-testid="tweetText"]')?.innerText?.trim();
    const user = el?.querySelector('[data-testid="User-Name"]');
    const name = user?.innerText?.split("\n")[0];
    const handle = url.match(/\/([^/?#]+)\/status\//)?.[1];
    const media = [];
    for (const img of el?.querySelectorAll('img[src*="pbs.twimg.com/media"]') || []) {
      const src = img.getAttribute("src");
      if (src) media.push({ kind: "image", url: src });
    }
    return {
      source: "x",
      collection: "bookmarks",
      collectionName: "Bookmarks",
      externalId: m[1],
      item: {
        contentType: "post",
        body: text,
        url,
        authorName: name,
        authorHandle: handle,
        publishedAt: el?.querySelector("time")?.getAttribute("datetime") || undefined,
        media,
      },
    };
  }
  if (/youtube\.com\/watch/.test(url)) {
    const id = new URL(url).searchParams.get("v");
    if (!id) return null;
    return {
      source: "youtube",
      collection: "WL",
      collectionName: "Watch Later",
      externalId: id,
      item: {
        contentType: "video",
        title: document.title.replace(/ - YouTube$/, ""),
        url,
        publishedAt:
          document.querySelector('meta[itemprop="datePublished"], meta[itemprop="uploadDate"]')?.getAttribute("content") ||
          undefined,
      },
    };
  }
  if (/reddit\.com/.test(url)) {
    const comment = url.match(/comment\/([a-z0-9]+)/i);
    const post = url.match(/comments\/([a-z0-9]+)/i);
    if (comment) {
      const el = document.querySelector("shreddit-profile-comment, shreddit-comment");
      return {
        source: "reddit",
        collection: "saved",
        collectionName: "Saved",
        externalId: `t1_${comment[1]}`,
        item: {
          contentType: "comment",
          title: "Comment",
          url,
          body: (el?.querySelector("[slot='comment']")?.innerText || el?.innerText || document.body.innerText)
            .trim()
            .slice(0, 800),
          authorHandle: el?.getAttribute("author") || undefined,
          publishedAt: parseWhen(el?.getAttribute("created-timestamp") || el?.getAttribute("created")),
        },
      };
    }
    if (post) {
      const el = document.querySelector("shreddit-post");
      const text = (el?.querySelector("[slot='text']")?.innerText || document.querySelector("[slot='text']")?.innerText || "").trim();
      const outbound = el?.getAttribute("content-href") || undefined;
      const media = [];
      for (const img of document.querySelectorAll("shreddit-post img, shreddit-aspect-ratio img, gallery-carousel img")) {
        const src = img.currentSrc || img.getAttribute("src") || "";
        if (!/^https?:\/\//.test(src) || /emoji|avatar|icon|snoo|award/i.test(src)) continue;
        if (media.some((x) => x.url === src)) continue;
        media.push({ kind: "image", url: src });
        if (media.length >= 6) break;
      }
      return {
        source: "reddit",
        collection: "saved",
        collectionName: "Saved",
        externalId: `t3_${post[1]}`,
        item: {
          contentType: "post",
          title: el?.getAttribute("post-title") || document.title.replace(/ : r\/.*$/, "") || undefined,
          url,
          body: [text, outbound].filter(Boolean).join("\n\n") || undefined,
          authorHandle: el?.getAttribute("author") || undefined,
          authorName: el?.getAttribute("author") || undefined,
          publishedAt: parseWhen(
            el?.getAttribute("created-timestamp") || el?.getAttribute("created") || document.querySelector("time")?.getAttribute("datetime"),
          ),
          media,
        },
      };
    }
    return null;
  }
  if (/instagram\.com/.test(url)) {
    const p = url.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
    if (!p) return null;
    const root = document.querySelector("div[role='dialog']") || document.querySelector("main") || document.body;
    let user;
    for (const a of root.querySelectorAll("a[href^='/']")) {
      const path = (a.getAttribute("href") || "").split("?")[0].replace(/\/$/, "");
      const name = path.startsWith("/") ? path.slice(1) : path;
      if (name && !name.includes("/") && !/^(p|reel|reels|stories|explore|direct|saves|accounts|about|tv)$/i.test(name)) {
        user = name;
        break;
      }
    }
    const caption = (
      root.querySelector("h1")?.innerText ||
      document.querySelector("meta[property='og:description']")?.getAttribute("content") ||
      document.querySelector("meta[name='description']")?.getAttribute("content") ||
      ""
    ).trim();
    const bad = /t51\.2885-19|s150x150|s50x50|s206x206|s320x320|profile|emoji|cdn\.fbsbx\.com/i;
    const article = root.querySelector("article") || root;
    const header = article.querySelector("header");
    const cands = [];
    for (const img of article.querySelectorAll("img")) {
      if (header && header.contains(img)) continue;
      const src = img.currentSrc || img.getAttribute("src") || "";
      if (!/^https?:\/\//.test(src) || bad.test(src)) continue;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w && h && (w < 180 || h < 180)) continue;
      cands.push({ url: src, area: (w || 800) * (h || 800) });
    }
    cands.sort((a, b) => b.area - a.area);
    const media = [];
    const top = cands[0];
    if (top) {
      media.push({ kind: "image", url: top.url });
      for (const c of cands.slice(1)) {
        if (c.url === top.url || c.area < top.area * 0.45) continue;
        media.push({ kind: "image", url: c.url });
        if (media.length >= 4) break;
      }
    }
    return {
      source: "instagram",
      collection: "saved",
      collectionName: "Saved",
      externalId: p[2],
      item: {
        contentType: p[1] === "reel" ? "reel" : "post",
        url,
        title: caption ? caption.slice(0, 200) : undefined,
        body: caption || undefined,
        authorHandle: user,
        authorName: user,
        publishedAt: parseWhen(root.querySelector("time")?.getAttribute("datetime")),
        media,
      },
    };
  }
  return null;
}

export function detectListState() {
  const url = location.href;
  if (/\/i\/flow\/login|\/login(\?|$)|accounts\/login|accounts\.google|ServiceLogin|reddit\.com\/login/.test(url)) {
    return "logged-out";
  }
  if (
    document.querySelector(
      'article[data-testid="tweet"], shreddit-post, shreddit-profile-comment, a[href*="/p/"], a[href*="/reel/"], ytd-playlist-video-renderer',
    )
  ) {
    return "ready";
  }
  if (/\/i\/(bookmarks|history)|instagram\.com\/(saves|[^/]+\/saved)|\/user\/[^/]+\/saved|\/saved\/?(\?|$)|list=WL/.test(url)) {
    return "loading";
  }
  return "unknown";
}
