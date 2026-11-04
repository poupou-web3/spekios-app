# Browser interactions

The explorer acts only through typed commands on observed controls (`browser-interactions-v2`). The planner, recorded graph, evidence pipeline and fresh-browser replay all use the same commands.

## Supported actions

| Command | Observed target | Parameters and limits |
| --- | --- | --- |
| `navigate` | Original entry URL, or a permitted recorded page | Initial navigation, a return to the entry URL, or a resume/recovery navigation |
| `click` | Visible native button or link | Existing control ID; unique accessible name |
| `fill` | Native text/search input or textarea | Synthetic plain text, up to 500 characters and the field's `maxlength`; empty string clears; control characters and line breaks rejected |
| `select` | Native single-select dropdown | Exact enabled observed option value; duplicate values and choices requiring access/payment/destructive actions rejected |
| `set_checked` | Native checkbox or radio | Explicit boolean; radios can only be selected, not unchecked |
| `submit` | Observed native form submitter | Same-origin search or operator-configured exact test form; native validation preserved. See [form permissions](./action-outcomes.md#form-permissions) |
| `scroll` | Observed document scroll affordance | Up or down by up to 80% of the viewport, clamped to the document extent; target coordinates come from the recorder |

The model proposes a control ID, typed action, goal, likelihood score and expected result. A proposal for a button or link may omit the action and is treated as a click; other types require their parameters. Models cannot send selectors, JavaScript, arbitrary coordinates, keystrokes or additional fields. (Meta [computer-use recovery](./computer-use.md) is a separate, bounded exception.)

Before dispatch, a fresh observation must match the planning state. The worker revalidates the command against the observed control and its options, and requires a unique native role/name locator. Dropdown labels exclude their nested option text. Covered, disabled, unnamed or ambiguous controls are recorded as unavailable. Scrolling can reveal new controls, which become candidates on the next planning pass.

## Evidence and replay

Each action keeps its exact typed parameters, prediction, action UUID, before/after capture UUIDs, image differences, model assessment and usage. Text values, selected option values, checkbox/radio state and scroll position are part of state identity. An action with no visible change is still assessed.

Screenshots hide the caret and hold CSS animations on their initial frame; the run records `screenshot_caret: "hide"`, `screenshot_animations: "disabled"`, reduced motion, and a clock paused for the screenshot and DOM read. A caret blink or CSS spinner does not by itself invalidate a plan. Visible text that keeps changing can still reach the completion deadline and make the action inconclusive.

[Fresh reproduction](./reproduction.md) preserves the original values, booleans, scroll targets, expected results and viewport. It validates each control against fresh evidence, runs the recorded path once and assesses every step. Changed preconditions are inconclusive. Reproduction does not guess replacement inputs or add submissions to repair a path. Recorded submissions replay their exact parameters, subject to current form permissions.

The workspace timeline labels fill/select/check/uncheck actions, and **Inspect action** shows the exact parameters.

## Observation and prompt bounds

The recorder observes at most 120 controls across the whole document, keeping room for document scroll controls: controls in the viewport first, then the nearest ones further down. A control further down has `in_viewport: false`, its document `page_y` and no rectangle. When one is chosen, the runtime scrolls the document so it sits a third of the way down the viewport before the before capture and records `action.revealed`; the planner treats that scroll as part of the same action. Controls in nested scrolling containers, off-canvas content and fixed elements outside the viewport are not observed. Ambiguity is checked across the whole document. Up to 20 dropdown options are recorded, with omissions marked. Password, email and telephone fields and controls with credential or payment context are blocked, and their values are omitted from structured observations. This is not screenshot redaction: private screenshots still contain what the app displays.

The model receives bounded projections of those observations. Control and option IDs and values needed for selection stay exact; omitted controls/options and shortened URLs are marked. A model may select only controls and options supplied in its prompt; the command is then rebuilt from the full recorded control. Requests are fitted below the gateway's 64 KiB prompt limit by shortening page text, control lists and history together; the chosen `context_scale` is recorded. Stored evidence is never rewritten to fit.

These rules apply to every target. Input and change handlers in the target app may react immediately. Isolation from Spekios itself comes from the browser sandbox container, not from this contract.

## Run and verify

With a configured provider:

```sh
just fixture
just explore http://exploration-fixture:8082/interactions
just explore-matrix http://exploration-fixture:8082/interactions
just explore http://exploration-fixture:8082/scrolling
```

`just explorer-test` includes the real-browser interaction tests (`test/interactions.test.ts`) with simulated providers: label resolution, typed argument validation, text/option/checked state, protected controls, unchecking, offscreen discovery, bounded form context and replay with exact parameters. Its CLI verifier exercises the form flow at all three viewports and writes `artifacts/browser-interactions/verification.json`.

## Not built yet

Enter/Tab and other keyboard shortcuts, file uploads, custom dropdowns and contenteditable widgets, nested or horizontal scrolling, iframes, dialogs and downloads. Account creation and payment are not model actions.
