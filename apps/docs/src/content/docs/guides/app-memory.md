---
{
  "title": "Explore deeper across runs",
  "description": "How ScoutQA remembers which pages and controls earlier runs explored, skips repeats, reopens unfinished pages and lets you forget an app's memory.",
  "reviewed": "2026-10-30",
  "sidebar": {"order": 6}
}
---
Each exploration has a bounded action budget. With **app memory** on, the next run of the same app continues from what earlier runs learned. It doesn't repeat the same opening journey.

## What a later run does differently

- **Skips what was already tried.** Controls that earlier runs clicked, filled or selected rank lower. Controls that appear on a known page for the first time rank higher, so new or changed UI is explored early.
- **Reopens unfinished pages.** A page that an earlier run reached but did not finish can be opened directly, as one navigation, instead of replaying the clicks that led there. The Flow tab shows this as **Reopening a page from earlier runs**, and the action timeline as **Open remembered page**.
- **Tells the model what happened before.** The planning request lists earlier attempts on the current page and their last results. They are marked as untrusted hints. They never decide whether behavior is correct.

Every action still has a fresh prediction, before and after screenshots and an assessment. Memory only changes which action is chosen next.

## What is remembered

Memory is kept separately for each app origin, screen size (desktop, tablet, mobile), sign-in state (public or signed in) and test or live model mode. It records:

- Page addresses and titles.
- Control names, roles and links.
- How often earlier runs tried each control, its best model score and its last result.

Screenshots, field values and credentials are not stored in memory.

Scout reopens a remembered page only within the app's own origin. It never reopens addresses that look like sign-out, payment, deletion or other risky actions, or addresses with tokens, codes, keys, sessions or signatures in the query.

Reproductions, automatic rechecks and fix verification follow their recorded path exactly. They never use or change memory.

## Turn it on or off

Memory is on by default for explorations with a live model. Turn off **Remember explored pages and controls across runs** in **Settings → Exploration defaults** to explore without it. A run with memory off neither reads nor records it. Runs with simulated test models use memory only when the job explicitly asks for it, so repeated test runs stay independent.

Agents and API clients can override the default for one exploration with `app_memory: false` (or `true`) when starting it.

The run heading shows which applies: **Fresh exploration**, **First remembered run** or **Guided by N earlier runs**.

## Forget an app

**Settings → App memory** lists each remembered app, screen size and sign-in state. It shows the number of runs, pages, and tried and untried controls. **Forget** deletes that memory only. Recorded runs, screenshots, findings and issues stay.

A memory that a running test is still using can't be forgotten until the run ends.

## Limits

Memory guides choices; it does not prove coverage. Pages are identified by their exact address, so pages with changing query values are remembered separately. The scoring weights are engineering defaults, not fitted to real apps. See [how exploration chooses a path](../../product/exploration/) for budgets and stopping rules.
