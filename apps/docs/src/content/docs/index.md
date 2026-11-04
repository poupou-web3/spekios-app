---
{
  "title": "Spekios documentation",
  "description": "Learn Spekios: URL-first web exploration, recorded evidence, human-reviewed findings, MCP tools and a self-hosted HTTP API.",
  "reviewed": "2026-11-04",
  "sidebar": {
    "order": 0
  },
  "template": "splash",
  "hero": {
    "title": "Explore a URL. Understand what broke.",
    "tagline": "From likely user paths to evidence you can inspect. Learn to run Spekios, review findings and give your coding agent useful feedback.",
    "actions": [
      {
        "text": "Run Spekios locally",
        "link": "getting-started/local-setup/",
        "icon": "right-arrow"
      },
      {
        "text": "Connect an agent",
        "link": "agents/connect/",
        "variant": "secondary"
      }
    ]
  }
}
---
Spekios explores your web app from a URL, checks each action against a recorded expectation, and gives people and coding agents the evidence to investigate what happened.

## Start with your next task

- **[Run Spekios locally](getting-started/local-setup/)** — Start the workspace, browser sandbox and storage services with Docker Compose.
- **[Test your first URL](getting-started/first-run/)** — Submit a site, follow the run and inspect its recorded actions.
- **[Connect a coding agent](agents/connect/)** — Use MCP or HTTP to submit work, return for a report and investigate a finding.
- **[Install the agent skill](agents/skill/)** — Give your agent a small, reusable Spekios workflow without adding an SDK.
- **[Integrate the API](api/overview/)** — Work with durable jobs, progress, reports and verified evidence.
- **[Operate the stack](operators/architecture/)** — Understand the services, data boundaries and recovery model.
- **[Read with an LLM](agents/machine-readable/)** — Use clean Markdown, the LLM index, OpenAPI and the generated tool catalog.

## What you can learn from a run

Every automated action has an intended result, an observed outcome and evidence IDs. A report connects those observations to a page, control and recorded path. A coding agent can use that context with its own repository access to investigate a fix.

An unchanged screenshot can still reveal a failure. A changed screenshot can be normal. Spekios assesses the behavior; image differences help locate where to look.

## Know the current scope

Spekios is a self-hosted developer preview. It tests any http or https address its browser can reach, including local and private apps, using Chromium in an isolated browser sandbox and API-key model connections. Explorations have no action limit unless you set one. A completed run is a recorded exploration, not a claim that the entire app works.

Read [capabilities and limits](product/capabilities/) before using it with a new target. The documentation reflects implemented behavior; proposed features are labeled explicitly.
