import { createHash } from "node:crypto";
import { RejectedPayload, sanitizeText } from "../../core/sanitize.ts";
import { nowIso } from "./desk.ts";
import { all, first, run } from "./sql.ts";

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

export function libraryCapabilityUsable(capability: LibraryCapability): boolean {
  return Boolean(capability.libraryId) && !capability.revokedAt;
}

export async function issueLibraryCapability(
  db: D1Database,
  input: { libraryId: string; scope: unknown; label?: unknown },
): Promise<{ token: string; capability: LibraryCapability }> {
  const libraryId = requireLibraryId(input.libraryId);
  if (!isLibraryScope(input.scope)) throw new RejectedPayload("invalid scope");
  const label = sanitizeText(typeof input.label === "string" ? input.label : "", MAX_LABEL);
  const token = `lib_${crypto.randomUUID().replaceAll("-", "")}`;
  const capability: LibraryCapability = {
    id: crypto.randomUUID(),
    libraryId,
    scope: input.scope,
    label,
    createdAt: nowIso(),
    revokedAt: null,
  };
  await run(
    db,
    `INSERT INTO library_capabilities (id, library_id, token_hash, scope, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    capability.id,
    libraryId,
    hashSecret(token),
    capability.scope,
    label,
    capability.createdAt,
  );
  return { token, capability };
}

export async function listLibraryCapabilities(db: D1Database, libraryId: string): Promise<LibraryCapability[]> {
  libraryId = requireLibraryId(libraryId);
  return all<LibraryCapability>(
    db,
    `SELECT id, library_id AS libraryId, scope, label, created_at AS createdAt, revoked_at AS revokedAt
       FROM library_capabilities
      WHERE library_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC, id DESC`,
    libraryId,
  );
}

export async function revokeLibraryCapability(db: D1Database, libraryId: string, id: string): Promise<boolean> {
  libraryId = requireLibraryId(libraryId);
  if (!id.trim()) return false;
  const result = await run(
    db,
    `UPDATE library_capabilities SET revoked_at = ? WHERE id = ? AND library_id = ? AND revoked_at IS NULL`,
    nowIso(),
    id,
    libraryId,
  );
  return Number(result.meta.changes ?? 0) > 0;
}

export async function lookupLibraryCapability(db: D1Database, token: string): Promise<LibraryCapability | null> {
  if (!token) return null;
  const row = await first<LibraryCapability>(
    db,
    `SELECT id, library_id AS libraryId, scope, label, created_at AS createdAt, revoked_at AS revokedAt
       FROM library_capabilities WHERE token_hash = ?`,
    hashSecret(token),
  );
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
