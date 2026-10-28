import type { ObservedControl } from './contracts.js';
import { actionRisk } from './interaction-contract.js';

export type TestFormRule = { action_url: string; method: 'get'|'post'; submitter: string };

// Permissions come from the operator's configuration, never from page content
// or the model. Exact action URL + method + submitter; no wildcards.
export function testFormRules(raw = process.env.SCOUT_TEST_FORM_RULES ?? '[]'): TestFormRule[] {
  const rules: unknown = JSON.parse(raw);
  if (!Array.isArray(rules) || rules.length > 20) throw new Error('Expected at most twenty test form rules.');
  for (const rule of rules) {
    if (!rule || Object.keys(rule).sort().join(',') !== 'action_url,method,submitter' || !['get','post'].includes(rule.method)
      || typeof rule.submitter !== 'string' || !rule.submitter.trim() || rule.submitter.length > 200) throw new Error('Invalid test form rule.');
    const url = new URL(rule.action_url);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.href !== rule.action_url
      || url.href.length > 2048) throw new Error('Test form rules require an exact HTTP action URL without credentials, query or fragment.');
  }
  return rules;
}

export function authorizeForm(control: ObservedControl, origin: string, rules: TestFormRule[]): ObservedControl {
  const form = control.form;
  if (!form) return control;
  form.authorization = null;
  let url: URL;
  try { url = new URL(form.action); } catch { return control; }
  if (form.unsafe || !['get','post'].includes(form.method) || !['','_self'].includes(form.target)
    || url.origin !== origin || url.username || url.password || url.hash || url.href.length > 2048
    || actionRisk(control.name+' '+form.action)) return control;
  if (rules.some(rule => rule.action_url === url.href && rule.method === form.method && rule.submitter === control.name)) form.authorization = 'configured_test_form';
  else if (form.search && form.method === 'get') form.authorization = 'search';
  return control;
}
