# Local stack, model connections, and usage accounting

Design reviewed against official provider documentation on 21 October 2026. This is an implementation contract, not a claim that any model account is connected. See [Local infrastructure](./LOCAL_INFRASTRUCTURE.md) for the services and archive actually verified on this machine, and [Architecture](./ARCHITECTURE_AND_BUILD_PLAN.md) for delivery order.

## Technology decision

Implementation update, 22 October: API-key adapters for all three providers, screenshot-ID inputs, durable call records, token accounting and S3/ClickHouse export are implemented and tested against fake providers. Live-account verification, subscription adapters, streaming, monetary reservations and reconciliation remain pending. The [gateway guide](./MODEL_GATEWAY.md) distinguishes this working subset from the broader contract below.

Use **Rust with Axum/Tokio for the API and control plane**, including the model gateway and usage admission/settlement. Keep React/TypeScript for the UI and TypeScript/Playwright for browser control. Python remains an option for offline evaluation/training utilities, not an additional online service. This updates the earlier Node API recommendation at the user's request.

Rust gives us explicit concurrency and memory ownership, but no application benchmark establishes faster end-to-end runs than Node. Browser navigation, provider latency, image work and storage need separate measurement. Keeping Playwright avoids rewriting the browser tooling. The Rust API reads runs/captures and executes recorded model calls; autonomous browser work remains unfinished. [Axum documentation](https://docs.rs/axum/latest/axum/)

| Service | Responsibility | Persistence and failure behavior |
| --- | --- | --- |
| Rust API/control plane | URL-only admission, credential handoff, evidence access, progress, provider gateway | Reads authoritative state; does not keep a browser job inside an HTTP request |
| TypeScript browser worker | Execute typed actions, observe, capture; return evidence for assessment | One active attempt initially; durable leases and bounded concurrency later |
| PostgreSQL | Run state, capture relationships, task leases, usage ledger, outbox | Transactional source of truth; unique constraints make settlement idempotent |
| SeaweedFS S3 | Original screenshots, masks, structured payloads, manifests | Local `qa-evidence` bucket; persistent volume; immutable application object identities |
| ClickHouse | Searchable action/model events, timings, token and storage analytics | Replayable projection from the durable outbox; stable event IDs for deduplicated queries |
| OpenTelemetry collector, later | Trace and metric collection | Supplemental diagnostics; not the only copy of mandatory execution records |

Use **Docker Compose plus `just` for the default local loop**. Kubernetes is a deployment target, not a prerequisite for running this first machine. Add a kind-based parity environment once service contracts and worker isolation are stable; use the same OCI images, API Deployments, bounded worker Jobs, Secrets, resource limits, and persistent storage. A cluster adds its own networking, storage and lifecycle work; it does not make model calls faster. Do not migrate the existing evidence volumes implicitly. Redis remains optional after PostgreSQL leases prove insufficient. See [deployment decisions](./DEPLOYMENT_AND_DEVELOPMENT.md), [Docker single-server guidance](https://docs.docker.com/compose/how-tos/production/), [kind](https://kind.sigs.k8s.io/docs/user/quick-start/), and [just](https://just.systems/man/en/).

Use a small ClickHouse deployment first. Instrument with the OTel SDK and add the contrib collector when the application emits spans. Required actions and usage commit to PostgreSQL before asynchronous export, so exporter failure or telemetry queue overflow cannot erase the audit trail. Monitor backlog age and bytes; stop admitting new browser work before persistent storage fills. [ClickHouse and OpenTelemetry](https://clickhouse.com/docs/guides/use-cases/observability/build-your-own/integrating-opentelemetry)

## Connecting the user's models

Provider selection and authentication are saved once in local settings. Starting an exploration still needs only a URL. Keep model access credentials separate from credentials for the app being tested.

| Connection mode | Authentication and billing | Implementation choice |
| --- | --- | --- |
| OpenAI API | User's API key, API billing | Direct model adapter |
| OpenAI ChatGPT plan | Official Sign in with ChatGPT, eligible account/client, explicit plan-use consent | Separate local-app adapter and capability profile |
| Claude API | User's API key or supported cloud-provider credentials | Direct model adapter |
| Claude Code native runner | User signs in through the unmodified binary's supported flow | Optional runner adapter; preserves the native harness and authentication |
| OpenRouter | User's OpenRouter API key; free or paid routing chosen explicitly | Rust HTTP adapter; capability validation, free-only policy, returned-model/provider attribution |

**OpenRouter.** Support both explicit catalog models and `openrouter/free`. A `:free` suffix is valid only when the catalog lists that variant. Free-only mode permits only free routes/fallbacks and disables paid plugins; it never silently escalates to a paid model. Free models have variable availability and account limits. Fetch limits rather than hardcoding a promise of unlimited free testing. Pin a specific compatible free model for repeatable evaluations; the free router may choose a different compatible model between calls. Preserve both requested and returned model IDs. [Free variants](https://openrouter.ai/docs/guides/routing/model-variants/free), [free router](https://openrouter.ai/docs/guides/routing/routers/free-router), [limits](https://openrouter.ai/docs/api_reference/limits)

Require image input and the selected tool/structured-output capabilities before admitting a screenshot-driven action. Verify them with a completed inference, not just a catalog flag. Rate limiting pauses/retries within the run budget with a new attempt ID. A missing compatible free endpoint is an explicit unavailable state. OpenRouter and each downstream provider have distinct logging/training policies; apply the workspace's data-policy restrictions to routing. [Provider logging policies](https://openrouter.ai/docs/guides/privacy/provider-logging)

**OpenAI subscription development route.** The current documentation covers open-source and locally hosted apps; paid or remotely hosted offerings require a separate eligibility path. Eligible Plus/Pro users can authorize plan usage, but neither a subscription nor successful identity login alone proves this application's inference access. Keep the API-key option available. [Local-app overview](https://developers.openai.com/siwc/token-sharing-open-source), [Eligibility quickstart](https://developers.openai.com/siwc/quickstart)

Implement a loopback OAuth flow with PKCE, random state and nonce, ID-token validation, and a stable opaque installation ID. Persist the issued client ID per account/workspace registration. Request and check the plan-use grant in addition to identity scopes. Keep tokens in protected local storage, serialize refreshes, and redact all credentials from recordings. A restart must retain the installation identity. [Registration contract](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [Account/session handling](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)

Fetch the account-specific model catalog and validate the chosen model with a completed inference request. Use the public Responses API, with `store: false` and `stream: true`. Persist terminal completion or error; an accepted HTTP request is insufficient. Our browser tools execute locally and return structured results and screenshots. [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

This preview route supports model-compatible images and custom/function tools, but not native computer use, hosted MCP, or audio/video input. It also rejects `max_output_tokens` and several ordinary API parameters. The adapter must filter its request schema accordingly and send its own context history. A strict per-call output or dollar ceiling cannot be promised on that route; use call, time, concurrency, and provider quota limits, with visibly estimated cost. [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

**Claude subscription development route.** For our custom model loop, use Claude API or supported cloud credentials. Anthropic's SDK documentation does not authorize a third-party Claude account login as a generic API connection. [Claude Agent SDK authentication](https://code.claude.com/docs/en/agent-sdk/quickstart)

An optional native-runner mode can run the unmodified Claude Code binary, with the user authenticating through Anthropic's own flow and retaining the supported authentication choices. This has conditions under Anthropic's terms; it is not permission to extract or proxy subscription tokens into our custom client. Keep the binary's credentials under its control. [Claude Code product and credential conditions](https://code.claude.com/docs/en/legal-and-compliance)

The native runner is an architectural alternative: it chooses actions through our instrumented tool boundary. Validate that no alternative browser/HTTP path can act on the target without recording. If that cannot be enforced, the mode fails the evidence-completeness gate and stays unavailable for autonomous runs. Native-runner usage fields may differ from API fields; retain that distinction.

## Adapter and accounting contract

Each connection advertises tested capabilities: image input, structured output/tool schema support, streaming, cancellation behavior, maximum output enforcement, usage reporting, and authentication mode. Select a model from available account choices; record exact model identifiers rather than silently changing them between runs. Keep the agent policy, model gateway, and browser executor separate so no provider bypasses capture/check requirements.

Every model invocation creates a request record before dispatch:

| Group | Required fields |
| --- | --- |
| Identity | `model_request_id`, `workspace_id`, `user_id`, `connection_id`, `run_id`, `task_id`, `attempt_id`, optional `action_id`/`check_id` |
| Provenance | Provider, authentication/billing mode, requested/returned model, prompt/schema/tool versions, redacted input/output artifact references |
| Execution | Start/end time, latency, provider request/response ID, terminal state, retry ordinal, parent request, failure reason |
| Usage | Reported input/output totals, cached input and cache-write fields, reasoning/image detail where available, raw usage schema/version |
| Cost | Pricing snapshot/version, estimated API cost, provider-settled amount if supplied, currency, separate subscription/quota information |

Store missing usage as `null` with a reason, not zero. Normalize provider-specific totals carefully: some cache/reasoning fields are subsets, while others are billed categories. Preserve raw usage and test each adapter's normalization so displayed totals do not double-count. Do not derive image tokens from PNG file size. Subscription usage is not a dollar invoice and token totals cannot reveal an undisclosed plan-quota formula.

Settle each request once in PostgreSQL, including retries and calls that finish after cancellation. Do not release an in-flight reservation merely because the browser stopped. Export ledger events to ClickHouse with stable IDs; duplicate delivery must not increase the dashboard's totals. An ambiguous network failure remains usage-unknown until reconciled. Never hide it as a free failed request.

The first dashboard should answer: tokens by user/model/run/action; calls and retries; model, browser and image-processing latency; screenshot bytes stored; ClickHouse export lag; incomplete recordings; and estimated cost versus reported usage. Provider keys and authenticated target state never appear in these analytical rows.

## Every model call is observable

Record each actual provider attempt, including retries, validation failures, timeouts, rate limits, partial streams and cancellation. Use `model_call_id` for an attempt and `model_request_id` for its logical request, alongside trace/span, user, workspace, run, worker, action and check IDs. Save the request before dispatch, append received stream events with sequence numbers, and save the final response or explicit incomplete state. Keep provider-returned usage and generation IDs so unknown usage can be reconciled later.

| Store | Contents |
| --- | --- |
| PostgreSQL | Call lifecycle, budget reservation, authoritative usage/cost settlement, payload references, durable outbox |
| ClickHouse | Every call/event, status, retries, timing/first-token latency, requested/returned model and provider, token categories, cost, error, prompt/tool versions, redacted input/output text and searchable tool arguments/results |
| S3 bucket | Canonical request/response JSON, received streaming chunks, images and large tool payloads, hashes, redaction metadata and lineage |

ClickHouse is the inspection/query surface for calls and responses. Large/base64 multimodal bodies stay in S3; analytical rows carry resolvable artifact IDs. If searchable text is bounded, record its truncation and a full-payload reference rather than silently discarding the remainder. Never record authorization headers, API keys, refresh tokens, passwords or session cookies in prompts or telemetry. Excluding credentials is compatible with preserving the complete agent trajectory. Keep raw/reviewed labels separate and export only reviewed, eligible training examples.

The outbox exports immutable events; a versioned current-call projection supports one logical attempt per ID. Replaying export must not double-count tokens/cost. A failed ClickHouse export does not lose the call or release an unsettled budget. This contract applies to OpenRouter as well as direct OpenAI/Claude calls; its implementation follows the recorded-browser slice.

OpenRouter already stores request metadata, while its private input/output logging is opt-in. We should not depend on a vendor dashboard as our only audit trail. ClickHouse explicitly supports LLM prompt, response, tool and usage observability. These sources establish public behavior, not either vendor's internal database choices. [OpenRouter data collection](https://openrouter.ai/docs/guides/privacy/data-collection), [input/output logging](https://openrouter.ai/docs/guides/features/input-output-logging), [ClickHouse LLM observability](https://clickhouse.com/resources/engineering/llm-observability)

## Implementation acceptance

1. A user connects an eligible provider through its supported flow, chooses a model, and completes a screenshot-plus-tool round trip. No credential is printed or placed in an artifact.
2. One browser action links its model request, before/after captures, raw difference mask, assessment, and usage record through stable IDs.
3. Duplicate usage delivery settles once. Stop during inference preserves the eventual charge or explicit unknown status.
4. ClickHouse downtime leaves the action and usage ledger intact; export resumes without duplicate totals.
5. Provider quota exhaustion pauses dependent work and exposes the access issue. It does not silently switch to a separately billed connection.

These acceptance checks remain application work until executed. The infrastructure archive and standalone pixel comparison are useful first increments, not evidence that provider authentication or autonomous exploration already works.
