# Spekios human authentication

Spekios is the public product name; `scout` remains the internal package and service name.
Lovable hosts the landing page and human sign-in (Google, Apple, email/password).
The Rust API owns the application session, the user/workspace mapping, settings and
QA data; no application data lives in Lovable.

Lovable project: https://lovable.dev/projects/a393e034-e3f2-4e09-9456-d2b48479023a

Sign-in is optional. With the five `SPEKIOS_*` settings empty, the API uses the
operator token (and, if enabled, the loopback development bypass). Code:
`apps/api/src/web_auth.rs`; schema: `infra/postgres/024-web-auth.sql`.

## Bridge clients

Two clients are registered in Lovable:

| Client | Callback | Use |
| --- | --- | --- |
| `spekios-local` | `http://localhost:18080/auth/callback` | Local development |
| `spekios-app` | `https://app.spekios.com/auth/callback` (launch URL `https://app.spekios.com/login`) | Production |

Lovable stores only the SHA-256 hash of each client secret. The backend secret
and its registered hash must stay paired; do not regenerate either on its own.
The Lovable account page prefers the hosted client, so **Open Spekios** goes to
the production `/login`.

## Configuration

| Setting | Meaning |
| --- | --- |
| `SPEKIOS_AUTH_ORIGIN` | Published HTTPS origin of the Lovable wrapper (`https://spekios.com`), without a path |
| `SPEKIOS_ISSUER` | `https://ctgxazkkspnsukrpjesw.supabase.co/auth/v1` |
| `SPEKIOS_CLIENT_ID` | `spekios-local` or `spekios-app` |
| `SPEKIOS_CLIENT_SECRET` | Backend-only client credential, 32–512 printable ASCII characters |
| `SPEKIOS_REDIRECT_URI` | Exact registered callback: localhost HTTP or production HTTPS |

Configure all five or leave all five empty; partial configuration fails startup.
Enabling Spekios auth always disables `SCOUT_DEV_AUTH_BYPASS`. Operator and agent
bearer credentials still work, and MCP never accepts a browser cookie. If
`SCOUT_PUBLIC_ORIGIN` is set, it must match the callback's origin; otherwise an
HTTPS callback supplies the pinned public origin.

## Local sign-in

Use the existing `.env` with its database and storage credentials; do not
generate replacement infrastructure credentials for an existing volume.

```sh
node scripts/setup-spekios-auth.mjs --auth-origin https://spekios.com --activate
```

The helper keeps the secret in the ignored, mode-0600 `.env.spekios.local`
(re-running it reuses the same secret), merges the five settings into `.env`,
sets `SCOUT_DEV_AUTH_BYPASS=false`, and writes the hash-only registration SQL to
`artifacts/spekios-local-registration.sql`. Apply that SQL in Lovable only when
registering a new installation or changing the callback. Without `--activate` it
prepares the files but leaves `.env` unchanged.

Then apply the schema and recreate the API so it reads the new `.env`:

```sh
just dev                       # applies every schema file, including 024-web-auth.sql
# or, on an already running stack:
bash scripts/apply-schemas.sh
just reload-env
```

A container restart alone does not reload its environment. Open
**http://localhost:18080** and choose **Sign in or create an account**. Use that
exact host: `localhost` and `127.0.0.1` are different cookie origins. Existing
recordings stay in the operator workspace; each new person gets a new private
workspace. No email-based account linking or transfer of old data happens.

Never paste passwords, provider tokens or the client secret into chat. Lovable's
managed consent screens may show Lovable branding.

## Production

Production settings live in the ignored `infra/deploy/ansible/secrets.yml` (see
`secrets.example.yml`) and are deployed with the rest of the environment; see
[infra/deploy/README.md](infra/deploy/README.md). For a new installation or a
coordinated credential rotation:

1. Put the five settings in `secrets.yml`, preserving the existing database,
   storage, operator and provider credentials.
2. Deploy with `just cloud-deploy --tags app`. The deploy applies the schemas
   and recreates the API with the new environment.
3. Check that `https://app.spekios.com/v1/auth-mode` reports `{"mode":"spekios"}`
   and that `/login` redirects to `https://spekios.com/bridge/authorize` with
   client `spekios-app`, the exact HTTPS callback, a random state and an S256
   challenge.
4. Enable the `spekios-app` client in Lovable after checking its credential hash
   matches the backend secret.
5. Sign up, sign in, sign out and back in, and confirm the account keeps its
   workspace. With a second account, confirm it gets a different workspace and
   cannot read the first account's project or run URLs.

## Protocol and security

1. `GET /login?next=...` accepts only local return paths (`/`, `/workspace`,
   `/settings`, `/connect`, `/issues` and issue pages). It creates a random state,
   PKCE verifier and opaque browser cookie; PostgreSQL holds the cookie/state
   hashes, verifier and return path for 10 minutes. The authorize redirect uses
   S256 PKCE and the configured client and callback.
2. Lovable authenticates the person and redirects the browser back with `code`
   and `state`. Only the browser needs to reach localhost; no tunnel is needed.
3. `GET /auth/callback` consumes the login attempt once, checks the cookie,
   state and expiry, then POSTs to the fixed `/api/public/bridge/token` endpoint
   on the auth origin with the client credential and PKCE verifier. It follows no
   redirects, waits at most 5 seconds and reads at most 16 KiB. Errors contain no
   codes, tokens or upstream bodies.
4. The backend checks `iss`, `aud`, `sub`, handoff ID and freshness. A unique
   `(issuer, subject)` maps to a local user and workspace. Email is contact data,
   never an identity key. Concurrent first logins are serialized in PostgreSQL.
   A user, email, workspace or project ID supplied by the browser never grants access.
5. A new random 12-hour session is created and only its hash is stored. A new
   login revokes the previous browser session. Cookies are HttpOnly and
   SameSite=Lax; over HTTPS they are Secure with `__Host-` names and no Domain.
6. Cookie-authenticated writes require the exact application Origin and reject
   cross-site fetches; every cookie request checks the pinned Host. Login and
   callback navigations may arrive cross-site and are protected by state and
   PKCE. Unknown return URLs, duplicate callback parameters and ambiguous
   cookies are rejected.
7. `GET /logout` shows a confirmation form; `POST /logout` revokes the session
   and any pending login, clears cookies and redirects to the auth origin's
   `/logout`. That page's CSP `form-action` allows only itself and that URL.

All responses are uncached and use `Referrer-Policy: no-referrer`, except the
logout confirmation page, which uses `same-origin` so its form sends the Origin
the CSRF check needs. Do not enable proxy access logging of callback query
strings or Cookie headers; the API does not log them. Expired login attempts and
sessions are purged at the next login.

Limits: there is no remote revocation hook. Deleting or disabling a Lovable
account, or signing out only on the Lovable account page, does not end an
already issued Spekios session before its 12-hour expiry.

## Tests

`just api-test` runs the configuration, Host/CSRF, PKCE, return-path, cookie and
identity-validation tests. The database lifecycle test (login binding, one-use
callbacks, stable workspace mapping, different subjects sharing an email,
session rotation and expiry, logout, and cookie rejection on MCP) uses a mock
bridge and real PostgreSQL. It is opt-in and **truncates** its auth and
workspace tables, so point it only at a disposable database, never the
application database. Set PGHOST/PGPORT/PGUSER/PGDATABASE/POSTGRES_PASSWORD for
that instance, then:

```sh
SPEKIOS_AUTH_TEST_DB=1 cargo test --manifest-path apps/api/Cargo.toml --lib web_auth -- --include-ignored
just web-test
```

These tests do not exercise real Google/Apple login or confirmation and reset
email delivery.
