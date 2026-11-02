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

Production activated on 2 November 2026: `https://app.spekios.com/v1/auth-mode`
reports `{"mode":"spekios"}`. The enabled `spekios-app` bridge client has exactly
`https://app.spekios.com/auth/callback` and launch URL
`https://app.spekios.com/login`. The localhost client is unchanged. The existing
Lovable account page prefers the hosted client on computers, phones and tablets.

This checkout's ignored `.env.spekios.production` holds the five backend settings;
`infra/deploy/ansible/secrets.yml` contains the same settings and preserves the
existing provider configuration. The original deployment checkout at
`/Users/admin/Documents/coding/front-clause/infra/deploy/ansible/secrets.yml` also
has these settings, so later deployments retain them. All private files have mode
0600. Only the credential's SHA-256 hash was registered in Lovable. The backend
value and registered hash must stay paired; do not regenerate either in isolation.
The server's existing database/storage/operator/provider credentials were
preserved, its auth tables already existed, and initial activation recreated only
the API container. A private copy of the previous environment remains under
`/opt/scout/shared/.env.before-spekios-auth.*` for rollback.

## Production sign-in operations

For another deployment or a coordinated credential rotation:

1. Apply the private settings to the existing production environment,
   preserving database, storage, operator and provider credentials. Keep them in
   the secrets file used for future Ansible deployments as well.
2. Ensure migration `024-web-auth.sql` is applied. Recreate the API so Compose
   loads all five settings; a container restart alone does not reload its
   environment. No application data needs to move to Lovable.
3. Check `https://app.spekios.com/v1/auth-mode` reports `spekios`. Check `/login`
   redirects to the published `https://spekios.com/bridge/authorize` with client
   `spekios-app`, the exact HTTPS callback, random state and S256 challenge.
4. Enable the registered `spekios-app` client after verifying its credential hash
   matches the backend configuration. The existing Lovable account page prefers
   a configured hosted client, so **Open Spekios** will then use the production
   `/login` link on computers, phones and tablets. No frontend identity parameter
   or shared browser cookie is needed.
5. Complete a real signup/sign-in and Continue flow, sign out and back in, and
   check that the same account retains its workspace. Use a second account to
   verify that it gets a different workspace and cannot read the first account's
   project/run URLs. New accounts start empty; existing operator or local
   recordings are not automatically assigned to a new account.

The app derives identity only from the backend exchange. A user ID, email,
workspace ID or project ID supplied by the browser never grants account access.
Verification on 2 November 2026: all six `web_auth` tests passed with Rust 1.96,
including the lifecycle/isolation test against a disposable PostgreSQL container
that was removed afterwards. All 82 regular API library tests and 214
web/shared-UI tests also passed. Live checks
verified auth mode, the authorize redirect's pinned origin/client/callback and
S256 challenge, secure host-only HttpOnly login cookie, uncached responses, and
401 responses for anonymous `/v1/identity` and `/v1/runs` requests. The actual
production backend also authenticated to the published HTTPS token endpoint;
a deliberately invalid code returned `invalid_grant` with `no-store`, confirming
the client credential and server-to-server connectivity. A credential-free report
is saved at `artifacts/spekios-production-verification.json` (ignored). Real
provider consent and confirmation/reset email delivery still require user
verification.

Lovable's production browser test used two disposable pre-confirmed email
accounts. Both completed the real published sign-in form, hosted account launch,
authorize/Continue and app callback; the app's identity and run-list endpoints
returned 200 with the new secure app session. Repeated logins preserved each
workspace, and the two accounts received different workspaces. Anonymous identity,
runs, jobs and memory requests returned 401. A callback replay in a fresh browser
returned 400 without a session (the missing pre-auth cookie also rejects this
case). All six handoffs were hashed, 60-second codes marked consumed in Lovable.
This test did not exercise provider consent or email delivery. Disposable auth
accounts, app sessions, identity mappings and empty test workspaces were removed.

The browser test also found the logout confirmation form's `no-referrer` policy
caused a null Origin and a 403 rejection. The fix in
[PR #1](https://github.com/poupou-web3/front/pull/1) gives only that page a
`same-origin` policy and lets the security middleware preserve it. Missing, null
and foreign origins remain rejected, including null Origin with same-origin
fetch metadata. The API tests cover this regression.
The first fix was deployed through the original Ansible app playbook as production
commit `f550fff6409f0f9727844af1fec531467ca5eb4c`; public health, sandbox metadata
isolation and operator-console access checks passed. Live response checks confirm
`same-origin` only on the logout confirmation page and `no-referrer` on login,
callback and app pages. Live logout requests with null or foreign Origin still
return 403, even when claiming same-origin fetch metadata.
The next real browser test confirmed automatic sign-in navigation to `/account`,
successful handoff, a same-origin logout POST returning 303, and 401 when reusing
the revoked app cookie. It also exposed the browser enforcing `form-action`
against the hosted logout redirect. [PR #2](https://github.com/poupou-web3/front/pull/2)
adds only the configured identity provider's `/logout` URL to that page's policy;
without auth configuration, form targets remain self-only. All six auth tests,
including the disposable-database lifecycle test, passed again.
The final production revision is `f64ec388a7834b6a6ee88dd6d9c4bbf8dbbe7399`.
After deployment, a fresh Chrome session submitted the real sign-out form,
followed its 303 to `https://spekios.com/logout` (200), and displayed "You're
signed out" without CSP violations or aborted navigation. Anonymous app identity
access remained 401. This last redirect test needed no account or cleanup.

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

All responses are uncached. They use `Referrer-Policy: no-referrer`, except the
logout confirmation page uses `same-origin` so its form supplies the Origin
required by the CSRF check without sending referrers off-site. Do not enable
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
