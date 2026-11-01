---
{
  "title": "Models, usage and settings API",
  "description": "Inspect provider availability, submit bounded model requests, read nullable usage and save revisioned Scout exploration defaults.",
  "reviewed": "2026-10-29",
  "sidebar": {
    "order": 7
  }
}
---
The gateway records durable model requests and attempts. Its public configuration responses describe availability without returning provider keys.

## Read providers and usage

~~~text
GET /v1/model-providers
GET /v1/usage
GET /v1/operations
GET /v1/capabilities
~~~

Usage belongs to the authenticated workspace and includes provider-reported tokens and cost. Input and output tokens are counted apart (**known_input_tokens**, **known_output_tokens**) and added up in **known_total_tokens**. **by_model** repeats those counts and the reported cost for each provider and model, and **by_agent** for submitted browser work. A run report's **model_usage** and each run in **GET /v1/runs** carry the same fields for that run. Missing fields remain null/unknown, so a total covers only reported tokens. Retries and late responses remain attributable to their original request/attempt.

Operations is a human manager/operator route. It exposes delivery and queue snapshots. These are not substitutes for direct service health probes.

## Submit a direct model request

**POST /v1/model-requests** is a trusted operator/worker route. Agents start browser jobs instead of submitting raw inference. It accepts a strict JSON body:

~~~json
{
  "request_id": "00000000-0000-4000-8000-000000000002",
  "provider": "openrouter",
  "model": "openrouter/free",
  "prompt": "Describe the visible result.",
  "max_output_tokens": 1024,
  "max_attempts": 2,
  "free_only": true
}
~~~

The request is asynchronous: new admission returns 202, an identical retry 200. Read **GET /v1/model-requests/{request_id}** afterward.

Prompt bytes are limited to 65536; optional system text to 16384. This route accepts request bodies up to 192 KiB. Output-token bounds are 1–4096 and attempt bounds 1–3. Optional evidence links are **run_id**, **action_id** and up to two distinct **capture_ids**; action/capture links require a run.

This gateway request does not execute browser actions. API keys stay server-side. Supported providers are `openai`, `anthropic`, `openrouter` and `meta`. Meta uses the Responses API and model IDs such as `muse-wonder-1.0`.

## Save exploration defaults

Workspace managers read **GET /v1/exploration-settings**, then POST the complete new preference set to the same path.

Use a fresh **request_id**, the current **expected_revision**, provider, model, **viewport_profile**, **free_only**, **auto_reproduce**, **max_auto_reproductions** and **max_auto_replay_actions**. The optional boolean **app_memory** defaults to true. The limits **max_actions**, **max_minutes**, **max_tokens** and **max_cost_usd** are optional; absent or null means no limit. **stop_after_idle_actions** defaults to 50; null turns it off. **limit_overrides** lists limits for a **project_id**, **provider**, **model** or a combination; see [exploration limits](../../guides/exploration-limits/). The optional **saved_models** is the settings page's model list: up to 30 entries of **provider**, **model** and an optional **label** (up to 60 characters), each provider and model ID once, and optional **input_usd_per_million** and **output_usd_per_million** prices (0–10,000 US dollars per million tokens) that the workspace uses to estimate cost. Jobs do not freeze it.

The default revision is zero until the first saved preference. Action limits are 1–10,000, minutes 1–10,080, tokens 1,000–1,000,000,000, cost 0.01–100,000 USD; auto-reproduction case bounds 1–3; total replay-action bounds 1–100. A job freezes the limits resolved for its project and model at admission.

A new save returns 201; an identical retry 200. Revision conflicts return 409. New jobs freeze the effective revision; existing jobs and retries do not adopt later defaults.

The preferences endpoint cannot change provider keys, allowed origins or test-form rules.

## App memory

**GET /v1/app-memory** lists up to 100 remembered scopes for the caller, newest first. Each scope is one origin, viewport profile, sign-in state and execution mode, with run, page and tried/untried control counts and **in_use** while an active run uses it.

**POST /v1/app-memory/{scope_id}/forget** with an empty JSON body deletes that scope's derived pages and controls and returns 200. Runs and evidence are unchanged. An unknown scope returns 404; a scope in use returns 409 **memory_scope_in_use**.

An exploration job (**POST /v1/browser-jobs** with kind **explore**, or the **scout_start_exploration** tool) accepts an optional boolean **app_memory** that overrides the saved default for that run. While the gateway uses simulated models, omitted **app_memory** means off. Reproduction and fix-verification jobs reject it; they never use memory. See [explore deeper across runs](../../guides/app-memory/).
