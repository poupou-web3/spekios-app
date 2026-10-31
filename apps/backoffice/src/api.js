// Operator requests. A 401 closes the session and returns to the operator sign-in.
import {requireOk,workspaceRequest} from '/assets/ui/http.js';
import {login} from './app.js';
import {state} from './state.js';
export async function api(path,body,extraHeaders={},timeoutMs=18000){
  const token=state.token,developmentAccess=state.developmentAccess;
  const response=await workspaceRequest(path,{token:developmentAccess?'':token,body,headers:extraHeaders,timeoutMs});
  if(token!==state.token||developmentAccess!==state.developmentAccess)throw new Error('Back office disconnected.');
  if(response.status===401){state.connected=false;state.developmentAccess=false;state.token='';state.drawer=null;state.error='Operator access is required.';sessionStorage.removeItem('scout.backoffice-token');login();throw new Error('Operator access is required.');}
  if(response.status===304)return response;
  return requireOk(response);
}
export async function get(path, headers){
  const response=await api(path, undefined, headers);
  if(response.status===304)return null;
  const etag=response.headers?.get?.('etag')||'';
  const body=await response.json();
  if(etag&&body&&typeof body==='object')Object.defineProperty(body,'_etag',{value:etag,configurable:true});
  return body;
}
