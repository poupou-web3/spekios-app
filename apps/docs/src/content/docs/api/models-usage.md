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

Usage belongs to the authenticated workspace and includes provider-reported tokens and cost, with **by_agent** subtotals for submitted browser work. Missing fields remain null/unknown. Retries and late responses remain attributable to their original request/attempt.

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

Prompt bytes are limited to 32768; optional system text to 16384. Output-token bounds are 1–4096 and attempt bounds 1–3. Optional evidence links are **run_id**, **action_id** and up to two distinct **capture_ids**; action/capture links require a run.

This gateway request does not execute browser actions. API keys stay server-side.

## Save exploration defaults

Workspace managers read **GET /v1/exploration-settings**, then POST the complete new preference set to the same path.

Use a fresh **request_id**, the current **expected_revision**, provider, model, **max_actions**, **viewport_profile**, **free_only**, **auto_reproduce**, **max_auto_reproductions** and **max_auto_replay_actions**.

The default revision is zero until the first saved preference. Action bounds are 1–12; auto-reproduction case bounds 1–3; total replay-action bounds 1–24.

A new save returns 201; an identical retry 200. Revision conflicts return 409. New jobs freeze the effective revision; existing jobs and retries do not adopt later defaults.

The preferences endpoint cannot change provider keys, allowed origins or test-form rules.
