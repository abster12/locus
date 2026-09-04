// Type contract for extension/shell/pairing.js (plain JS — it runs in Chrome).
export function verifyPairing(options: {
  origin: unknown;
  token: unknown;
  fetchImpl?: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>;
  storage: { set: (value: { origin: string; token: string }) => Promise<void> | void };
}): Promise<void>;
