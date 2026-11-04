# Engineering notes

Internal design and operator notes for Spekios. The published user guide is separate: [apps/docs](../apps/docs/README.md).

## Product

- [Architecture](./product/architecture.md) — components, the run flow, the rules the code keeps, and what is not built yet

## Exploration

- [Run a URL](./exploration/overview.md) — what an exploration records, its settings, and where it stops
- [Planner](./exploration/planner.md) — ranking next actions, strategies, model cost, and memory across runs
- [Browser interactions](./exploration/interactions.md) — text, dropdowns, checkboxes, radios, and scrolling
- [Action outcomes](./exploration/action-outcomes.md) — completion, form submission, and network/console evidence
- [Computer use](./exploration/computer-use.md) — Meta computer-tool recovery when native controls run out
- [Reproduction](./exploration/reproduction.md) — replay a suspect action in a fresh browser
- [Automatic reproduction](./exploration/automatic-reproduction.md) — optional bounded rechecks after a run
- [Cancellation](./exploration/cancellation.md) — stop queued or active work and keep evidence
- [Private login](./exploration/private-login.md) — manual sign-in and saved sessions
- [Finding reviews](./exploration/finding-reviews.md) — human confirmation, dismissal, and versioned labels
- [Triage and rechecks](./exploration/triage.md) — bug, intended behavior and duplicate decisions, deployment rechecks from CI
- [Larchwood, a shop with known bugs](./exploration/bug-lab.md) — measure what an exploration finds, misses and wrongly flags

## Runtime and evidence

- [Browser runtime](./runtime/browser.md) — workers, sandboxes, isolation, and recovery
- [Evidence](./runtime/evidence.md) — captures, storage layout, and training labels
- [Reports](./runtime/reports.md) — Markdown, JSON, and verified evidence ZIPs

## Platform

- [Local stack](./platform/infrastructure.md) — requirements, start, services, and common commands
- [Deployment](./platform/deployment.md) — one-host deploy and public HTTPS
- [Model gateway](./platform/model-gateway.md) — providers, calls, and usage accounting
- [Provider access](./platform/provider-access.md) — personal keys and demo credits
- [Workspace](./platform/workspace.md) — user workspace and back office
- [Service logs](./platform/logs.md) — container output in the back office
- [PostHog journeys](./platform/posthog.md) — import recorded sessions and validate flows
- [Spekios sign-in](../SPEKIOS_AUTH.md) — hosted human login

## Agents

- [MCP and HTTP interface](./agents/interface.md) — tools, authentication, and limits

## Code

- [Rust API](../apps/api/README.md)
- [Browser runtime](../packages/browser-runtime/README.md)
- [Pixel differences](../packages/image-diff/README.md)
- [Web workspace](../apps/web/README.md)
- [Back office](../apps/backoffice/README.md)
- [Agent CLI](../packages/cli/README.md)
- [Production deployment](../infra/deploy/README.md)
