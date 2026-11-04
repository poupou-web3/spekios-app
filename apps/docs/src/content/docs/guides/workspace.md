---
{
  "title": "Use the workspace",
  "description": "Navigate Spekios’s run timeline, flow graph, evidence inspector, review filters, settings and theme.",
  "reviewed": "2026-11-01",
  "sidebar": {
    "order": 1
  }
}
---
The workspace helps a tester follow behavior. Operators of a Spekios deployment use a separate back office for execution and delivery; it is not part of the workspace and the workspace does not link to it.

## User workspace

Paste a URL on the workspace home and choose **Start testing**. The scheme is optional: `app.example.com` is tested as `https://app.example.com`. The line under the field shows whether Spekios is ready; **Change** opens screen size, sign-in and automatic rechecks. Follow the durable job and open its run. The timeline records each automated action with its expectation, outcome and assessment.

Use **Inspect action** to see exact typed parameters and linked evidence. Compare Before/After captures, open masks and sampled frames, and move between actions. The inspector preserves native image detail so small changes remain inspectable.

The **Flow** view shows states, transitions, frontier and planner decisions. Ranking scores describe selection order, not a measured probability of real-user behavior.

The run page shows input, output and total model tokens and an estimated cost; **Model usage** under the summary breaks them down by model. The run list shows the same for each run. See [estimate cost](../../getting-started/models/#estimate-cost).

## Findings and reviews

Filters help find runs and original candidates by review state. An independent replay is shown as evidence about the original action, not as a second unrelated bug.

Use [finding review](../findings/) to record a human conclusion and rationale. Export the selected run using [portable reports](../reports/).

## Settings and appearance

Settings has one page per section, listed beside the content (or as tabs on a narrow screen). Each has its own address, such as `/settings/limits`. Edits in any section stay until you save or discard them; the save bar names the sections with unsaved changes and links to any that need a fix.

- **Models:** your list of model IDs (several per provider if you like) with their input and output prices, the exploration and navigation models chosen from it, a model for each project, ranking reuse, and which providers the server can use. Credentials are never shown. A single test can also pick a project and its own model under the launch options; see [choose a model per project or per run](../../getting-started/models/#choose-a-model-per-project-or-per-run).
- **Exploration:** default viewport, exploration strategy and automatic rechecks.
- **Limits:** run limits and overrides for projects and models.
- **Memory & sessions:** app memory on or off, remembered apps you can forget, and saved app sessions with removal controls.
- **Appearance:** match your computer’s light or dark setting, or keep one theme in this browser. The same control sits in the top bar.

## Operator back office

The team running Spekios uses a separate back office for service readiness, the browser job queue, model requests and attempts, ordered events and read-only server configuration. Outbox counters there indicate delivery state; they are not direct health probes for every service.

## Configuration changes

Saving defaults creates a new revision without restarting. Existing jobs retain their original configuration. Edit keys and allowed origins in the private environment configuration and restart the services.

For queue, provider or storage problems, use [troubleshooting](../../operators/troubleshooting/).
