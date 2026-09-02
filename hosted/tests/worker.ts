import worker, { createAuth, registrationClosed, type Env } from "../src/index.ts";

async function signCookie(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return encodeURIComponent(`${value}.${b64}`);
}

async function testLogin(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    email: string;
    name: string;
    image?: string | null;
    accountId?: string;
    accessToken?: string;
    refreshToken?: string;
    idToken?: string;
  };
  const accountId = body.accountId ?? crypto.randomUUID();
  const auth = createAuth(env);
  const ctx = await auth.$context;
  const existing = await env.DB.prepare(
    `SELECT userId FROM account WHERE providerId = 'google' AND accountId = ?`,
  )
    .bind(accountId)
    .first<{ userId: string }>();

  if (!existing && registrationClosed(env)) {
    return Response.json({ error: "Registration closed" }, { status: 403 });
  }

  let userId: string;
  let account: unknown = null;
  if (existing) {
    userId = existing.userId;
  } else {
    const created = await ctx.internalAdapter.createOAuthUser(
      {
        name: body.name,
        email: body.email,
        emailVerified: true,
        image: body.image ?? null,
      },
      {
        providerId: "google",
        issuer: "local:oauth:google",
        accountId,
        accessToken: body.accessToken ?? "google-access-token",
        refreshToken: body.refreshToken ?? "google-refresh-token",
        idToken: body.idToken ?? "google-id-token",
      },
    );
    if (!created?.user || !created.account) {
      return Response.json({ error: "Failed to create test user" }, { status: 500 });
    }
    userId = created.user.id;
    account = created.account;
  }
  const session = await ctx.internalAdapter.createSession(userId);
  const cookie = await signCookie(session.token, env.BETTER_AUTH_SECRET);
  const accounts = await env.DB.prepare(
    `SELECT accessToken, refreshToken, idToken FROM account WHERE userId = ?`,
  )
    .bind(userId)
    .all<{ accessToken: string | null; refreshToken: string | null; idToken: string | null }>();
  return Response.json(
    {
      user: { id: userId },
      account,
      stored: accounts.results,
    },
    {
      headers: {
        "set-cookie": `better-auth.session_token=${cookie}; Path=/; HttpOnly; SameSite=Lax`,
      },
    },
  );
}

async function testStats(env: Env): Promise<Response> {
  const count = async (table: string) => {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    return row?.n ?? 0;
  };
  const accounts = await env.DB.prepare(
    `SELECT accessToken, refreshToken, idToken FROM account`,
  ).all<{ accessToken: string | null; refreshToken: string | null; idToken: string | null }>();
  return Response.json({
    users: await count('"user"'),
    sessions: await count("session"),
    libraries: await count("libraries"),
    memberships: await count("library_memberships"),
    userAccess: await count("user_access"),
    accounts: accounts.results,
  });
}

async function testDisable(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { userId?: string };
  if (!body.userId) return Response.json({ error: "Missing userId" }, { status: 400 });
  await env.DB.prepare(`UPDATE user_access SET status = 'disabled', disabled_at = ? WHERE user_id = ?`)
    .bind(Date.now(), body.userId)
    .run();
  return Response.json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/__test/login") {
      return testLogin(request, env);
    }
    if (request.method === "POST" && url.pathname === "/__test/disable") {
      return testDisable(request, env);
    }
    if (request.method === "GET" && url.pathname === "/__test/stats") {
      return testStats(env);
    }
    return worker.fetch(request, env, ctx);
  },
};
