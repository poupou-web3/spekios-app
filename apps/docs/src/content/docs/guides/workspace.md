---
{
  "title": "Use the workspace",
  "description": "Navigate Spekios’s run timeline, flow graph, evidence inspector, review filters, settings and theme.",
  "reviewed": "2026-11-04",
  "sidebar": {
    "order": 1
  }
}
---
The workspace helps a tester follow behavior. Operators of a Spekios deployment use a separate back office for execution and delivery; it is not part of the workspace and the workspace does not link to it.

## User workspace

**/workspace** lists your projects: one per website origin, with findings to review, confirmed findings and tests. Each project has an **Overview**, **Tests**, **Issues & fixes** and **Project settings** (an optional PostHog connection). **Activity**, **Connect your agent** and **Settings** sit at the bottom of the sidebar; the account menu at the top right shows worker and model gateway status.

Paste a URL and choose **Start testing**. The scheme is optional: `app.example.com` is tested as `https://app.example.com`, and `localhost:3000` as `http://host.docker.internal:3000`. The line under the field shows whether Spekios is ready; **Change** opens screen size, sign-in, saved app session, project, model, API key and automatic rechecks. A new test opens its project, which follows the job to its run.

A run report has **Actions**, **Findings** and **Flow map** tabs. **Actions** records each automated action with its expectation, outcome and assessment. Open an action to see exact typed parameters and linked evidence. Compare Before/After captures, open masks and sampled frames, and move between actions. The inspector preserves native image detail so small changes remain inspectable.

The **Flow map** tab shows states, transitions, frontier and planner decisions. Ranking scores describe selection order, not a measured probability of real-user behavior.

The run page shows input, output and total model tokens and an estimated cost; **Model usage** under the summary breaks them down by model. The run list shows the same for each run. See [estimate cost](../../getting-started/models/#estimate-cost).

## Findings and reviews

**Tests** filters runs by status and data source; **Findings** filters original candidates by review state. An independent replay is shown as evidence about the original action, not as a second unrelated bug.

Use [finding review](../findings/) to record a human conclusion and rationale. Export the selected run using [portable reports](../reports/).

## Settings and appearance

Settings has one page per section, listed beside the content (or as tabs on a narrow screen). Each has its own address, such as `/settings/limits`. Edits in any section stay until you save or discard them; the save bar names the sections with unsaved changes and links to any that need a fix.

- **Models:** your list of model IDs (several per provider if you like) with their input and output prices, the exploration and navigation models chosen from it, a model for each project, ranking reuse, and which providers the server can use. Credentials are never shown. A single test can also pick a project and its own model under the launch options; see [choose a model per project or per run](../../getting-started/models/#choose-a-model-per-project-or-per-run).
- **Exploration:** default viewport, exploration strategy and automatic rechecks.
- **Limits:** run limits and overrides for projects and models.
- **Memory & sessions:** app memory on or off, remembered apps you can forget, and saved app sessions with removal controls.
- **Appearance:** match your computer’s light or dark setting, or keep one theme in this browser. The same control is in the account menu.

## Operator back office

The team running Spekios uses a separate back office for service readiness, the browser job queue, model requests and attempts, ordered runtime events, live service logs, provider connections and demo credits. Locally it runs at http://127.0.0.1:18083 and asks for **SCOUT_API_TOKEN**. Outbox counters there indicate delivery state; they are not direct health probes for every service.

## Configuration changes

Saving defaults creates a new revision without restarting. Existing jobs retain their original configuration. Personal API keys are managed under **Settings → Models**. Operator environment keys and **SCOUT_ALLOWED_ORIGINS** live in the private environment configuration; restart the services after changing them.

For queue, provider or storage problems, use [troubleshooting](../../operators/troubleshooting/).
