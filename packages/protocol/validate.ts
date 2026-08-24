import { isContentType, isSourceId, type SourceId } from "../../core/types.ts";
import { assertSafeMetadata, RejectedPayload, sanitizeItemDraft } from "../../core/sanitize.ts";
import type {
  CaptureBatchV1,
  CaptureChangeV1,
  CaptureFinishV1,
  CaptureSessionV1,
  ItemDraftWireV1,
} from "./types.ts";

const MAX_CHANGES = 100;
const MAX_ID = 300;

function rec(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RejectedPayload("expected an object");
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new RejectedPayload(`${field} is required`);
  if (value.length > MAX_ID * 4) throw new RejectedPayload(`${field} is too long`);
  return value;
}

function optStr(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new RejectedPayload(`${field} must be a string`);
  return value;
}

function num(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new RejectedPayload(`${field} must be a number`);
  return value;
}

export function parseSource(value: unknown): SourceId | `custom:${string}` {
  if (typeof value !== "string") throw new RejectedPayload("source is required");
  if (isSourceId(value)) return value;
  if (value.startsWith("custom:") && value.length > 7 && value.length < 80) return value as `custom:${string}`;
  throw new RejectedPayload("unknown source");
}

export function parseSession(input: unknown): CaptureSessionV1 {
  const o = rec(input);
  if (o.protocolVersion !== 1) throw new RejectedPayload("protocolVersion must be 1");
  const source = parseSource(o.source);
  const producer = rec(o.producer);
  const collection = rec(o.collection);
  const mode = o.mode;
  if (mode !== "incremental" && mode !== "snapshot") throw new RejectedPayload("mode must be incremental or snapshot");
  return {
    protocolVersion: 1,
    source,
    producer: { id: str(producer.id, "producer.id"), version: str(producer.version, "producer.version") },
    accountExternalId: str(o.accountExternalId, "accountExternalId").slice(0, MAX_ID),
    collection: {
      externalId: str(collection.externalId, "collection.externalId").slice(0, MAX_ID),
      name: optStr(collection.name, "collection.name"),
      url: optStr(collection.url, "collection.url"),
    },
    mode,
    observedAt: str(o.observedAt, "observedAt"),
  };
}

function parseDraft(input: unknown): ItemDraftWireV1 {
  const o = rec(input);
  const contentType = str(o.contentType, "item.contentType");
  if (!isContentType(contentType)) throw new RejectedPayload("unknown contentType");
  const clean = sanitizeItemDraft({
    contentType,
    title: optStr(o.title, "item.title"),
    body: optStr(o.body, "item.body"),
    url: str(o.url, "item.url"),
    authorName: optStr(o.authorName, "item.authorName"),
    authorHandle: optStr(o.authorHandle, "item.authorHandle"),
    publishedAt: optStr(o.publishedAt, "item.publishedAt"),
    sourceSavedAt: optStr(o.sourceSavedAt, "item.sourceSavedAt"),
    media: Array.isArray(o.media)
      ? o.media.map((m) => {
          const r = rec(m);
          return { kind: str(r.kind, "media.kind"), url: str(r.url, "media.url") };
        })
      : undefined,
  });
  return {
    contentType,
    title: clean.title,
    body: clean.body,
    url: clean.url,
    authorName: clean.authorName,
    authorHandle: clean.authorHandle,
    publishedAt: clean.publishedAt,
    sourceSavedAt: clean.sourceSavedAt,
    media: clean.media,
  };
}

export function parseChange(input: unknown): CaptureChangeV1 {
  const o = rec(input);
  if (o.kind === "upsert") {
    return {
      kind: "upsert",
      externalId: str(o.externalId, "externalId").slice(0, MAX_ID),
      revision: optStr(o.revision, "revision"),
      sourcePosition: o.sourcePosition === undefined ? undefined : num(o.sourcePosition, "sourcePosition"),
      item: parseDraft(o.item),
      metadata: assertSafeMetadata(o.metadata) as CaptureChangeV1 extends { metadata?: infer M } ? M : never,
    };
  }
  if (o.kind === "remove") {
    return {
      kind: "remove",
      externalId: str(o.externalId, "externalId").slice(0, MAX_ID),
      observedAt: str(o.observedAt, "observedAt"),
    };
  }
  throw new RejectedPayload("change.kind must be upsert or remove");
}

export function parseBatch(input: unknown): CaptureBatchV1 {
  const o = rec(input);
  if (!Array.isArray(o.changes)) throw new RejectedPayload("changes must be an array");
  if (o.changes.length === 0) throw new RejectedPayload("changes must not be empty");
  if (o.changes.length > MAX_CHANGES) throw new RejectedPayload(`changes exceed ${MAX_CHANGES}`);
  return {
    sessionId: str(o.sessionId, "sessionId"),
    sequence: num(o.sequence, "sequence"),
    idempotencyKey: str(o.idempotencyKey, "idempotencyKey").slice(0, 200),
    changes: o.changes.map(parseChange),
  };
}

export function parseFinish(input: unknown): CaptureFinishV1 {
  const o = rec(input);
  if (o.coverage !== "complete" && o.coverage !== "partial") {
    throw new RejectedPayload("coverage must be complete or partial");
  }
  return {
    sessionId: str(o.sessionId, "sessionId"),
    coverage: o.coverage,
    cursor: o.cursor as CaptureFinishV1["cursor"],
  };
}
