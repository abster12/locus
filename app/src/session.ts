export type LocusRuntime = "local" | "hosted";

export type SessionState =
  | {
      kind: "local-ready";
      csrfToken: string;
      library: { id: string; name: string };
    }
  | { kind: "hosted-signed-out" }
  | {
      kind: "hosted-ready";
      csrfToken: string;
      user: { id: string; name: string; email: string; image: string | null };
      session: { expiresAt: string };
      library: { id: string; name: string; role: "owner" };
    }
  | { kind: "hosted-access-denied" }
  | { kind: "load-failed" };

export const LOCAL_LIBRARY_LABEL = "Local account";
export const ACCOUNT_CALLBACK = "/";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export async function loadSession(runtime: LocusRuntime, fetcher: Fetcher = fetch): Promise<SessionState> {
  let res: Response;
  try {
    res = await fetcher("/api/session", { credentials: "same-origin" });
  } catch {
    return { kind: "load-failed" };
  }
  if (runtime === "hosted") {
    if (res.status === 401) return { kind: "hosted-signed-out" };
    if (res.status === 403) return { kind: "hosted-access-denied" };
  }
  if (!res.ok) return { kind: "load-failed" };
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { kind: "load-failed" };
  }
  return runtime === "hosted" ? parseHosted(data) : parseLocal(data);
}

export async function startGoogleSignIn(fetcher: Fetcher = fetch): Promise<{ ok: true; url: string } | { ok: false }> {
  try {
    const res = await fetcher("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ provider: "google", callbackURL: ACCOUNT_CALLBACK }),
    });
    const data: unknown = await res.json();
    if (!res.ok || !data || typeof data !== "object") return { ok: false };
    const url = (data as { url?: unknown }).url;
    if (typeof url !== "string" || !url) return { ok: false };
    return { ok: true, url };
  } catch {
    return { ok: false };
  }
}

export async function signOutHosted(fetcher: Fetcher = fetch): Promise<{ ok: true } | { ok: false }> {
  try {
    const res = await fetcher("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: "{}",
    });
    return res.ok ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function consumeCallbackError(url: URL, replace: (href: string) => void): boolean {
  const failed = url.searchParams.has("error") || url.searchParams.has("error_description");
  if (!failed) return false;
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  replace(`${url.pathname}${url.search}${url.hash}`);
  return true;
}

function parseLocal(data: unknown): SessionState {
  if (!data || typeof data !== "object") return { kind: "load-failed" };
  const rec = data as { csrf?: unknown; libraryId?: unknown };
  if (typeof rec.csrf !== "string" || !rec.csrf) return { kind: "load-failed" };
  if (typeof rec.libraryId !== "string" || !rec.libraryId) return { kind: "load-failed" };
  return {
    kind: "local-ready",
    csrfToken: rec.csrf,
    library: { id: rec.libraryId, name: LOCAL_LIBRARY_LABEL },
  };
}

function parseHosted(data: unknown): SessionState {
  if (!data || typeof data !== "object") return { kind: "load-failed" };
  const rec = data as {
    csrfToken?: unknown;
    user?: unknown;
    session?: unknown;
    library?: unknown;
  };
  if (typeof rec.csrfToken !== "string" || !rec.csrfToken) return { kind: "load-failed" };
  const user = parseUser(rec.user);
  const expiresAt = parseExpires(rec.session);
  const library = parseLibrary(rec.library);
  if (!user || !expiresAt || !library) return { kind: "load-failed" };
  return { kind: "hosted-ready", csrfToken: rec.csrfToken, user, session: { expiresAt }, library };
}

function parseUser(value: unknown): { id: string; name: string; email: string; image: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as { id?: unknown; name?: unknown; email?: unknown; image?: unknown };
  if (typeof rec.id !== "string" || !rec.id) return null;
  if (typeof rec.name !== "string") return null;
  if (typeof rec.email !== "string" || !rec.email) return null;
  if (rec.image !== null && typeof rec.image !== "string") return null;
  return { id: rec.id, name: rec.name, email: rec.email, image: rec.image };
}

function parseExpires(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const expiresAt = (value as { expiresAt?: unknown }).expiresAt;
  return typeof expiresAt === "string" && expiresAt ? expiresAt : null;
}

function parseLibrary(value: unknown): { id: string; name: string; role: "owner" } | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as { id?: unknown; name?: unknown; role?: unknown };
  if (typeof rec.id !== "string" || !rec.id) return null;
  if (typeof rec.name !== "string" || !rec.name) return null;
  if (rec.role !== "owner") return null;
  return { id: rec.id, name: rec.name, role: "owner" };
}
