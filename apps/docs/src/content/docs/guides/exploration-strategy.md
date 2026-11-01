---
{
  "title": "Share a run between breadth, depth and re-walks",
  "description": "Each exploration shares its actions between new territory, deep journeys and re-walking paths earlier runs recorded. Set the split, and read depth and coverage per level.",
  "reviewed": "2026-11-01",
  "sidebar": {"order": 8}
}
---
Every exploration shares its actions between three strategies:

| Strategy | What it does | One turn |
| --- | --- | --- |
| **New territory** (breadth) | Tries controls no run has tried, spread across the app's areas. | One new control, plus any steps needed to reach it. |
| **Deep journeys** (depth) | Follows one path, such as a sign-up or checkout, while it keeps reaching new screens. | Until a step makes no progress, the next step needs a return trip, or the journey reaches its step limit. |
| **Re-walk known paths** (rewalk) | Repeats an action earlier runs recorded in the [app map](../app-memory/#the-app-map) and compares where it leads and what it shows now. | One recorded action, plus any steps needed to reach it. |

The default split is 50% new territory, 30% deep journeys and 20% re-walks. Steps taken to get back to an earlier screen count toward the strategy that asked for them.

## When a journey ends

A journey goes on while each step makes progress:

- it reaches a screen this run has not reached yet;
- or it fills a field, chooses an option or changes a checkbox, so a form moves forward.

Scrolling, a small change that leaves the same controls, and a step back to a screen the run already reached end the journey. So does a next step that needs a return trip.

A journey takes at most 12 steps. With an action limit, it is also held to its share of the limit, at least 2 steps: with the default 30% and a limit of 6 actions, a journey takes at most 2 steps. Without this, one journey could use a short run's whole budget, and the discovery tree would be a single chain.

## How turns are chosen

Each strategy has a share of the run's actions. After every action, the strategy furthest below its share takes the next turn. A strategy with nothing to do is skipped and does not build up turns it could not take; the others share its part. Re-walks need app memory and at least one earlier run of the same app, screen size and sign-in state.

With **Adapt shares during a run** on (the default), shares follow what each strategy finds:

- A screen no run of the app has reached is worth the most.
- So is a different outcome on a re-walk: the action now leads to another screen, or its result changed between no issue and suspected bug.
- A suspected bug adds to either.
- A screen new to this run, or a re-walk that matches earlier runs, is worth a little.

Recent actions count most. A strategy that stops finding anything keeps at least a quarter of its share, so a slow start never shuts it out.

## New territory spreads across areas

In a browser, strict breadth-first exploration would cost a return trip for almost every action. Instead, new territory counts the actions spent in each top-level area, meaning each screen one step from the entry page and everything found from it. An area can use six actions, or its fair share of the run so far if that is larger, before its controls lose priority to areas that have had less.

New territory also gives lower priority to controls that only repeat something already covered:

- another item of a list already tried on an equivalent screen;
- a control earlier runs tried on an equivalent screen.

It also goes back to screens whose remaining controls the model has not ranked yet. The model ranks at most eight controls per screen.

## Re-walks compare outcomes

A re-walk repeats clicks, form submissions allowed by your test-form rules, menu choices and checkbox changes. Typed text is not kept in the map, so text entry is not re-walked. Transitions whose last outcome was suspect or inconclusive, or that led to different screens before, go first. Each recorded action is re-walked at most once per run.

Every action on a screen equivalent to one earlier runs recorded is compared, whichever strategy chose it. The assessment sees what earlier runs observed, as a hint that may be stale; a difference alone is never reported as a bug. Each comparison is saved as an **exploration.compared** event, and [map-diff](../app-memory/#the-app-map) lists changed destinations and regressions across runs.

An active [testing focus](../testing-focus/) pauses re-walks until it is cleared.

## Depth and coverage per level

Depth is the number of screens from the entry page along the discovery tree. Scrolling, filling part of a form or closing a menu shows another view of the same screen, which keeps that screen's depth. The **Flow** tab shows:

- **Discovery tree**: each screen once, under the screen it was first reached from, with the action that reached it and how many of its controls were tried. A screen's other views are listed with it, and what was found from them appears under the screen.
- **Depth and coverage**: for each depth, the screens reached and how many of their usable controls were tried in any view. Blocked controls are counted separately.
- How many actions each strategy took and its current share.

With few actions the tree stays small: each action can add at most one screen. A consent banner or another one-way choice on the entry page also leaves the page's other choices unreachable for the rest of the run, because the run keeps one browser session.

When a run ends, its configuration keeps **strategy** (actions, turns, yield and shares per strategy, the longest journey and the journey step limit, and how many re-walked transitions matched or changed) and **coverage_by_depth**. The [app map](../app-memory/#the-app-map) reports the same per-depth coverage across all runs under **summary.by_depth**.

## Change the split

Open **Settings → Exploration defaults → Exploration strategy**. Enter whole percentages that add up to 100. New territory or deep journeys must have a share; set re-walks to 0 to turn them off. Turn off **Adapt shares during a run** to keep the split fixed. API clients send **exploration_strategy** with the settings, for example `{"breadth": 40, "depth": 40, "rewalk": 20, "adaptive": true}`.

A job keeps the split it was admitted with. Reproductions and fix verifications follow their recorded path and do not use a strategy.
