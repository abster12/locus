import { isChallengeTitle } from "./policy.ts";

export type ReadingFailureCode =
  | "blocked_challenge"
  | "authentication_required"
  | "paywall_or_consent"
  | "not_found"
  | "gone"
  | "unsupported_content_type"
  | "not_article_like"
  | "unsafe_target"
  | "timeout"
  | "network_error"
  | "parse_error"
  | "empty_content";

export type OriginalStatus =
  | "unknown"
  | "reachable"
  | "not_found"
  | "gone"
  | "blocked"
  | "authentication_required"
  | "paywall_or_consent"
  | "error";

const AUTH_TITLE = /log ?in to continue|sign ?in to continue|please log ?in|please sign ?in|authentication required/i;
const PAYWALL_TITLE = /subscribe to (?:read|continue)|members only|paywall|become a subscriber/i;
const MISSING_TITLE = /page not found|^404\b|not found|doesn't exist|does not exist|content (?:deleted|removed|unavailable)/i;
const ENABLE_JS = /enable javascript|enable cookies|please enable javascript/i;
const PAYWALL_BODY = /subscribe to continue|already a subscriber|metered paywall|this article is for subscribers/i;
const AUTH_BODY = /log ?in to continue|sign ?in to continue|create an account to (?:read|continue)/i;
const CONSENT_BODY = /accept (?:all )?cookies|consent to cookies|we use cookies to|manage (?:your )?privacy preferences/i;
const CHALLENGE_BODY = /verify you are (?:a )?human|checking your browser|just a moment|attention required|cf-browser-verification|cdn-cgi\/challenge/i;

export interface ClassifyInput {
  status: number;
  finalUrl: string;
  contentType: string;
  title: string | null;
  text: string;
  wordCount: number;
  hasArticle: boolean;
  scriptCount: number;
}

export interface ClassifyResult {
  failure: ReadingFailureCode | null;
}

export function isHtmlContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct.includes("text/html") || ct.includes("application/xhtml");
}

export function isPdfContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes("application/pdf");
}

export function originalStatusFor(code: ReadingFailureCode | null, ok: boolean): OriginalStatus {
  if (ok) return "reachable";
  switch (code) {
    case "not_found":
      return "not_found";
    case "gone":
      return "gone";
    case "blocked_challenge":
    case "unsafe_target":
      return "blocked";
    case "authentication_required":
      return "authentication_required";
    case "paywall_or_consent":
      return "paywall_or_consent";
    case "timeout":
    case "network_error":
    case "parse_error":
      return "error";
    default:
      return "reachable";
  }
}

export function isTransient(code: ReadingFailureCode | null): boolean {
  return code === "timeout" || code === "network_error";
}

export function classifyFetchedPage(input: ClassifyInput): ClassifyResult {
  const { status } = input;
  if (status === 410) return fail("gone");
  if (status === 404) return fail("not_found");
  if (status === 401 || status === 403) {
    if (challengeSignal(input, true)) return fail("blocked_challenge");
    return fail("authentication_required");
  }
  if (status === 402) return fail("paywall_or_consent");
  if (status === 408 || status === 504) return fail("timeout");
  if (status === 429 || status >= 500) return fail("network_error");
  if (status < 200 || status >= 300) return fail("network_error");

  if (isPdfContentType(input.contentType)) {
    return { failure: null };
  }
  if (!isHtmlContentType(input.contentType) && input.contentType) {
    return fail("unsupported_content_type");
  }

  const dense = input.wordCount >= 80 && input.hasArticle;
  if (challengeSignal(input, !dense)) return fail("blocked_challenge");
  if (AUTH_TITLE.test(input.title ?? "") || (lowDensity(input) && AUTH_BODY.test(input.text))) {
    return fail("authentication_required");
  }
  if (PAYWALL_TITLE.test(input.title ?? "") || (lowDensity(input) && PAYWALL_BODY.test(input.text))) {
    return fail("paywall_or_consent");
  }
  if (lowDensity(input) && CONSENT_BODY.test(input.text) && !input.hasArticle) {
    return fail("paywall_or_consent");
  }
  if (MISSING_TITLE.test(input.title ?? "") && lowDensity(input)) return fail("not_found");
  if (lowDensity(input) && ENABLE_JS.test(`${input.title ?? ""} ${input.text}`) && !input.hasArticle) {
    return fail("empty_content");
  }
  if (input.wordCount === 0) return fail("empty_content");
  return { failure: null };
}

function challengeSignal(input: ClassifyInput, allowBody: boolean): boolean {
  if (isChallengeTitle(input.title)) return true;
  try {
    const path = new URL(input.finalUrl).pathname.toLowerCase();
    if (path.includes("/cdn-cgi/") || path.includes("challenge-platform")) return true;
  } catch {
    // ignore
  }
  if (!allowBody) return false;
  return CHALLENGE_BODY.test(input.text) && lowDensity(input);
}

function lowDensity(input: ClassifyInput): boolean {
  return input.wordCount < 80 || (input.scriptCount >= 5 && input.wordCount < 200);
}

function fail(failure: ReadingFailureCode): ClassifyResult {
  return { failure };
}
