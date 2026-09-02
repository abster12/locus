import type { Db } from "../db/open.ts";
import { newId, nowIso } from "../db/open.ts";
import { enqueueAtlasItem } from "./atlas/module.ts";
import { reconcileItem } from "./reading/module.ts";

export function persistNewItem(
  db: Db,
  input: {
    libraryId: string;
    draft: {
      contentType: string;
      title?: string | null;
      body?: string | null;
      url: string;
      authorName?: string | null;
      authorHandle?: string | null;
      publishedAt?: string | null;
      sourceSavedAt?: string | null;
      media?: { kind: string; url: string }[];
    };
    firstObservedAt: string;
    capturedAt: string | null;
    activityKind: string;
    captureRunId: string | null;
  },
): string {
  const itemId = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO items (
      id, content_type, title, body, url, author_name, author_handle, published_at, source_saved_at,
      first_observed_at, captured_at, media, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    itemId,
    input.draft.contentType,
    input.draft.title ?? null,
    input.draft.body ?? null,
    input.draft.url,
    input.draft.authorName ?? null,
    input.draft.authorHandle ?? null,
    input.draft.publishedAt ?? null,
    input.draft.sourceSavedAt ?? null,
    input.firstObservedAt,
    input.capturedAt,
    JSON.stringify(input.draft.media ?? []),
    now,
    now,
  );
  db.prepare(`INSERT INTO item_state (item_id, status, snoozed_until, updated_at) VALUES (?, 'inbox', NULL, ?)`).run(itemId, now);
  db.prepare(
    `INSERT INTO activities (id, item_id, kind, occurred_at, timestamp_source, capture_run_id) VALUES (?, ?, ?, ?, 'locus', ?)`,
  ).run(newId(), itemId, input.activityKind, input.firstObservedAt, input.captureRunId);
  reconcileItem(db, input.libraryId, itemId);
  enqueueAtlasItem(db, input.libraryId, itemId);
  return itemId;
}
