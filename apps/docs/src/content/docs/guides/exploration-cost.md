---
{
  "title": "Spend fewer model calls per exploration",
  "description": "Reuse a screen's ranking from earlier runs when it has not changed, and send navigation to a cheaper model while state-changing actions keep the full assessment.",
  "reviewed": "2026-11-04",
  "sidebar": {"order": 9}
}
---
Most of an exploration's cost is model calls. Each action normally needs a ranking of the screen and an assessment of the result, and each trip back to an earlier screen adds a prediction. Two settings reduce that cost without changing what evidence is recorded.

## Reuse unchanged rankings

With **Reuse a screen’s ranking from earlier runs when it hasn’t changed** on (the default, under **Settings → Models → Cost controls**), a run that reaches a screen an earlier run already ranked uses that ranking instead of asking the model again. It needs [app memory](../app-memory/). Without memory, every screen is ranked fresh.

A ranking is reused only when all of these hold:

- **The screen matches.** It has the same address pattern (**/orders/:n**), title and text. Numbers, dates and clock times may differ. Every control must be in the same state: enabled or disabled, checked, filled, invalid. For example, a form showing a validation message is ranked again.
- **The model matches.** It is the same provider and model.
- **It is the first visit.** This is the run's first visit to that screen. Later visits in the same run are ranked fresh, as before.
- **No focus.** No [testing focus](../testing-focus/) is pending or active.
- **It was reused fewer than 10 times.** The next visit asks the model again and replaces the stored ranking, so rankings follow changes to the app and the model.

Some rankings are never stored:

- rankings where the model chose to type text, because typed text is not kept;
- rankings of a screen whose control list was cut short;
- rankings made under a testing focus;
- rankings made after some controls on the screen were already tried.

A reused ranking is recorded as its own planning decision with status **reused**. It points to the earlier run and its model request, and makes no model request of its own. Actions chosen from it keep the full evidence: before and after screenshots, a prediction and an assessment. Their prediction is marked **reused_ranking**. Replays and reviews work as usual.

## Use a cheaper model for navigation

In **Settings → Models → Models in use**, choose a **Navigation model** from your model list to send navigation to a cheaper model. A project can choose its own navigation model under **Project models**, and an API run can send one with its `model`. Navigation means opening a URL (the entry page, a return to it, a remembered page), following a link and scrolling. The navigation model predicts and assesses these actions. Everything else keeps the exploration model:

- ranking the screen;
- clicks on buttons, form entry, selections, checkboxes and submissions;
- predictions for re-walks and returns that are not navigation.

The exploration model assesses a navigation action again when the navigation model:

- reports anything other than **no issue observed**;
- marks its expectation uncertain;
- runs while the page logged errors or requests failed;
- fails or returns an invalid answer.

The run then keeps the exploration model's assessment and records the navigation model's result as **screening**, with the reason. If the navigation model is not available when the run starts, the exploration model does everything and the run says why.

Free-only applies to an OpenRouter navigation model too: use **openrouter/free** or a model ID ending in **:free**.

## What a run records

The run configuration records:

- **model_tiers**: the navigation model, if any, and which actions it handles;
- **ranking_reuse**: whether reuse was on;
- **model_use**, when the run ends: planning requests made and reused, rankings stored, navigation-model requests, reassessments and fallbacks.

Each assessment has **model_tier**. Each model request keeps its provider and model, so reported tokens and cost show which model they came from.

With an action limit, a run with a navigation model allows up to `4 × actions + 6` model requests instead of `3 × actions + 6`, which leaves room for one reassessment per action. Reaching that cap stops the run with **model_request_budget_reached**.

## API

API clients save **reuse_rankings** (true or false) and **navigation_model** (`{"provider": "openrouter", "model": "vendor/small-model:free"}`, or null for one model) in their defaults with **POST /v1/exploration-settings**. A job keeps the values it was admitted with.
