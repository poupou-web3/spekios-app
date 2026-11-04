// Process log lines for the browser worker: one JSON object per line on stdout,
// shipped to the back office Logs tab by the log collector (docs/platform/logs.md).
// Lines carry identifiers, states, counts and error classes only. Target-site
// text, URLs, prompts, model output and credentials never reach process output.
// Off unless the worker turns it on, so CLI commands keep a clean stdout.
export type LogLevel = 'debug' | 'info' | 'warning' | 'error';
type Value = string | number | boolean | null | undefined;

let enabled = false;
export function enableProcessLog(on = true) { enabled = on; }

export function log(level: LogLevel, msg: string, fields: Record<string, Value> = {}) {
  if (!enabled) return;
  const line: Record<string, Value> = { level, msg };
  for (const [key, value] of Object.entries(fields)) if (value !== undefined && value !== null) line[key] = value;
  process.stdout.write(JSON.stringify(line) + '\n');
}

// Runtime events copy these payload keys when the value is a number, a boolean
// or a short machine token (UUIDs, enums, model names). Free text never matches.
const EVENT_KEYS = ['kind', 'request_id', 'decision_id', 'call_id', 'model_tier', 'stop_reason', 'executed_actions', 'planned_actions',
  'replayed_actions', 'max_actions', 'attempt', 'candidates', 'coverage_complete', 'changed_pixels', 'reason', 'execution_mode',
  'recovered', 'reused_from', 'source_action_id', 'source_run_id', 'verification_id', 'reproduction_id', 'child_job_id', 'worker_id'];
const TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const QUIET = new Set(['action.settling_frame', 'capture.available', 'state.observed', 'action.evidence_recorded']);

function token(value: unknown): Value {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return typeof value === 'string' && TOKEN.test(value) ? value : undefined;
}

export function eventFields(payload: unknown): Record<string, Value> {
  const fields: Record<string, Value> = {};
  if (!payload || typeof payload !== 'object') return fields;
  const record = payload as Record<string, unknown>;
  for (const key of EVENT_KEYS) {
    const value = token(record[key]);
    if (value !== undefined) fields[key] = value;
  }
  const verdict = token((record.assessment as Record<string, unknown> | undefined)?.verdict);
  if (verdict !== undefined) fields.verdict = verdict;
  return fields;
}

export function eventLevel(type: string): LogLevel {
  if (QUIET.has(type)) return 'debug';
  if (type === 'run.failed') return 'error';
  if (/\.(failed|evidence_failed|interrupted)$/.test(type) || type.endsWith('_unavailable')) return 'warning';
  return 'info';
}
