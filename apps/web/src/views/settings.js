// Workspace settings: exploration defaults, provider availability, saved app sessions and appearance.
import {button,toast} from '/assets/ui/components.js';
import {MODEL_PROVIDERS,date,esc,number,providerName,short} from '/assets/ui/format.js';
import {themePreference,themeSwitch} from '/assets/ui/theme.js';
import {api,get} from '../api.js';
import {render} from '../app.js';
import {state} from '../state.js';
import {accessBanner} from './home.js';
// Server bounds. Exploration limits are optional: empty means no limit.
export const MAX_ACTIONS=10000,MAX_REPLAY_ACTIONS=100;
export const LIMITS=[['max_actions','maxActions','Maximum actions',1,MAX_ACTIONS,1],['max_minutes','maxMinutes','Maximum minutes',1,10080,1],
  ['max_tokens','maxTokens','Maximum reported tokens',1000,1000000000,1],['max_cost_usd','maxCostUsd','Maximum reported cost (USD)',0.01,100000,0.01],
  ['stop_after_idle_actions','stopAfterIdleActions','Stop after actions with nothing new',5,1000,1]];
const MAX_OVERRIDES=50,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An override row: what it matches and its limits. Empty limits inherit.
const overrideRow=(o={})=>({project_id:o.projectId||'',provider:o.provider||'',model:o.model||'',...Object.fromEntries(LIMITS.map(([key,camel])=>[key,o.limits?.[camel]??null]))});
export function overridePayload(row){
  const item={limits:{}};if(row.project_id.trim())item.project_id=row.project_id.trim();if(row.provider)item.provider=row.provider;if(row.model.trim())item.model=row.model.trim();
  for(const [key] of LIMITS)if(row[key]!==null&&row[key]!=='')item.limits[key]=row[key];
  return item;
}
export function configurationValues(settings=state.settings){
  return {provider:settings.provider||'openrouter',model:settings.model||'',...Object.fromEntries(LIMITS.map(([key,camel])=>[key,settings[camel]??null])),
    stop_after_idle_actions:settings.stopAfterIdleActions===undefined?50:settings.stopAfterIdleActions,limit_overrides:(settings.limitOverrides||[]).map(overrideRow),viewport_profile:settings.viewportProfile||'desktop',free_only:settings.provider==='openrouter'&&settings.freeOnly===true,auto_reproduce:settings.autoReproduce===true,max_auto_reproductions:settings.maxAutoReproductions??2,max_auto_replay_actions:settings.maxAutoReplayActions??12,app_memory:settings.appMemory!==false};
}
export function configurationDraft(){
  const values=configurationValues(),fingerprint=JSON.stringify(values),old=state.configurationDraft;
  if(!old||!old.dirty&&!old.saving&&(old.revision!==state.settingsRevision||old.fingerprint!==fingerprint)){
    state.configurationDraft={values,revision:state.settingsRevision,fingerprint,dirty:false,saving:false,requestId:null,error:'',message:old?.message||'',models:{[values.provider]:values.model}};
  }
  return state.configurationDraft;
}
export function configurationError(values){
  if(!MODEL_PROVIDERS.includes(values.provider))return 'Choose a supported provider.';
  if(typeof values.model!=='string'||/[\x00-\x1f\x7f]/.test(values.model)||! /^[A-Za-z0-9/:._-]{1,200}$/.test(values.model.trim()))return 'Enter a model ID using letters, numbers, / : . _ or - (up to 200 characters).';
  for(const [key,max,label] of [['max_auto_reproductions',3,'Maximum automatic cases'],['max_auto_replay_actions',MAX_REPLAY_ACTIONS,'Total replay actions']])if(!Number.isInteger(values[key])||values[key]<1||values[key]>max)return `${label} must be a whole number from 1 to ${max}.`;
  const limitError=(row,prefix='')=>{for(const [key,,label,min,max,step] of LIMITS){const v=row[key];if(v===null)continue;if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||step===1&&!Number.isInteger(v))return `${prefix}${label} must be empty (no limit) or ${step===1?'a whole number':'a number'} from ${min} to ${max}.`;}return '';};
  const own=limitError(values);if(own)return own;
  if(values.limit_overrides.length>MAX_OVERRIDES)return `Use at most ${MAX_OVERRIDES} limit overrides.`;
  const seen=new Set();
  for(const [index,row] of values.limit_overrides.entries()){
    const label=`Override ${index+1}: `;
    if(!row.project_id.trim()&&!row.provider&&!row.model.trim())return label+'choose a project ID, a provider or a model.';
    if(row.project_id.trim()&&!UUID.test(row.project_id.trim()))return label+'the project ID must be a UUID.';
    if(row.model.trim()&&!/^[A-Za-z0-9/:._-]{1,200}$/.test(row.model.trim()))return label+'enter a model ID using letters, numbers, / : . _ or -.';
    const error=limitError(row,label);if(error)return error;
    if(LIMITS.every(([key])=>row[key]===null))return label+'set at least one limit.';
    const match=JSON.stringify([row.project_id.trim(),row.provider,row.model.trim()]);if(seen.has(match))return label+'another override matches the same project and model.';seen.add(match);
  }
  if(!['desktop','tablet','mobile'].includes(values.viewport_profile))return 'Choose a supported viewport.';
  if(values.provider==='openrouter'&&values.free_only&&values.model.trim()!=='openrouter/free'&&!values.model.trim().endsWith(':free'))return 'Free-only requires openrouter/free or a model ID ending in :free.';
  return '';
}
export function updateConfiguration(field,value){
  const draft=configurationDraft();if(draft.saving)return false;
  const override=/^override\.(\d+)\.(\w+)$/.exec(field);
  if(override){const row=draft.values.limit_overrides[Number(override[1])];if(!row||!Object.hasOwn(row,override[2]))return false;row[override[2]]=value;draft.dirty=JSON.stringify(draft.values)!==draft.fingerprint;draft.requestId=null;draft.error='';draft.message='';return true;}
  if(!Object.hasOwn(draft.values,field))return false;
  if(field==='provider'){
    draft.models[draft.values.provider]=draft.values.model;
    draft.values.model=Object.hasOwn(draft.models,value)?draft.models[value]:value==='meta'?'muse-wonder-1.0':'';
    if(value!=='openrouter')draft.values.free_only=false;
  }
  draft.values[field]=value;draft.dirty=JSON.stringify(draft.values)!==draft.fingerprint;
  draft.requestId=null;draft.error='';draft.message='';return true;
}
export function editOverrides(add,index){
  const draft=configurationDraft();if(draft.saving)return;
  if(add){if(draft.values.limit_overrides.length<MAX_OVERRIDES)draft.values.limit_overrides.push(overrideRow());}else draft.values.limit_overrides.splice(index,1);
  draft.dirty=JSON.stringify(draft.values)!==draft.fingerprint;draft.requestId=null;draft.error='';draft.message='';
}
export function rebaseConfiguration(discard=false){
  const draft=configurationDraft();if(draft.saving)return;
  if(discard){state.configurationDraft=null;configurationDraft();return;}
  draft.revision=state.settingsRevision;draft.fingerprint=JSON.stringify(configurationValues());draft.dirty=JSON.stringify(draft.values)!==draft.fingerprint;draft.requestId=null;draft.error='';draft.message='Edits kept. Review the values, then save to create a new revision.';
}
export function applyConfiguration(snapshot){
  // A polling response started before a save may arrive after it.
  if(Number.isSafeInteger(snapshot.revision)&&snapshot.revision>=state.settingsRevision){state.settings=snapshot.settings;state.settingsRevision=snapshot.revision;}
}
export async function saveConfiguration(){
  const draft=configurationDraft();if(draft.saving||!draft.dirty)return;
  draft.error=configurationError(draft.values);
  if(!draft.requestId&&draft.revision!==state.settingsRevision)draft.error='Defaults changed elsewhere. Discard your edits or explicitly keep them on the latest revision before saving.';
  if(draft.error){render();return;}
  draft.requestId??=crypto.randomUUID();draft.saving=true;draft.message='';render();
  const token=state.token,developmentAccess=state.developmentAccess,sameSession=()=>token===state.token&&developmentAccess===state.developmentAccess;
  const body={request_id:draft.requestId,expected_revision:draft.revision,...draft.values,model:draft.values.model.trim(),limit_overrides:draft.values.limit_overrides.map(overridePayload)};
  try{
    const saved=await (await api('/v1/exploration-settings',body)).json();if(!sameSession()||state.configurationDraft!==draft)return;
    applyConfiguration(saved);draft.saving=false;draft.dirty=false;state.configurationDraft=null;
    const clean=configurationDraft();clean.message=`Saved revision ${saved.revision}. These defaults apply to new explorations.`;
    toast(clean.message);
    // Read the latest state after an idempotent retry that returned an older revision.
    try{const latest=await get('/v1/exploration-settings');if(sameSession())applyConfiguration(latest);}catch{}
  }catch(error){
    if(!sameSession()||state.configurationDraft!==draft)return;
    draft.error=error.message;
    if(error.code==='revision_conflict'){
      draft.requestId=null;
      try{const latest=await get('/v1/exploration-settings');if(sameSession())applyConfiguration(latest);}catch{}
      draft.error='Defaults changed elsewhere. Your edits are preserved. Choose whether to discard them or keep them on the latest revision.';
    }else if(error.status&&error.status<500){draft.requestId=null;}
  }finally{draft.saving=false;if(sameSession())render();}
}
export function configurationView(){
  const draft=configurationDraft(),v=draft.values,conflict=draft.dirty&&draft.revision!==state.settingsRevision,invalid=configurationError(v);
  const field=(key,label,type='text',min='',max='')=>`<label for="configuration-${key}"><span>${label}</span><input id="configuration-${key}" data-configuration-field="${key}" type="${type}" value="${esc(v[key]??'')}" ${type==='number'?`min="${min}" max="${max}" step="1"`:'maxlength="200" autocomplete="off" spellcheck="false"'} required></label>`;
  return `<section class="panel settings-panel"><div class="panel-header"><div><h2>Exploration defaults</h2><p class="small muted">Saved revision ${esc(state.settingsRevision)} · applies to new explorations</p></div>${draft.dirty?'<span class="pill dirty-indicator">Unsaved changes</span>':''}</div><p class="configuration-note small muted">Save the model, action limits and viewport for future jobs. Queued and running jobs keep their original settings. Each URL launch can override its viewport and automatic checks. Saving does not call a model or test a connection.</p><form id="exploration-configuration-form" class="configuration-form"><fieldset ${draft.saving?'disabled':''}><legend class="sr-only">Default exploration settings</legend><div class="configuration-grid"><label for="configuration-provider"><span>Model provider</span><select id="configuration-provider" data-configuration-field="provider">${MODEL_PROVIDERS.map(p=>`<option value="${p}" ${v.provider===p?'selected':''}>${providerName(p)}</option>`).join('')}</select></label>${field('model','Model ID')}<label for="configuration-viewport_profile"><span>Default viewport</span><select id="configuration-viewport_profile" data-configuration-field="viewport_profile">${['desktop','tablet','mobile'].map(p=>`<option value="${p}" ${v.viewport_profile===p?'selected':''}>${p[0].toUpperCase()+p.slice(1)}</option>`).join('')}</select></label>${field('max_auto_reproductions','Maximum automatic cases','number',1,3)}${field('max_auto_replay_actions','Total additional replay actions','number',1,MAX_REPLAY_ACTIONS)}</div> ${limitsView(v)}<label class="configuration-toggle"><input id="configuration-free_only" data-configuration-field="free_only" type="checkbox" ${v.free_only?'checked':''} ${v.provider!=='openrouter'?'disabled':''}><span>Restrict OpenRouter to free model IDs</span></label><p class="small muted">Use openrouter/free or a model ending in :free. Provider availability and rate limits still apply. Direct OpenAI, Anthropic and Meta AI calls use their own API billing. Meta AI defaults to muse-wonder-1.0.</p><label class="configuration-toggle"><input id="configuration-auto_reproduce" data-configuration-field="auto_reproduce" type="checkbox" ${v.auto_reproduce?'checked':''}><span>Automatically recheck suspected bugs by default</span></label><p class="small muted">Fresh-browser checks use additional model calls. Findings still require human review. Allowed app origins and provider credentials stay in the server configuration managed by your Scout administrator.</p><label class="configuration-toggle"><input id="configuration-app_memory" data-configuration-field="app_memory" type="checkbox" ${v.app_memory?'checked':''}><span>Remember explored pages and controls across runs</span></label><p class="small muted">Later runs of the same app, screen size and sign-in state skip controls already tried and can reopen pages earlier runs did not finish. Memory guides choices only; every action still records fresh evidence.</p></fieldset>${conflict?`<div class="settings-feedback notice" role="status">Saved defaults are now revision ${esc(state.settingsRevision)}. Your edits still use revision ${esc(draft.revision)}. ${draft.requestId?'A previous save may have completed. Retry save to check its original receipt, or discard your edits.':'Review the current values below before keeping your edits.'}</div>`:''}${draft.error?`<p class="settings-feedback notice error" role="alert">${esc(draft.error)}</p>`:''}${draft.message?`<p class="settings-feedback" role="status">${esc(draft.message)}</p>`:''}${draft.dirty&&invalid?`<p class="small muted">${esc(invalid)}</p>`:''}<div class="configuration-actions"><button type="submit" class="button primary" ${draft.saving||!draft.dirty||conflict&&!draft.requestId||invalid?'disabled':''}>${draft.saving?'Saving…':draft.requestId?'Retry save':'Save defaults'}</button><button type="button" class="button" data-action="discard-configuration" ${!draft.dirty||draft.saving?'disabled':''}>Discard edits</button>${conflict?`<button type="button" class="button" data-action="rebase-configuration" ${draft.saving?'disabled':''}>Keep my edits on revision ${esc(state.settingsRevision)}</button>`:''}</div></form></section>`;
}
// Empty means no limit. Overrides apply to a project, a model or both; the most specific one wins.
function limitsView(v){
  const input=(id,field,value,[,,label,min,max,step],extra='')=>`<label for="${id}"><span>${label}</span><input id="${id}" data-configuration-field="${field}" type="number" value="${value===null?'':esc(value)}" min="${min}" max="${max}" step="${step}" placeholder="${extra||'No limit'}"></label>`;
  const rows=v.limit_overrides.map((row,i)=>`<fieldset class="configuration-override"><legend>Override ${i+1}</legend><div class="configuration-grid"><label for="override-${i}-project_id"><span>Project ID</span><input id="override-${i}-project_id" data-configuration-field="override.${i}.project_id" value="${esc(row.project_id)}" maxlength="36" placeholder="Any project" autocomplete="off" spellcheck="false"></label><label for="override-${i}-provider"><span>Provider</span><select id="override-${i}-provider" data-configuration-field="override.${i}.provider"><option value="">Any provider</option>${MODEL_PROVIDERS.map(p=>`<option value="${p}" ${row.provider===p?'selected':''}>${providerName(p)}</option>`).join('')}</select></label><label for="override-${i}-model"><span>Model ID</span><input id="override-${i}-model" data-configuration-field="override.${i}.model" value="${esc(row.model)}" maxlength="200" placeholder="Any model" autocomplete="off" spellcheck="false"></label>${LIMITS.map(limit=>input(`override-${i}-${limit[0]}`,`override.${i}.${limit[0]}`,row[limit[0]],limit,'Inherit')).join('')}</div><button type="button" class="button quiet" data-action="remove-limit-override" data-index="${i}">Remove override</button></fieldset>`).join('');
  return `<h3 class="configuration-subheading">Limits</h3><p class="small muted">Leave a limit empty for no limit. Explorations then run until nothing new is left to explore or you stop them. Token and cost limits count usage the provider has reported; an action already in progress can finish past the limit.</p><div class="configuration-grid">${LIMITS.map(limit=>input(`configuration-${limit[0]}`,limit[0],v[limit[0]],limit)).join('')}</div><p class="small muted">Overrides set different limits for a project, a model, or a model within a project. The most specific matching override wins; empty fields inherit. Jobs keep the limits they started with.</p>${rows}<button type="button" class="button" data-action="add-limit-override" ${v.limit_overrides.length>=MAX_OVERRIDES?'disabled':''}>Add override</button>`;
}
export function savedSessions(){
  const sessions=state.access.sessions||[];
  return `<section class="panel settings-panel"><h2>Saved app sessions</h2><p class="small muted">Encrypted on this machine for up to 24 hours. Select a session when starting a run for the same app. Removing it prevents future reuse; an already running browser keeps its current session.</p>${sessions.map(s=>`<div class="key-value"><span>${esc(s.origin)}<small class="table-sub">${s.execution_mode==='protocol_fixture'?'Test session · ':''}${short(s.session_id)} · expires ${date(s.expires_at)}</small></span>${s.revoked_at?'<span class="muted">Removed</span>':new Date(s.expires_at)<=new Date()?'<span class="muted">Expired</span>':button('revoke-session','Remove session','close',`data-id="${s.session_id}"`)}</div>`).join('')||'<p>No saved app sessions.</p>'}</section>`;
}
export function memoryPanel(){
  const scopes=state.memory?.scopes;
  const row=s=>`<div class="key-value"><span>${esc(s.origin)}<small class="table-sub">${s.execution_mode==='protocol_fixture'?'Test data · ':''}${esc(s.viewport_profile)} · ${s.auth_scope==='signed_in'?'signed in':'public'} · ${number(s.runs)} run${s.runs===1?'':'s'} · ${number(s.pages)} pages · ${number(s.tried_controls)} tried / ${number(s.untried_controls)} untried controls · map: ${number(s.map_states??0)} states, ${number(s.map_transitions??0)} transitions${s.map_max_depth==null?'':`, ${number(s.map_max_depth)} deep`} · updated ${date(s.updated_at)}</small></span>${s.in_use?'<span class="muted">In use by a running test</span>':button('forget-memory','Forget','close',`data-id="${s.scope_id}"`)}</div>`;
  return `<section class="panel settings-panel"><h2>App memory</h2><p class="small muted">What earlier runs explored, kept separately for each app, screen size and sign-in state. Forgetting removes only this memory; recorded runs and evidence stay.</p>${scopes?scopes.map(row).join('')||'<p>No app memory yet. It is recorded by explorations that use it.</p>':state.memoryError?`<p class="notice error" role="alert">${esc(state.memoryError)}</p>`:'<p class="small muted">Loading app memory…</p>'}</section>`;
}
export function providerAvailability(){
  const providers=state.providers.providers||[];
  return `<section class="panel settings-panel"><h2>Available model providers</h2><p class="small muted">Your Scout administrator manages provider credentials; they are never shown here.${state.providers.test_mode?' This server currently returns simulated model responses.':''}</p>${providers.map(p=>`<div class="key-value"><span>${esc(providerName(p.provider))}</span><span class="pill ${p.configured?'green':''}">${p.configured?'Available':'Not configured'}</span></div>`).join('')||'<p class="small muted">No provider status is available yet. Refresh the workspace.</p>'}</section>`;
}
export function appearancePanel(){
  return `<section class="panel settings-panel"><h2>Appearance</h2><p class="small muted">Follow your computer’s light or dark setting, or keep one theme in this browser.</p><div class="appearance-row">${themeSwitch(themePreference(),true)}</div></section>`;
}
export function settingsView(){
  return `${accessBanner()}<div class="page-heading"><div><div class="eyebrow">Workspace</div><h1>Settings</h1><p>Defaults for new explorations, saved app sign-ins and how Scout looks in this browser.</p></div></div>${configurationView()}${memoryPanel()}${providerAvailability()}${savedSessions()}${appearancePanel()}`;
}
