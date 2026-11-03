export type Expectation =
  | { kind: 'url_equals'; value: string }
  | { kind: 'text_equals'; testId: string; value: string }
  | { kind: 'attribute_equals'; testId: string; attribute: string; value: string };

export type ActionSpec = {
  command: { type: 'navigate'; url: string } | { type: 'click'; button: string };
  prediction: { source: 'fixture_defined'; description: string; expected: Expectation };
};
export type Assessment = {
  check_id: string;
  method: 'deterministic-fixture-v1';
  verdict: 'no_issue_observed' | 'suspect' | 'inconclusive';
  expected: Expectation;
  actual: string | null;
  reason: string;
  tool_error: string | null;
  confirmed_bug: false;
};
export type Observation = {
  auth_context_id?: string;
  url: string; title: string | null; text: string | null; text_truncated: boolean | null; scroll: { x: number; y: number } | null;
  viewport: { width: number; height: number }; device_scale: number | null;
  observed_value: string | null; observed_at: string; screenshot_started_at: string;
  screenshot_finished_at: string; observation_error: string | null;
  controls?: ObservedControl[];
  controls_truncated?: boolean;
};
export type ObservedControl = {
  control_id: string; role: 'button' | 'link' | 'textbox' | 'searchbox' | 'combobox' | 'checkbox' | 'radio' | 'scroll' | 'visual'; name: string; href: string | null;
  disabled: boolean; submits_form: boolean; ambiguous: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  occluded?: boolean;
  // Controls further down the document are observed without a viewport rect.
  // Occlusion is only known after the runtime scrolls one into view.
  in_viewport?: boolean; page_y?: number;
  input_type?: string; read_only?: boolean; sensitive?: boolean; unsupported?: boolean;
  value?: string; value_truncated?: boolean; max_length?: number; checked?: boolean;
  options?: { value: string; label: string; disabled: boolean }[]; options_truncated?: boolean;
  scroll_target?: { x: number; y: number; direction: 'up' | 'down' };
  validation_message?: string;
  form?: { action: string; method: string; target: string; search: boolean; unsafe: boolean;
    authorization: 'search' | 'configured_test_form' | null; signature: string };
};
export type ControlAction = { type: 'click' } | { type: 'fill'; value: string } | { type: 'select'; value: string }
  | { type: 'set_checked'; checked: boolean } | { type: 'scroll' } | { type: 'submit' }
  | {type:'computer';action:import('./computer-use.js').ComputerAction;screenshot_sha256:string};
export type BrowserCommand = { type: 'navigate'; url: string } | (ControlAction & { control: ObservedControl });
export type Capture = {
  schema_version: 1;
  capture_id: string; run_id: string; action_id: string; phase: 'before' | 'after';
  sha256: string; object_key: string; metadata_key: string; byte_length: number; observation: Observation;
  purpose: 'runtime_validation' | 'exploration'; training_status: 'excluded_fixture' | 'unreviewed';
};
// Explorations have no limit unless the user configures one; these cap a
// configured limit (executed actions include navigation and returns).
export const MAX_EXPLORATION_ACTIONS = 10_000;
export const MAX_EXPLORATION_MINUTES = 10_080;
// Replays follow a recorded prefix and keep their own bound: at most 50 steps
// within 100 recorded ordinals, which also count skipped plans and reveals.
export const MAX_REPLAY_STEPS = 50;
export const MAX_REPLAY_ORDINAL = MAX_REPLAY_STEPS * 2;
export const workspaceId = '00000000-0000-4000-8000-000000000001';
export const userId = '00000000-0000-4000-8000-000000000002';
export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);

export function validatePlan(url: string, specs: ActionSpec[]): ActionSpec[] {
  const target = new URL(url);
  // This recorder is confined to the in-process fixture and launches Chromium
  // beside it. Target apps run through the explorer and the browser sandbox.
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.username || target.password) {
    throw new Error('This development recorder accepts only a local controlled fixture URL.');
  }
  if (!Array.isArray(specs) || specs.length < 1 || specs.length > 10) throw new Error('Expected 1–10 recorded actions.');
  const frozen = structuredClone(specs);
  for (const spec of frozen) {
    if (spec.prediction?.source !== 'fixture_defined' || !spec.prediction.description?.trim()) throw new Error('A sourced prediction is required before acting.');
    const expected = spec.prediction.expected;
    if (!expected || !['url_equals', 'text_equals', 'attribute_equals'].includes(expected.kind) || typeof expected.value !== 'string' || expected.value.length > 2000) throw new Error('Unsupported expectation.');
    if (expected.kind !== 'url_equals' && !/^[a-zA-Z0-9_-]{1,100}$/.test(expected.testId)) throw new Error('Invalid expectation target.');
    if (expected.kind === 'attribute_equals' && !/^data-[a-z0-9-]{1,100}$/.test(expected.attribute)) throw new Error('Only data attributes are supported.');
    if (spec.command?.type === 'navigate') {
      if (new URL(spec.command.url).origin !== target.origin) throw new Error('Navigation leaves the allowed fixture origin.');
    } else if (spec.command?.type !== 'click' || typeof spec.command.button !== 'string' || !spec.command.button.trim() || spec.command.button.length > 200) {
      throw new Error('Unsupported browser action.');
    }
  }
  return frozen;
}
