# Browser interactions

Extended on 25 October 2026 as `browser-interactions-v2`; see [action completion and form journeys](./action-outcomes.md). The original interaction increment was implemented on 23 October. The URL explorer can now fill text/search fields, choose native dropdown options, change checkboxes/radios, and scroll the document. The planner, recorded graph, evidence pipeline and fresh-browser replay use the same typed commands.

## Supported actions

| Command | Observed target | Parameters and limits |
| --- | --- | --- |
| `navigate` | Original allowed entry URL | Initial navigation or a recorded return to that entry URL |
| `click` | Visible native button or link | Existing control ID; unique accessible name |
| `fill` | Native text/search input or textarea | Synthetic plain text, up to 500 characters and the field's `maxlength`; empty string clears; control characters and line breaks rejected |
| `select` | Native single-select dropdown | Exact enabled observed option value; duplicate values and choices requiring access/payment/destructive actions rejected |
| `set_checked` | Native checkbox or radio | Explicit boolean; radios can only be selected, not independently unchecked |
| `submit` | Observed native form submitter | Same-origin search or operator-configured exact test form; native validation preserved |
| `scroll` | Observed document scroll affordance | Up/down by up to 80% of the viewport, clamped to the observed document extent; target coordinates come from the recorder |

The model proposes a control ID, typed action, goal, likelihood score and expected result. Click proposals from older fixtures remain supported without an explicit action object. New interaction types require their action parameters. Models cannot send selectors, JavaScript, arbitrary coordinates, keystrokes or additional fields.

Before dispatch, a fresh observation must match the planning state. The worker revalidates the command against the observed control and its options, and requires a unique native role/name locator. Dropdown labels exclude their nested option text. Covered, disabled, unnamed or ambiguous controls are recorded as unavailable. Scrolling can reveal new controls, which become candidates on the next planning pass.

## Evidence and replay

Each action retains its exact typed parameters, prediction, action UUID, before/after capture UUIDs, image differences, model assessment and usage. Text values, selected option values, checkbox/radio state and scroll position participate in state identity. A lack of visible change still triggers assessment.

Screenshots now hide the blinking text caret using Playwright's screenshot setting. The run records `screenshot_caret: "hide"`; the remaining screenshot pixels and one-pixel differences are preserved. This prevents a caret blink alone from repeatedly invalidating a text-entry plan. Other animations remain visible; continuous changes can now reach the completion deadline and stop exploration as inconclusive.

Fresh reproduction preserves the original values, booleans, scroll targets, expected results and viewport. It validates each control against fresh evidence, runs the recorded path once and separately assesses every step. Changed preconditions remain inconclusive. Reproduction does not guess replacement inputs or add submissions to repair a path. Recorded permitted submissions replay their exact parameters, subject to current permissions.

The GUI labels fill/select/check/uncheck actions in the timeline. **Inspect action** exposes exact parameters; Operations shows model requests and ordered events. Screenshot bytes, masks and manifests remain in the private bucket. Runtime events export to ClickHouse, and provider calls retain their request/response and usage records.

## Observation and prompt bounds

The recorder observes at most 120 controls across the whole document, reserving room for document scroll controls: controls in the viewport first, then the nearest ones further down. A control further down has `in_viewport: false`, its document `page_y` and no rectangle. When one is chosen, the runtime scrolls the document so it sits a third of the way down the viewport before the before capture and records `action.revealed`; the planner treats that scroll as part of the same action, not as drift. Controls in nested scrolling containers, off-canvas content and fixed elements outside the viewport are not observed. Ambiguity is checked across the whole document, matching how dispatch resolves controls. It records up to 20 bounded dropdown options and marks omissions. Long field values and names remain explicitly bounded. Password/email/telephone fields and controls with credential/payment context remain blocked; their values are omitted from structured control observations. This is not screenshot redaction: the existing private screenshots still contain what the test app displays.

The model receives bounded projections of those observations. Control and option IDs/values needed for selection remain exact; omitted controls/options and shortened URLs are marked. A model may select only controls/options actually supplied in its planning prompt. The command is then reconstructed from the full recorded control. Requests are fitted below the gateway's 64 KiB UTF-8 prompt limit by shortening page text, control lists and history together; the chosen `context_scale` is part of the request. Full stored evidence is not rewritten to fit the prompt.

These controls apply to every admitted target: public https sites and allowed origins. Unapproved form submission, Enter/Tab shortcuts, account creation, payments, file uploads, custom dropdowns/contenteditable widgets, nested/horizontal scrolling, iframes, dialogs and downloads remain unsupported. Input/change handlers in the target app may react immediately. Isolation from Scout itself comes from the browser sandbox container, not from this contract.

The queued worker separately supports [private human login and saved app sessions](./private-login.md). Its human-only input controls do not expand the model tool surface.

## Run and verify

With a configured provider and the fixture origin allowed:

```sh
.tools/bin/just fixture
.tools/bin/just explore http://exploration-fixture:8082/interactions
.tools/bin/just explore-matrix http://exploration-fixture:8082/interactions
.tools/bin/just explore http://exploration-fixture:8082/scrolling
```

`just explorer-test` runs the existing explorer/reproduction cases plus real-browser interaction tests with simulated providers. They cover native label resolution, typed argument validation, text/option/checked state, protected controls, unchecking, offscreen discovery, bounded form context and fresh replay with exact parameters. The CLI verifier exercises the form flow at all three viewports, replays seeded form/scroll failures, reads back bucket hashes and manifests, and checks ClickHouse events and usage.

Saved examples and verification results are written to `artifacts/browser-interactions/verification.json`. `just web-contract-test` checks GUI templates against those persisted runs without controlling a browser. Live-model quality and visual GUI interaction validation remain separate, unverified checks.
