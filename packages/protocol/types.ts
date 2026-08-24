import type { CaptureMode, ContentType, Coverage, JsonValue, SourceId } from "../../core/types.ts";

export interface CaptureProducerV1 {
  id: string;
  version: string;
}

export interface CaptureSessionV1 {
  protocolVersion: 1;
  source: SourceId | `custom:${string}`;
  producer: CaptureProducerV1;
  accountExternalId: string;
  collection: {
    externalId: string;
    name?: string;
    url?: string;
  };
  mode: CaptureMode;
  observedAt: string;
}

export interface ItemDraftWireV1 {
  contentType: ContentType;
  title?: string;
  body?: string;
  url: string;
  authorName?: string;
  authorHandle?: string;
  publishedAt?: string;
  sourceSavedAt?: string;
  media?: { kind: string; url: string }[];
}

export type CaptureChangeV1 =
  | {
      kind: "upsert";
      externalId: string;
      revision?: string;
      sourcePosition?: number;
      item: ItemDraftWireV1;
      metadata?: Record<string, JsonValue>;
    }
  | {
      kind: "remove";
      externalId: string;
      observedAt: string;
    };

export interface CaptureBatchV1 {
  sessionId: string;
  sequence: number;
  idempotencyKey: string;
  changes: CaptureChangeV1[];
}

export interface CaptureFinishV1 {
  sessionId: string;
  coverage: Coverage;
  cursor?: JsonValue;
}

export type JsonlRecordV1 =
  | ({ type: "session" } & CaptureSessionV1)
  | ({ type: "batch" } & CaptureBatchV1)
  | ({ type: "finish" } & CaptureFinishV1);
