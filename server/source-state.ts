export type SourceAccountState = "imported" | "pending" | "runner" | "extension" | "connected";

export function classifySourceAccount(input: {
  accountKind: "live" | "imported";
  externalId: string;
  captureRunning: boolean;
  extensionConnected: boolean;
  runnerProfileExists: boolean;
}): SourceAccountState {
  if (input.accountKind === "imported") return "imported";
  if (input.externalId.startsWith("pending:") || input.externalId === "pending") return "pending";
  if (input.captureRunning && input.extensionConnected) return "extension";
  if (input.runnerProfileExists) return "runner";
  return "connected";
}
