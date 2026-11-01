# Choosing the next path

Implemented on 23 October 2026 as `frontier-v1`, extended on 30 October as `frontier-v2`, on 31 October as `frontier-v3` and on 1 November as `frontier-v4` and `frontier-v5`. The URL explorer schedules unexplored controls across its recorded state graph, returns to earlier branches, and replans when the screen changes. `frontier-v2` observes controls anywhere in the document and uses [memory from earlier runs](#memory-across-runs) of the same app. `frontier-v3` [shares each run's actions](#sharing-actions-between-strategies) between new territory, deep journeys and re-walking transitions from the app map, and reports coverage at each depth. `frontier-v4` adds local recovery and reliable return routing. `frontier-v5` counts depth in screens: [another view of a screen](#views-of-one-screen) keeps its depth. Its discovery tree, strategy split and ranked choices are shown in the workspace's **Flow** tab.

This is a bounded exploration algorithm. Model scores are hypotheses about the next user action, not measured or calibrated probabilities. It ranks observed possibilities; it does not invent a complete future application tree.

## Observe, rank, act, assess

1. Save a screenshot and observed native controls. Controls inside the viewport have their rectangle and whether another element covers them. Controls further down the document are observed with `in_viewport: false` and their document position; whether they are covered is only known after scrolling. Content clipped by nested scrolling containers, off-canvas content and fixed elements outside the viewport are not observed. Up to 120 controls are kept, visible ones first, then the nearest ones further down. Document scroll affordances remain candidates. Every occurrence has a capture UUID, even when identical PNG bytes share a bucket object.
2. Identify the state from the URL, text, controls, viewport and scroll bucket. Clock and date labels, and screenshot bytes, do not split the state. A one-pixel mask is still stored with the action.
3. Compare the previous and new screenshots. Count changed mask pixels inside each observed control, rather than treating the entire difference bounding box as changed. On the same URL, flag controls that became visible or enabled. Across URLs, the model interprets the new page without these change bonuses.
4. Give the model the current discovery path, the last eight actions and outcomes, current screenshot, up to 4,000 characters of page text, eligible controls (about 20 KB) and the controls that changed. When memory is in use it also receives what earlier runs tried on this page. If a request would exceed the prompt limit (64 KiB, fitted below 54 KiB to leave room for the testing focus), page text, controls and history shrink together and the request records its `context_scale`. Ask for up to eight likely next actions, each with a goal, score and expected result. A fresh decision replaces older proposals at that state. Other states retain their pending proposals until revisited.
5. Rank eligible, unattempted controls across all reachable states. Select a local action or the first recorded step needed to return to another branch. The remaining action budget must cover the return plus an unexplored action.
6. Save the selection, competing candidates, score components, prediction and action ID before dispatch. If the chosen control is further down the page, scroll the document so it sits about a third of the way down the viewport (`action.revealed`). Capture the page again and reject a stale plan before clicking.
7. Execute one typed action, save after evidence and exact differences, and request a separate assessment. Then update the graph and choose again. Returns receive the same evidence and assessment as ordinary exploration actions.

The executable command always resolves an observed control ID. A model cannot supply selectors, JavaScript or an unseen URL. Disabled, covered, ambiguous and policy-blocked controls remain visible as coverage gaps.

## Scoring

For a candidate control, the scheduling score is:

```text
local = max(0.01,
    0.65 × model_next_action_score
  + 0.15 × newly_exposed
  + 0.10 × has_changed_pixels_inside_control
  + 0.10 × never_attempted_control            (this run or earlier runs)
  + 0.10 × new_since_earlier_runs             (page known, control not seen before)
  - 0.15 × min(previous_attempts_of_control, 3)
  - 0.20 × tried_in_earlier_runs              (0.10 if its last result was not "no issue")
  - 0.20 × same_entry_tried_in_this_run       (another list item or the same control on an equivalent screen)
  - 0.20 × same_entry_tried_in_earlier_runs   (app map; only when URL memory has no attempt))

priority = local × (0.6 + 0.4 × sqrt(discovery_path_score))
                 / (1 + 0.3 × return_steps)

candidate_path_score = discovery_path_score × model_next_action_score
```

Boolean terms are zero or one. An initial page has discovery path score 1. Later discovery scores multiply the model scores along the first observed path. These products are **not a normalized probability distribution**. The weights are versioned engineering defaults, not fitted to traffic or evaluated against real users yet.

Earlier-run terms are zero when memory is off or empty. `new_since_earlier_runs` is withheld when the earlier observation of that page was truncated, so a control cannot look new only because it was not listed before.

The model estimates likely intent; the scheduler also balances useful coverage and travel cost. A newly revealed menu item scored 0.65 can outrank an unchanged Help link scored 0.80 because it continues the interaction and occupies a changed region. Conversely, a high score never makes a blocked control eligible. Exact-state attempts are excluded; repeated control identities in other states receive a penalty rather than being globally forbidden.

## Sharing actions between strategies

Each run's executed actions are shared between three strategies (`strategy-v2`), 50/30/20 by default and configurable per user ([guide](../../apps/docs/src/content/docs/guides/exploration-strategy.md)):

- **breadth** (new territory) ranks with the score above multiplied by an area balance. An area is a depth-1 screen and everything discovered from it or its views; actions are counted from each executed transition's source state. With `fair = max(6, actions so far / known areas)`, where known areas are depth-1 screens plus untried entry-page controls plus one, a candidate in an area that used `n > fair` actions is multiplied by `fair / n`. Breadth also offers a return to any reachable state with unranked controls (score as a remembered unranked page, 0.30), because one plan ranks at most eight. Remembered pages compete unchanged.
- **depth** (deep journeys) multiplies the score by `(1 + 0.25 × depth) / (1 + return_steps)`. Remembered pages use their app-map depth and count as one return step.
- **rewalk** lists app-map transitions from map states equivalent to reachable states, groups them by action key, and maps each to an available control with the same entry and an identical transition key. Clicks, authorized submits, selects and checkbox changes are re-walkable (choices recorded since `strategy-v1`); text entry and navigation are not. Priority is `(0.5 + 0.3 × earlier_suspect_or_inconclusive + 0.2 × several_destinations) × (0.6 + 0.4 × √path) / (1 + 0.3 × return_steps)`. Each `(map state, action key)` is walked at most once per run. Its prediction is a separate `rewalk_prediction` request with earlier results as untrusted hints; the screen is not replanned first.

Scheduling is a deficit round-robin. After each executed action, every strategy that had a candidate gains its current share as credit and the executing one is charged one action; the largest credit minus spent takes the next turn (ties: larger configured share). A turn continues until its first action, while travelling (`return`/`resume`) toward its target, and for depth while each step makes progress, the next depth candidate needs no travel and the journey is below its step limit. Progress is a map state new to the run, or a fill, select or checkbox change that creates a state new to the run; a scroll, or a step back to a screen the run already reached, ends the journey. The step limit is 12, or `ceil(depth share × action limit)` when the run has an action limit and that is smaller, but at least 2. Before `strategy-v2` a journey went on after any new exact state and had no budget-relative limit, so in a 6-action run one journey of scrolls and small in-page changes could take every action after the first. Breadth and rewalk turns end after one target action.

With adaptive shares (default), each strategy's yield is `(0.5 × 2 + Σ 0.8^age × reward) / (2 + Σ 0.8^age)` and its share is `configured × (0.25 + 0.75 × yield / best_yield)`, normalized over strategies with candidates. Rewards per action: 1 for a map state no run reached before, 0.3 for progress as defined above, 1 for a changed known transition (other destination, or verdict flipped between `no_issue_observed` and `suspect`), 0.2 for a matching one, plus 0.5 for a suspect, capped at 1. An operator testing focus pauses re-walks. Rewards and weights are engineering defaults, not fitted.

Every action whose `(from map state, action key)` the app map already holds is compared, whichever strategy chose it: the assessment request gets `earlier_runs` (same destination, last observed result and verdict, labelled as stale-able hints), and `exploration.compared` records known destinations, the new one and both verdicts. Selections record `strategy` (mode, turn, shares, yields, deficits and candidate counts). At the end the run configuration holds `strategy` and `coverage_by_depth`: per depth, http(s) states, usable controls, tried controls, blocked controls and their ratio.

## Fewer and cheaper model calls

Two settings lower the model calls per action (`ranking-v1`; [guide](../../apps/docs/src/content/docs/guides/exploration-cost.md)).

**Ranking reuse** (`reuse_rankings`, default on, needs app memory). A screen signature hashes the page template, sign-in presence, stabilized title, stabilized text with digit runs replaced, whether text was truncated, and the set of controls as `(entry key, disabled, occluded, in viewport, checked, has value, invalid, form authorization, option values)`. It is stricter than a map state on purpose: a form before and after it is filled, or with a validation message, is a different screen. A fresh plan is stored in `app_map_rankings` under `(scope, signature, provider, model)` when the state had no attempted controls, the control list and the plan's control context were not truncated, no testing focus applied, and no proposal fills text. Proposals are stored by control entry with their action, goal, expected result and score. On a state's first visit in a run, without a pending or applied focus, a stored ranking with fewer than 10 reuses is mapped back onto the available controls by entry (any item of a collapsed list may stand in), revalidated with the interaction contract, and recorded as an `exploration_decisions` row with status `reused`, a fresh request ID and `reused_from` (run, request, decision). No model request is made. Predictions from it carry `reused_ranking`. Later visits in the run plan fresh as before. A fresh first-visit plan replaces the stored ranking and resets its count.

**Navigation model** (`navigation_model`, default none). Opening a URL, a link click with an `href`, and scrolling are navigation. Their predictions (entry, return, resume, recovery and re-walk) and assessments go to the navigation model; a failed prediction falls back to the main model. A navigation assessment is reassessed by the main model when its verdict is not `no_issue_observed`, it marks the expectation uncertain, the action outcome has browser errors or failed requests not blocked by the runtime, or the call fails or is invalid (tool, observation and completion failures already force `inconclusive` and are not reassessed). The assessment records `model_tier` and, when reassessed, `screening` (reason, and the navigation decision, request and verdict). Plans, state-changing actions and fix verifications always use the main model. The navigation client must be ready in the same execution mode, otherwise the run records `navigation_unavailable` and uses the main model. `model_use` in the final run configuration counts plans requested and reused, rankings stored, navigation requests, reassessments and fallbacks.

## Returning to branches

Settled transitions with complete observations and no browser tool error form the routing graph independently of the model's bug verdict. Input changes and form submissions are excluded from return routes. The planner considers recorded paths and reopening the original entry URL followed by recorded transitions. Route cost is one per step plus `2 × failures / (successful_returns + 1)` for each step. It chooses the least costly usable path that leaves room for the unexplored action; a longer reliable route cannot hide a shorter route that alone fits the remaining action budget. If no recorded route is usable, a previously observed safe same-origin page URL can be reopened and observed afresh.

For example, a recorded execution can be:

```text
Entry → Catalog (dead end) → reopen Entry → Help → Save draft
```

The Catalog page need not contain a Home link. Reopening the entry URL uses the **same browser context**; it does not reset server data, cookies or authentication. Every return landing is checked against its expected exact state. A different landing invalidates that route, records `exploration.return_changed`, and causes planning from the actual observed page. A settled transition to the actual destination can be learned separately even if a model assessment suspects a product defect. Successful return steps have no lifetime use cap. Failed restoration routes are excluded until fresh successful evidence reestablishes them; a URL shortcut that failed to restore a particular destination state is excluded for that state for the rest of the run. Other states at the same URL remain reachable.

The discovery tree stores each state's first parent, depth and path score. The underlying graph separately preserves cycles, return edges and repeated observations. A tree is a view of discovery history, not a claim that the application itself is a tree.

### Views of one screen

Exact states include the scroll position, which controls are in the viewport, and control values, so scrolling or typing creates a new state. Since `frontier-v5`, a state whose app-map state key matches a state the run already reached is a view of that screen. It records `screen_state_id` (the run's first state with that key) and takes that state's depth rather than its parent's depth plus one, so depth counts screens. Its `parent_state_id` stays the actual parent, so routes and path scores are unchanged. Views of one screen belong to the same area, coverage by depth counts the screen once and a control tried in any of its views as tried, and the Flow tab lists views with their screen and hangs what was found from them under it. Tried controls are not shared between views for ranking: a submit on an empty form and on a filled one are different actions.

## Memory across runs

With memory on (the default for live queued jobs and live `just explore` runs; simulated-model jobs use it only when they explicitly set `app_memory: true`, so fixture verification never depends on earlier test runs; library callers opt in with `appMemory: true`), each run reads a snapshot of what earlier runs of the same app learned and records what it observes. A memory **scope** is one workspace user, origin, viewport profile and its size in pixels, sign-in state (public or signed in) and execution mode, so desktop, mobile, signed-in and simulated-model runs never share memory. Desktop memory recorded at the earlier 800 × 600 size stays in its own scope, apart from runs at 1920 × 1080.

Memory is keyed by the observed page URL and the stable control identity (URL, role, name and link). Exact screenshot states are never compared across runs, and memory is never treated as evidence. For each page it keeps the title, how many runs saw it, its best discovery path score and whether its control list was truncated; for each control, how often earlier runs tried it, the best model score it received, its last assessment and a short observed result. Screenshots, field values and credentials are not stored. Writes share the transaction that records the corresponding evidence.

The snapshot is frozen when the run starts (and again for a new sign-in context), so a run's own observations never count as "earlier". It changes planning in three ways:

- **Scores.** Controls already tried in earlier runs lose their novelty bonus and are penalized; controls that appear on a known page for the first time get a bonus (see above).
- **Resume steps.** A page earlier runs reached but did not finish (it has untried, unblocked controls) becomes a candidate route of one navigation. Its score uses the best earlier model score among its untried controls (0.30 if none was ranked) and the page's best earlier path score: `(0.65 × score + 0.10) × (0.6 + 0.4 × √path) / 1.3`. It needs room for the navigation plus one action, is offered at most once per run, never for the entry URL or a page already visited in the run, and ranks after fresh choices under a new testing focus. The navigation is an ordinary action with prediction, captures and assessment, recorded with purpose `resume`; the landing page is observed and planned afresh.
- **Model context.** The planning request includes up to 12 earlier attempts on the current page with their last results, labelled as untrusted hints that never establish expected behavior.

Remembered URLs are reopened only within the entry site's registered domain, and never when the path or query suggests sign-out, payment, deletion or another risky action, or when a query parameter looks like a token, code, key, session, signature or similar secret. Replays (manual, automatic and fix verification) never read or write memory. Turning memory off for a run neither reads nor records it. **Settings → App memory** lists scopes and can forget one; forgetting removes only this projection, never run evidence, and is refused while an active run uses the scope.

## Page drift and bounds

A fixed, permitted return/recovery navigation does not depend on a stale source-page control: it can proceed from the fresh before capture even if the source changed. `exploration.navigation_refreshed` records this case. The landing is still observed and assessed, never assumed restored. Private login boundaries and network policy continue to apply.

If the fresh before capture differs from the planning capture, the worker records a `skipped` action with no dispatch, saves the new state and a `replanning_mask`, and requests a fresh plan. Three replans on the same page without a settled successful action defer that page for the rest of this run, record `exploration.branch_deferred`, and block its pending controls. Counts are maintained per URL; a completed, settled action resets the replan streaks. Other reachable branches remain eligible. Previously observed permitted links on a deferred page can be opened directly once per URL with a new prediction and fresh evidence, so a changing entry page need not prevent exploring its children. These links use the same safe-URL rules as remembered pages. A skipped plan consumes model work but not an executed-action slot. Reproduction remains strict and stops on changed prerequisites instead of inventing a replacement path.

When the runtime scrolled to a chosen control, the guard instead compares the document without its viewport: URL, title, text and every control's identity and state, ignoring the screenshot, scroll position and viewport geometry. Any other change still forces a replan. If the revealed control turns out to be covered, disabled or ambiguous, the action is `skipped` with method `reveal-guard`, the control is blocked as `unavailable_after_reveal` and planning continues. Other pre-dispatch control validation failures use `dispatch-guard` and `unavailable_before_dispatch`. Local blocks apply across states of that URL for this run, prevent return routing through the control, and are counted as blocked rather than attempted. There is no run-wide reveal failure cap.

A dispatched browser interaction failure or bounded completion timeout can also yield to other controls or branches when before/after observations and the model assessment are complete. Its inconclusive assessment and evidence stay recorded, the failed control is blocked locally, and `exploration.action_recovered` records the continuation. The action is never automatically dispatched again. Missing captures, incomplete observations, failed assessments, cancellation and lost browser/storage access still stop work. Local blocks do not become permanent cross-run exclusions.

Explorations have no default limit. Users set optional limits on dispatched actions (1–10,000, including navigation, returns and resumes), minutes (1–10,080), reported tokens and reported cost, with per-project and per-model overrides resolved at admission ([exploration limits](../../apps/docs/src/content/docs/guides/exploration-limits.md)). Stop reasons are `action_budget_reached`, `time_budget_reached`, `token_budget_reached`, `cost_budget_reached`, and `no_new_states` after `stop_after_idle_actions` (default 50) consecutive actions reach no state new to the run. Token and cost limits use settled reported usage, checked before each new action. The worker runs up to `SCOUT_BROWSER_SLOTS` jobs at once. An interrupted exploration continues in a new run with the remaining action budget, at most three times; each attempt gets a fresh time limit, and a dispatched action is not repeated. With an action limit, exploration permits at most `3 × max_actions + 6` model requests (`4 × max_actions + 6` with a navigation model; none without a limit); replay permits one assessment per executed source action. Each request has one provider attempt and at most 2,048 output tokens. These limits bound work; they are not token or monetary quotas. Stop reasons distinguish exhausted actions, model requests, time, unreachable frontiers and insufficient budget to travel to a remaining branch. `coverage_complete` remains false.

## Responsive coverage

| Profile | Chromium viewport |
| --- | --- |
| `desktop` (default) | 1920 × 1080 |
| `tablet` | 768 × 1024 |
| `mobile` | 390 × 844 |

Choose a profile beside the URL in the workspace, or set `SCOUT_EXPLORER_VIEWPORT`. For all three profiles:

```sh
.tools/bin/just explore-matrix http://exploration-fixture:8082/responsive
```

The matrix runs the three profiles at once. Each has its own browser, run ID, graph, screenshots and usage. There is no shared matrix job or combined coverage report. These are responsive Chromium layouts, not native-device, touch, Safari or Android validation. Reproduction inherits the source run's viewport.

## Inspecting the evidence

The Flow tab shows ranked candidates with their discovery paths, next-action and path scores, return cost and selection reason, followed by the discovery tree (each screen once, with the action that first reached it), depth and coverage per level with actions per strategy, and the full recorded graph. PostgreSQL stores the state/frontier projections and decision lineage. The immutable run manifest includes them. `exploration.selected`, `exploration.replanned`, `exploration.return_changed` and `exploration.compared` events export to ClickHouse with run/action/capture references. Model request/response payloads and token usage retain their existing durable records.

Run `just explorer-test` for real Chromium/storage checks with simulated models. Coverage includes dead-end return, route costs and cycles, refreshed scores, changed-control priority, one-pixel mask intersections, covered controls, per-page stale-plan recovery, five-leaf repeated returns, deferred-page exits, local tool-error and timeout recovery, the time limit, controls revealed further down the page (and a covered one skipped), memory recording, a resumed page with exact replay, memory-free runs and per-viewport scopes, all three viewports, and fresh replay through a return path. The end-to-end planner record is written to `artifacts/exploration-planner/verification.json`. `just workspace-test` checks profile admission and the queued worker; `just web-contract-test` checks templates against persisted results. Browser layout/interaction verification remains unverified because computer-use access was restricted.

Native text/search entry, dropdown selection, checkbox/radio changes and document scrolling now use the same planner; see [browser interactions](./interactions.md). Remaining work includes live-model quality evaluation and score calibration, larger and semantic planning projections that preserve exact evidence, form submission and keyboard/custom widgets, credential handoff, timed settling, automatic reproduction scheduling, resumable exploration, multi-worker scheduling and broader isolation. The current browser limit is 120 observed controls per page, with model context also bounded; this is not exhaustive coverage of large or continuously changing pages. Memory weights are engineering defaults, not fitted against real runs.
