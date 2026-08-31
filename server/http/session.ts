import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locusHome, newId } from "../../db/open.ts";

export interface Install {
  sessionSecret: string;
  csrfSecret: string;
}

export function loadInstall(): Install {
  const dir = locusHome();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "install.json");
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Install;
    if (raw.sessionSecret && raw.csrfSecret) return raw;
  }
  const install: Install = {
    sessionSecret: randomBytes(32).toString("hex"),
    csrfSecret: randomBytes(32).toString("hex"),
  };
  writeFileSync(path, JSON.stringify(install, null, 2));
  return install;
}

export function sign(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function sessionCookie(install: Install): string {
  const id = newId();
  return `${id}.${sign(install.sessionSecret, id)}`;
}

export function validSession(install: Install, cookieHeader: string | undefined): string | null {
  const cookie = readCookie(cookieHeader, "locus_session");
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig || payload === "desk") return null;
  const expected = sign(install.sessionSecret, payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return payload;
}

export function csrfToken(install: Install): string {
  return sign(install.csrfSecret, "csrf:desk");
}

export function validCsrf(install: Install, token: string | undefined): boolean {
  if (!token) return false;
  const expected = csrfToken(install);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

export function allowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const ok = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    "127.0.0.1",
    "localhost",
    "[::1]",
  ]);
  return ok.has(host);
}

export function allowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return false;
  if (origin.startsWith("chrome-extension://")) return true;
  const ok = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
  return ok.has(origin);
}
