import { isPendingExternalId } from "../db/source-lifecycle.ts";

export type SourceAccountState = "imported" | "pending" | "runner" | "extension" | "connected";

export type SourceConnectionState =
  | "not_connected"
  | "connecting"
  | "connected"
  | "capturing"
  | "needs_attention";

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

export function pickConnectionAccount<T extends {
  accountKind: "live" | "imported" | "disconnected";
  externalId: string;
  createdAt: string;
}>(accounts: readonly T[]): T | undefined {
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

export function classifySourceAccount(input: {
  accountKind: "live" | "imported" | "disconnected";
  externalId: string;
  captureRunning: boolean;
  extensionConnected: boolean;
  runnerProfileExists: boolean;
}): SourceAccountState {
  if (input.accountKind !== "live") return "imported";
  if (isPendingExternalId(input.externalId)) return "pending";
  if (input.captureRunning && input.extensionConnected) return "extension";
  if (input.runnerProfileExists) return "runner";
  return "connected";
}
