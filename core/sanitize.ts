const MAX_TITLE = 500;
const MAX_BODY = 20_000;
const MAX_HANDLE = 200;
const MAX_URL = 2_000;
const MAX_MEDIA = 8;

export class RejectedPayload extends Error {
  readonly code = "rejected-payload";
  constructor(message: string) {
    super(message);
    this.name = "RejectedPayload";
  }
}

export function sanitizeText(value: string, max: number): string {
  return value.replace(/\u0000/g, "").trim().slice(0, max);
}

export function sanitizeUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL) {
    throw new RejectedPayload("url is missing or too long");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new RejectedPayload("url is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RejectedPayload("url must be http or https");
  }
  if (parsed.username || parsed.password) {
    throw new RejectedPayload("url must not contain credentials");
  }
  return parsed.toString();
}

export function optionalUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return sanitizeUrl(value);
}

export function optionalIso(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new RejectedPayload("timestamp is not a valid date");
  return d.toISOString();
}

export function inferHandleFromUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  if (/(^|\.)(x|twitter)\.com$/i.test(host)) {
    const m = parsed.pathname.match(/^\/([^/]+)\/status\/\d+/);
    const handle = m?.[1];
    if (!handle || /^(i|intent|share|search|home)$/i.test(handle)) return undefined;
    return handle;
  }
  if (/(^|\.)reddit\.com$/i.test(host)) {
    const sub = parsed.pathname.match(/^\/r\/([^/]+)/);
    return sub?.[1] ? `r/${sub[1]}` : undefined;
  }
  return undefined;
}

const BODY_URL_RE = /https?:\/\/[^\s)>"']+/g;

export function isStageOutbound(url: string, permalink?: string): boolean {
  return url !== permalink && !isPlatformPermalink(url);
}

export function outboundUrls(body: string | null | undefined, permalink?: string): string[] {
  if (!body) return [];
  const norm = body.replace(/(https?:\/\/)\s+/g, "$1");
  return [...new Set(norm.match(BODY_URL_RE) ?? [])].filter((u) => isStageOutbound(u, permalink));
}

export function isReadingItem(body: string | null | undefined, permalink: string): boolean {
  return outboundUrls(body, permalink).length > 0;
}

export function isPlatformPermalink(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (/(^|\.)(x|twitter)\.com$/i.test(host)) return /\/status\/\d+/.test(u.pathname);
    if (/(^|\.)instagram\.com$/i.test(host)) return /\/(p|reel|tv)\//.test(u.pathname);
    if (/(^|\.)reddit\.com$/i.test(host)) return /\/comments\//.test(u.pathname);
    if (/(^|\.)youtube\.com$/i.test(host)) return Boolean(u.searchParams.get("v"));
    if (/(^|\.)youtu\.be$/i.test(host)) return u.pathname.length > 1;
    return false;
  } catch {
    return false;
  }
}

export function youtubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (/(^|\.)youtu\.be$/i.test(u.hostname)) return u.pathname.replace(/^\//, "").split("/")[0] || null;
    if (!/(^|\.)youtube\.com$/i.test(u.hostname)) return null;
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

export function sanitizeItemDraft(input: {
  contentType: string;
  title?: string;
  body?: string;
  url: string;
  authorName?: string;
  authorHandle?: string;
  publishedAt?: string;
  sourceSavedAt?: string;
  media?: { kind: string; url: string }[];
}): {
  contentType: string;
  title?: string;
  body?: string;
  url: string;
  authorName?: string;
  authorHandle?: string;
  publishedAt?: string;
  sourceSavedAt?: string;
  media: { kind: string; url: string }[];
} {
  const title = input.title ? sanitizeText(input.title, MAX_TITLE) : undefined;
  const body = input.body ? sanitizeText(input.body, MAX_BODY) : undefined;
  const media = (input.media ?? []).slice(0, MAX_MEDIA).map((m) => ({
    kind: sanitizeText(m.kind, 40) || "unknown",
    url: sanitizeUrl(m.url),
  }));
  return {
    contentType: input.contentType,
    title: title || undefined,
    body: body || undefined,
    url: sanitizeUrl(input.url),
    authorName: input.authorName ? sanitizeText(input.authorName, MAX_HANDLE) : undefined,
    authorHandle: input.authorHandle
      ? sanitizeText(input.authorHandle, MAX_HANDLE)
      : inferHandleFromUrl(sanitizeUrl(input.url)),
    publishedAt: optionalIso(input.publishedAt),
    sourceSavedAt: optionalIso(input.sourceSavedAt),
    media,
  };
}

export function assertSafeMetadata(metadata: unknown): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new RejectedPayload("metadata must be an object");
  }
  const json = JSON.stringify(metadata);
  if (json.length > 8192) throw new RejectedPayload("metadata exceeds 8KB");
  return metadata as Record<string, unknown>;
}
