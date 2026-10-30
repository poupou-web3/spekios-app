# Engineering notes

Internal design and operator notes for Scout QA. The published user guide is separate: [apps/docs](../apps/docs/README.md).

## Product

- [Architecture and build sequence](./product/architecture.md) — system shape, session loop, and delivery order
- [Requirements and data model](./product/implementation-plan.md) — behavior, schema, APIs, and acceptance checks
- [Product reference](./product/reference.md) — exploratory session, reports, triage, and later regression ideas

## Exploration

- [Run a URL](./exploration/overview.md) — what a bounded exploration records and where it stops
- [Planner](./exploration/planner.md) — likely next actions, changed controls, branch returns, viewports, and memory across runs
- [Browser interactions](./exploration/interactions.md) — text, dropdowns, checkboxes, radios, and scrolling
- [Action outcomes](./exploration/action-outcomes.md) — completion, form submission, and network/console evidence
- [Reproduction](./exploration/reproduction.md) — replay a suspect action in a fresh browser
- [Automatic reproduction](./exploration/automatic-reproduction.md) — optional bounded rechecks after an opted-in run
- [Cancellation](./exploration/cancellation.md) — stop queued or active work and keep evidence
- [Private login](./exploration/private-login.md) — manual sign-in and saved sessions
- [Finding reviews](./exploration/finding-reviews.md) — human confirmation, dismissal, and versioned labels

## Runtime and evidence

- [Browser runtime](./runtime/browser.md) — workers, isolation, recovery, and capacity
- [Evidence and training data](./runtime/evidence.md) — captures, masks, and what may be exported
- [Reports](./runtime/reports.md) — Markdown, JSON, and verified evidence ZIPs

## Platform

- [Local infrastructure](./platform/infrastructure.md) — services that are actually running, and how to verify them
- [Model connections](./platform/models.md) — providers, authentication modes, and token accounting
- [Model gateway](./platform/model-gateway.md) — connect a provider, submit a call, and inspect usage
- [Deployment](./platform/deployment.md) — local commands and the Kubernetes direction
- [Workspace](./platform/workspace.md) — user workspace and operations console

## Agents

- [MCP and HTTP interface](./agents/interface.md) — tools, authentication, and current limits
- [Control plan](./agents/plan.md) — what the first agent increment covers and what remains

## Reviews

- [29 October 2026 cleanup](./reviews/2026-10-29-cleanup.md)

## Code

- [Rust API](../apps/api/README.md)
- [Browser recorder](../packages/browser-runtime/README.md)
- [Pixel differences](../packages/image-diff/README.md)
- [Web workspace](../apps/web/README.md)
- [Back office](../apps/backoffice/README.md)
