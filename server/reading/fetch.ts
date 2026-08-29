import { Resolver } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { isBlockedIp, isPublicHostname } from "./policy.ts";

export const MAX_REDIRECTS = 4;
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 1_500_000;
export const MAX_IMAGE_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 8_192;

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

export interface DnsAnswers {
  a: string[];
  aaaa: string[];
}

export interface ReadingHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface ReadingTransport {
  resolve(hostname: string): Promise<DnsAnswers>;
  request(args: { url: URL; ip: string; headers: Record<string, string>; maxBytes: number; timeoutMs: number }): Promise<ReadingHttpResponse>;
}

export interface FetchedResource {
  url: URL;
  status: number;
  contentType: string;
  body: Buffer;
}

const defaultTransport: ReadingTransport = {
  async resolve(hostname) {
    return resolveAll(hostname);
  },
  async request(args) {
    return pinnedRequest(args);
  },
};


export async function fetchReadingResource(
  rawUrl: string,
  opts: { accept: string; maxBytes: number; transport?: ReadingTransport; timeoutMs?: number } = {
    accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.1",
    maxBytes: MAX_HTML_BYTES,
  },
): Promise<FetchedResource> {
  const transport = opts.transport ?? defaultTransport;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => {
    const left = deadline - Date.now();
    if (left <= 0) throw new ReadingFetchError("timeout", "timeout");
    return left;
  };
  let current = parsePublicHttpUrl(rawUrl);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const ip = await withDeadline(pinnedAddress(current.hostname, transport), remaining());
    const response = await transport.request({
      url: current,
      ip,
      maxBytes: opts.maxBytes,
      timeoutMs: remaining(),
      headers: {
        host: current.host,
        "user-agent": "LocusReading/0.1",
        accept: opts.accept,
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = header(response.headers, "location");
      if (!location) return done(current, response);
      if (redirect === MAX_REDIRECTS) throw new ReadingFetchError("network_error", "too many redirects");
      current = parsePublicHttpUrl(new URL(location, current).toString());
      continue;
    }
    return done(current, response);
  }
  throw new ReadingFetchError("network_error", "too many redirects");
}

function done(url: URL, response: ReadingHttpResponse): FetchedResource {
  return {
    url,
    status: response.status,
    contentType: header(response.headers, "content-type") ?? "",
    body: response.body,
  };
}

export async function pinnedAddress(hostname: string, transport: ReadingTransport = defaultTransport): Promise<string> {
  const answers = isIP(hostname)
    ? isIP(hostname) === 4
      ? { a: [hostname], aaaa: [] }
      : { a: [], aaaa: [hostname] }
    : await transport.resolve(hostname);
  const all = [...answers.a, ...answers.aaaa];
  if (all.length === 0) throw new ReadingFetchError("network_error", "dns failed");
  // Mixed public/private is a rejection, not a filter.
  if (all.some((ip) => isBlockedIp(ip))) throw new ReadingFetchError("unsafe_target", "blocked address");
  return answers.a[0] ?? answers.aaaa[0]!;
}

function parsePublicHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ReadingFetchError("unsafe_target", "bad url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ReadingFetchError("unsafe_target", "only http(s)");
  if (parsed.username || parsed.password) throw new ReadingFetchError("unsafe_target", "credentials");
  if (!isPublicHostname(parsed.hostname)) throw new ReadingFetchError("unsafe_target", "blocked host");
  return parsed;
}

async function resolveAll(hostname: string): Promise<DnsAnswers> {
  const resolver = new Resolver();
  const empty = (error: unknown): string[] => {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: string }).code) : "";
    if (code === "ENODATA" || code === "ENOTFOUND" || code === "EREFUSED") return [];
    throw error;
  };
  const [a, aaaa] = await Promise.all([
    resolver.resolve4(hostname).catch(empty),
    resolver.resolve6(hostname).catch(empty),
  ]);
  return { a, aaaa };
}

function pinnedRequest(args: {
  url: URL;
  ip: string;
  headers: Record<string, string>;
  maxBytes: number;
  timeoutMs: number;
}): Promise<ReadingHttpResponse> {
  const { url, ip } = args;
  const isTls = url.protocol === "https:";
  const lib = isTls ? https : http;
  const headers = { ...args.headers, host: url.host };
  delete (headers as { cookie?: string }).cookie;
  delete (headers as { referer?: string }).referer;
  delete (headers as { authorization?: string }).authorization;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: ip,
        family: ip.includes(":") ? 6 : 4,
        port: url.port ? Number(url.port) : isTls ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
        servername: isTls ? url.hostname : undefined,
        timeout: args.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > args.maxBytes) {
            req.destroy();
            res.destroy();
            reject(new ReadingFetchError("network_error", "response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: flattenHeaders(res.headers),
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", (error) => reject(wrapNet(error)));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new ReadingFetchError("timeout", "timeout"));
    });
    req.on("error", (error) => reject(wrapNet(error)));
    req.end();
  });
}

function wrapNet(error: unknown): ReadingFetchError {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: string }).code) : "";
  if (code === "ABORT_ERR" || code === "ETIMEDOUT" || code === "UND_ERR_ABORTED") {
    return new ReadingFetchError("timeout", "timeout");
  }
  return new ReadingFetchError("network_error", error instanceof Error ? error.message : "network");
}

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
    else if (Array.isArray(value)) out[key.toLowerCase()] = value.join(", ");
  }
  return out;
}

function header(headers: Record<string, string>, name: string): string | null {
  return headers[name.toLowerCase()] ?? null;
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new ReadingFetchError("timeout", "timeout"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ReadingFetchError("timeout", "timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Decode width/height from a cached image. Unknown formats are rejected. */
export function imageDimensions(bytes: Buffer, mime: string): { width: number; height: number } | null {
  const type = mime.toLowerCase();
  if (type.includes("png")) return pngSize(bytes);
  if (type.includes("gif")) return gifSize(bytes);
  if (type.includes("jpeg") || type.includes("jpg")) return jpegSize(bytes);
  if (type.includes("webp")) return webpSize(bytes);
  return null;
}

export function imageWithinBounds(bytes: Buffer, mime: string): boolean {
  const size = imageDimensions(bytes, mime);
  if (!size) return false;
  return size.width > 0 && size.height > 0 && size.width <= MAX_IMAGE_EDGE && size.height <= MAX_IMAGE_EDGE;
}

function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (bytes.subarray(0, 8).toString("binary") !== "\x89PNG\r\n\x1a\n") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function gifSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 10) return null;
  const sig = bytes.subarray(0, 6).toString("ascii");
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 8 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    if (marker === 0xd8 || marker === 0xd9) {
      i += 2;
      continue;
    }
    const len = bytes.readUInt16BE(i + 2);
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc &&
      i + 8 < bytes.length
    ) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 30) return null;
  if (bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WEBP") return null;
  const kind = bytes.subarray(12, 16).toString("ascii");
  if (kind === "VP8X" && bytes.length >= 30) {
    const w = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
    const h = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
    return { width: w, height: h };
  }
  if (kind === "VP8 " && bytes.length >= 30) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (kind === "VP8L" && bytes.length >= 25) {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}
