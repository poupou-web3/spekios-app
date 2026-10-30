---
{
  "title": "Explore your first URL",
  "description": "Submit a URL to ScoutQA, choose access and viewport settings, follow a durable run and inspect recorded actions and findings.",
  "reviewed": "2026-10-28",
  "sidebar": {
    "order": 2
  }
}
---
Start with a web app you control and a small action budget. You only need the URL; Scout infers likely user flows.

## Before submitting

Confirm the stack is ready, a provider key and model are configured, and the target origin is allowed. Prepare a dedicated test account if the app requires sign-in.

The target may change data when its controls are used. Use a development or staging app with disposable data.

## Start the run

1. Open the workspace at **http://127.0.0.1:18080**.
2. Paste the target URL.
3. Choose a **desktop**, **tablet** or **mobile** profile.
4. Choose whether to ask when sign-in is detected, sign in before exploration, or explore public pages.
5. Leave automatic rechecks off for the first run, then submit.

The UI creates a durable job. It follows the queue state into the recorded run. A pre-launch failure remains visible even if no browser run was created.

## Follow the observations

Open the timeline to inspect action parameters, the predicted outcome and the assessment. Use **Inspect action** for screenshots and artifacts. Compare Before/After and inspect the pixel-difference mask at native resolution.

The **Flow** view shows the recorded states and branch choices. The run summary shows its model token total; operators inspect individual model attempts and delivery state in the separate back office.

## Review a finding

A model suspicion is a candidate. Check whether the expectation matches your intended app behavior, inspect evidence and use fresh reproduction when appropriate. [Finding review](../../guides/findings/) explains confirmation and dismissal.

No findings in a bounded run does not prove that every flow works.

## Stop or return later

You can close the tab and return to the job. To stop work, use the explicit cancellation control. Closing a client or cancelling a network request does not cancel durable work.

If the app needs access, respond to the [private sign-in handoff](../private-apps/). Payment, external identity providers and unsupported interactions can leave a branch blocked.

## Share useful feedback

Use **Export report** for portable files, or let a coding agent retrieve the [structured report](../../agents/workflow/) and inspect evidence by ID.
