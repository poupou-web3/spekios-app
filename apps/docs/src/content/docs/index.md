---
{
  "title": "ScoutQA documentation",
  "description": "Learn ScoutQA: URL-first web exploration, recorded evidence, human-reviewed findings, MCP tools and a self-hosted HTTP API.",
  "reviewed": "2026-10-29",
  "sidebar": {
    "order": 0
  },
  "template": "splash",
  "hero": {
    "title": "Explore a URL. Understand what broke.",
    "tagline": "From likely user paths to evidence you can inspect. Learn to run Scout, review findings and give your coding agent useful feedback.",
    "actions": [
      {
        "text": "Run Scout locally",
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
Scout explores your web app from a URL, checks each action against a recorded expectation, and gives people and coding agents the evidence to investigate what happened.

## Start with your next task

- **[Run Scout locally](getting-started/local-setup/)** — Start the workspace, browser worker and storage services with Docker Compose.
- **[Test your first URL](getting-started/first-run/)** — Submit a controlled app, follow the run and inspect its recorded actions.
- **[Connect a coding agent](agents/connect/)** — Use MCP or HTTP to submit work, return for a report and investigate a finding.
- **[Install the agent skill](agents/skill/)** — Give your agent a small, reusable Scout workflow without adding an SDK.
- **[Integrate the API](api/overview/)** — Work with durable jobs, progress, reports and verified evidence.
- **[Operate the stack](operators/architecture/)** — Understand the services, data boundaries and recovery model.
- **[Read with an LLM](agents/machine-readable/)** — Use clean Markdown, the LLM index, OpenAPI and the generated tool catalog.

## What you can learn from a run

Every automated action has an intended result, an observed outcome and evidence IDs. A report connects those observations to a page, control and recorded path. A coding agent can use that context with its own repository access to investigate a fix.

An unchanged screenshot can still reveal a failure. A changed screenshot can be normal. Scout assesses the behavior; image differences help locate where to look.

## Know the current scope

Scout is a local developer preview for operator-controlled web apps. It uses Chromium, bounded action budgets and API-key model connections. A completed run is a recorded exploration, not a claim that the entire app works.

Read [capabilities and limits](product/capabilities/) before using it with a new target. The documentation reflects implemented behavior; proposed features are labeled explicitly.
