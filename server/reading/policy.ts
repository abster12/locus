import { isPlatformPermalink, youtubeVideoId } from "../../core/sanitize.ts";

export const LOCAL_LIBRARY_ID = "local";
export const CANDIDATE_LIMIT = 20;
const MAX_URL = 2_000;

export type ReadingKind = "article" | "documentation" | "repository" | "pdf" | "unknown";
export type ExclusionReason =
  | "malformed"
  | "credentials"
  | "scheme"
  | "too_long"
  | "unsafe_target"
  | "platform_permalink"
  | "social_asset"
  | "media_page"
  | "binary"
  | "policy_path"
  | "item_permalink"
  | "duplicate"
  | "candidate_limit_exceeded";

export interface ReadingCandidate {
  observedUrl: string;
  canonicalUrl: string;
  kind: "article" | "pdf";
}

export interface DiscoveryResult {
  candidates: ReadingCandidate[];
  exclusions: Partial<Record<ExclusionReason, number>>;
}

const TRACKING =
  /^(utm_|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|twclid|msclkid|yclid|igshid|ttclid|li_fat_id|mc_eid|mc_cid|ref_src|ref_url|si|_hsenc|_hsmi|mkt_tok|icid|s_cid|cmpid|campaignid|campaign_id|ndclid|sclid|tbclid|oto_token|gclsrc)$/i;

const BINARY_EXT =
  /\.(avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp|aac|flac|m4a|mp3|ogg|wav|avi|m4v|mkv|mov|mp4|webm|wmv|7z|apk|bin|dmg|exe|gz|iso|rar|tar|zip|woff2?|ttf|otf|wasm)$/i;

const POLICY_SEGMENTS = new Set([
  "login",
  "signin",
  "sign-in",
  "signup",
  "sign-up",
  "auth",
  "authenticate",
  "authentication",
  "account",
  "accounts",
  "cart",
  "checkout",
  "download",
  "downloads",
  "share",
  "logout",
  "register",
  "password",
  "oauth",
  "authorize",
]);

const CHALLENGE_TITLE =
  /prove your humanity|verify you(?:'| a)?re (?:a )?human|verify you are not a robot|confirm you(?:'| a)?re (?:a )?human|checking your browser|checking if the site connection is secure|attention required|just a moment|access denied|request blocked|unusual traffic|enable javascript(?: to continue)?|enable cookies(?: to continue)?|please verify you are a human|sorry, you have been blocked|\bcaptcha\b|are you a robot/i;

export function discoverCandidates(body: string | null | undefined, permalink: string): DiscoveryResult {
  const exclusions: Partial<Record<ExclusionReason, number>> = {};
  const bump = (reason: ExclusionReason): void => {
    exclusions[reason] = (exclusions[reason] ?? 0) + 1;
  };
  const candidates: ReadingCandidate[] = [];
  const permalinkCanonical = cleanupUrl(permalink)?.canonicalUrl ?? null;

  for (const raw of extractRawUrls(body ?? "")) {
    const cleaned = cleanupUrl(raw);
    if (!cleaned) {
      bump(classifyCleanupFailure(raw));
      continue;
    }
    const excluded = hardExclusion(cleaned, permalink, permalinkCanonical);
    if (excluded) {
      bump(excluded);
      continue;
    }
    const kind: "article" | "pdf" = isPdfPath(new URL(cleaned.canonicalUrl).pathname) ? "pdf" : "article";
    const next: ReadingCandidate = { ...cleaned, kind };
    const dup = collapseDuplicate(candidates, next);
    if (dup.kind === "skip") {
      bump("duplicate");
      continue;
    }
    if (candidates.length >= CANDIDATE_LIMIT) {
      bump("candidate_limit_exceeded");
      continue;
    }
    candidates.push(next);
  }
  return { candidates, exclusions };
}

export function cleanupUrl(raw: string): { observedUrl: string; canonicalUrl: string } | null {
  const stripped = stripTrailingPunct(raw.trim());
  if (!stripped || stripped.length > MAX_URL) return null;
  let parsed: URL;
  try {
    parsed = new URL(stripped);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (!isPublicHostname(parsed.hostname)) return null;

  const observedUrl = parsed.toString();
  parsed.hash = "";
  if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) {
    parsed.port = "";
  }
  if (parsed.pathname === "") parsed.pathname = "/";
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING.test(key)) parsed.searchParams.delete(key);
  }

  parsed.hostname = applyHostPolicy(parsed.hostname.toLowerCase());
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  const canonicalUrl = parsed.toString();
  return { observedUrl, canonicalUrl };
}

export function isChallengeTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return CHALLENGE_TITLE.test(normalized);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

function extractRawUrls(body: string): string[] {
  const norm = body.replace(/(https?:\/\/)\s+/g, "$1");
  return norm.match(/https?:\/\/[^\s<>"']+/g) ?? [];
}

function classifyCleanupFailure(raw: string): ExclusionReason {
  const trimmed = raw.trim();
  if (trimmed.length > MAX_URL) return "too_long";
  try {
    const parsed = new URL(stripTrailingPunct(trimmed));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "scheme";
    if (parsed.username || parsed.password) return "credentials";
    if (!isPublicHostname(parsed.hostname)) return "unsafe_target";
  } catch {
    return "malformed";
  }
  return "malformed";
}

function hardExclusion(
  candidate: { observedUrl: string; canonicalUrl: string },
  permalink: string,
  permalinkCanonical: string | null,
): ExclusionReason | null {
  if (permalinkCanonical && candidate.canonicalUrl === permalinkCanonical) return "item_permalink";
  if (permalink && (candidate.observedUrl === permalink || candidate.canonicalUrl === permalink)) return "item_permalink";
  if (isSocialPlatformPermalink(candidate.canonicalUrl) || isSocialPlatformPermalink(candidate.observedUrl)) {
    return "platform_permalink";
  }
  let host = "";
  let path = "/";
  try {
    const u = new URL(candidate.canonicalUrl);
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return "malformed";
  }
  if (isSocialAssetHost(host) || isSocialAssetHost(aliasHostname(host))) return "social_asset";
  if (isKnownMediaPage(host)) return "media_page";
  if (isPdfPath(path)) return null;
  if (BINARY_EXT.test(path)) return "binary";
  if (hasPolicySegment(path)) return "policy_path";
  return null;
}

function collapseDuplicate(
  existing: ReadingCandidate[],
  next: ReadingCandidate,
): { kind: "keep" } | { kind: "skip" } {
  const nextUrl = new URL(next.canonicalUrl);
  for (const cur of existing) {
    if (cur.canonicalUrl === next.canonicalUrl) return { kind: "skip" };
    const curUrl = new URL(cur.canonicalUrl);
    const aliases =
      curUrl.protocol === nextUrl.protocol &&
      aliasHostname(curUrl.hostname) === aliasHostname(nextUrl.hostname) &&
      curUrl.port === nextUrl.port &&
      curUrl.pathname === nextUrl.pathname &&
      curUrl.search === nextUrl.search;
    if (aliases) return { kind: "skip" };
  }
  return { kind: "keep" };
}

function isSocialPlatformPermalink(url: string): boolean {
  if (isPlatformPermalink(url) || youtubeVideoId(url)) return true;
  try {
    const u = new URL(url);
    const host = aliasHostname(u.hostname.toLowerCase());
    const path = u.pathname;
    if (/(^|\.)(facebook\.com|fb\.com|fb\.me)$/i.test(host)) {
      return /\/(posts|permalink|watch|reel|videos|photo|share|stories)\b/i.test(path) || /permalink\.php/i.test(path);
    }
    if (/(^|\.)tiktok\.com$/i.test(host)) return /\/video\//i.test(path);
  } catch {
    return false;
  }
  return false;
}

function isSocialAssetHost(host: string): boolean {
  return /(^|\.)(redd\.it|twimg\.com|cdninstagram\.com|fbcdn\.net|ytimg\.com|ggpht\.com)$/i.test(host);
}

// These destinations are media players or galleries, not prose documents.
// Keep the policy explicit so a generic host rewrite cannot hide new article-like sites.
function isKnownMediaPage(host: string): boolean {
  return /(^|\.)(imgur\.com|streamable\.com|pca\.st)$/i.test(host) || /^open\.spotify\.com$/i.test(host);
}

function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}

function hasPolicySegment(path: string): boolean {
  return path
    .toLowerCase()
    .split("/")
    .filter(Boolean)
    .some((segment) => POLICY_SEGMENTS.has(segment));
}

// Alias identity is deliberately opt-in. Add a host only after confirming that
// its alternate hostname is the same publisher resource namespace.
const HOST_ALIASES = new Map<string, string>([
  ["www.example.com", "example.com"],
  ["mobile.example.com", "example.com"],
  ["m.example.com", "example.com"],
]);

export function aliasHostname(host: string): string {
  const normalized = host.toLowerCase();
  return HOST_ALIASES.get(normalized) ?? normalized;
}

export function applyHostPolicy(host: string): string {
  return aliasHostname(host);
}

export function isPublicHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  return !isBlockedIp(h);
}

/** True when any DNS answer is private, loopback, link-local, multicast, documentation, or metadata. */
export function isBlockedIp(ip: string): boolean {
  let h = ip.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return isBlockedV4(h);
  if (h.includes(":")) return isBlockedV6(h);
  return false;
}

function isBlockedV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    (a === 192 && b === 0 && p[2] === 2) ||
    (a === 192 && b === 88 && p[2] === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && p[2] === 100) ||
    (a === 203 && b === 0 && p[2] === 113)
  );
}

function isBlockedV6(ip: string): boolean {
  if (ip === "::" || ip === "::1") return true;
  const dotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dotted?.[1]) return isBlockedV4(dotted[1]);
  if (ip.startsWith("::ffff:")) {
    const rest = ip.slice(7);
    if (rest.includes(".")) return isBlockedV4(rest);
    const hex = rest.split(":");
    if (hex.length >= 2) {
      const hi = Number.parseInt(hex[hex.length - 2] ?? "0", 16);
      const lo = Number.parseInt(hex[hex.length - 1] ?? "0", 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        return isBlockedV4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
      }
    }
    return true;
  }
  if (ip.startsWith("64:ff9b:")) {
    const last = ip.split(":").pop() ?? "";
    if (last.includes(".")) return isBlockedV4(last);
    const groups = ip.split(":").filter(Boolean);
    const lo = Number.parseInt(groups[groups.length - 1] ?? "0", 16);
    const hi = Number.parseInt(groups[groups.length - 2] ?? "0", 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      return isBlockedV4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
    }
    return true;
  }
  if (ip.startsWith("2002:")) {
    const parts = ip.split(":");
    const a = Number.parseInt(parts[1] || "0", 16);
    const b = Number.parseInt(parts[2] || "0", 16);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return isBlockedV4(`${(a >> 8) & 255}.${a & 255}.${(b >> 8) & 255}.${b & 255}`);
    }
    return true;
  }
  return (
    ip.startsWith("fc") ||
    ip.startsWith("fd") ||
    ip.startsWith("fe80") ||
    ip.startsWith("fec0") ||
    ip.startsWith("ff") ||
    ip.startsWith("100::") ||
    ip.startsWith("2001:db8:") ||
    ip.startsWith("2001:2:")
  );
}

/** Metadata canonical may retarget identity only as an approved same-site alias. */
export function isApprovedAlias(fromUrl: string, metadataCanonical: string): boolean {
  const from = cleanupUrl(fromUrl);
  const to = cleanupUrl(metadataCanonical);
  if (!from || !to) return false;
  let a: URL;
  let b: URL;
  try {
    a = new URL(from.canonicalUrl);
    b = new URL(to.canonicalUrl);
  } catch {
    return false;
  }
  if (a.protocol !== b.protocol) return false;
  if (aliasHostname(a.hostname) !== aliasHostname(b.hostname)) return false;
  return a.pathname === b.pathname && a.search === b.search;
}

function stripTrailingPunct(s: string): string {
  let out = s;
  for (;;) {
    if (!out) return out;
    const c = out[out.length - 1]!;
    if (/[.,;:!?]$/.test(c)) {
      out = out.slice(0, -1);
      continue;
    }
    if (")]}>'\"".includes(c) && unmatchedCloser(out, c)) {
      out = out.slice(0, -1);
      continue;
    }
    break;
  }
  return out;
}

function unmatchedCloser(s: string, close: string): boolean {
  if (close === "'" || close === '"') {
    return [...s].filter((ch) => ch === close).length % 2 === 1;
  }
  const open = close === ")" ? "(" : close === "]" ? "[" : close === "}" ? "{" : "<";
  let opens = 0;
  let closes = 0;
  for (const ch of s) {
    if (ch === open) opens += 1;
    if (ch === close) closes += 1;
  }
  return closes > opens;
}
