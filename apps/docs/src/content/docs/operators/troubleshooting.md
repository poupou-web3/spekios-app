---
{
  "title": "Troubleshoot a local run",
  "description": "Diagnose ScoutQA startup, target connectivity, provider availability, sign-in blockers, report conflicts, evidence failures and interrupted work.",
  "reviewed": "2026-10-28",
  "sidebar": {
    "order": 4
  }
}
---
Start by separating API health, job execution, target access and evidence delivery. They can fail independently.

## The workspace cannot connect

Check Docker is running and inspect:

~~~sh
docker compose ps
docker compose logs --tail=100 api browser-worker
~~~

The workspace is served at **http://127.0.0.1:18080**. Confirm token mode and local configuration. Do not paste logs containing private app data or tokens into a public issue.

## The API is healthy but exploration will not start

Check provider availability, selected model, the target’s exact allowed origin and queue capacity. Model configuration is separate from process health.

A missing provider or full queue can reject admission before a run exists. Read the job/progress response rather than looking only at recent runs.

## The browser cannot open my host app

The worker runs inside Docker. **localhost** refers to its container. Use a hostname reachable from Docker, make sure the app is listening on the intended interface and allow that exact scheme/host/port.

Do not loosen the allowlist to arbitrary targets to solve a hostname mismatch.

## The run is waiting for a person

Open the workspace’s private login handoff or choose public-only when offered. Unsupported external OAuth can remain blocked. Agent tools expose blocker metadata, not private control frames.

## The report changed during pagination

Restart from offset zero after the snapshot-conflict error. New actions, usage, evidence, replay or human review can change the report, including after browser completion.

## Evidence is missing or fails verification

Inspect the recorded availability and operations/outbox state. Preserve spool files and object-store data. The API refuses mismatched hashes or lengths; do not replace the expected hash to conceal a failure.

## The browser finished but the job failed

Inspect **execution_issues**. Manifest publication or event delivery can fail after browser work ends. The report retains the browser lifecycle and queue status separately.

## The process restarted

Recorded work remains inspectable. Interrupted actions and private inputs are not automatically replayed. Start fresh work intentionally with a new job UUID after checking the target state.

For deterministic integration checks, the repository provides **just agent-test**, **just explorer-test** and related fixture suites. These use simulated providers; some restart local services. Avoid running them over active work.
