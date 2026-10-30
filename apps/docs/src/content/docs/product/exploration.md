---
{
  "title": "How exploration chooses a path",
  "description": "Understand likely-action ranking, changed-control discovery, the recorded state graph and automatic returns to unexplored branches.",
  "reviewed": "2026-10-30",
  "sidebar": {
    "order": 3
  }
}
---
Scout explores a bounded graph of observed browser states. It asks what a user is likely to do next, combines that inference with recorded evidence and selects a supported action. The scores rank candidates; they are not calibrated probabilities.

## Observe and rank

The recorder collects native controls across the whole page, including field values, checked state, dropdown options and document scroll affordances. Controls further down the page are included and marked as outside the visible area. When one is chosen, Scout scrolls it into view before taking the before screenshot. If it then turns out to be covered or unusable, Scout skips it without acting. The model proposes a control, typed action, likely user goal and expected result.

The planner combines model intent, novelty, changed pixels within controls and the cost of returning to a branch. A newly revealed or changed clickable control can become a candidate on the next observation.

The model sees up to 4,000 characters of page text, the available controls and the last eight actions with their outcomes. If a request would be too large, these shrink together instead of the run failing.

## Avoid stale and duplicate actions

State fingerprints include the page, control state and authentication context. Previously attempted state/action combinations are tracked so the explorer can favor new work.

Before dispatch, a fresh observation must match the planning state. The worker revalidates the selected control and exact parameters. A changed screen triggers replanning instead of executing a stale selector.

## Return to unexplored branches

The frontier records reachable actions that have not yet been explored. Scout can follow a recorded return route or reopen the entry URL, assess those return actions and continue from a different branch.

Returning consumes the same action budget. It does not restore server-side app data. An authentication-context change discards old return plans and starts from the entry URL in the new context.

## Learn from earlier runs

With [app memory](../../guides/app-memory/) on, a run knows which pages and controls earlier runs of the same app explored. Controls already tried rank lower, and controls new to a known page rank higher. A page an earlier run reached but did not finish can be reopened directly. Memory is keyed by page address and control identity, never by exact screenshots, and it never replaces fresh evidence.

## Assess every action

The prediction is frozen first. The worker performs the action, waits for bounded completion, records screenshots and diagnostics, computes exact image differences and requests an assessment.

A zero-pixel difference still receives a check. One changed pixel is retained. Neither result alone determines whether the behavior is wrong.

## Coverage limits

The default exploration budget is 20 actions; configurable bounds are one to 50, including navigation, returns and reopened pages. A run also stops after 30 minutes by default. Up to 120 controls per page are observed, and model inputs are bounded. Unsupported widgets, access boundaries, continuously changing pages and exhausted budgets leave explicit coverage gaps.

[Responsive coverage](../../guides/responsive/) uses separate desktop, tablet and mobile Chromium runs. It does not imply native-device or complete-app coverage.
