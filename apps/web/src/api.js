import {closeAgentHandoff} from './agent-handoff.js';
import {resetNotifications} from './notifications.js';
// Authenticated workspace requests. A 401 closes the session and returns to sign-in.
import {requireOk,workspaceRequest} from '/assets/ui/http.js';
import {clearImages} from './images.js';
import {login} from './shell.js';
import {state,steeringDrafts} from './state.js';
import {closeReportExport} from './views/export.js';
export async function api(path,body,extraHeaders={},timeoutMs=18000,signal=null){
  const token=state.token,developmentAccess=state.developmentAccess,browserAuth=state.browserAuth;
  const response=await workspaceRequest(path,{token:developmentAccess?'':token,body,headers:extraHeaders,timeoutMs,signal});
  if((token!==state.token||developmentAccess!==state.developmentAccess||browserAuth!==state.browserAuth))throw new Error('Workspace disconnected.');
  if(response.status===401){state.computerUseCheck=null;state.computerUseResult=null;closeAgentHandoff();resetNotifications();state.identity=null;closeReportExport();state.connected=false;state.developmentAccess=false;state.browserAuth=false;state.token='';state.configurationDraft=null;steeringDrafts.clear();state.error='Workspace access is required.';sessionStorage.removeItem('scout.workspace-token');clearImages();login();throw new Error('Workspace access is required.');}
  if(response.status===304)return response;
  return requireOk(response);
}
export async function get(path, headers){
  const browserAuth=state.browserAuth;
  const response=await api(path, undefined, headers);
  if(response.status===304)return null;
  const etag=response.headers?.get?.('etag')||'';
  const body=await response.json();
  if(browserAuth!==state.browserAuth)throw new Error("Workspace disconnected.");
  if(etag&&body&&typeof body==='object')Object.defineProperty(body,'_etag',{value:etag,configurable:true});
  return body;
}
