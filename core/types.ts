export type SourceId = "x" | "instagram" | "youtube" | "reddit";

export type ContentType = "post" | "thread" | "reel" | "video" | "comment" | "link";

export type ItemStatus = "inbox" | "accepted" | "snoozed" | "archived" | "rejected";

export type ActivityKind = "imported" | "detected" | "captured" | "updated" | "source_removed";

export type Coverage = "complete" | "partial";

export type CaptureMode = "incremental" | "snapshot";

export type ItemId = string & { readonly __brand: "ItemId" };
export type AccountId = string & { readonly __brand: "AccountId" };
export type CollectionId = string & { readonly __brand: "CollectionId" };
export type SourceCollectionId = string & { readonly __brand: "SourceCollectionId" };
export type SourceRecordId = string & { readonly __brand: "SourceRecordId" };
export type CaptureRunId = string & { readonly __brand: "CaptureRunId" };
export type SessionId = string & { readonly __brand: "SessionId" };

export function asItemId(value: string): ItemId {
  return value as ItemId;
}

export function asAccountId(value: string): AccountId {
  return value as AccountId;
}

export const SOURCES: SourceId[] = ["x", "instagram", "youtube", "reddit"];

export function isSourceId(value: string): value is SourceId {
  return value === "x" || value === "instagram" || value === "youtube" || value === "reddit";
}

export function isContentType(value: string): value is ContentType {
  return (
    value === "post" ||
    value === "thread" ||
    value === "reel" ||
    value === "video" ||
    value === "comment" ||
    value === "link"
  );
}

export function isItemStatus(value: string): value is ItemStatus {
  return (
    value === "inbox" ||
    value === "accepted" ||
    value === "snoozed" ||
    value === "archived" ||
    value === "rejected"
  );
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface MediaRef {
  kind: string;
  url: string;
}

export interface ItemDraftV1 {
  contentType: ContentType;
  title?: string;
  body?: string;
  url: string;
  authorName?: string;
  authorHandle?: string;
  publishedAt?: string;
  sourceSavedAt?: string;
  media?: MediaRef[];
}

export interface ItemRecord {
  id: ItemId;
  contentType: ContentType;
  title: string | null;
  body: string | null;
  url: string;
  authorName: string | null;
  authorHandle: string | null;
  publishedAt: string | null;
  sourceSavedAt: string | null;
  firstObservedAt: string;
  capturedAt: string | null;
  media: MediaRef[];
  createdAt: string;
  updatedAt: string;
}

export type CaptureErrorCode =
  | "logged-out"
  | "login-timeout"
  | "session-expired"
  | "challenge"
  | "wrong-page"
  | "permission-denied"
  | "site-changed"
  | "scan-stalled"
  | "tab-closed"
  | "server-unreachable"
  | "storage-full"
  | "interrupted";

export const CAPTURE_ERROR_CODES: CaptureErrorCode[] = [
  "logged-out",
  "login-timeout",
  "session-expired",
  "challenge",
  "wrong-page",
  "permission-denied",
  "site-changed",
  "scan-stalled",
  "tab-closed",
  "server-unreachable",
  "storage-full",
  "interrupted",
];

export function isCaptureErrorCode(value: string): value is CaptureErrorCode {
  return (CAPTURE_ERROR_CODES as string[]).includes(value);
}

export function recoveryText(code: CaptureErrorCode): string {
  switch (code) {
    case "logged-out":
      return "Log in to the site in the window we opened. Locus never sees your password.";
    case "login-timeout":
      return "Login timed out. Click Connect or Refresh and log in on the real site.";
    case "session-expired":
      return "The saved browser session expired. Click Refresh and log in again on the real site.";
    case "challenge":
      return "Complete the check in the window, then click Resume.";
    case "wrong-page":
      return "The capture window is not on the saved-items page. Navigate there, then click Resume.";
    case "permission-denied":
      return "This producer is not allowed to write that source. Pair it again from Sources.";
    case "site-changed":
      return "This site’s markup changed. The pack could not find saved items. Capture stopped.";
    case "scan-stalled":
      return "The page stopped loading more items. Existing records were kept. Try Refresh.";
    case "tab-closed":
      return "The capture window was closed. Existing records were kept.";
    case "server-unreachable":
      return "The capture producer could not reach Locus. Is the desk still running?";
    case "storage-full":
      return "The local library could not store more records. Free disk space, then retry.";
    case "interrupted":
      return "Capture was stopped. Existing records were kept. Click Refresh to continue.";
    default: {
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}

export type DateLabelKind = "saved" | "discovered" | "captured" | "published";

export interface DateLabel {
  kind: DateLabelKind;
  at: string;
  text: string;
}

export function dateLabel(item: {
  sourceSavedAt: string | null;
  firstObservedAt: string;
  capturedAt: string | null;
  publishedAt: string | null;
}): DateLabel {
  if (item.publishedAt) {
    return { kind: "published", at: item.publishedAt, text: formatDay(item.publishedAt) };
  }
  if (item.sourceSavedAt) {
    return { kind: "saved", at: item.sourceSavedAt, text: `saved ${formatDay(item.sourceSavedAt)}` };
  }
  if (item.capturedAt) {
    return { kind: "captured", at: item.capturedAt, text: `imported ${formatDay(item.capturedAt)}` };
  }
  return {
    kind: "discovered",
    at: item.firstObservedAt,
    text: `discovered ${formatDay(item.firstObservedAt)}`,
  };
}

export function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date();
  if (sameDay(d, today)) return "today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, yesterday)) return "yesterday";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
