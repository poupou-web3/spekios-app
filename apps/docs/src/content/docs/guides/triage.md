---
{
  "title": "Triage findings and recheck a deploy",
  "description": "Decide whether a Scout issue is a bug, intended behavior or a duplicate, let later runs recognize it, and recheck every open issue after a deploy from the workspace, an agent or CI.",
  "reviewed": "2026-10-31",
  "sidebar": {"order": 3}
}
---
Scout records every suspected problem as a permanent issue. Triage decides what each issue is, so Scout knows what to keep checking and what to recognize next time.

## Decide what an issue is

Open **Issues & fixes**, choose an issue and answer **What is this?**:

| Decision | Meaning | What Scout does next |
| --- | --- | --- |
| **Bug** | The app should behave as expected. | Keeps it open, includes it in deployment rechecks, and files later repeats as duplicates of it. |
| **Intended behavior** | The app works as designed; the expectation was wrong. | Labels later suspects with the same page and control as known intended behavior. |
| **Duplicate** | Another issue already covers this. Give that issue's ID. | Rolls this issue and later repeats up to that one. |
| **Needs review** | Not decided yet. | Keeps it open. |

Write why: what the product should do, and the evidence for it. Every decision is kept, with who made it and when.

Agents can triage too, with **scout_triage_issue**. Their decisions are shown as made by an agent. An agent cannot replace a decision made by a person; a person can change any decision. Scout also triages on its own when a new issue repeats known behavior, shown as decided by Scout with a link to the issue it matched.

## How later runs recognize known behavior

A later run can reach the same behavior by a different path. Scout compares the page the action started on, the control and what was done with it, the viewport, and whether the run was signed in. When those match a triaged issue, the new issue is triaged the same way:

- A match with **intended behavior** is recorded as intended behavior.
- A match with a **bug** or a **duplicate** is recorded as a duplicate of the known bug.

Nothing is hidden. The evidence, the model's assessment and the new issue are all recorded. The issue list shows open issues by default (new, needs review and bugs); choose **All issues** to see known behavior. Reports count findings by triage, and a coding-agent report gives no repair objective for intended behavior.

**scout_list_knowledge** and **GET /v1/knowledge** list known behavior for a site: each bug or intended behavior, who decided and why, its page and control, and how many duplicates and repeats it has.

## Recheck after a deploy

A recheck verifies a deployment against every open issue found on a site, up to 25 at a time, newest first. Each issue gets its own fresh-browser fix verification on the new deployment, keeping its recorded entry path. Intended behavior and duplicates are not rechecked. Each check uses model calls and can change data on the deployment.

In the workspace, use **Recheck a deployment** on the issues page. Give the deployment URL and, if the issues were found on another site, that site.

From an agent, call **scout_recheck_deployment** with a saved **recheck_id**, then poll **scout_get_recheck**. A retry with the same ID reuses every check already admitted.

From CI, run the script after the deploy step:

~~~sh
SCOUT_API=https://scout.internal.example SCOUT_TOKEN=$SCOUT_AGENT_TOKEN \
  node scripts/scout-recheck.mjs --candidate "$PREVIEW_URL" \
  --source https://staging.example --label "$GIT_SHA"
~~~

It waits for every verdict and exits 1 if any issue still reproduces. With **--strict** it also fails when a check was blocked, inconclusive or could not run. Set **SCOUT_RECHECK_ID** to a UUID derived from the CI run to make a retried step reuse the same recheck. The token needs the **runs:write** scope. Run the same script from cron or a scheduled CI job for periodic rechecks; Scout has no built-in scheduler.

A **resolved** item means the recorded expected behavior was observed on that deployment. It is not proof of a production fix or full coverage.

## Limits

- Matching uses the page address without its fragment. Pages whose address changes with each visit match only when the address repeats.
- Triage and known behavior are scoped to the workspace member who owns the issues.
- A recheck covers at most 25 open issues. The response says how many more were not included.
