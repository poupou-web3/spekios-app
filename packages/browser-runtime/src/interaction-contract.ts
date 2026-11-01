import type { BrowserCommand, ControlAction, ObservedControl } from './contracts.js';

export const INTERACTION_VERSION = 'browser-interactions-v2';

export function actionRisk(label: string): string|null {
  if (/\b(log[ -]?in|sign[ -]?in|sign[ -]?up|register|password|credentials|authenticate|connect wallet)\b/i.test(label)) return 'credentials_required';
  if (/\b(pay|buy|purchase|checkout|subscribe|upgrade|billing|donate|trade|swap|transfer|withdraw)\b/i.test(label)) return 'payment_or_transaction_requires_handoff';
  if (/\b(delete|remove|erase|destroy|reset|revoke|send|publish|invite|disconnect)\b/i.test(label)) return 'potentially_destructive_or_external_action';
  return null;
}

// Validate model proposals and stored replay commands with the same contract.
// Inputs are plain text and observed option values, never executable selectors.
export function controlAction(control: ObservedControl, value?: unknown): ControlAction {
  if (value === undefined && ['button','link'].includes(control.role)) value = {type:'click'};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A typed interaction is required for this control.');
  const action = value as Record<string, unknown>;
  const keys = action.type === 'fill' || action.type === 'select' ? ['type','value'] : action.type === 'set_checked' ? ['checked','type'] : ['type'];
  if (Object.keys(action).sort().join(',') !== keys.sort().join(',')) throw new Error('Interaction has unsupported fields.');
  if (control.sensitive || control.read_only || control.unsupported || control.disabled || control.ambiguous || control.occluded
    || (control.submits_form && (action.type !== 'submit' || !control.form?.authorization || control.form.unsafe))) throw new Error('Control does not permit this interaction.');
  switch (action.type) {
    case 'submit':
      if (control.role !== 'button' || !control.submits_form || !control.form?.authorization) break;
      return {type:'submit'};
    case 'click':
      if (!['button','link'].includes(control.role)) break;
      return {type:'click'};
    case 'fill':
      if (!['textbox','searchbox'].includes(control.role) || !['text','search','textarea'].includes(control.input_type ?? '')) break;
      if (typeof action.value !== 'string' || action.value.length > Math.min(500,control.max_length ?? 500) || /[\u0000-\u001f\u007f]/.test(action.value)) throw new Error('Text input must be bounded plain text without control characters.');
      return {type:'fill',value:action.value};
    case 'select': {
      const matches = control.options?.filter(option => option.value === action.value) ?? [];
      if (control.role !== 'combobox' || typeof action.value !== 'string' || action.value.length > 200 || matches.length !== 1 || matches[0].disabled || actionRisk(matches[0].label+' '+matches[0].value)) throw new Error('Select requires one enabled, observed option value without a handoff requirement.');
      return {type:'select',value:action.value};
    }
    case 'set_checked':
      if (!['checkbox','radio'].includes(control.role) || typeof action.checked !== 'boolean' || (control.role === 'radio' && !action.checked)) break;
      return {type:'set_checked',checked:action.checked};
    case 'scroll':
      if (control.role !== 'scroll' || !control.scroll_target || !['up','down'].includes(control.scroll_target.direction)
        || ![control.scroll_target.x,control.scroll_target.y].every(n=>Number.isFinite(n)&&n>=0)) break;
      return {type:'scroll'};
  }
  throw new Error('Interaction type does not match the observed control.');
}

const TYPE_MISMATCH = 'Interaction type does not match the observed control.';
const TYPE_REQUIRED = 'A typed interaction is required for this control.';

// One safe action for this control when a proposal names the wrong type.
// Submit is only returned when this control already permits that exact submit.
export function fallbackAction(control: ObservedControl): ControlAction | null {
  const attempt = (value: unknown) => { try { return controlAction(control, value); } catch { return null; } };
  switch (control.role) {
    case 'button': return attempt({type:'submit'}) ?? attempt({type:'click'});
    case 'link': return attempt({type:'click'});
    case 'checkbox': return attempt({type:'set_checked', checked: control.checked !== true});
    case 'radio': return attempt({type:'set_checked', checked: true});
    case 'scroll': return attempt({type:'scroll'});
    case 'combobox': {
      const option = control.options?.find(item => !item.disabled && !actionRisk(item.label + ' ' + item.value));
      return option ? attempt({type:'select', value: option.value}) : null;
    }
    case 'textbox':
    case 'searchbox': return attempt({type:'fill', value:'sample'.slice(0, Math.min(500, control.max_length ?? 500))});
    default: return null;
  }
}

// Keep a proposal that names the wrong type by substituting that fallback.
// Ill-formed proposals and actions the control does not permit stay rejected.
export function resolveAction(control: ObservedControl, proposed?: unknown): ControlAction | null {
  try { return controlAction(control, proposed); }
  catch (error) {
    const reason = error instanceof Error ? error.message : '';
    if (reason === 'Interaction has unsupported fields.') throw error;
    if (reason !== TYPE_MISMATCH && reason !== TYPE_REQUIRED) return null;
    return fallbackAction(control);
  }
}

export function commandFor(control: ObservedControl, action?: unknown): BrowserCommand {
  return {...controlAction(control,action),control};
}

// A selected action that no longer fits the live control becomes its fallback,
// or nothing when no safe action remains. Callers skip that control and continue.
export function plannedCommand(control: ObservedControl | undefined, action?: unknown): BrowserCommand | null {
  if (!control) return null;
  const resolved = resolveAction(control, action);
  return resolved ? commandFor(control, resolved) : null;
}
export function commandAction(command: Exclude<BrowserCommand,{type:'navigate'}>): ControlAction {
  const {control:_control,...action}=command;
  return action;
}
export function commandKey(command: BrowserCommand) {
  return command.type === 'navigate' ? JSON.stringify(['navigate',command.url])
    : JSON.stringify([command.control.control_id,commandAction(command),command.control.scroll_target ?? null]);
}
