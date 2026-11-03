---
{
  "title": "Read a coding-agent report",
  "description": "Interpret Scout report categories, frozen expectations, actual outcomes, reproduction paths, evidence references, uncertainty and repair objectives.",
  "reviewed": "2026-11-03",
  "sidebar": {
    "order": 3
  }
}
---
A coding-agent report turns existing recordings into an investigation handoff. It returns structured JSON and readable Markdown without new model inference.

## What a finding explains

An item identifies the run/action, page route or recorded location, control and exact typed action. It includes the expected result frozen before acting, the actual observation, assessment rationale, viewport, recorded reproduction path, redacted diagnostics and capture/artifact references.

A justified **repair_objective.target_behavior** describes behavior to investigate. It is not a proven source-level fix. Source location and root cause remain unknown.

## Share the exact handoff

Read **scout_get_issue {issue_id}** or **spekios issue show <issue-id>** for a persistent finding. **handoff.agent_description.text** is the same deterministic Markdown previewed by **Copy for my agent** in the UI. It identifies the failing interface, expected/observed behavior, steps, evidence references, uncertainty, human decisions, tracking and the candidate-check workflow. The structured fields remain available alongside it.

Use the agent's own checkout to investigate and establish a source location or cause. After deploying a fix, run **spekios issue verify <issue-id> <candidate-url>**, then **spekios verification show <verification-id>**. Reads and copying use no inference; verification can use model credits.

Matching reruns append occurrences to the same issue. Tracking retains previous candidate outcomes and marks later observations separately. Absence in a run never proves a fix. See [finding history](../../guides/fix-verification/).

## Read the category first

| Category | How to use it |
| --- | --- |
| suspected_bug | Investigate the expectation and evidence. This is not automatic confirmation. |
| observed_change | A recorded change; it can be ordinary correct behavior. |
| diagnostic_signal | A browser/network observation that needs context before assigning an app defect. |
| execution_problem | A runner, queue or delivery problem; distinguish it from app behavior. |
| inconclusive | Evidence or preconditions do not support a reliable conclusion. |
| pending_check | The action has not yet received its final assessment. |

Independent reproduction and latest human review are separate fields. A human dismissal suppresses repair advice. Replay actions do not become duplicate original findings.

## Example: a broken Save draft

An illustrative report could say: “Click Save draft on /settings. Expected: status changes to Saved. Observed: status remains Ready.”

Even with zero changed pixels, this can be a useful suspicion. The next step is to check whether saving was expected, inspect the path and diagnostics, then investigate the handler using code access.

The docs example is not a real customer recording.

## Read all pages consistently

The default page size is four items; bounds are one to ten. Follow the complete continuation under **pagination.next**, including its **expected_snapshot** hash.

Actions, evidence, usage, reproduction or human review can change the source. A **409 report_snapshot_changed_restart_from_offset_zero** requires restarting pagination. A finished browser run can still receive later review overlays.

## What completion means

Queued jobs return **not_started**. Jobs ending before browser launch return **execution_ended_without_run**. Recorded runs return **partial** or **run_finished**.

**coverage_complete** remains false. A run finishing does not mean the app passed all flows. Inspect coverage limitations and **execution_issues**, which preserve queue/delivery failures separately.

Long text is bounded in the handoff. Use **scout_get_action** and the raw run/evidence references when you need the stored details.
