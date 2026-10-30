# Choosing the next path

Implemented on 23 October 2026 as `frontier-v1`. The URL explorer now schedules unexplored controls across its recorded state graph, returns to earlier branches, and replans when the screen changes. Its discovery tree and ranked choices are shown in the workspace's **Flow** tab.

This is a bounded exploration algorithm. Model scores are hypotheses about the next user action, not measured or calibrated probabilities. It ranks observed possibilities; it does not invent a complete future application tree.

## Observe, rank, act, assess

1. Save a screenshot and observed native controls, including viewport rectangles and whether another element covers the control. Document scroll affordances also become candidates. Every occurrence has a capture UUID, even when identical PNG bytes share a bucket object.
2. Identify the exact state from screenshot bytes, URL, text, controls, viewport and scroll. Keep all states and transitions; a one-pixel change can produce a distinct state.
3. Compare the previous and new screenshots. Count changed mask pixels inside each observed control, rather than treating the entire difference bounding box as changed. On the same URL, flag controls that became visible or enabled. Across URLs, the model interprets the new page without these change bonuses.
4. Give the model the current discovery path, recent actions and outcomes, current screenshot, eligible controls and change signals. Ask for up to eight likely next actions, each with a goal, score and expected result. A fresh decision replaces older proposals at that state. Other states retain their pending proposals until revisited.
5. Rank eligible, unattempted controls across all reachable states. Select a local action or the first recorded step needed to return to another branch. The remaining action budget must cover the return plus an unexplored action.
6. Save the selection, competing candidates, score components, prediction and action ID before dispatch. Capture the page again and reject a stale plan before clicking.
7. Execute one typed action, save after evidence and exact differences, and request a separate assessment. Then update the graph and choose again. Returns receive the same evidence and assessment as ordinary exploration actions.

The executable command always resolves an observed control ID. A model cannot supply selectors, JavaScript or an unseen URL. Disabled, covered, ambiguous and policy-blocked controls remain visible as coverage gaps.

## Scoring

For a candidate control, the scheduling score is:

```text
local = max(0.01,
    0.65 × model_next_action_score
  + 0.15 × newly_exposed
  + 0.10 × has_changed_pixels_inside_control
  + 0.10 × never_attempted_control
  - 0.15 × min(previous_attempts_of_control, 3))

priority = local × (0.6 + 0.4 × sqrt(discovery_path_score))
                 / (1 + 0.3 × return_steps)

candidate_path_score = discovery_path_score × model_next_action_score
```

Boolean terms are zero or one. An initial page has discovery path score 1. Later discovery scores multiply the model scores along the first observed path. These products are **not a normalized probability distribution**. The weights are versioned engineering defaults, not fitted to traffic or evaluated against real users yet.

The model estimates likely intent; the scheduler also balances useful coverage and travel cost. A newly revealed menu item scored 0.65 can outrank an unchanged Help link scored 0.80 because it continues the interaction and occupies a changed region. Conversely, a high score never makes a blocked control eligible. Exact-state attempts are excluded; repeated control identities in other states receive a penalty rather than being globally forbidden.

## Returning to branches

Successful assessed transitions form the routing graph. Breadth-first search finds the shortest recorded route to a state with pending candidates. The planner also considers reopening the original entry URL and then following recorded transitions. It chooses the shorter usable route.

For example, a recorded execution can be:

```text
Entry → Catalog (dead end) → reopen Entry → Help → Save draft
```

The Catalog page need not contain a Home link. Reopening the entry URL uses the **same browser context**; it does not reset server data, cookies or authentication. Every return landing is checked against its expected exact state. A different landing invalidates that route, records `exploration.return_changed`, and causes planning from the actual observed page. Suspect or inconclusive transitions are not accepted as reusable routes. Each recorded return step is limited to two uses, and failed restoration routes are excluded.

The discovery tree stores each state's first parent, depth and path score. The underlying graph separately preserves cycles, return edges and repeated observations. A tree is a view of discovery history, not a claim that the application itself is a tree.

## Page drift and bounds

If the fresh before capture differs from the planning capture, the worker records a `skipped` action with no dispatch, saves the new state and a `replanning_mask`, and requests a fresh plan. Three such skips end the run with `replanning_limit_reached`. A skipped plan consumes model work but not an executed-action slot. Reproduction remains strict and stops on changed prerequisites instead of inventing a replacement path.

Runs allow 1–12 dispatched actions, including navigation and returns. Exploration permits at most `3 × max_actions + 6` model requests; replay permits one assessment per executed source action. Each request has one provider attempt and at most 2,048 output tokens. These limits bound work; they are not token or monetary quotas. Stop reasons distinguish exhausted actions, model requests, unstable pages, unreachable frontiers and insufficient budget to travel to a remaining branch. `coverage_complete` remains false.

## Responsive coverage

| Profile | Chromium viewport |
| --- | --- |
| `desktop` | 800 × 600 |
| `tablet` | 768 × 1024 |
| `mobile` | 390 × 844 |

Choose a profile beside the URL in the workspace, or set `SCOUT_EXPLORER_VIEWPORT`. For all three profiles:

```sh
.tools/bin/just explore-matrix http://exploration-fixture:8082/responsive
```

The matrix runs sequentially with separate browser contexts, run IDs, graphs, screenshots and usage. There is no shared matrix job or combined coverage report yet. These are responsive Chromium layouts, not native-device, touch, Safari or Android validation. Reproduction inherits the source run's viewport.

## Inspecting the evidence

The Flow tab shows ranked candidates with their discovery paths, next-action and path scores, return cost and selection reason, followed by the discovery tree and full recorded graph. PostgreSQL stores the state/frontier projections and decision lineage. The immutable run manifest includes them. `exploration.selected`, `exploration.replanned` and `exploration.return_changed` events export to ClickHouse with run/action/capture references. Model request/response payloads and token usage retain their existing durable records.

Run `just explorer-test` for real Chromium/storage checks with simulated models. Coverage includes dead-end return, route costs and cycles, refreshed scores, changed-control priority, one-pixel mask intersections, covered controls, stale-plan recovery and its limit, all three viewports, and fresh replay through a return path. The end-to-end planner record is written to `artifacts/exploration-planner/verification.json`. `just workspace-test` checks profile admission and the queued worker; `just web-contract-test` checks templates against persisted results. Browser layout/interaction verification remains unverified because computer-use access was restricted.

Native text/search entry, dropdown selection, checkbox/radio changes and document scrolling now use the same planner; see [browser interactions](./interactions.md). Remaining work includes live-model quality evaluation and score calibration, larger and semantic planning projections that preserve exact evidence, form submission and keyboard/custom widgets, credential handoff, timed settling, automatic reproduction scheduling, resumable exploration, multi-worker scheduling and broader isolation. The current browser limit is 40 observed controls, with model context also bounded; this is not exhaustive coverage of large or continuously changing pages.
