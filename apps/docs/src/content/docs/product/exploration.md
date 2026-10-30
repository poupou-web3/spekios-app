---
{
  "title": "How exploration chooses a path",
  "description": "Understand likely-action ranking, changed-control discovery, the recorded state graph and automatic returns to unexplored branches.",
  "reviewed": "2026-10-28",
  "sidebar": {
    "order": 3
  }
}
---
Scout explores a bounded graph of observed browser states. It asks what a user is likely to do next, combines that inference with recorded evidence and selects a supported action. The scores rank candidates; they are not calibrated probabilities.

## Observe and rank

The recorder collects visible native controls, field values, checked state, dropdown options and document scroll affordances. The model proposes a control, typed action, likely user goal and expected result.

The planner combines model intent, novelty, changed pixels within controls and the cost of returning to a branch. A newly revealed or changed clickable control can become a candidate on the next observation.

## Avoid stale and duplicate actions

State fingerprints are the page URL, visible text, control state and authentication context. Screenshot bytes stay on the capture and are diffed exactly. Previously attempted state/action combinations are tracked so the explorer can favor new work.

Before dispatch, a fresh observation must match the planning state. The worker revalidates the selected control and exact parameters. A changed screen triggers replanning instead of executing a stale selector.

## Return to unexplored branches

The frontier records reachable actions that have not yet been explored. Scout can follow a recorded return route or reopen the entry URL, assess those return actions and continue from a different branch.

Returning consumes the same action budget. It does not restore server-side app data. An authentication-context change discards old return plans and starts from the entry URL in the new context.

## Assess every action

The prediction is frozen first. The worker performs the action, waits for bounded completion, records screenshots and diagnostics, computes exact image differences and requests an assessment.

A zero-pixel difference still receives a check. One changed pixel is retained. Neither result alone determines whether the behavior is wrong.

## Coverage limits

The default exploration budget is six actions; configurable bounds are one to twelve. Controls and model inputs are bounded. Unsupported widgets, access boundaries, continuously changing pages and exhausted budgets leave explicit coverage gaps.

[Responsive coverage](../../guides/responsive/) uses separate desktop, tablet and mobile Chromium runs. It does not imply native-device or complete-app coverage.
