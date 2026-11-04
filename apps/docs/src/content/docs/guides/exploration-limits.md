---
{
  "title": "Set exploration limits",
  "description": "Explorations have no limit by default. Set your own action, time, token and cost limits, and different limits for a project or a model.",
  "reviewed": "2026-11-04",
  "sidebar": {"order": 7}
}
---
An exploration has no action, time, token or cost limit unless you set one. It keeps going until nothing new is left to explore, you stop it, or one of your limits is reached.

## Your limits

Open **Settings → Limits**. Leave a field empty for no limit.

| Limit | Range | What it counts |
| --- | --- | --- |
| **Maximum actions** | 1–10,000 | Executed actions, including navigation, returns and reopened pages. |
| **Maximum minutes** | 1–10,080 (one week) | Wall-clock time of one exploration attempt. |
| **Maximum reported tokens** | 1,000–1,000,000,000 | Input plus output tokens the model provider reported for the run. |
| **Maximum reported cost (USD)** | 0.01–100,000 | Cost the provider reported for the run. Calls without a reported price do not count. |
| **Stop after actions with nothing new** | 5–1,000 (default 50) | Consecutive actions that reached only screens the run had already recorded. |

Token and cost limits are checked before each new action, against usage that has been reported. An action already in progress, with its prediction and assessment, can finish past the limit.

The last row is not a budget. It ends an exploration that keeps returning to what it already recorded, such as paging through an endless list. Leave it empty to turn it off.

## Limits for a project or a model

Add an **override** for a project ID, a provider, a model ID, or a model within a project. A job uses your limits, then applies every matching override from least to most specific: model, then project, then model within the project. An empty field in an override inherits.

For example, keep no limits by default, cap a paid model at 2,000,000 tokens, and give one project a 2-hour limit.

Agents and API clients choose the project with **project_id** when they start work. The API also accepts **null** in an override to remove a limit you set as a default.

## What a job keeps

A job keeps the limits resolved when it was admitted, under **settings** in the job and **limits** in the run configuration. Changing your settings later does not change queued or running jobs. The run records why it stopped: **action_budget_reached**, **time_budget_reached**, **token_budget_reached**, **cost_budget_reached**, **model_request_budget_reached** (a model-call cap derived from the action limit), **no_new_states** or **no_reachable_unexplored_controls**.

If a worker stops mid-run, the job is marked interrupted and is not resumed automatically. **Continue exploration** starts a new job from the recorded graph with your current limits.

## Server defaults

Operators can set **SCOUT_EXPLORER_MAX_ACTIONS** and **SCOUT_EXPLORER_MAX_MINUTES** for users who have not saved their own limits. Both are empty by default: no limit.

## What long runs do not change

Reproductions and fix verifications replay the recorded path that led to a finding, at most 50 steps. A finding deep in a very long run can be too far down its path to replay. It is still recorded with its evidence.
