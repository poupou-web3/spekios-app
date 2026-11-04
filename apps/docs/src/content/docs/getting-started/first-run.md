---
{
  "title": "Explore your first URL",
  "description": "Submit a URL to Spekios, choose access and viewport settings, follow a durable run and inspect recorded actions and findings.",
  "reviewed": "2026-11-04",
  "sidebar": {
    "order": 2
  }
}
---
You only need the URL; Spekios infers likely user flows. Any http or https address the browser can reach works, including a local or private app. Explorations have no action limit by default, so consider a small **Maximum actions** in **Settings → Limits** for a first run.

## Before submitting

Confirm the stack is ready and a model and API key are chosen in **Settings → Models**. The line under the URL field says **Ready** when the browser worker and model gateway are available. Prepare a dedicated test account if the app requires sign-in.

Spekios acts like a user: it clicks, types and submits search or permitted test forms, so it can change data on the site. It skips recognized sign-out, payment and deletion controls. On an app with real data, prefer a test account.

## Start the run

1. Open the workspace at **http://127.0.0.1:18080**.
2. Paste the target URL. The scheme is optional: a bare host opens as https, and `localhost` or a `name:port` address as http. A loopback address opens as `host.docker.internal`, because the browser runs in Docker.
3. Select **Change** under the field. Choose a **Desktop**, **Tablet** or **Mobile** screen size and a sign-in mode: **Ask when sign-in is detected**, **Sign in before testing** or **Public pages only**. You can also pick a saved app session, project, model and API key here.
4. Leave **Automatically recheck suspected bugs** off for the first run, then choose **Start testing**.

The UI creates a durable job. It follows the queue state into the recorded run. A pre-launch failure remains visible even if no browser run was created.

## Follow the observations

The **Actions** tab lists each action with its parameters, predicted outcome and assessment. Open an action for its screenshots and artifacts. Compare Before/After and inspect the pixel-difference mask at native resolution.

The **Flow map** tab shows the recorded states and branch choices. The run summary shows input, output and total tokens and an estimated cost; operators inspect individual model attempts and delivery state in the separate back office.

## Review a finding

A model suspicion is a candidate. Check whether the expectation matches your intended app behavior, inspect evidence and use fresh reproduction when appropriate. [Finding review](../../guides/findings/) explains confirmation and dismissal.

No findings in a bounded run does not prove that every flow works.

## Stop or return later

You can close the tab and return to the job. To stop work, use the explicit cancellation control. Closing a client or cancelling a network request does not cancel durable work.

If the app needs access, respond to the [private sign-in handoff](../private-apps/) from **Activity**. Payment, external identity providers and unsupported interactions can leave a branch blocked.

If a test fails, is interrupted or cancelled, **Continue exploration** carries on from everything the test explored so far, starting on the page where it stopped. Its **Flow map** tab keeps the earlier tree, with what was already tried on each screen. It does not repeat an action that was already sent to the browser, and it uses your current model and limits for the additional work. **Run again** starts a new test at the same address. A blocked test only offers **Run again**, because it still needs access. Both keep the original run and its evidence. The same controls appear as icons in **Recent tests**.

## Share useful feedback

Use **Export report** for portable files, or let a coding agent retrieve the [structured report](../../agents/workflow/) and inspect evidence by ID.
