import { isDeepStrictEqual } from 'node:util';
import type { Page } from 'playwright';
import { hash, jsonBytes } from './store.js';
import type { Capture, ControlAction, ObservedControl } from './contracts.js';
import { actionRisk, controlAction } from './interaction-contract.js';
import { authorizeForm, testFormRules, type TestFormRule } from './form-policy.js';

function publicHostname(hostname: string): boolean {
  const host = hostname.replace(/\.$/, '').toLowerCase();
  if (!host || host.length > 253 || !host.includes('.') || host.includes(':')) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
  if (host === 'localhost' || ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'].some(suffix => host.endsWith(suffix))) return false;
  return host.split('.').every(label => /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/.test(label));
}

// Public https sites can be pasted and tested. Private, HTTP and internal hosts
// still need an exact entry in the operator allowlist. Hostname checks are not
// a resolved-address boundary.
export function publicHttpsOrigin(url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  return publicHostname(url.hostname);
}

function publicWebOrigin(url: URL): boolean {
  if ((url.protocol !== 'https:' && url.protocol !== 'wss:') || url.username || url.password || url.port) return false;
  return publicHostname(url.hostname);
}

function networkOrigin(url: URL): string | null {
  if (url.protocol === 'https:' || url.protocol === 'wss:') return `https://${url.host}`;
  if (url.protocol === 'http:' || url.protocol === 'ws:') return `http://${url.host}`;
  return null;
}

// Subresources follow the page the operator opened: its own origin, public
// HTTPS, and public WSS. Sibling APIs, fonts and hosted backends are part of
// that page. The top-level document stays on the entry origin. A public page
// does not gain the operator's private allowlist.
export function permitBrowserRequest(pageOrigin: string, rawUrl: string, scope: 'main' | 'subresource', allowedOrigins: readonly string[] = []): boolean {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.username || url.password) return false;
  if (scope === 'main') return url.href === 'about:blank' || networkOrigin(url) === pageOrigin;
  if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
  if (url.href === 'about:blank' || url.href === 'about:srcdoc') return true;
  if (networkOrigin(url) === pageOrigin || publicWebOrigin(url)) return true;
  let page: URL;
  try { page = new URL(pageOrigin); } catch { return false; }
  if (publicHttpsOrigin(page)) return false;
  const target = networkOrigin(url);
  return target !== null && allowedOrigins.includes(target);
}

export function validateTarget(input: string, origins: string[]): string {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || input.length > 2048 ||
      !(origins.includes(url.origin) || publicHttpsOrigin(url))) throw new Error('Target must belong to an explicitly configured controlled-app origin.');
  return url.href;
}

export async function observeControls(page: Page, rules: TestFormRule[] = testFormRules()) {
  const candidates = await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll('button,a[href],input,textarea,select')).flatMap<Omit<ObservedControl,'control_id'>>(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      if (!rect.width || !rect.height || style.visibility !== 'visible' || style.display === 'none' ||
          rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return [];
      const input=element instanceof HTMLInputElement ? element : null;
      const textarea=element instanceof HTMLTextAreaElement ? element : null;
      const select=element instanceof HTMLSelectElement ? element : null;
      const field=input||textarea||select;
      const inputType=input?.type ?? (textarea?'textarea':select?'select':null);
      const role: ObservedControl['role'] = element instanceof HTMLButtonElement ? 'button' : element instanceof HTMLAnchorElement ? 'link'
        : inputType==='checkbox'?'checkbox':inputType==='radio'?'radio':select?'combobox':inputType==='search'?'searchbox'
        : ['submit','reset','button'].includes(inputType??'')?'button':'textbox';
      if (element.getAttribute('role') && element.getAttribute('role') !== role) return [];
      const labelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ');
      const labelText=field ? Array.from(field.labels??[]).map(label=>{
        // A wrapping label's name excludes the nested control's option/value
        // text. Including it would make a native select unresolvable by role.
        const copy=label.cloneNode(true) as HTMLElement;
        copy.querySelectorAll('input,textarea,select,button,script,style,[hidden],[aria-hidden="true"]').forEach(node=>node.remove());
        return copy.textContent??'';
      }).join(' ') : '';
      const name = (labelledBy || element.getAttribute('aria-label') || labelText || (field ? role==='button'?input?.value:'' : (element as HTMLElement).innerText) || '').replace(/\s+/g, ' ').trim();
      const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
      const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
      const points = [[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]];
      const hittable = points.some(([x,y]) => {
        const hit = document.elementFromPoint(left+(right-left)*x, top+(bottom-top)*y);
        return hit === element || (hit !== null && element.contains(hit));
      });
      const details: Partial<ObservedControl> = {};
      const submitter=element instanceof HTMLButtonElement ? element : input?.type==='submit' ? input : null;
      const form=submitter?.type==='submit' ? submitter.form : null;
      if (form && submitter) {
        const fields=Array.from(form.elements).filter((node):node is HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement => node instanceof HTMLInputElement||node instanceof HTMLTextAreaElement||node instanceof HTMLSelectElement);
        const hints=fields.map(node=>[node.name,node.id,node.getAttribute('autocomplete'),node.getAttribute('aria-label'),Array.from(node.labels??[]).map(l=>l.textContent).join(' ')].join(' ')).join(' ').replace(/[_-]/g,' ');
        const sensitive=/\b(password|passcode|secret|token|api key|username|user name|email|e mail|one time code|credit|card|cc|cvc|cvv|billing|payment|wallet|sign in|sign up|log in|login|register|authenticate)\b/i.test(hints);
        details.form={action:submitter.hasAttribute('formaction')?submitter.formAction:form.action,
          method:(submitter.getAttribute('formmethod')||form.method).toLowerCase(),target:submitter.getAttribute('formtarget')??form.target,
          search:form.getAttribute('role')==='search'||fields.some(node=>node instanceof HTMLInputElement&&node.type==='search'),
          unsafe:sensitive||fields.length>40||fields.some(node=>node instanceof HTMLInputElement&&!['text','search','hidden','checkbox','radio','submit','button'].includes(node.type)),
          authorization:null,signature:JSON.stringify(fields.map(node=>[node.tagName,node.type,node.name,node.disabled,node.getAttribute('autocomplete')]))};
      }
      if (field && role!=='button') {
        const hints=[name,field.name,field.id,field.getAttribute('autocomplete'),field.form?.getAttribute('action'),field.form?.textContent].join(' ').replace(/[_-]/g,' ');
        const sensitive=inputType==='password'||inputType==='email'||inputType==='tel'||/\b(password|passcode|secret|token|api key|username|user name|email|e mail|one time code|credit|card|cc|cvc|cvv|billing|payment|wallet|sign in|sign up|log in|login|register|authenticate)\b/i.test(hints);
        Object.assign(details,{input_type:inputType!,sensitive,read_only:!!(input?.readOnly||textarea?.readOnly),
          unsupported:select ? select.multiple||select.size>1 : !['text','search','textarea','checkbox','radio'].includes(inputType!)});
        if (!sensitive) {
          if (!field.validity.valid) details.validation_message=field.validationMessage.slice(0,300);
          if (inputType==='checkbox'||inputType==='radio') details.checked=input!.checked;
          else { details.value=field.value.slice(0,500); details.value_truncated=field.value.length>500; }
          if ((input||textarea) && (input||textarea)!.maxLength>=0) details.max_length=(input||textarea)!.maxLength;
          if (select) {
            const options=Array.from(select.options);
            details.options=options.filter(option=>option.value.length<=200).slice(0,20).map(option=>({value:option.value,label:option.label.slice(0,120),
              disabled:option.disabled||(option.parentElement instanceof HTMLOptGroupElement&&option.parentElement.disabled)||options.filter(other=>other.value===option.value).length!==1}));
            details.options_truncated=details.options.length!==options.length;
          }
        }
      }
      return [{ role, name: name.slice(0, 200), href: element instanceof HTMLAnchorElement ? element.href : null,
        disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
        submits_form: !!((element instanceof HTMLButtonElement||input) && (element as HTMLButtonElement).type==='submit' && (element as HTMLButtonElement).form),
        ambiguous: !name || name.length > 200, occluded: !hittable || style.pointerEvents === 'none',
        rect: { x: left, y: top, width: right-left, height: bottom-top }, ...details }];
    });
    const scrolling=document.scrollingElement;
    const maxY=Math.max(0,(scrolling?.scrollHeight??0)-innerHeight),step=Math.max(1,Math.floor(innerHeight*.8));
    const scrolls: Omit<ObservedControl,'control_id'>[]=[];
    for (const direction of ['down','up'] as const) {
      const y=direction==='down'?Math.min(maxY,scrollY+step):Math.max(0,scrollY-step);
      if (Math.abs(y-scrollY)<1) continue;
      scrolls.push({role:'scroll',name:`Scroll page ${direction}`,href:null,disabled:false,submits_form:false,ambiguous:false,
        scroll_target:{x:scrollX,y,direction}});
    }
    return { truncated: controls.length+scrolls.length > 40, controls: [...controls.slice(0,40-scrolls.length).map(control => ({ ...control,
      ambiguous: control.ambiguous || controls.filter(other => other.role === control.role && other.name === control.name).length !== 1 })),...scrolls] };
  });
  const controls: ObservedControl[] = candidates.controls.map(c => authorizeForm({ ...c,
    ...(c.form?{form:{...c.form,signature:hash(Buffer.from(c.form.signature))}}:{}),
    control_id: hash(jsonBytes({ url: page.url(), role: c.role, name: stabilizeText(c.name), href: c.href })).slice(0, 24) }, new URL(page.url()).origin,rules));
  return { controls: [...new Map(controls.map(c => [c.control_id, c])).values()], controls_truncated: candidates.truncated };
}

export function blockedReason(control: ObservedControl, origin: string): string | null {
  if (control.disabled) return 'disabled_control';
  if (control.ambiguous) return 'ambiguous_control';
  if (control.occluded) return 'covered_or_unclickable_control';
  if (control.sensitive) return 'sensitive_field_requires_handoff';
  if (control.read_only) return 'read_only_control';
  if (control.unsupported) return 'unsupported_control_type';
  if (control.submits_form && !control.form?.authorization) return 'form_submission_requires_handoff';
  const label = control.name + ' ' + (control.href ?? '');
  const risk=actionRisk(label);
  if (risk) return risk;
  if (control.href) {
    try {
      const url = new URL(control.href);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) return 'outside_allowed_origin';
      if (url.href.length > 2048) return 'target_too_long';
    } catch { return 'invalid_target'; }
  }
  return null;
}

// Clocks, dates and relative labels are the same page a moment later. The
// replacement is a token so "2s ago" and "5 minutes ago" share an identity
// while "Ready" and "Saved" do not.
const VOLATILE_TEXT: readonly RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}(?:[tT ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?\s+\d{4}\b/gi,
  /\b(?:an?|\d+)\s+(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago\b/gi,
  /\b\d+\s*[smhd]\s+ago\b/gi,
  /\bjust now\b|\bmoments? ago\b/gi,
  /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?\b/gi,
];
export const GEOMETRY_TOLERANCE_PX = 8;

export function stabilizeText(value: string): string {
  let text = value.normalize('NFKC');
  for (const pattern of VOLATILE_TEXT) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, '<time>');
  }
  return text.replace(/\s+/g, ' ').trim();
}

function stabilizeField(value: string | null | undefined): string | null {
  if (value == null) return value ?? null;
  return stabilizeText(value);
}

function quantize(value: number): number {
  return Math.round(value / GEOMETRY_TOLERANCE_PX) * GEOMETRY_TOLERANCE_PX;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
}

function mapAddress(url: string | null, mapUrl: (url: string) => string): string | null {
  if (!url || url === 'about:blank') return url;
  return mapUrl(url);
}

// Screenshot bytes stay on the capture. State identity is the route, the
// control set and the visible copy, with clock text and a few pixels of
// scroll tolerated. Rectangles and control ids are not part of that set.
function projectControl(control: ObservedControl, mapUrl: (url: string) => string) {
  const { control_id: _controlId, rect: _rect, form, scroll_target: scrollTarget, options, ...rest } = control;
  const projected: Record<string, unknown> = {
    ...rest,
    name: stabilizeText(control.name),
    href: mapAddress(control.href, mapUrl),
    occluded: control.occluded ?? false,
  };
  if (scrollTarget) projected.scroll_target = { direction: scrollTarget.direction, x: quantize(scrollTarget.x), y: quantize(scrollTarget.y) };
  if (options) projected.options = options.map(option => ({ ...option, label: stabilizeText(option.label) }));
  if (control.read_only && typeof control.value === 'string') projected.value = stabilizeText(control.value);
  if (control.validation_message != null) projected.validation_message = stabilizeText(control.validation_message);
  if (form) {
    const { signature: _signature, ...formRest } = form;
    projected.form = { ...formRest, action: mapAddress(form.action, mapUrl) };
  }
  return projected;
}

export function projectState(capture: Capture, mapUrl: (url: string) => string = url => url, auth: 'id' | 'presence' = 'id') {
  const o = capture.observation;
  return {
    ...(auth === 'id' && o.auth_context_id ? { auth_context_id: o.auth_context_id } : {}),
    ...(auth === 'presence' ? { authenticated: !!o.auth_context_id } : {}),
    url: mapAddress(o.url, mapUrl),
    title: stabilizeField(o.title),
    text: stabilizeField(o.text),
    text_truncated: o.text_truncated,
    viewport: o.viewport,
    device_scale: o.device_scale,
    scroll: o.scroll ? { x: quantize(o.scroll.x), y: quantize(o.scroll.y) } : o.scroll,
    controls: (o.controls ?? []).map(control => projectControl(control, mapUrl)),
    controls_truncated: o.controls_truncated ?? false,
  };
}

export function stateFingerprint(capture: Capture) {
  return hash(jsonBytes(canonical(projectState(capture))));
}

export function findObservedControl(recorded: ObservedControl, controls: readonly ObservedControl[]): ObservedControl | undefined {
  const same = (control: ObservedControl) => isDeepStrictEqual(projectControl(control, url => url), projectControl(recorded, url => url));
  const exact = controls.find(control => control.control_id === recorded.control_id);
  if (exact) return same(exact) ? exact : undefined;
  const matches = controls.filter(same);
  return matches.length === 1 ? matches[0] : undefined;
}

export function statesMatch(left: Capture, right: Capture): boolean {
  return !left.observation.observation_error && !right.observation.observation_error && stateFingerprint(left) === stateFingerprint(right);
}

// Fix verification and same-app reproduction share this comparison. Pixels,
// control ids and form signatures may differ. Authentication is presence, so a
// candidate can use its own saved session.
export function sameObservedState(left: Capture, right: Capture, mapLeftUrl: (url: string) => string = url => url): boolean {
  if (left.observation.observation_error || right.observation.observation_error) return false;
  return isDeepStrictEqual(projectState(left, mapLeftUrl, 'presence'), projectState(right, url => url, 'presence'));
}

export function observedCopyIdentity(parts: { url: string; title: string | null; text: string | null }): string {
  return hash(jsonBytes(canonical({ url: parts.url, title: stabilizeField(parts.title), text: stabilizeField(parts.text) })));
}

type Obj = Record<string, unknown>;
function object(value: unknown, keys: string[]): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Model output must be a JSON object.');
  const o = value as Obj;
  if (Object.keys(o).sort().join(',') !== [...keys].sort().join(',')) throw new Error('Model output has missing or unsupported fields.');
  return o;
}
function text(value: unknown, max = 1200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error('Invalid model text field.');
  return value;
}
export type Proposal = { control_id: string; goal: string; expected_result: string; likelihood: number; action?: ControlAction };
export type Plan = { candidates: Proposal[]; stop_reason: string | null };
export function parsePlan(value: unknown, allowed: ObservedControl[]): Plan {
  const o = object(value, ['candidates', 'stop_reason']);
  if (!Array.isArray(o.candidates) || o.candidates.length > 8) throw new Error('Expected at most eight ranked candidates.');
  const seen = new Set<string>();
  const candidates = o.candidates.map(value => {
    const hasAction=!!value && typeof value==='object' && Object.hasOwn(value,'action');
    const candidate = object(value, ['control_id', 'goal', 'expected_result', 'likelihood',...(hasAction?['action']:[])]);
    const controlId = text(candidate.control_id, 24);
    if (!allowed.some(control => control.control_id === controlId) || seen.has(controlId)) throw new Error('Model selected an unobserved, blocked, or already attempted control.');
    seen.add(controlId);
    if (typeof candidate.likelihood !== 'number' || !Number.isFinite(candidate.likelihood) || candidate.likelihood < 0 || candidate.likelihood > 1) throw new Error('Invalid likelihood.');
    const action=controlAction(allowed.find(control=>control.control_id===controlId)!,candidate.action);
    return { control_id: controlId, goal: text(candidate.goal, 300), expected_result: text(candidate.expected_result), likelihood: candidate.likelihood, action };
  }).sort((a, b) => b.likelihood - a.likelihood);
  if (candidates.length && o.stop_reason !== null) throw new Error('An actionable plan cannot also stop.');
  return { candidates, stop_reason: candidates.length ? null : text(o.stop_reason) };
}
export function parsePrediction(value: unknown) {
  const o = object(value, ['goal', 'expected_result']);
  return { goal: text(o.goal, 300), expected_result: text(o.expected_result) };
}
export function parseAssessment(value: unknown, captureIds: string[]) {
  const o = object(value, ['verdict', 'reason', 'observed_result', 'evidence_capture_ids', 'expectation_uncertain']);
  if (!['no_issue_observed', 'suspect', 'inconclusive'].includes(String(o.verdict))) throw new Error('Unsupported assessment verdict.');
  if (!Array.isArray(o.evidence_capture_ids) || o.evidence_capture_ids.length !== 2 ||
      [...o.evidence_capture_ids].sort().join(',') !== [...captureIds].sort().join(',')) throw new Error('Assessment must reference exactly the two supplied captures.');
  if (typeof o.expectation_uncertain !== 'boolean') throw new Error('Missing expectation uncertainty.');
  return { verdict: o.verdict as 'no_issue_observed' | 'suspect' | 'inconclusive', reason: text(o.reason),
    observed_result: text(o.observed_result), evidence_capture_ids: captureIds, expectation_uncertain: o.expectation_uncertain };
}
