# Demo credits and personal provider keys

The back office's **Demo credits** tab configures the shared Meta API key and a
lifetime allowance per account (default **$1**). The sponsored connection runs
only `muse-spark-1.3-contributor`. It starts disabled; the operator saves a key and
enables it. Raising or lowering the allowance preserves existing spending and
reservations. Disabling the demo never disables personal models or key management.

In **Settings → Models**, users see the demo connection and remaining credit
separately from **Your API keys**. A personal key has a provider and name; multiple
keys can belong to the same provider. The first becomes that provider's default.
Users can change the default or remove a key without revealing its value.
Adding a model without a usable key opens the named-key form, and the model stays
in the draft if the form is cancelled. Keys may also be added first.

An account default, navigation model, project model and individual test can each
choose a key. New projects receive an ID automatically; the editable agent ID is
under the advanced disclosure. Project settings override account defaults, and a
test can override the project's selection. A submitted job keeps the resolved
key reference. Removing that key blocks future dispatch through it instead of
silently switching to a different paid key. An already dispatched call can settle.

Demo exhaustion stops only demo-funded inference. Personal-key calls do not draw
from the demo balance, including calls to the same Meta model. The customer sees
the shared connection labeled **Spekios demo key**, never a pretend personal key.
Contributor mode permits Meta to use submitted content for training; the demo
card discloses this and links to [Meta's pricing and data-use documentation](https://dev.meta.ai/docs/pricing-rate-limits).

## Credential boundaries

`provider_keys` stores AES-256-GCM ciphertext, an idempotency fingerprint and safe
metadata. Authenticated encryption binds the record to its ID, scope, account,
workspace and provider. `SCOUT_PROVIDER_VAULT_KEY` is an independent 32-byte key
stored as 64 hex characters outside PostgreSQL. Local setup and deployment create
it once in the private `.env`; preserve it across replicas, restarts and releases.
Changing it requires re-encryption of existing records.

Creation accepts the secret once. Responses and listings return only names,
providers, IDs, default status and timestamps. Jobs and preferences contain opaque
references (`provider_key_id` in requests, `providerKeyId` in snapshots), not keys.
The gateway obtains the credential server-side and sends it only in the selected
provider's authentication header. Selected keys are rejected in prompts before
admission and redacted from provider responses before journals, evidence or usage
events are written. Endpoint overrides are not accepted.

Personal-key reads and writes are scoped to the authenticated account and
workspace. Agents cannot manage credentials or view key names or demo balances.
The shared key and allowance require the operator principal; a signed-in human
workspace manager cannot administer them. Existing environment keys remain an
operator/local-development facility and are not a fallback for hosted users.

## Budget enforcement

Before demo inference, the gateway sends the exact Responses body to Meta's
[input-count endpoint](https://dev.meta.ai/docs/api-reference/responses/count-input-tokens).
This counts input, media and server scaffolding without generating a response.
The gateway then reserves the noncached input cost plus the maximum output cost,
including reasoning within the output limit. Failure to count or reserve prevents
inference. User-entered prices never affect the sponsored allowance.

Amounts use integer microdollars, rounded upward. A PostgreSQL account-row lock
serializes reservations across runs and replicas. Each actual attempt has one
reservation keyed by its call ID. Settlement, model usage and the durable outbox
commit together. Known usage settles once and releases unused credit; uncertain
usage retains its reservation through crashes, recovery and cancellation. In-flight
credit cannot be spent by another call. A retry is a separate reserved attempt.
No provider fallback occurs when credit is insufficient.

The rate schedule is Meta Spark 1.3 Contributor's $0.10/M input, $0.20/M output
and $0.002/M cached input. Output usage includes reasoning; it is not added twice.
Provider-reported cost is used when present, otherwise reported token categories
use that schedule. The balance distinguishes spent credit from pending/uncertain
reservations. A small positive remainder may not cover the next input/output cap.

## API

| Endpoint | Access and behavior |
| --- | --- |
| `GET /v1/model-providers` | Own safe key metadata, scoped provider readiness and demo balance; agents receive readiness only |
| `POST /v1/provider-keys` | Human manager: `key_id`, `provider`, `name`, `api_key`, optional `make_default`; retrying the same ID and content does not create another key |
| `POST /v1/provider-keys/{id}/default` | Set an owned active key as its provider's default |
| `POST /v1/provider-keys/{id}/revoke` | Remove an owned key from future use |
| `GET /v1/admin/demo` | Operator-only configuration metadata; never returns the shared secret |
| `POST /v1/admin/demo` | Operator-only `expected_revision`, `enabled`, `allowance_usd`, fixed `model`, optional replacement `api_key` |

Preferences, project models, navigation models and per-run model choices accept
`provider_key_id` as a saved UUID or `demo`. Saving models and preferences does not
consume credit or require an inference request. Demo selection is validated again
at job/request admission, and credit/key revocation is fenced at actual dispatch.

## Verification

`just provider-access-test` uses a disposable PostgreSQL container, fake keys, and a
natively built API (it needs Docker and a Rust toolchain). It checks
encryption binding/tampering, multiple keys per provider, ownership isolation,
concurrent reservation limits, idempotent settlement, uncertain usage and personal
funding after demo exhaustion. Its real-browser pass covers the back-office form,
project/default selections, the model-first modal surviving refresh, key defaults,
revocation and browser-storage/response leakage. It makes no inference calls or
browser explorations; one test job is queued and cancelled with no worker. Screenshots and a credential-free report are written under
`artifacts/provider-access/` (ignored). A real Meta key is entered only in the
back office; no real key is needed for these checks.
