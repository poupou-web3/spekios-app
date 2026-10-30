// Authenticated workspace requests. A 401 closes the session and returns to sign-in.
import {requireOk,workspaceRequest} from '/assets/ui/http.js';
import {clearImages} from './images.js';
import {login} from './shell.js';
import {state,steeringDrafts} from './state.js';
import {closeReportExport} from './views/export.js';
export async function api(path,body,extraHeaders={},timeoutMs=18000,signal=null){
  const token=state.token,developmentAccess=state.developmentAccess;
  const response=await workspaceRequest(path,{token:developmentAccess?'':token,body,headers:extraHeaders,timeoutMs,signal});
  if((token!==state.token||developmentAccess!==state.developmentAccess))throw new Error('Workspace disconnected.');
  if(response.status===401){closeReportExport();state.connected=false;state.developmentAccess=false;state.token='';state.configurationDraft=null;steeringDrafts.clear();state.error='Workspace access is required.';sessionStorage.removeItem('scout.workspace-token');clearImages();login();throw new Error('Workspace access is required.');}
  return requireOk(response);
}
export const get = async path => (await api(path)).json();
