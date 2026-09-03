export type SourceConnectionState =
  | "not_connected"
  | "connecting"
  | "connected"
  | "capturing"
  | "needs_attention";

export function isPendingExternalId(externalId: string): boolean {
  return externalId.startsWith("pending:") || externalId === "pending";
}

const PLACEHOLDER_DISPLAY_NAMES = new Set(["x", "instagram", "youtube", "reddit", "pending", "unknown", "extension"]);

export function isPlaceholderDisplayName(value: string | null | undefined): boolean {
  if (value == null) return true;
  const name = value.trim();
  if (!name) return true;
  if (isPendingExternalId(name)) return true;
  return PLACEHOLDER_DISPLAY_NAMES.has(name.toLowerCase());
}

export function resolvedAccountDisplayName(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  const current = existing?.trim() || null;
  const next = incoming?.trim() || null;
  if (isPlaceholderDisplayName(next)) return current;
  if (isPlaceholderDisplayName(current)) return next;
  return current;
}

export function sourceConnectionState(input: {
  hasLiveAccount: boolean;
  pending: boolean;
  running: boolean;
  hasRecovery: boolean;
}): SourceConnectionState {
  if (!input.hasLiveAccount) return "not_connected";
  if (input.running) return "capturing";
  if (input.pending) return "connecting";
  if (input.hasRecovery) return "needs_attention";
  return "connected";
}

export function pickConnectionAccount<
  T extends {
    accountKind: "live" | "imported" | "disconnected";
    externalId: string;
    createdAt: string;
  },
>(accounts: readonly T[]): T | undefined {
  let resolved: T | undefined;
  let pending: T | undefined;
  for (const account of accounts) {
    if (account.accountKind !== "live") continue;
    if (isPendingExternalId(account.externalId)) {
      if (!pending || account.createdAt > pending.createdAt) pending = account;
    } else if (!resolved || account.createdAt > resolved.createdAt) {
      resolved = account;
    }
  }
  return resolved ?? pending;
}
