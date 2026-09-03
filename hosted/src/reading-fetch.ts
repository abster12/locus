import { isPublicHostname } from "../../server/reading/policy.ts";

export const MAX_REDIRECTS = 4;
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

export type FetchFailureCode = "unsafe_target" | "timeout" | "network_error";

export class ReadingFetchError extends Error {
  constructor(
    readonly code: FetchFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ReadingFetchError";
  }
}

export interface FetchedPage {
  url: URL;
  status: number;
  contentType: string;
  body: string;
}

export function publicHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ReadingFetchError("unsafe_target", "bad url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ReadingFetchError("unsafe_target", "only http(s)");
  }
  if (parsed.username || parsed.password) throw new ReadingFetchError("unsafe_target", "credentials");
  if (!isPublicHostname(parsed.hostname)) throw new ReadingFetchError("unsafe_target", "blocked host");
  return parsed;
}

export async function fetchReadingPage(
  rawUrl: string,
  opts: { accept?: string; maxBytes?: number; timeoutMs?: number } = {},
): Promise<FetchedPage> {
  const maxBytes = opts.maxBytes ?? MAX_HTML_BYTES;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const accept = opts.accept ?? "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.1";
  const deadline = Date.now() + timeoutMs;
  let current = publicHttpUrl(rawUrl);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ReadingFetchError("timeout", "timeout");
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(remaining),
        headers: {
          accept,
          "user-agent": "LocusReading/0.1",
        },
      });
    } catch (error) {
      if (error instanceof ReadingFetchError) throw error;
      if (isTimeout(error)) throw new ReadingFetchError("timeout", "timeout");
      throw new ReadingFetchError("network_error", "network error");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      void response.body?.cancel();
      if (!location) {
        return { url: current, status: response.status, contentType: contentTypeOf(response), body: "" };
      }
      if (redirect === MAX_REDIRECTS) throw new ReadingFetchError("network_error", "too many redirects");
      current = publicHttpUrl(new URL(location, current).toString());
      continue;
    }
    const body = await readBounded(response, maxBytes);
    return {
      url: current,
      status: response.status,
      contentType: contentTypeOf(response),
      body,
    };
  }
  throw new ReadingFetchError("network_error", "too many redirects");
}

function contentTypeOf(response: Response): string {
  return response.headers.get("content-type") ?? "";
}

function isTimeout(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
  if (error instanceof Error && error.name === "TimeoutError") return true;
  if (error instanceof Error && /aborted|timeout/i.test(error.message)) return true;
  return false;
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ReadingFetchError("network_error", "response too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ReadingFetchError) throw error;
    if (isTimeout(error)) throw new ReadingFetchError("timeout", "timeout");
    throw new ReadingFetchError("network_error", "network error");
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}
