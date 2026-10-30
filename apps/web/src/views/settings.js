// Workspace settings: exploration defaults, provider availability, saved app sessions and appearance.
import {button,toast} from '/assets/ui/components.js';
import {MODEL_PROVIDERS,date,esc,providerName,short} from '/assets/ui/format.js';
import {themePreference,themeSwitch} from '/assets/ui/theme.js';
import {api,get} from '../api.js';
import {render} from '../app.js';
import {state} from '../state.js';
import {accessBanner} from './home.js';
export function configurationValues(settings=state.settings){
  return {provider:settings.provider||'openrouter',model:settings.model||'',max_actions:settings.maxActions??6,viewport_profile:settings.viewportProfile||'desktop',free_only:settings.provider==='openrouter'&&settings.freeOnly===true,auto_reproduce:settings.autoReproduce===true,max_auto_reproductions:settings.maxAutoReproductions??2,max_auto_replay_actions:settings.maxAutoReplayActions??12};
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
  for(const [key,max,label] of [['max_actions',12,'Maximum actions'],['max_auto_reproductions',3,'Maximum automatic cases'],['max_auto_replay_actions',24,'Total replay actions']])if(!Number.isInteger(values[key])||values[key]<1||values[key]>max)return `${label} must be a whole number from 1 to ${max}.`;
  if(!['desktop','tablet','mobile'].includes(values.viewport_profile))return 'Choose a supported viewport.';
  if(values.provider==='openrouter'&&values.free_only&&values.model.trim()!=='openrouter/free'&&!values.model.trim().endsWith(':free'))return 'Free-only requires openrouter/free or a model ID ending in :free.';
  return '';
}
export function updateConfiguration(field,value){
  const draft=configurationDraft();if(draft.saving||!Object.hasOwn(draft.values,field))return false;
  if(field==='provider'){
    draft.models[draft.values.provider]=draft.values.model;
    draft.values.model=Object.hasOwn(draft.models,value)?draft.models[value]:value==='meta'?'muse-wonder-1.0':'';
    if(value!=='openrouter')draft.values.free_only=false;
  }
  draft.values[field]=value;draft.dirty=JSON.stringify(draft.values)!==draft.fingerprint;
  draft.requestId=null;draft.error='';draft.message='';return true;
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
  const body={request_id:draft.requestId,expected_revision:draft.revision,...draft.values,model:draft.values.model.trim()};
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
  return `<section class="panel settings-panel"><div class="panel-header"><div><h2>Exploration defaults</h2><p class="small muted">Saved revision ${esc(state.settingsRevision)} · applies to new explorations</p></div>${draft.dirty?'<span class="pill dirty-indicator">Unsaved changes</span>':''}</div><p class="configuration-note small muted">Save the model, action limits and viewport for future jobs. Queued and running jobs keep their original settings. Each URL launch can override its viewport and automatic checks. Saving does not call a model or test a connection.</p><form id="exploration-configuration-form" class="configuration-form"><fieldset ${draft.saving?'disabled':''}><legend class="sr-only">Default exploration settings</legend><div class="configuration-grid"><label for="configuration-provider"><span>Model provider</span><select id="configuration-provider" data-configuration-field="provider">${MODEL_PROVIDERS.map(p=>`<option value="${p}" ${v.provider===p?'selected':''}>${providerName(p)}</option>`).join('')}</select></label>${field('model','Model ID')}${field('max_actions','Maximum exploration actions','number',1,12)}<label for="configuration-viewport_profile"><span>Default viewport</span><select id="configuration-viewport_profile" data-configuration-field="viewport_profile">${['desktop','tablet','mobile'].map(p=>`<option value="${p}" ${v.viewport_profile===p?'selected':''}>${p[0].toUpperCase()+p.slice(1)}</option>`).join('')}</select></label>${field('max_auto_reproductions','Maximum automatic cases','number',1,3)}${field('max_auto_replay_actions','Total additional replay actions','number',1,24)}</div><label class="configuration-toggle"><input id="configuration-free_only" data-configuration-field="free_only" type="checkbox" ${v.free_only?'checked':''} ${v.provider!=='openrouter'?'disabled':''}><span>Restrict OpenRouter to free model IDs</span></label><p class="small muted">Use openrouter/free or a model ending in :free. Provider availability and rate limits still apply. Direct OpenAI, Anthropic and Meta AI calls use their own API billing. Meta AI defaults to muse-wonder-1.0.</p><label class="configuration-toggle"><input id="configuration-auto_reproduce" data-configuration-field="auto_reproduce" type="checkbox" ${v.auto_reproduce?'checked':''}><span>Automatically recheck suspected bugs by default</span></label><p class="small muted">Fresh-browser checks use additional model calls. Findings still require human review. Allowed app origins and provider credentials stay in the server configuration managed by your Scout administrator.</p></fieldset>${conflict?`<div class="settings-feedback notice" role="status">Saved defaults are now revision ${esc(state.settingsRevision)}. Your edits still use revision ${esc(draft.revision)}. ${draft.requestId?'A previous save may have completed. Retry save to check its original receipt, or discard your edits.':'Review the current values below before keeping your edits.'}</div>`:''}${draft.error?`<p class="settings-feedback notice error" role="alert">${esc(draft.error)}</p>`:''}${draft.message?`<p class="settings-feedback" role="status">${esc(draft.message)}</p>`:''}${draft.dirty&&invalid?`<p class="small muted">${esc(invalid)}</p>`:''}<div class="configuration-actions"><button type="submit" class="button primary" ${draft.saving||!draft.dirty||conflict&&!draft.requestId||invalid?'disabled':''}>${draft.saving?'Saving…':draft.requestId?'Retry save':'Save defaults'}</button><button type="button" class="button" data-action="discard-configuration" ${!draft.dirty||draft.saving?'disabled':''}>Discard edits</button>${conflict?`<button type="button" class="button" data-action="rebase-configuration" ${draft.saving?'disabled':''}>Keep my edits on revision ${esc(state.settingsRevision)}</button>`:''}</div></form></section>`;
}
export function savedSessions(){
  const sessions=state.access.sessions||[];
  return `<section class="panel settings-panel"><h2>Saved app sessions</h2><p class="small muted">Encrypted on this machine for up to 24 hours. Select a session when starting a run for the same app. Removing it prevents future reuse; an already running browser keeps its current session.</p>${sessions.map(s=>`<div class="key-value"><span>${esc(s.origin)}<small class="table-sub">${s.execution_mode==='protocol_fixture'?'Test session · ':''}${short(s.session_id)} · expires ${date(s.expires_at)}</small></span>${s.revoked_at?'<span class="muted">Removed</span>':new Date(s.expires_at)<=new Date()?'<span class="muted">Expired</span>':button('revoke-session','Remove session','close',`data-id="${s.session_id}"`)}</div>`).join('')||'<p>No saved app sessions.</p>'}</section>`;
}
export function providerAvailability(){
  const providers=state.providers.providers||[];
  return `<section class="panel settings-panel"><h2>Available model providers</h2><p class="small muted">Your Scout administrator manages provider credentials; they are never shown here.${state.providers.test_mode?' This server currently returns simulated model responses.':''}</p>${providers.map(p=>`<div class="key-value"><span>${esc(providerName(p.provider))}</span><span class="pill ${p.configured?'green':''}">${p.configured?'Available':'Not configured'}</span></div>`).join('')||'<p class="small muted">No provider status is available yet. Refresh the workspace.</p>'}</section>`;
}
export function appearancePanel(){
  return `<section class="panel settings-panel"><h2>Appearance</h2><p class="small muted">Follow your computer’s light or dark setting, or keep one theme in this browser.</p><div class="appearance-row">${themeSwitch(themePreference(),true)}</div></section>`;
}
export function settingsView(){
  return `${accessBanner()}<div class="page-heading"><div><div class="eyebrow">Workspace</div><h1>Settings</h1><p>Defaults for new explorations, saved app sign-ins and how Scout looks in this browser.</p></div></div>${configurationView()}${providerAvailability()}${savedSessions()}${appearancePanel()}`;
}
