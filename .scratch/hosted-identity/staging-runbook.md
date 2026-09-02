# Hosted identity staging runbook

Date: 2026-09-02

This runbook is for hosted identity ticket 04. It is deliberately operator-assisted: an agent can prepare and verify the code, but a person must authorize Cloudflare and Google Cloud access and supply real Google test identities.

Use placeholders literally as prompts to substitute known staging values. Never commit the substituted OAuth client, secrets, Cloudflare credentials, cookies, OAuth codes, or test-user emails.

## 0. Stop conditions

Do not deploy while any of these are true:

- `hosted/wrangler.jsonc` has `database_id = 00000000-0000-0000-0000-000000000000` for staging.
- staging `BETTER_AUTH_URL` begins with `http://localhost` or differs from the final staging origin.
- the staging Google OAuth redirect URI differs by scheme, host, path, case, or trailing slash from `<staging-origin>/api/auth/callback/google`.
- Rate Limiting enforcement, centralized security headers, structured redacted logging, Worker tests, typecheck, or deploy dry-run are incomplete.
- fewer than two Google identities are available for isolation testing. Three are required for the complete registration-closed matrix.

## 1. Authenticate and identify the staging origin

From `hosted/`:

```sh
npx wrangler whoami
```

If no intended Cloudflare account is shown, the operator runs `npx wrangler login` and approves the browser flow, then reruns `whoami`. Do not proceed under an unexpected account.

The staging environment creates the Worker `locus-identity-staging`. This account's selected free origin and callback are:

```text
STAGING_ORIGIN=https://locus-identity-staging.abhigyan0987.workers.dev
STAGING_CALLBACK=https://locus-identity-staging.abhigyan0987.workers.dev/api/auth/callback/google
```

These are documentation placeholders, not shell variables required by later commands.

## 2. Create and bind the dedicated staging D1 database

Create it once:

```sh
npx wrangler d1 create locus-identity-staging
```

Copy the returned database id into only the `env.staging.d1_databases` entry in `hosted/wrangler.jsonc`. The binding is `DB`, the database name is `locus-identity-staging`, and `migrations_dir` is `migrations`. Do not change the local binding to point at staging and do not reuse a production id.

Run the repository check after editing configuration:

```sh
npm run check
```

## 3. Create the dedicated Google OAuth web client

In the intended Google Cloud project:

1. Configure the OAuth consent screen/test-user policy appropriate for staging.
2. Create a Web application OAuth client named clearly for Locus staging.
3. Add the exact authorized redirect URI `STAGING_CALLBACK` from step 1.
4. If the console requests an authorized JavaScript origin, use the exact `STAGING_ORIGIN`.
5. Keep the client id and client secret out of source and ticket comments.

Google requires an exact redirect URI match. Better Auth constructs this callback from `BETTER_AUTH_URL`, so the checked-in staging value and Google configuration must agree before deploy.

## 4. Set staging secrets

The four staging secrets are independent and environment-specific:

```sh
npx wrangler secret put BETTER_AUTH_SECRET --env staging
npx wrangler secret put CSRF_SECRET --env staging
npx wrangler secret put GOOGLE_CLIENT_ID --env staging
npx wrangler secret put GOOGLE_CLIENT_SECRET --env staging
```

Paste values only into Wrangler's hidden prompt. Generate the Better Auth and CSRF secrets independently with at least 32 random bytes. Do not place them in `vars`, `.dev.vars`, shell history, command arguments, screenshots, or logs.

## 5. Apply and verify migrations

Preview the target and pending migrations first:

```sh
npx wrangler d1 migrations list locus-identity-staging --remote --env staging
```

Apply them to the named staging database:

```sh
npx wrangler d1 migrations apply locus-identity-staging --remote --env staging
```

Run `list` again. It must report no pending migrations. Apply again only to verify that Wrangler reports no migrations to apply; do not edit or rerun old SQL files manually.

## 6. Deploy and perform unauthenticated checks

```sh
npx wrangler deploy --env staging
```

Confirm the deployment URL exactly matches `BETTER_AUTH_URL`, then check:

```sh
curl -sS -D - https://locus-identity-staging.<workers-subdomain>.workers.dev/api/health -o /dev/null
curl -sS -D - https://locus-identity-staging.<workers-subdomain>.workers.dev/ -o /dev/null
```

Record header names and statuses, not values that contain identity or session material. Verify HTTPS, CSP/frame protection, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS where intended, and `Cache-Control: no-store` on authenticated/session responses.

## 7. Verify open registration, persistence, and isolation

Use separate clean browser profiles.

1. User A signs in with Google, records its Library id privately, signs out, signs in again, and receives the same Library.
2. User B signs in and receives a different Library, then repeats sign-out/sign-in.
3. Restart/redeploy the same Worker without changing bindings; A and B still receive their original Libraries.
4. A requests B's proof-resource Library URL and B requests A's. Both receive `404`.
5. Mutation probes use the current session CSRF token; missing/stale CSRF and wrong Origin fail.

Do not paste Library, user, session, cookie, or CSRF values into ticket comments.

## 8. Close and reopen registration

Keep users A and B registered. Before closing, confirm user C has never signed into this staging database.

Change only `env.staging.vars.REGISTRATION_MODE` from `open` to `closed`, deploy with `--env staging`, and verify:

1. A and B can still sign in and recover the same Libraries.
2. C receives the generic registration-closed result and no accessible Library.
3. No client request can override the mode.

Change the checked-in staging value back to `open`, deploy again, and verify C can now register. The submitted challenge environment must remain open and free through September 21, 2026 at 5:00 pm PDT unless the documented emergency alternative is activated.

## 9. Disable and re-enable a user

Use the display-safe Better Auth user id from that user's authenticated session response. Do not identify the user by putting an email address in shell history.

Disable:

```sh
npx wrangler d1 execute locus-identity-staging --remote --env staging --command="UPDATE user_access SET status = 'disabled', disabled_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE user_id = '<USER_ID>'"
```

The affected user's already-issued cookie must receive `403` on `/api/session` and every private proof route. Other users remain active.

Re-enable only when intended:

```sh
npx wrangler d1 execute locus-identity-staging --remote --env staging --command="UPDATE user_access SET status = 'active', disabled_at = NULL WHERE user_id = '<USER_ID>'"
```

After either command, use a count-only query or the user's request outcome to confirm the change. Do not print full `user_access` rows in shared output.

## 10. Verify token non-retention without exposing tokens

Run only an aggregate query:

```sh
npx wrangler d1 execute locus-identity-staging --remote --env staging --command="SELECT COUNT(*) AS retained_google_tokens FROM account WHERE accessToken IS NOT NULL OR refreshToken IS NOT NULL OR idToken IS NOT NULL"
```

The count must be zero after first and repeated logins. Never select the token columns themselves.

## 11. Verify rate limits and redacted logs

Use the checked-in test procedure to trigger allowed traffic and then a bounded number of rejected requests until the documented `429` response occurs. Do not stress OAuth provider endpoints or use unbounded loops.

Inspect staging logs in Cloudflare Workers Logs or with:

```sh
npx wrangler tail --env staging
```

Verify expected route/status/correlation metadata is useful while complete emails, cookies, authorization headers, OAuth codes, token values, secrets, and raw D1 rows are absent. Search using known harmless marker values generated for the test; do not paste real credentials into requests merely to test redaction.

## 12. Record sanitized evidence

Ticket 04's `## Answer` may contain:

- staging hostname;
- D1 database name and only a short id suffix;
- applied migration names;
- deployment version and UTC verification time;
- pass/fail outcomes for A/B/C, restart, isolation, disable, headers, rate limits, token-null count, and log search.

It must not contain emails, Google account names, complete user/Library/session ids, cookies, OAuth URLs/codes, CSRF tokens, secret values, or raw database rows.

## References

- Cloudflare Wrangler environments and environment-specific secrets: https://developers.cloudflare.com/workers/wrangler/environments/
- Cloudflare D1 Wrangler commands and remote migrations: https://developers.cloudflare.com/d1/wrangler-commands/
- Cloudflare Worker Rate Limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Cloudflare Workers Logs: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- Cloudflare security-header example: https://developers.cloudflare.com/workers/examples/security-headers/
- Google OAuth web-server redirect URI rules: https://developers.google.com/identity/protocols/oauth2/web-server
- Better Auth Google callback and `BETTER_AUTH_URL`: https://better-auth.com/docs/beta/authentication/google
