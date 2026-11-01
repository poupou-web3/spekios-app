# App login and session reuse

Implemented for the local queued browser worker on 24 October 2026. Start from a URL; when Scout detects a native login form or a visible sign-in option, the workspace offers a private manual login. The same test browser continues after the user signs in. No AI provider account is connected by this feature.

## User flow

1. Start an exploration from the workspace. **App access** offers **Ask when sign-in is detected** (default), **Sign in before exploration**, or **Public pages only**. A saved session can be selected explicitly for the matching app and execution mode.
2. Every waiting sign-in prompt presents **Open private login**, **Try creating an account**, **Skip sign-in for this run**, and **Cancel run**. Skipping switches the current run to public-only access and suppresses further sign-in prompts. When a login gate was reached from a public page, Scout blocks that control and reopens a previously observed public URL to continue other branches. If no public page is available, the run is blocked.
3. The private dialog displays a live image of the worker's browser. Click an app field, type or paste into the masked text box, and send the text. Tab/previous-field, Enter, Backspace and scrolling support native forms and verification-code entry. These are human controls, not model tools.
4. Finish signing in and choose **I'm signed in · continue testing**. Scout reloads the requested entry URL, requires a successful same-origin response and no recognized login form, and checks a visible sign-out control or changed app session state. The latter is labeled `human_confirmed_changed_app_session`; it is not proof of the user's role or every protected permission.
5. Optionally save the app session for reuse for 24 hours. The default is not to save it. Operations → Connections lists saved sessions and lets the user remove them.
6. If a recognized login gate reappears during exploration, Scout requests access again unless sign-in was skipped for this run. Old evidence remains; the planner starts a new account context and reopens the entry URL. It does not resume an old plan against a different account state.

The local worker has one browser and pauses during the handoff. An optional sign-in prompt waits for the user's login/public/cancel choice; it does not run a second public explorer concurrently. Requests expire after ten minutes. There are at most three handoffs per run and the existing browser/model budgets still apply. Cancelling a handoff cancels the run; expiry or unavailable access produces a blocked run. Process interruption closes the private browser and never replays human inputs.

## Private recording boundary

A first URL-navigation prediction may run before login detection, using only the submitted URL. Detection returns booleans, not form contents. Recognized native login forms are checked before screenshot/DOM capture. When an automated action reaches one, it retains its previous evidence and an explicit inconclusive observation gap. Private human login is not assessed as an automated product test.

Private display frames pass through the authenticated Rust API with `Cache-Control: no-store`. They are transient PNGs in memory and browser blob URLs; they never enter the evidence spool, bucket, ClickHouse payloads or model prompts. Closing the dialog revokes its displayed blob URL. Human text is sent only to the test browser and is cleared from the local entry box after sending. The worker serializes control, claims the window with a short-lived in-memory lease, and reserves input UUIDs before dispatch to prevent uncertain retries from typing twice.

Durable events record request/open/input-kind/completion/skip/cancel/expiry/interruption, IDs and verification method. Text values, passwords, codes, cookies, session tokens and raw login URLs are omitted. Normal screenshots and per-action assessment resume after login. This does not redact personal data that the authenticated app subsequently displays: use dedicated test accounts and test data.

Each authenticated segment has an opaque `auth_context_id`, included in its observations, actions and state fingerprints. Graph history keeps both contexts, but the planner discards old return routes at an account boundary. Fresh reproduction loads the exact saved session and replays only the selected authenticated segment. A run without a saved session cannot reproduce its authenticated path; expired/revoked sessions require a new signed-in run. Browser state does not reset server-side app data.

## Storage and API

PostgreSQL migration `008-browser-access.sql` adds access-request/session metadata and blocked/cancelled lifecycle values. Runtime access events use the existing durable ClickHouse outbox. Authentication material is stored separately from evidence, in the `auth-vault` Docker volume, using AES-256-GCM with app-origin/workspace/user/session/execution-mode associated data. Ciphertext and its local key have mode 0600; the directory has mode 0700. This is a local encrypted vault, not a hosted KMS: a host administrator with both files can decrypt it. Back up/secure this volume separately from training evidence.

Session snapshots include cookies, local storage and supported IndexedDB state. The API never returns them. Sessions are usable for at most 24 hours or until removed; app-side expiry can be earlier. Removal deletes the ciphertext and prevents future reuse. A browser that already loaded a session remains signed in until it closes. Expired files are cleaned when the worker starts; expiry is also enforced on every load. Session storage, passkeys and custom browser-bound authentication need additional support.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/browser-access` | Workspace-owned access requests and nonsecret session metadata |
| `GET /v1/browser-access/account-identity` | GUI-only verified email from the current user’s configured Lovable identity, scoped by issuer/user/workspace |
| `POST /v1/browser-access/:id/start` | Claim the private view using a client UUID; returns an in-memory control lease |
| `GET /v1/browser-access/:id/screen` | Current transient frame; requires the control lease |
| `POST /v1/browser-access/:id/input` | Bounded human input with an idempotency UUID; requires the lease |
| `POST /v1/browser-access/:id/create-account` | Explicit native signup attempt with `attempt_id`, test `email`, `name` and `remember`; requires the private lease |
| `POST /v1/browser-access/:id/complete` | Check the entry page and optionally retain its app session |
| `POST /v1/browser-access/:id/skip` | Skip a waiting login request and use public-only access for the rest of this run |
| `POST /v1/browser-access/:id/cancel` | Cancel a pending/active login and its run |
| `POST /v1/browser-sessions/:id/revoke` | Remove a saved session |

`POST /v1/browser-jobs` accepts optional `auth_mode: auto | sign_in | public` and `session_id` on exploration jobs. Public mode cannot load a session. IDs must belong to the local workspace/user, exact app origin, and live/simulated execution mode. The worker rechecks validity when loading. The private worker port is internal to Compose; all GUI access uses the existing workspace Bearer token. Keep this deployment on loopback; shared remote deployment requires its own TLS, per-user authorization and isolation work.

## Current compatibility limits

This first handoff supports admitted targets and same-origin native login forms, including manually supplied email/password and verification codes. Google/OAuth and external identity-provider redirects remain blocked; there is no embedded Google sign-in or transfer of the user's ordinary browser cookies. Google's supported-browser flow requires separate work and verification ([Google OAuth browser policy](https://developers.google.com/identity/protocols/oauth2/policies#browsers)).

Detection is heuristic: visible native password/one-time-code fields, email login forms, and sign-in/sign-out labels. Custom widgets, multilingual labels, passkeys, native popups and unusual authentication may not be detected or usable. **Sign in before exploration** explicitly requests the handoff when automatic detection is insufficient. The human can submit a login form; general model-driven form submission remains unsupported. Direct CLI exploration does not expose a manual-control server; launch interactive sign-in from the GUI/job worker.

Account creation is an explicit GUI action within the same private recording boundary. The private form defaults to the verified email from the signed-in Lovable identity, resolved server-side from the configured issuer and current user/workspace. The address stays editable and registration still requires the person’s action. Unverified or missing linked contact data is never silently reused; local/development access can supply a dedicated test email. This identity lookup is absent from the coding-agent tools and from run evidence. A bounded native-form driver generates an identity from the reviewed test email/name and a random password. It follows observed same-origin registration links, fills recognized identity/password fields and required terms checkboxes, and reserves each submission before dispatch. Repeating the same `attempt_id` reuses the attempt; a second attempt on that handoff is rejected. The worker yields its serialized browser lock between steps so cancellation remains available. A CAPTCHA, verification code, phone requirement, unsupported required field, validation failure or external provider returns control to the person. Automatic completion requires a successful same-origin entry response with a recognized sign-out control and no login form.

The private creation response returns generated credentials only to the lease holder for a private download. They never enter events, model prompts or ordinary evidence. A scope-bound AES-GCM copy is saved before registration in `<attempt_id>.account-sealed` in the auth vault, with file mode 0600. These account files are retained independently of the 24-hour session expiry; deleting a saved app session does not delete the account on the target app. Signup requests and their progress are identified by IDs and static status codes, with no field values in durable events. No email inbox is provisioned or polled.

## Verification

`just explorer-test` exercises private native login/code input, duplicate-input protection, failed completion, encrypted state, saved-session reuse, expiry mid-flow, context reset, authenticated reproduction, public-only blocking, optional skip, cancellation, timeout and revocation with a real Chromium browser and simulated models.

`just workspace-test` also drives the Rust proxy and queued worker, verifies private-frame/model-record boundaries, checks ClickHouse access events, and interrupts a pending login to verify recovery without replay. Its result is saved at `artifacts/browser-access/verification.json`. `just web-test` and `just web-contract-test` check GUI templates; visual GUI interaction and real Google/provider quality remain unverified.

The controlled demo target is `http://exploration-fixture:8082/auth/required` (or `/auth/optional` and `/auth/broken`). Its synthetic login is `qa@example.test`, password `fixture-only-password`, code `123456`; these are fixture constants, not real credentials. A model must still be configured for ordinary GUI exploration. Fixture suites use isolated simulated providers and restore normal provider mode afterward.
