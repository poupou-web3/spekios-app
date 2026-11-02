// Credentials live only in this dialog until submission. Refreshes replace the
// workspace, never this native modal; no key is saved in state or browser storage.
import {esc,providerName,MODEL_PROVIDERS} from '/assets/ui/format.js';
import {icon,toast} from '/assets/ui/components.js';
import {api,get} from './api.js';
import {render} from './app.js';
import {state} from './state.js';

export const providerKeys=provider=>(state.providers.keys||[]).filter(k=>k.provider===provider);
export function demoReady(){const d=state.providers.demo;return !!d?.enabled&&!!d.configured&&Number(d.remaining_usd)>=Number(d.minimum_call_reserve_usd);}
export function connectionReady(provider,model,reference=''){
  if(!Array.isArray(state.providers.keys))return state.providers.providers?.some(p=>p.provider===provider&&p.configured)===true;
  if(reference==='demo')return provider==='meta'&&model===state.providers.demo?.model&&demoReady();
  const keys=providerKeys(provider);
  if(reference)return keys.some(k=>k.key_id===reference);
  return keys.some(k=>k.is_default)||(state.providers.operator_access===true&&state.providers.providers?.some(p=>p.provider===provider&&p.configured));
}
export function needsPersonalKey(provider,model){
  if(!Array.isArray(state.providers.keys)||providerKeys(provider).length)return false;
  if(state.providers.operator_access&&state.providers.providers?.some(p=>p.provider===provider&&p.configured))return false;
  return !(provider==='meta'&&model===state.providers.demo?.model&&demoReady());
}
export function keyOptions(provider,model,selected='',inherit='Default key for this provider'){
  const keys=providerKeys(provider),demo=provider==='meta'&&model===state.providers.demo?.model;
  return `<option value="" ${!selected?'selected':''}>${esc(inherit)}</option>`
    +(demo?`<option value="demo" ${selected==='demo'?'selected':''}>Spekios demo key${demoReady()?' · demo credits':' · unavailable'}</option>`:'')
    +keys.map(k=>`<option value="${esc(k.key_id)}" ${selected===k.key_id?'selected':''}>${esc(k.name)}${k.is_default?' · provider default':''}</option>`).join('')
    +(selected&&!(selected==='demo'&&demo)&&!keys.some(k=>k.key_id===selected)?'<option selected disabled>Unavailable key — choose another</option>':'');
}
export function keyField(provider,model,selected,field,id,label='API key',inherit){
  if(!Array.isArray(state.providers.keys))return '';
  return `<div class="model-key-field"><label for="${id}"><span>${esc(label)}</span><select id="${id}" data-configuration-field="${esc(field)}">${keyOptions(provider,model,selected,inherit)}</select></label><button type="button" class="button quiet" data-action="add-provider-key" data-provider="${esc(provider)}">${icon('plus')}Add key</button></div>`;
}
const money=n=>`$${Number(n||0).toFixed(2)}`;
export function demoPanel(){
  const d=state.providers.demo;if(!d)return '';
  const active=demoReady(),label=!d.enabled||!d.configured?'Demo unavailable':active?'Demo credits available':'Demo balance too low for the next call';
  return `<section class="panel demo-credits" aria-labelledby="demo-credits-title"><div class="panel-header"><div><p class="eyebrow">Spekios demo key</p><h3 id="demo-credits-title">${money(d.remaining_usd)} demo credits remaining</h3></div><span class="pill ${active?'green':'amber'}">${label}</span></div><p class="small muted">${money(d.spent_usd)} used of ${money(d.allowance_usd)} per account · ${esc(d.model)} only${Number(d.reserved_usd)>0?` · ${money(d.reserved_usd)} reserved for calls`:''}.</p><progress aria-label="Demo credits used" max="${Math.max(Number(d.allowance_usd)||0,0.000001)}" value="${Math.min(Number(d.allowance_usd)||0,Number(d.spent_usd||0)+Number(d.reserved_usd||0))}"></progress><p class="small muted">This shared demo key is provided by Spekios. Add your own named keys at any time to use other models or continue after demo credits run out. Personal-key calls do not use demo credits.</p><p class="small demo-data-note">Meta Contributor mode may use demo prompts and screenshots to improve its models. <a href="https://dev.meta.ai/docs/pricing-rate-limits" target="_blank" rel="noreferrer">About Contributor mode</a></p>${active&&state.settings.providerKeyId!=='demo'?'<button type="button" class="button" data-action="use-demo-model">Use demo model</button>':''}${Number(d.uncertain_calls)>0?'<p class="small muted">Some usage is uncertain; its reserved credit stays held until reconciled.</p>':''}</section>`;
}
export function launchConnection(model){
  const d=state.providers.demo;
  if(model.key==='demo'&&d)return `<div class="demo-launch-note"><strong>Spekios demo key · ${money(d.remaining_usd)} remaining</strong><p class="small">${esc(d.model)} only. Meta Contributor mode may use demo prompts and screenshots to improve its models.</p><a href="#/settings/models">Manage models and API keys</a></div>`;
  const key=providerKeys(model.provider).find(k=>model.key?k.key_id===model.key:k.is_default);
  return key?`<p class="small muted launch-key-note">Using your key: <strong>${esc(key.name)}</strong>. Billed by your provider; demo credits are not used. <a href="#/settings/models">Manage keys</a></p>`:'';
}
export function keysPanel(){
  if(!Array.isArray(state.providers.keys))return '';
  const keys=state.providers.keys;
  return `<section class="panel settings-card" aria-labelledby="personal-keys-title"><div class="settings-card-head"><div><h3 id="personal-keys-title">Your API keys</h3><p>Give each key a name. Save multiple keys for a provider, then choose one for your defaults, a project or a test.</p></div><button type="button" class="button" data-action="add-provider-key">${icon('plus')}Add API key</button></div><div class="settings-card-body">${state.providers.vault_ready===false?'<p class="notice">Key storage is not ready yet. Ask your administrator to enable it.</p>':''}${keys.length?`<ul class="personal-key-list">${keys.map(k=>`<li><div><strong>${esc(k.name)}</strong><small>${esc(providerName(k.provider))}${k.is_default?' · provider default':''}</small></div><div class="row">${k.is_default?'':`<button type="button" class="button quiet" data-action="default-provider-key" data-id="${esc(k.key_id)}">Make default</button>`}<button type="button" class="button quiet" data-action="revoke-provider-key" data-id="${esc(k.key_id)}" aria-label="Remove ${esc(k.name)}">Remove</button></div></li>`).join('')}</ul>`:'<p class="small muted">No personal keys yet. Demo credit does not limit which keys or models you can add.</p>'}<p class="small muted">Keys are saved securely and never shown again. A provider default is used only when you select it; demo calls never silently switch to a personal key.</p></div></section>`;
}
export function openProviderKeyDialog(provider=MODEL_PROVIDERS[0],onSaved){
  if(document.getElementById('provider-key-dialog'))return;
  const dialog=document.createElement('dialog');dialog.id='provider-key-dialog';dialog.className='provider-key-dialog';
  dialog.innerHTML=`<form id="provider-key-form"><div class="row"><h2>Add an API key</h2><button type="button" class="button quiet" data-close-key aria-label="Close API key form">${icon('close')}</button></div><p class="small muted">Name this key so you can recognize it when choosing a project’s model connection.</p><label for="key-provider">Provider<select id="key-provider" name="provider">${MODEL_PROVIDERS.map(p=>`<option value="${p}" ${p===provider?'selected':''}>${esc(providerName(p))}</option>`).join('')}</select></label><label for="key-name">Key name<input id="key-name" name="name" maxlength="60" required autocomplete="off" placeholder="For example, Production or Personal"></label><label for="key-secret">API key<input id="key-secret" name="api_key" type="password" minlength="8" maxlength="4096" required autocomplete="off" spellcheck="false" autocapitalize="off"></label><label class="row"><input name="make_default" type="checkbox" ${providerKeys(provider).length?'':'checked'}> Use as this provider’s default key</label><p id="provider-key-error" class="small error" role="alert"></p><div class="row"><button type="button" class="button" data-close-key>Cancel</button><button type="submit" class="button primary">Save key</button></div><p class="small muted">You can add another key for the same provider later. Keys are never included in model prompts or reports.</p></form>`;
  const opener=document.activeElement;
  dialog.querySelector('#key-provider').addEventListener('change',event=>{
    dialog.querySelector('[name="make_default"]').checked=providerKeys(event.target.value).length===0;
  });
  const close=()=>{dialog.querySelector('#key-secret').value='';dialog.close();dialog.remove();opener?.focus?.();};
  dialog.querySelectorAll('[data-close-key]').forEach(button=>button.addEventListener('click',close));
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  const id=crypto.randomUUID();
  dialog.querySelector('form').addEventListener('submit',async event=>{
    event.preventDefault();const form=new FormData(event.target),secret=String(form.get('api_key')||'');
    dialog.querySelector('#key-secret').value='';form.delete('api_key');
    const buttons=dialog.querySelectorAll('button');buttons.forEach(b=>b.disabled=true);
    try{
      await api('/v1/provider-keys',{key_id:id,provider:form.get('provider'),name:String(form.get('name')||'').trim(),api_key:secret,make_default:form.has('make_default')});
      state.providers=await get('/v1/model-providers');close();onSaved?.(id,String(form.get('provider')));toast('API key saved.');render();
    }catch(error){dialog.querySelector('#provider-key-error').textContent=error.message;buttons.forEach(b=>b.disabled=false);dialog.querySelector('#key-secret').focus();}
  });
  document.body.append(dialog);dialog.showModal();dialog.querySelector('#key-name').focus();
}
export async function changeProviderKey(id,action){
  try{await api(`/v1/provider-keys/${id}/${action}`,{});state.providers=await get('/v1/model-providers');toast(action==='revoke'?'Key removed. Choose another key for any models using it.':'Provider default updated.');render();}catch(error){toast(error.message);}
}
