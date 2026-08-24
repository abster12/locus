import type { CaptureBatchV1, CaptureFinishV1, CaptureSessionV1 } from "../protocol/types.ts";

export interface CaptureClient {
  start(session: CaptureSessionV1): Promise<{ sessionId: string }>;
  batch(batch: CaptureBatchV1): Promise<{ replayed: boolean; upserted: number }>;
  finish(finish: CaptureFinishV1): Promise<{ removed: number }>;
}

export function createCaptureClient(args: { baseUrl: string; token: string }): CaptureClient {
  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${args.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { error: text };
    }
    if (!res.ok) {
      const err = json && typeof json === "object" && "error" in json ? String((json as { error: unknown }).error) : res.statusText;
      throw new Error(err);
    }
    return json as T;
  }

  return {
    start: (session) => post("/capture/v1/sessions", session),
    batch: (batch) => post("/capture/v1/batches", batch),
    finish: (finish) => post("/capture/v1/finish", finish),
  };
}
