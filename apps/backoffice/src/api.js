// Operator requests. A 401 closes the session and returns to the operator sign-in.
import {requireOk,workspaceRequest} from '/assets/ui/http.js';
import {login} from './app.js';
import {state} from './state.js';
export async function api(path,body,extraHeaders={},timeoutMs=18000){
  const token=state.token,developmentAccess=state.developmentAccess;
  const response=await workspaceRequest(path,{token:developmentAccess?'':token,body,headers:extraHeaders,timeoutMs});
  if(token!==state.token||developmentAccess!==state.developmentAccess)throw new Error('Back office disconnected.');
  if(response.status===401){state.connected=false;state.developmentAccess=false;state.token='';state.drawer=null;state.error='Operator access is required.';sessionStorage.removeItem('scout.backoffice-token');login();throw new Error('Operator access is required.');}
  return requireOk(response);
}
export const get = async path => (await api(path)).json();
