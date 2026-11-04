---
{
  "title": "Explore your first URL",
  "description": "Submit a URL to Spekios, choose access and viewport settings, follow a durable run and inspect recorded actions and findings.",
  "reviewed": "2026-10-28",
  "sidebar": {
    "order": 2
  }
}
---
Start with a small action budget. You only need the URL; Spekios infers likely user flows. Any public https site works; a local or private app needs its origin allowed first.

## Before submitting

Confirm the stack is ready and a provider key and model are configured. For a local or private app, confirm its origin is allowed. Prepare a dedicated test account if the app requires sign-in.

Spekios acts like a user: it clicks, types and submits search or permitted test forms, so it can change data on the site. It skips recognized sign-out, payment and deletion controls. On an app with real data, prefer a test account.

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

If a test fails, is interrupted or cancelled, **Continue exploration** carries on from everything the test explored so far, starting on the page where it stopped. Its **Flow** tab keeps the earlier tree, with what was already tried on each screen. It does not repeat an action that was already sent to the browser, and it uses your current model and limits for the additional work. **Run again** starts a new test at the same address. A blocked test only offers **Run again**, because it still needs access. Both keep the original run and its evidence. The same controls appear as icons in **Recent tests**.

## Share useful feedback

Use **Export report** for portable files, or let a coding agent retrieve the [structured report](../../agents/workflow/) and inspect evidence by ID.
