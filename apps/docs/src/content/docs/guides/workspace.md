---
{
  "title": "Use the workspace and back office",
  "description": "Navigate ScoutQA’s run timeline, flow graph, evidence inspector, review filters and operations console.",
  "reviewed": "2026-10-28",
  "sidebar": {
    "order": 1
  }
}
---
The workspace helps a tester follow behavior. The back office helps an operator understand execution and delivery. Both use the same local developer identity today; switching views does not grant a separate permission role.

## User workspace

Submit a URL, follow the durable job and open its run. The timeline records each automated action with its expectation, outcome and assessment.

Use **Inspect action** to see exact typed parameters and linked evidence. Compare Before/After captures, open masks and sampled frames, and move between actions. The inspector preserves native image detail so small changes remain inspectable.

The **Flow** view shows states, transitions, frontier and planner decisions. Ranking scores describe selection order, not a measured probability of real-user behavior.

## Findings and reviews

Filters help find runs and original candidates by review state. An independent replay is shown as evidence about the original action, not as a second unrelated bug.

Use [finding review](../findings/) to record a human conclusion and rationale. Export the selected run using [portable reports](../reports/).

## Back office

- **Operations:** service readiness, queue state and outbox delivery snapshots.
- **Model activity:** request/attempt records and scoped filters.
- **Usage:** nullable provider-reported tokens and cost.
- **Events:** ordered runtime and review observations.
- **Connections:** nonsecret exploration defaults and saved app-session metadata.

Outbox counters indicate delivery state. They are not direct health probes for every service.

## Configuration changes

Saving defaults creates a new revision without restarting. Existing jobs retain their original configuration. Edit keys and allowed origins in the private environment configuration and restart the services.

For queue, provider or storage problems, use [troubleshooting](../../operators/troubleshooting/).
