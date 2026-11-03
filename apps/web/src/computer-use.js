import {api,get} from './api.js';
import {state} from './state.js';
import {esc} from '/assets/ui/format.js';
import {render} from './app.js';

export function computerUseStatus(provider,model,keyReference,providers=state.providers){
  if(provider!=='meta')return {available:false,label:'Unsupported by this integration'};
  if((providers.computer_use?.documented_models||['muse-spark-1.3','muse-wonder-1.0']).includes(model))return {available:true,label:'Available · documented by Meta'};
  const source=keyReference==='demo'?'demo':keyReference?'personal':providers.keys?.some(k=>k.provider==='meta'&&k.is_default&&!k.revoked_at)?'personal':'operator';
  const key=keyReference==='demo'?null:keyReference||providers.keys?.find(k=>k.provider==='meta'&&k.is_default&&!k.revoked_at)?.key_id||null;
  const verified=(providers.computer_use?.verified_connections||[]).some(c=>c.model===model&&c.funding_source===source&&(source==='demo'||c.provider_key_id===key));
  return {available:verified,label:verified?'Available · compatibility checked':'Unverified · check this connection first'};
}
export function computerUseField(model,index,reference){
  const status=computerUseStatus(model.provider,model.model,reference);
  const checking=state.computerUseCheck;
  return `<div class="model-computer-use"><small class="small muted">Computer use: ${esc(status.label)}</small><label><input type="checkbox" data-configuration-field="saved.${index}.computer_use" ${status.available&&(model.computer_use??['muse-spark-1.3','muse-wonder-1.0'].includes(model.model))?'checked':''} ${!status.available?'disabled':''}> Allow computer-use recovery</label><p class="small muted">Uses visual clicks, hovering, panel scrolling and dragging when normal exploration cannot progress.</p>${model.provider==='meta'?`<button type="button" class="button quiet" data-action="check-computer-use" data-index="${index}" ${checking?'disabled':''}>${checking?.index===index?'Checking…':'Check compatibility'}</button><small class="small muted">Makes one metered model call with ${reference==='demo'?'the demo API key':reference?'the selected exploration API key':'the account’s default API key'}. No app screenshots are sent and no actions execute.</small>`:''}${state.computerUseResult?.model===model.model&&state.computerUseResult?.provider===model.provider?`<p class="small" role="status">${esc(state.computerUseResult.message)}</p>`:''}</div>`;
}
export async function checkComputerUse(model,index,reference){
  if(state.computerUseCheck||model?.provider!=='meta')return;
  const token=state.token,browserAuth=state.browserAuth;
  const check={index,requestId:crypto.randomUUID()};state.computerUseCheck=check;render();
  let message='The connection could not be verified. Recovery remains unavailable for unverified models.';
  try{
    await api('/v1/computer-use/check',{request_id:check.requestId,provider:model.provider,model:model.model,...(reference?{provider_key_id:reference}:{})});
    const deadline=Date.now()+100000;
    while(Date.now()<deadline){
      const report=await get('/v1/model-requests/'+check.requestId);
      if(token!==state.token||browserAuth!==state.browserAuth)return;
      if(report.request.state==='completed'){
        state.providers=await get('/v1/model-providers');
        message='Compatibility confirmed for this connection. You can enable computer-use recovery and save your defaults.';break;
      }
      if(['failed','cancelled','interrupted'].includes(report.request.state)){message='This check did not confirm native computer-use support. Normal exploration is still available.';break;}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  }catch(error){message=error.message;}
  finally{
    if(state.computerUseCheck===check){state.computerUseCheck=null;
      if(token===state.token&&browserAuth===state.browserAuth){state.computerUseResult={provider:model.provider,model:model.model,message};render();}}
  }
}
