import { mkdirSync, rmSync } from "node:fs";
import { browserProfileDir } from "../db/open.ts";
import type { SourceId } from "../core/types.ts";
import { recoveryText, type CaptureErrorCode, isCaptureErrorCode } from "../core/types.ts";
import { createCaptureClient } from "../packages/capture-client/index.ts";
import { packFor } from "../site-packs/index.ts";
import { listYoutubePlaylists } from "../site-packs/youtube/index.ts";
import { launchCaptureBrowser, pageContext } from "./chrome.ts";
import type { PageState, Post } from "../site-packs/shared.ts";

export interface RunnerProgress {
  source: SourceId;
  accountId: string;
  phase: "opening" | "waiting-login" | "capturing" | "done" | "error";
  seen: number;
  upserted: number;
  message: string;
  errorCode?: CaptureErrorCode;
  coverage?: "complete" | "partial";
  previewJpeg?: string;
  pageUrl?: string;
}

export interface RunnerHandle {
  abort: AbortController;
  promise: Promise<void>;
}

const active = new Map<string, RunnerHandle>();
const progress = new Map<string, RunnerProgress>();

export function runnerKey(source: SourceId, accountId: string): string {
  return `${source}:${accountId}`;
}

export function getProgress(source: SourceId, accountId: string): RunnerProgress | undefined {
  return progress.get(runnerKey(source, accountId));
}

export function isRunning(source: SourceId, accountId: string): boolean {
  return active.has(runnerKey(source, accountId));
}

export function cancelRunner(source: SourceId, accountId: string): boolean {
  const handle = active.get(runnerKey(source, accountId));
  if (!handle) return false;
  handle.abort.abort();
  return true;
}

export function markRunning(source: SourceId, accountId: string): AbortController {
  const key = runnerKey(source, accountId);
  const existing = active.get(key);
  if (existing) return existing.abort;
  const abort = new AbortController();
  let settle: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  }).finally(() => {
    active.delete(key);
  });
  abort.signal.addEventListener("abort", settle, { once: true });
  active.set(key, { abort, promise });
  return abort;
}

export function markDone(source: SourceId, accountId: string): void {
  const handle = active.get(runnerKey(source, accountId));
  if (!handle) return;
  handle.abort.abort();
}

export function setProgress(
  source: SourceId,
  accountId: string,
  next: Partial<RunnerProgress> & Pick<RunnerProgress, "phase" | "message">,
): void {
  const key = runnerKey(source, accountId);
  const prev = progress.get(key);
  progress.set(key, {
    source,
    accountId,
    seen: next.seen ?? prev?.seen ?? 0,
    upserted: next.upserted ?? prev?.upserted ?? 0,
    phase: next.phase,
    message: next.message,
    errorCode: next.errorCode ?? prev?.errorCode,
    coverage: next.coverage ?? prev?.coverage,
    previewJpeg: next.previewJpeg ?? prev?.previewJpeg,
    pageUrl: next.pageUrl ?? prev?.pageUrl,
  });
}

export function deleteProfile(source: SourceId, accountId: string): void {
  rmSync(browserProfileDir(source, accountId), { recursive: true, force: true });
}

export function startRunner(args: {
  source: SourceId;
  accountId: string;
  token: string;
  baseUrl: string;
  extraPlaylists?: { id: string; name: string; url: string }[];
  resume?: boolean;
}): RunnerHandle {
  const key = runnerKey(args.source, args.accountId);
  const existing = active.get(key);
  if (existing) return existing;
  const abort = new AbortController();
  const promise = run(args, abort.signal).finally(() => {
    active.delete(key);
  });
  const handle = { abort, promise };
  active.set(key, handle);
  return handle;
}

async function run(
  args: {
    source: SourceId;
    accountId: string;
    token: string;
    baseUrl: string;
    extraPlaylists?: { id: string; name: string; url: string }[];
  },
  signal: AbortSignal,
): Promise<void> {
  const key = runnerKey(args.source, args.accountId);
  const pack = packFor(args.source);
  const set = (next: Partial<RunnerProgress> & Pick<RunnerProgress, "phase" | "message">) => {
    const prev = progress.get(key);
    progress.set(key, {
      source: args.source,
      accountId: args.accountId,
      seen: prev?.seen ?? 0,
      upserted: prev?.upserted ?? 0,
      ...next,
    });
  };
  set({ phase: "opening", message: "Opening browser…" });

  const profileDir = browserProfileDir(args.source, args.accountId);
  mkdirSync(profileDir, { recursive: true });
  const client = createCaptureClient({ baseUrl: args.baseUrl, token: args.token });
  let closer: (() => Promise<void>) | null = null;
  let closeOnExit = true;

  try {
    const launched = await launchCaptureBrowser(profileDir);
    closer = launched.close;
    const ctx = pageContext(launched.page, () => signal.aborted);
    await ctx.goto(pack.manifest.collectionUrl);
    await launched.page.bringToFront();

    set({
      phase: "waiting-login",
      message: `Log in to ${label(args.source)} to continue.`,
      pageUrl: await ctx.url(),
    });

    const ready = await waitUntilReady(ctx, launched.page, pack, signal, set);
    if (ready.kind === "error") {
      set({
        phase: "error",
        message: recoveryText(ready.code),
        errorCode: ready.code,
        coverage: "partial",
      });
      if (ready.code === "login-timeout" || ready.code === "challenge" || ready.code === "logged-out" || ready.code === "session-expired") {
        closeOnExit = false;
      }
      return;
    }

    const accountExternalId = (await pack.accountId(ctx)) ?? `pending:${args.accountId}`;
    const known = await fetchKnown(args.baseUrl, args.token, args.source);
    const jobs =
      args.source === "youtube"
        ? await youtubeJobs(ctx, pack.manifest, args.extraPlaylists)
        : [
            {
              externalId: pack.manifest.collectionExternalId,
              name: pack.manifest.collectionName,
              url: pack.manifest.collectionUrl,
            },
          ];

    let totalSeen = 0;
    let totalUpserted = 0;
    let anyPartial = false;

    for (const job of jobs) {
      if (signal.aborted) break;
      const current = await ctx.url();
      if (current !== job.url) await ctx.goto(job.url);
      await ctx.wait(800);
      const state = await pack.pageState(ctx);
      if (state === "challenge") {
        set({
          phase: "error",
          message: recoveryText("challenge"),
          errorCode: "challenge",
          coverage: "partial",
          seen: totalSeen,
          upserted: totalUpserted,
        });
        return;
      }
      if (state === "logged-out") {
        set({
          phase: "error",
          message: recoveryText("session-expired"),
          errorCode: "session-expired",
          coverage: "partial",
          seen: totalSeen,
          upserted: totalUpserted,
        });
        return;
      }
      if (state === "empty") {
        const started = await client.start({
          protocolVersion: 1,
          source: args.source,
          producer: { id: `locus.runner.${pack.manifest.id}`, version: pack.manifest.version },
          accountExternalId,
          collection: { externalId: job.externalId, name: job.name, url: job.url },
          mode: "snapshot",
          observedAt: new Date().toISOString(),
        });
        await client.finish({ sessionId: started.sessionId, coverage: "complete" });
        continue;
      }
      if (state === "site-changed" || state === "unknown") {
        // give the page a moment, then decide
        await ctx.wait(1500);
        const again = await pack.pageState(ctx);
        if (again === "unknown" || again === "wrong-page") {
          set({
            phase: "error",
            message: recoveryText(again === "wrong-page" ? "wrong-page" : "site-changed"),
            errorCode: again === "wrong-page" ? "wrong-page" : "site-changed",
            coverage: "partial",
            seen: totalSeen,
            upserted: totalUpserted,
          });
          return;
        }
      }

      set({ phase: "capturing", message: `Collecting ${job.name}…`, seen: totalSeen, upserted: totalUpserted });
      const started = await client.start({
        protocolVersion: 1,
        source: args.source,
        producer: { id: `locus.runner.${pack.manifest.id}`, version: pack.manifest.version },
        accountExternalId,
        collection: { externalId: job.externalId, name: job.name, url: job.url },
        mode: "incremental",
        observedAt: new Date().toISOString(),
      });

      let seq = 0;
      let jobSeen = 0;
      let pending: Post[] = [];
      const flush = async () => {
        if (pending.length === 0) return;
        seq += 1;
        const start = jobSeen - pending.length;
        const result = await client.batch({
          sessionId: started.sessionId,
          sequence: seq,
          idempotencyKey: `${started.sessionId}:${seq}`,
          changes: pending.map((post, i) => ({
            kind: "upsert" as const,
            externalId: post.id,
            sourcePosition: start + i,
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
          })),
        });
        totalUpserted += result.upserted;
        pending = [];
      };
      // Pack yields posts. We wrap them as Capture Protocol batches.
      for await (const post of pack.readList(ctx, known)) {
        if (signal.aborted) break;
        pending.push(post);
        jobSeen += 1;
        totalSeen += 1;
        if (pending.length >= 8) await flush();
        set({
          phase: "capturing",
          message: `Found ${totalSeen} saves…`,
          seen: totalSeen,
          upserted: totalUpserted,
        });
      }
      await flush();
      const coverage = "partial";
      if (coverage === "partial") anyPartial = true;
      await client.finish({ sessionId: started.sessionId, coverage });
    }

    if (signal.aborted) {
      set({
        phase: "error",
        message: recoveryText("interrupted"),
        errorCode: "interrupted",
        coverage: "partial",
        seen: totalSeen,
        upserted: totalUpserted,
      });
      return;
    }
    set({
      phase: "done",
      message: anyPartial
        ? `Found ${totalSeen} saves. Refresh again to continue.`
        : `Found ${totalSeen} saves.`,
      coverage: anyPartial ? "partial" : "complete",
      seen: totalSeen,
      upserted: totalUpserted,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code: CaptureErrorCode = signal.aborted
      ? "interrupted"
      : message.includes("net::") || message.includes("fetch")
        ? "server-unreachable"
        : isCaptureErrorCode(message)
          ? message
          : "interrupted";
    set({ phase: "error", message: recoveryText(code), errorCode: code, coverage: "partial" });
  } finally {
    if (closer && closeOnExit) await closer();
  }
}

async function waitUntilReady(
  ctx: ReturnType<typeof pageContext>,
  page: { screenshot: (opts: { type: "jpeg"; quality: number; encoding: "base64" }) => Promise<string | Buffer>; bringToFront: () => Promise<void> },
  pack: ReturnType<typeof packFor>,
  signal: AbortSignal,
  set: (next: Partial<RunnerProgress> & Pick<RunnerProgress, "phase" | "message">) => void,
): Promise<{ kind: "ready" } | { kind: "error"; code: CaptureErrorCode }> {
  const deadline = Date.now() + 4 * 60 * 60 * 1000;
  let last: PageState = "unknown";
  let ticks = 0;
  while (Date.now() < deadline) {
    if (signal.aborted) return { kind: "error", code: "interrupted" };
    const packState = await pack.pageState(ctx).catch(() => detectGeneric(ctx));
    const generic = packState === "unknown" || packState === "loading" ? await detectGeneric(ctx) : packState;
    last = generic === "ready" || generic === "empty" ? generic : packState;
    if (last === "ready" || last === "empty") return { kind: "ready" };
    ticks += 1;
    const waitingChallenge = last === "challenge";
    if (ticks % 4 === 1) {
      try {
        await page.bringToFront();
        const shot = await page.screenshot({ type: "jpeg", quality: 45, encoding: "base64" });
        set({
          phase: waitingChallenge ? "error" : "waiting-login",
          message: waitingChallenge
            ? recoveryText("challenge")
            : "Log in to continue.",
          errorCode: waitingChallenge ? "challenge" : undefined,
          previewJpeg: typeof shot === "string" ? shot : shot.toString("base64"),
          pageUrl: await ctx.url(),
        });
      } catch {
        set({
          phase: waitingChallenge ? "error" : "waiting-login",
          message: waitingChallenge
            ? recoveryText("challenge")
            : "Log in to continue.",
          errorCode: waitingChallenge ? "challenge" : undefined,
          pageUrl: await ctx.url(),
        });
      }
    }
    await ctx.wait(800);
  }
  return { kind: "error", code: last === "logged-out" ? "login-timeout" : "scan-stalled" };
}

async function detectGeneric(ctx: ReturnType<typeof pageContext>): Promise<PageState> {
  return ctx.evaluate(() => {
    const url = location.href;
    const text = document.body?.innerText?.slice(0, 8000) ?? "";
    if (/\/i\/flow\/login|\/login(\?|$)|\/i\/jf\/onboarding|redirect_after_login|accounts\.google\.com|accounts\/login|reddit\.com\/login/.test(url)) {
      return "logged-out" as const;
    }
    if (/challenge|checkpoint|verify you are|unusual traffic|are you a robot/i.test(url + text) &&
      document.querySelector("iframe[src*='captcha'], iframe[src*='arkose'], iframe[title*='challenge']")) {
      return "challenge" as const;
    }
    if (document.querySelector('article[data-testid="tweet"], ytd-playlist-video-renderer, shreddit-post, a[href*="/p/"], a[href*="/reel/"]')) {
      return "ready" as const;
    }
    if (/haven.t added any posts to your bookmarks|watch later is empty|haven.t saved anything|no saved posts/i.test(text)) {
      return "empty" as const;
    }
    if (document.querySelector('[data-testid="loginButton"], input[name="password"], a[href*="ServiceLogin"]')) {
      return "logged-out" as const;
    }
    return "loading" as const;
  });
}

async function youtubeJobs(
  ctx: ReturnType<typeof pageContext>,
  manifest: { collectionExternalId: string; collectionName: string; collectionUrl: string },
  extra?: { id: string; name: string; url: string }[],
): Promise<{ externalId: string; name: string; url: string }[]> {
  const jobs = [
    { externalId: manifest.collectionExternalId, name: manifest.collectionName, url: manifest.collectionUrl },
  ];
  try {
    const found = extra && extra.length > 0 ? extra : await listYoutubePlaylists(ctx);
    for (const p of found.slice(0, 8)) {
      jobs.push({ externalId: p.id, name: p.name, url: p.url });
    }
  } catch {
    // Watch Later still counts
  }
  return jobs;
}

async function fetchKnown(baseUrl: string, token: string, source: SourceId): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl}/capture/v1/known?source=${encodeURIComponent(source)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const data = (await res.json().catch(() => ({}))) as { done?: unknown };
    return Array.isArray(data.done) ? data.done.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function label(source: SourceId): string {
  switch (source) {
    case "x":
      return "X";
    case "instagram":
      return "Instagram";
    case "youtube":
      return "YouTube";
    case "reddit":
      return "Reddit";
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}
