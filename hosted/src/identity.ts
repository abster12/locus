export interface RequestIdentity {
  userId: string;
  sessionId: string;
  libraryId: string;
  role: "owner";
}

export interface LibraryRow {
  id: string;
  name: string;
  role: "owner";
}

type Env = Cloudflare.Env;

type SessionLike = {
  user: { id: string };
  session: { id: string };
} | null;

export type IdentityResult =
  | { ok: true; identity: RequestIdentity; library: LibraryRow }
  | { ok: false; status: 401 | 403 | 404; error: "Unauthorized" | "Forbidden" | "Not found" };

export async function findLibrary(env: Env, userId: string): Promise<LibraryRow | null> {
  return env.DB.prepare(
    `SELECT l.id, l.name, m.role
       FROM library_memberships m
       JOIN libraries l ON l.id = m.library_id
      WHERE m.user_id = ?
      LIMIT 1`,
  )
    .bind(userId)
    .first<LibraryRow>();
}

async function readAccess(env: Env, userId: string): Promise<"active" | "disabled" | null> {
  const existing = await env.DB.prepare("SELECT status FROM user_access WHERE user_id = ?")
    .bind(userId)
    .first<{ status: "active" | "disabled" }>();
  return existing?.status ?? null;
}

export async function resolveIdentity(env: Env, session: SessionLike): Promise<IdentityResult> {
  if (!session) return { ok: false, status: 401, error: "Unauthorized" };

  const access = await readAccess(env, session.user.id);
  if (access === "disabled") return { ok: false, status: 403, error: "Forbidden" };
  if (access !== "active") return { ok: false, status: 404, error: "Not found" };

  const library = await findLibrary(env, session.user.id);
  if (!library) return { ok: false, status: 404, error: "Not found" };

  return {
    ok: true,
    identity: {
      userId: session.user.id,
      sessionId: session.session.id,
      libraryId: library.id,
      role: "owner",
    },
    library,
  };
}
