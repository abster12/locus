import { createHash } from "node:crypto";
import type { Db } from "../../db/open.ts";
import { newId, nowIso } from "../../db/open.ts";
import { RejectedPayload, sanitizeText } from "../../core/sanitize.ts";

export const LIBRARY_SCOPES = ["library:read", "library:write"] as const;
export type LibraryScope = (typeof LIBRARY_SCOPES)[number];

export type LibraryCapability = {
  id: string;
  libraryId: string;
  scope: LibraryScope;
  label: string;
  createdAt: string;
  revokedAt: string | null;
};

const MAX_LABEL = 80;

export function isLibraryScope(value: unknown): value is LibraryScope {
  return value === "library:read" || value === "library:write";
}

export function issueLibraryCapability(
  db: Db,
  input: { libraryId: string; scope: unknown; label?: unknown },
): { token: string; capability: LibraryCapability } {
  const libraryId = requireLibraryId(input.libraryId);
  if (!isLibraryScope(input.scope)) throw new RejectedPayload("invalid scope");
  const label = sanitizeText(typeof input.label === "string" ? input.label : "", MAX_LABEL);
  const token = `lib_${crypto.randomUUID().replaceAll("-", "")}`;
  const capability: LibraryCapability = {
    id: newId(),
    libraryId,
    scope: input.scope,
    label,
    createdAt: nowIso(),
    revokedAt: null,
  };
  db.prepare(
    `INSERT INTO library_capabilities (id, library_id, token_hash, scope, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(capability.id, libraryId, hashSecret(token), capability.scope, label, capability.createdAt);
  return { token, capability };
}

export function listLibraryCapabilities(db: Db, libraryId: string): LibraryCapability[] {
  requireLibraryId(libraryId);
  return (
    db
      .prepare(
        `SELECT id, library_id AS libraryId, scope, label, created_at AS createdAt, revoked_at AS revokedAt
         FROM library_capabilities
         WHERE library_id = ? AND revoked_at IS NULL
         ORDER BY created_at DESC, id DESC`,
      )
      .all(libraryId) as LibraryCapability[]
  );
}

export function revokeLibraryCapability(db: Db, libraryId: string, id: string): boolean {
  requireLibraryId(libraryId);
  if (!id.trim()) return false;
  const result = db
    .prepare(
      `UPDATE library_capabilities SET revoked_at = ? WHERE id = ? AND library_id = ? AND revoked_at IS NULL`,
    )
    .run(nowIso(), id, libraryId);
  return Number(result.changes) > 0;
}

export function lookupLibraryCapability(db: Db, token: string): LibraryCapability | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT id, library_id AS libraryId, scope, label, created_at AS createdAt, revoked_at AS revokedAt
       FROM library_capabilities WHERE token_hash = ?`,
    )
    .get(hashSecret(token)) as LibraryCapability | undefined;
  if (!row || row.revokedAt) return null;
  return row;
}

function hashSecret(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function requireLibraryId(libraryId: string): string {
  if (typeof libraryId !== "string" || !libraryId.trim()) throw new RejectedPayload("library is required");
  return libraryId;
}
