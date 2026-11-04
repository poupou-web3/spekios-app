---
{
  "title": "Troubleshoot a local run",
  "description": "Diagnose Spekios startup, target connectivity, provider availability, sign-in blockers, report conflicts, evidence failures and interrupted work.",
  "reviewed": "2026-11-04",
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
docker compose logs --tail=100 api browser-worker browser-sandbox
~~~

The workspace is served at **http://127.0.0.1:18080**. Confirm token mode and local configuration. Do not paste logs containing private app data or tokens into a public issue.

## The API is healthy but exploration will not start

Check provider availability, the selected model and API key, demo credit and queue capacity. The line under the URL field names what is missing. Model configuration is separate from process health.

A missing provider or full queue can reject admission before a run exists. Read the job/progress response rather than looking only at recent runs.

## The browser cannot open my host app

The browser runs inside Docker, in the browser sandbox container, where **localhost** is that container. Spekios rewrites a loopback URL to **host.docker.internal**, which Docker Desktop provides; on other hosts, make sure that name resolves for containers. Make sure the app listens on an interface the container can reach, not only 127.0.0.1.

If the page loads but its API calls fail, the app probably calls another local or private origin. Add that exact origin to **SCOUT_ALLOWED_ORIGINS** and restart the services.

## Runs fail with “The browser sandbox is unavailable”

Check **docker compose ps browser-sandbox** and its logs. The worker waits up to 90 seconds for the sandbox, which restarts after every run. If Chromium cannot start its own sandbox on your host, some Linux hosts restrict unprivileged user namespaces. Set **SCOUT_CHROMIUM_SANDBOX=false** in the private .env and run **docker compose up -d browser-sandbox**. The container isolation still applies.

## The back office returns 502

After recreating only the **api** container, restart the back office with **docker compose restart backoffice**. Its proxy resolves the API address once at startup.

## The run is waiting for a person

Open **Activity** in the workspace and choose **Open private login**, or **Skip sign-in for this run**. Unsupported external OAuth can remain blocked. Agent tools expose blocker metadata, not private control frames.

## The report changed during pagination

Restart from offset zero after the snapshot-conflict error. New actions, usage, evidence, replay or human review can change the report, including after browser completion.

## Evidence is missing or fails verification

Inspect the recorded availability and operations/outbox state. Preserve spool files and object-store data. The API refuses mismatched hashes or lengths; do not replace the expected hash to conceal a failure.

## The browser finished but the job failed

Inspect **execution_issues**. Manifest publication or event delivery can fail after browser work ends. The report retains the browser lifecycle and queue status separately.

## The process restarted

Recorded work remains inspectable and the job is marked interrupted. Interrupted actions and private inputs are not automatically replayed. After checking the target state, choose **Continue exploration** or **Run again**, or submit a new job UUID from an agent.

For deterministic integration checks, the repository provides **just agent-test**, **just explorer-test** and related fixture suites. These use simulated providers; some restart local services. Avoid running them over active work.
