# Spekios human authentication

The public product is Spekios; Scout remains the internal package/service name.
Lovable hosts the landing page and human sign-in. Rust owns the application
session, user/workspace mapping, settings and QA data. No application database
migration to Lovable is needed.

Lovable project: https://lovable.dev/projects/a393e034-e3f2-4e09-9456-d2b48479023a

## Current status

Implemented: `/login`, `/auth/callback`, POST `/logout`, hosted-login UI,
host-only HttpOnly cookies, server-side sessions, immutable identity mapping,
PostgreSQL migration `024-web-auth.sql`, and a local credential setup helper.
The bridge client `spekios-local` is registered in Lovable with exactly
`http://localhost:18080/auth/callback`. Its secret is stored only in the ignored,
mode-0600 `.env.spekios.local`; Lovable receives only the SHA-256 hash.

The wrapper is published at https://spekios.com. The local configuration now
uses that origin, migration `024-web-auth.sql` has been applied to the local app
database, and the API was rebuilt/restarted successfully with Spekios auth enabled. The published token endpoint recognizes the registered client and
correctly rejects a deliberately invalid handoff code with `invalid_grant`.
The private preview is not a usable exchange origin (it returned HTTP 401).
Verified in a browser: http://localhost:18080 → hosted authorize page → the
Google/Apple/email sign-in form, with the local callback and PKCE request preserved.
Real Google/Apple login and the complete browser return still require a user test.

## Local sign-in configuration

Use this checkout's existing infrastructure `.env` with its original database
and worker credentials. Do not generate replacement infrastructure credentials
for an existing volume. The helper preserves all unrelated `.env` settings:

```sh
node scripts/setup-spekios-auth.mjs --auth-origin https://spekios.com --activate
```

This merges the five `SPEKIOS_*` settings into `.env` and disables the development
bypass. The secret remains private and is never printed. Re-running the helper
reuses the same secret. `artifacts/spekios-local-registration.sql` contains the
matching registration SQL (hash only); apply it in Lovable if preparing another
installation or changing the callback. This installation is already registered.

Apply the migration and rebuild only the API:

```sh
docker compose exec -T postgres psql -X -U scout -d scout -v ON_ERROR_STOP=1 < infra/postgres/024-web-auth.sql
docker compose up -d --build --no-deps api
```

Open **http://localhost:18080**, then choose **Sign in or create an account**.
Use that exact host: `localhost` and `127.0.0.1` are different cookie origins.
Existing local recordings remain in the original operator workspace; new people
receive a new private workspace. No email-based account linking or transfer of
old data happens automatically.

Google/Apple login and confirmation/reset email delivery still require a real
user browser test. Never paste passwords, provider tokens or the client secret
into chat. Lovable's managed consent screens may show Lovable branding.

## Configuration

| Setting | Meaning |
| --- | --- |
| `SPEKIOS_AUTH_ORIGIN` | Published HTTPS origin of the Lovable wrapper, without a path |
| `SPEKIOS_ISSUER` | `https://ctgxazkkspnsukrpjesw.supabase.co/auth/v1` |
| `SPEKIOS_CLIENT_ID` | `spekios-local` for this installation |
| `SPEKIOS_CLIENT_SECRET` | Generated backend-only client credential |
| `SPEKIOS_REDIRECT_URI` | Exact registered callback; localhost HTTP or production HTTPS |

Configure all five or leave all five empty. Partial configuration fails startup.
Enabling Spekios auth always disables `SCOUT_DEV_AUTH_BYPASS`, regardless of that
variable's old value. Existing operator and agent bearer credentials still work;
MCP never accepts a browser cookie. For production use a separate bridge client,
HTTPS callback, and secret. If `SCOUT_PUBLIC_ORIGIN` is set, its origin must match
the callback. Otherwise an HTTPS callback supplies the pinned public origin.

## Protocol and security

1. `GET /login?next=/connect` (or `/`, `/issues`, optionally with a fragment)
   generates a random state, verifier and opaque browser cookie. PostgreSQL holds
   the cookie/state hashes, verifier and approved local return path for 10 minutes.
   Its authorize redirect uses S256 PKCE and the configured client/callback.
2. Lovable authenticates the person and redirects the browser with `code` and
   `state`. Only the browser needs to reach localhost. No incoming tunnel is needed.
3. `GET /auth/callback` consumes the local attempt once, checks the browser cookie,
   state and expiry, then POSTs JSON to the fixed HTTPS
   `/api/public/bridge/token` endpoint. It passes the client credential and PKCE
   verifier, follows no redirects, waits at most five seconds, and bounds the
   response to 16 KiB. Errors contain no codes, tokens or upstream response bodies.
4. The backend checks `iss`, `aud`, `sub`, handoff ID and freshness. A unique
   `(issuer, subject)` maps to a local user and workspace. Email is contact data,
   never an identity join key. Concurrent first logins are serialized in PostgreSQL.
5. A new random 12-hour session is created; only its hash is stored. Successful
   login revokes the previous browser session. Local cookies are HttpOnly and
   SameSite=Lax; HTTPS uses Secure and `__Host-` names with no Domain attribute.
6. Cookie-authenticated API writes require the exact application Origin and reject
   cross-site fetches. All cookie requests check the pinned Host. Login/callback
   navigations permit cross-site arrival, protected by state and PKCE. Unknown
   return URLs, duplicate callback parameters and ambiguous cookies are rejected.
7. GET `/logout` shows a confirmation form; POST revokes local session and pending
   login, clears cookies, and sends the browser to the configured Lovable `/logout`.

All responses are uncached and use `Referrer-Policy: no-referrer`. Do not enable
proxy access logging of callback query strings or Cookie headers. The built-in
API does not log them. Pre-auth attempts expire after 10 minutes and sessions
expire absolutely after 12 hours. Expired records are purged at the next login.
No remote revocation webhook exists: deleting/disabling a Lovable account does
not immediately destroy an already issued Rust session. Lovable account-page
logout alone also does not destroy a Rust session. Shorter sessions or a remote
revocation hook can be added if needed.

## Verification

Rust tests cover configuration/host/CSRF fences, RFC 7636 PKCE, safe return paths,
cookie ambiguity and secure flags, pinned identity validation and fail-closed
unconfigured routes. The database-backed lifecycle test uses a mock bridge and
real PostgreSQL to check login state/cookie binding, one-use callbacks, stable
workspace mapping, different subjects sharing an email, session rotation and
expiry, logout, and rejection of browser cookies on MCP. It does not prove real
Google/Apple login or production Lovable deployment.

The destructive database test is opt-in; run it only against a **disposable**
PostgreSQL database, never the application database. It truncates its auth and
workspace tables. Supply PGHOST/PGPORT/PGUSER/PGDATABASE/POSTGRES_PASSWORD for that
disposable instance, then:

```sh
SPEKIOS_AUTH_TEST_DB=1 cargo test --manifest-path apps/api/Cargo.toml --lib web_auth -- --include-ignored
node --test apps/web/test/*.test.mjs packages/web-ui/test/*.test.mjs
```
