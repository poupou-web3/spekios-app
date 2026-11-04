---
{
  "title": "Triage findings and recheck a deploy",
  "description": "Decide whether a Spekios issue is a bug, intended behavior or a duplicate, let later runs recognize it, and recheck every open issue after a deploy from the workspace, an agent or CI.",
  "reviewed": "2026-11-03",
  "sidebar": {"order": 3}
}
---
Spekios records every suspected problem as a permanent issue. Triage decides what each issue is, so Spekios knows what to keep checking and what to recognize next time.

## Decide what an issue is

Open **Issues & fixes**, choose an issue and answer **What is this?**:

| Decision | Meaning | What Spekios does next |
| --- | --- | --- |
| **Bug** | The app should behave as expected. | Keeps it open, includes it in deployment rechecks, and records matching repeats on the same issue. |
| **Intended behavior** | The app works as designed; the expectation was wrong. | Keeps the decision on matching repeats; a different failure on the control needs its own review. |
| **Duplicate** | Another issue already covers this. Give that issue's ID. | Rolls this issue and later repeats up to that one. |
| **Needs review** | Not decided yet. | Keeps it open. |

Write why: what the product should do, and the evidence for it. Every decision is kept, with who made it and when.

Agents can triage too, with **scout_triage_issue**. Their decisions are shown as made by an agent. An agent cannot replace a decision made by a person; a person can change any decision. Earlier automatic matching decisions remain visible with their Spekios attribution. New unmatched failures are left for review.

## How later runs recognize known behavior

A later run can reach the same behavior by a different path. Spekios compares the page address without its fragment, the control and action, exact viewport, project, execution mode, saved sign-in account and normalized expected/observed behavior. Case and whitespace differences are ignored. A matching failure adds an occurrence to the existing issue, so its triage and review history remain intact.

A different or paraphrased failure on the same control remains a separate finding. **Related findings** shows possible matches and manually linked duplicates; a person or agent can review the evidence and link a duplicate explicitly. This avoids carrying an intended-behavior decision over to a new bug on the same button.

Nothing is hidden. The evidence, the model's assessment and each occurrence are all recorded. The issue list shows open issues by default (new, needs review and bugs); choose **All issues** to see known behavior. Reports count findings by triage, and a coding-agent report gives no repair objective for intended behavior.

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

It waits for every verdict and exits 1 if any issue still reproduces. With **--strict** it also fails when a check was blocked, inconclusive or could not run. Set **SCOUT_RECHECK_ID** to a UUID derived from the CI run to make a retried step reuse the same recheck. The token needs the **runs:write** scope. Run the same script from cron or a scheduled CI job for periodic rechecks; Spekios has no built-in scheduler.

A **resolved** item means the recorded expected behavior was observed on that deployment. It is not proof of a production fix or full coverage.

## Limits

- Matching uses the page address without its fragment. Pages whose address changes with each visit match only when the address repeats.
- Triage and known behavior are scoped to the workspace member who owns the issues.
- A recheck covers at most 25 open issues. The response says how many more were not included.
