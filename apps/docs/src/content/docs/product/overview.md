---
{
  "title": "What is Spekios?",
  "description": "Understand Spekios’s URL-first exploratory testing workflow and how it helps people and coding agents investigate web application behavior.",
  "reviewed": "2026-11-04",
  "sidebar": {
    "order": 1
  }
}
---
Spekios is a self-hosted exploratory QA system for web applications. Give it any http or https address its browser can reach, including a local or private app. It infers plausible user goals, chooses supported actions, records the resulting states and checks what happened against an expectation made before each action.

## The product workflow

1. **Submit a URL.** No test brief is required. Choose a model and API key once in **Settings**.
2. **Explore likely paths.** The planner ranks visible actions and reachable unexplored branches.
3. **Check every action.** Before/after screenshots, control observations, completion samples and redacted diagnostics support an assessment.
4. **Investigate findings.** People review suspicions; an independent replay can try the recorded path in a fresh browser.
5. **Give feedback to a coding agent.** Reports include expected versus actual behavior, locations, reproduction steps and evidence references.

The workspace follows runs, findings and issues, and its **Settings** pages hold models, exploration defaults, limits, app memory and saved app sessions. The back office, a separate deployment for the team operating Spekios, shows queue state, model requests, events, service logs and delivery status.

## Who it is for

Use Spekios on your own app while you develop it, on a staging environment, or on a public site you want to explore. It is useful for checking changes, exploring user journeys and collecting traceable observations for a person or agent to investigate.

Spekios does not connect to a source repository or edit application code. A coding agent uses its own repository access to establish the source location and cause.

## Start here

- [Run the local stack](../../getting-started/local-setup/)
- [Understand the exploration algorithm](../exploration/)
- [See current capabilities and limits](../capabilities/)
- [Give a coding agent a URL](../../agents/workflow/)
