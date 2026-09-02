import type { Db } from "../db/open.ts";
import { newId, nowIso, tx } from "../db/open.ts";
import { isItemStatus, type ItemStatus } from "./types.ts";
import { RejectedPayload, sanitizeText } from "./sanitize.ts";

export class MissingResource extends Error {
  readonly code = "not-found";

  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = "MissingResource";
  }
}

function requireItem(db: Db, itemId: string): void {
  const row = db.prepare(`SELECT 1 FROM items WHERE id = ?`).get(itemId);
  if (!row) throw new MissingResource("item");
}

function requireTag(db: Db, tagId: string): void {
  const row = db.prepare(`SELECT 1 FROM tags WHERE id = ?`).get(tagId);
  if (!row) throw new MissingResource("tag");
}

function requireCollection(db: Db, collectionId: string): void {
  const row = db.prepare(`SELECT 1 FROM collections WHERE id = ?`).get(collectionId);
  if (!row) throw new MissingResource("collection");
}

export function setStatus(db: Db, itemId: string, status: ItemStatus, snoozedUntil?: string): void {
  if (!isItemStatus(status)) throw new RejectedPayload("invalid status");
  const until = status === "snoozed" ? (snoozedUntil ?? new Date(Date.now() + 86400000).toISOString()) : null;
  tx(db, () => {
    requireItem(db, itemId);
    db.prepare(
      `INSERT INTO item_state (item_id, status, snoozed_until, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET status = excluded.status, snoozed_until = excluded.snoozed_until, updated_at = excluded.updated_at`,
    ).run(itemId, status, until, nowIso());
  });
}

export function ensureTag(db: Db, name: string, color?: string): { id: string; name: string } {
  const clean = sanitizeText(name, 40);
  if (!clean) throw new RejectedPayload("tag name required");
  const existing = db.prepare(`SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE`).get(clean) as
    | { id: string; name: string }
    | undefined;
  if (existing) return existing;
  const tag = { id: newId(), name: clean };
  db.prepare(`INSERT INTO tags (id, name, color) VALUES (?, ?, ?)`).run(tag.id, tag.name, color ?? null);
  return tag;
}

export function addTag(db: Db, itemId: string, name: string, color?: string): { id: string; name: string } {
  return tx(db, () => {
    requireItem(db, itemId);
    const tag = ensureTag(db, name, color);
    db.prepare(
      `INSERT OR IGNORE INTO memberships (item_id, target_id, target_kind, actor, created_at) VALUES (?, ?, 'tag', 'user', ?)`,
    ).run(itemId, tag.id, nowIso());
    return tag;
  });
}

export function removeTag(db: Db, itemId: string, tagId: string): void {
  tx(db, () => {
    requireItem(db, itemId);
    requireTag(db, tagId);
    db.prepare(`DELETE FROM memberships WHERE item_id = ? AND target_id = ? AND target_kind = 'tag'`).run(itemId, tagId);
    db.prepare(`DELETE FROM intake_tag_evidence WHERE item_id = ? AND tag_id = ?`).run(itemId, tagId);
  });
}

export function createCollection(db: Db, name: string, description?: string): { id: string; name: string } {
  const clean = sanitizeText(name, 80);
  if (!clean) throw new RejectedPayload("collection name required");
  const id = newId();
  db.prepare(`INSERT INTO collections (id, name, description, created_at) VALUES (?, ?, ?, ?)`).run(
    id,
    clean,
    description ? sanitizeText(description, 400) : null,
    nowIso(),
  );
  return { id, name: clean };
}

export function addToCollection(db: Db, itemId: string, collectionId: string): void {
  tx(db, () => {
    requireItem(db, itemId);
    requireCollection(db, collectionId);
    db.prepare(
      `INSERT OR IGNORE INTO memberships (item_id, target_id, target_kind, actor, created_at) VALUES (?, ?, 'collection', 'user', ?)`,
    ).run(itemId, collectionId, nowIso());
  });
}

export function removeFromCollection(db: Db, itemId: string, collectionId: string): void {
  tx(db, () => {
    requireItem(db, itemId);
    requireCollection(db, collectionId);
    db.prepare(`DELETE FROM memberships WHERE item_id = ? AND target_id = ? AND target_kind = 'collection'`).run(
      itemId,
      collectionId,
    );
  });
}

export function addNote(db: Db, itemId: string, body: string): { id: string } {
  const clean = sanitizeText(body, 4000);
  if (!clean) throw new RejectedPayload("note body required");
  const id = newId();
  tx(db, () => {
    requireItem(db, itemId);
    db.prepare(`INSERT INTO notes (id, item_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
      id,
      itemId,
      clean,
      nowIso(),
      nowIso(),
    );
  });
  return { id };
}

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
