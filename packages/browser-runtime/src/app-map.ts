import { createHash } from 'node:crypto';
import type { BrowserCommand, Capture, ControlAction, ObservedControl } from './contracts.js';
import { stabilizeText, type Proposal } from './exploration-policy.js';
import { controlAction } from './interaction-contract.js';

// The app map is the exploration tree carried between runs. Exact screens
// stay per-run evidence; the map keys what is stable across runs and data:
// the page template, the controls a state offers, and what was done.
export const MAP_VERSION = 'app-map-v1';
const MAX_MAP_CONTROLS = 200;
const key = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Identifier-like path segments and query values become placeholders, so
// /orders/123?page=2 and /orders/456?page=3 share /orders/:n?page=:n.
function placeholder(part: string): string {
  if (/^\d+$/.test(part)) return ':n';
  if (UUID.test(part) || /^[0-9a-f]{16,}$/i.test(part) || (part.length >= 20 && /\d/.test(part) && /^[\w-]+$/.test(part))) return ':id';
  return part.slice(0, 80);
}
export function pageTemplate(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { return raw.slice(0, 2048); }
  if (!['http:', 'https:'].includes(url.protocol)) return url.protocol;
  const path = url.pathname.split('/').map(placeholder).join('/');
  const keys = [...new Set(url.searchParams.keys())].sort();
  const query = keys.map(name => `${name}=${placeholder(url.searchParams.get(name) ?? '')}`).join('&');
  return (url.origin + path + (query ? '?' + query : '')).slice(0, 2048);
}

export type MapControl = { key: string; role: string; name: string; href: string | null; repeated: boolean };
// A link into a templated route (a product card, an order row) is one entry
// however many of them the page lists; any other control is its own entry.
export function controlEntry(control: Pick<ObservedControl, 'role' | 'name' | 'href'>): MapControl {
  const href = control.href ? pageTemplate(control.href) : null;
  const repeated = !!href && /\/:(n|id)(\/|$|\?)/.test(href);
  const name = repeated ? '*' : stabilizeText(control.name ?? '').trim().toLowerCase().slice(0, 200);
  return { key: key(['control', control.role, name, href]), role: control.role, name: repeated ? control.name.slice(0, 200) : control.name.slice(0, 200), href, repeated };
}

export type MapState = { key: string; page_template: string; title: string | null; controls: MapControl[]; controls_truncated: boolean };
// A state is its page template, sign-in presence and the entries it offers.
// Text and counts are excluded, so the same screen with new data matches.
export function mapState(capture: Capture): MapState {
  const o = capture.observation, template = pageTemplate(o.url);
  const entries = new Map<string, MapControl>();
  for (const control of o.controls ?? []) if (control.role !== 'scroll') {
    const entry = controlEntry(control);
    if (!entries.has(entry.key)) entries.set(entry.key, entry);
  }
  const controls = [...entries.values()].sort((a, b) => a.key.localeCompare(b.key));
  return { key: key(['state', template, !!o.auth_context_id, controls.map(c => c.key)]), page_template: template,
    title: o.title?.slice(0, 300) ?? null, controls: controls.slice(0, MAX_MAP_CONTROLS),
    controls_truncated: controls.length > MAX_MAP_CONTROLS || !!o.controls_truncated };
}

// What was done, independent of typed text: the action, the control entry,
// and a chosen option or checkbox value. Navigation keys its page template.
export function transitionKey(command: BrowserCommand): { key: string; entry: string | null } {
  if (command.type === 'navigate') return { key: key(['navigate', pageTemplate(command.url)]), entry: null };
  const entry = controlEntry(command.control).key;
  const choice = command.type === 'select' ? command.value : command.type === 'set_checked' ? command.checked : null;
  return { key: key([command.type, entry, choice]), entry };
}

// Rankings carried between runs. A later run that reaches the same screen can
// reuse what the model ranked there instead of asking again. The signature is
// stricter than a map state: title, text (numbers, dates and times
// normalized) and each control's state count too, so a form with and without
// a validation message, or before and after it is filled, is ranked anew.
export const RANKING_VERSION = 'ranking-v1';
export type StoredProposal = { entry_key: string; action: ControlAction; goal: string; expected_result: string; likelihood: number };
export function screenSignature(capture: Capture): string | null {
  const o = capture.observation;
  if (o.observation_error || o.controls_truncated || !/^https?:/.test(o.url)) return null;
  const controls = [...new Set((o.controls ?? []).map(c => JSON.stringify([controlEntry(c).key, c.disabled, !!c.occluded, c.in_viewport !== false,
    c.checked ?? null, !!c.value, !!c.validation_message, c.form?.authorization ?? null, c.options?.map(option => [option.value, option.disabled]) ?? null])))].sort();
  return key(['ranking', RANKING_VERSION, pageTemplate(o.url), !!o.auth_context_id, stabilizeText(o.title ?? ''),
    stabilizeText(o.text ?? '').replace(/\d+/g, '#'), !!o.text_truncated, controls]);
}
// What can be stored: every proposal keyed by its control entry. Typed text
// is never kept, so a ranking that fills a field is asked again next time.
export function rankingEntries(proposals: Proposal[], controls: readonly ObservedControl[]): StoredProposal[] | null {
  if (!proposals.length) return null;
  const stored: StoredProposal[] = [];
  for (const p of proposals) {
    const control = controls.find(c => c.control_id === p.control_id);
    if (!control || !p.action || p.action.type === 'fill') return null;
    stored.push({ entry_key: controlEntry(control).key, action: p.action, goal: p.goal, expected_result: p.expected_result, likelihood: p.likelihood });
  }
  return stored;
}
// Maps a stored ranking onto this screen's available controls. Proposals
// whose control is gone, already tried or no longer permits the action drop out.
export function restoreRanking(stored: readonly StoredProposal[], available: readonly ObservedControl[]): Proposal[] {
  const used = new Set<string>();
  return stored.flatMap(p => {
    const control = available.find(c => !used.has(c.control_id) && controlEntry(c).key === p.entry_key);
    if (!control) return [];
    try {
      const action = controlAction(control, p.action);
      used.add(control.control_id);
      return [{ control_id: control.control_id, goal: p.goal, expected_result: p.expected_result, likelihood: p.likelihood, action }];
    } catch { return []; }
  }).sort((a, b) => b.likelihood - a.likelihood).slice(0, 8);
}
