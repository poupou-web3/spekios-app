import {signIn,workspaceRequest,requireOk} from '/assets/ui/http.js';
import {mountThemeSwitch} from '/assets/ui/theme.js';
const $=selector=>document.querySelector(selector);
// The header theme control is the only shared widget on this page.
const themeSlot=$('[data-theme-slot]');if(themeSlot)mountThemeSwitch(themeSlot);
const status=$('#connection-status');
let token=sessionStorage.getItem('scout.workspace-token')||'',development=false,spekios=false,identity=null,busy=false;
let approvalTarget=null,reviewVersion=0,pendingFragment=false;
let setupInfo=null,selectedClient='desktop',refreshTimer;
let initial='',authorizationId=sessionStorage.getItem('scout.pending-authorization')||'';
function consumeFragment(){
  const fragment=new URLSearchParams(location.hash.slice(1));
  if(fragment.has('authorization')){authorizationId=fragment.get('authorization')||'';initial='';sessionStorage.setItem('scout.pending-authorization',authorizationId);}
  else if(fragment.has('code')){initial=fragment.get('code')||'';authorizationId='';sessionStorage.removeItem('scout.pending-authorization');}
  if(location.hash)history.replaceState(null,'',location.pathname);
  $('#user-code').value=initial;
}
consumeFragment();
const message=value=>{status.textContent=value;};
const labels={'runs:read':'Read runs, reports and recorded screenshots','runs:write':'Start tests, recheck findings and stop runs','usage:read':'Read workspace token and cost totals'};
const clients={
  desktop:{steps:['Open your agent app’s settings and find MCP servers.','Add a Streamable HTTP server named Spekios and paste the connection URL above.','Save the server, reconnect if needed, then select Authenticate to open Spekios’s approval page.'],help:'https://learn.chatgpt.com/docs/extend/mcp?surface=app'},
  claude:{steps:['In Claude, open Customize → Connectors → Add custom connector.','Name it Spekios and paste the connection URL above. Choose browser sign-in.','If asked for an OAuth client, choose Register automatically. Connect and approve the request in Spekios.'],help:'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp'},
  other:{steps:['Open your agent app’s integrations or MCP settings and add an HTTP server.','Paste the connection URL above. Choose browser authorization / OAuth.','Connect, then review and approve the request in Spekios. The client must support dynamic client registration and PKCE.'],help:'https://modelcontextprotocol.io/docs/learn/client-concepts'}
};
async function api(path,body){
  const currentToken=token;
  try{
    const response=await workspaceRequest(path,{token:currentToken,body,timeoutMs:15000});
    await requireOk(response);const value=await response.json();
    if(currentToken!==token)throw new Error('Workspace disconnected.');
    return value;
  }catch(e){
    if(currentToken!==token)throw new Error('Workspace disconnected.');
    if(e.status===401){if(spekios){location.assign('/login?next=%2Fconnect');throw e;}identity=null;clearInterval(refreshTimer);clearApproval();$('#manager-login').hidden=false;$('#connections').hidden=true;message('Workspace access expired. Sign in again to continue.');}
    throw e;
  }
}
function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function date(value){return new Date(value).toLocaleDateString();}
async function list(){
  const data=await api('/v1/agents');const root=$('#agent-list');root.replaceChildren();
  if(!data.agents.length){root.append(element('p','Your first agent will appear here after you approve its connection.','connection-empty'));return;}
  for(const agent of data.agents){
    const row=element('article',undefined,'panel connection-agent');
    const revoked=!!agent.revoked_at,expired=new Date(agent.expires_at).getTime()<=Date.now();
    const state=revoked?'Disconnected':expired?'Expired':agent.last_used_at?'Connected':'Approved · waiting for first use';
    const head=element('div',undefined,'connection-agent-heading');head.append(element('h3',agent.name),element('span',state,`pill ${!revoked&&!expired&&agent.last_used_at?'green':''}`));
    const info=element('p',`${agent.connection_kind==='browser_oauth'?'Browser connection':'Native connector'} · ${revoked?'Access revoked':'Reconnect after '+date(agent.expires_at)} · ${agent.last_used_at?'Last used '+new Date(agent.last_used_at).toLocaleString():'Not used yet'}`,'small muted');
    const detail=element('details',undefined,'small connection-agent-details');detail.append(element('summary','Permissions & connection ID'),element('p',(agent.scopes||[]).map(scope=>labels[scope]||scope).join(' · ')),element('code',agent.agent_id));
    row.append(head,info,detail);
    if(!revoked&&!expired){const button=element('button','Disconnect','button');button.addEventListener('click',async()=>{button.disabled=true;try{await api(`/v1/agents/${encodeURIComponent(agent.agent_id)}/revoke`,{});message('Agent disconnected. Its recorded tests are still available.');await list();}catch(e){message(e.message);button.disabled=false;}});row.append(button);}
    root.append(row);
  }
}
function selectClient(client){
  selectedClient=client;
  for(const key of Object.keys(clients))$('#client-'+key).setAttribute('aria-pressed',String(key===client));
  $('#client-steps').replaceChildren(...clients[client].steps.map(step=>element('li',step)));
  $('#client-help').href=clients[client].help;
  const local=setupInfo&&!setupInfo.cloud_reachable;
  $('#network-notice').hidden=!local;
  $('#network-notice').textContent=client==='claude'?'Claude’s account connectors run in the cloud and cannot reach this local address. Use a publicly reachable HTTPS Spekios deployment for this option. Local agent apps can connect to this machine.':'This Spekios address works for agent apps on this computer. Cloud agents and apps on other devices need a reachable HTTPS Spekios deployment.';
}
function prompt(){
  const raw=$('#test-url').value.trim();let target='the app URL I provide';
  if(raw){try{const url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error();target=url.href;}catch{return null;}}
  return `Use Spekios to test ${target}. Check my workspace identity and relevant previous runs first. Start a new test when needed, check progress, and bring back a report with expected vs. actual behavior and screenshot evidence. If access is needed, ask me to sign in through Spekios.`;
}
function renderPrompt(){const text=prompt();$('#starter-prompt').textContent=text||'Enter an HTTP or HTTPS app URL without credentials.';$('#copy-prompt').disabled=!text;}
async function copy(value,label){try{await navigator.clipboard.writeText(value);message(label);}catch{message('Copy is unavailable in this browser. Select and copy the displayed text.');}}
async function loadSetup(){
  try{setupInfo=await api('/v1/agent-setup');$('#mcp-url').value=setupInfo.mcp_url;$('#copy-url').disabled=false;selectClient(selectedClient);}catch(e){message('Connection setup is unavailable: '+e.message);}
}
function showApproval(connection,kind){
  if(connection.status!=='pending')throw new Error('This connection has already been decided. Start a new connection in your agent if needed.');
  $('#agent-name').textContent=`Allow ${connection.agent_name} to connect?`;
  $('#approval-scope').textContent=`${identity?.workspace_name||'Your workspace'} · Request expires ${new Date(connection.expires_at).toLocaleTimeString()}`;
  $('#callback-label').hidden=kind!=='oauth';$('#client-warning').hidden=kind!=='oauth';
  $('#callback-label').textContent=kind==='oauth'?`Return to: ${connection.redirect_uri}`:'';
  $('#scopes').replaceChildren(...connection.scopes.map(scope=>element('li',labels[scope]||scope)));
  $('#usage-warning').hidden=!connection.scopes.includes('runs:write');
  $('#approval').hidden=false;$('#connection-onboarding').hidden=true;$('#approve').disabled=false;$('#deny').disabled=false;
  message('Review the app, workspace and permissions. Access is granted only when you allow this connection.');
}
async function ready(){
  try{identity=await api('/v1/identity');if(identity.principal_kind!=='workspace_manager')throw new Error('Open this page with your workspace access to approve an agent.');
    $('#workspace-label').textContent=`${identity.workspace_name||'Your workspace'} · Runs and evidence stay private to this workspace.`;
    $('#manager-login').hidden=true;$('#connections').hidden=false;await list();
    if(authorizationId||initial){await reviewPending();}else{message('Choose your agent to get started.');}
    clearInterval(refreshTimer);refreshTimer=setInterval(()=>{if(!document.hidden&&!busy)list().catch(()=>{});},10000);
  }catch(e){message(e.message);if(!identity||identity.principal_kind!=='workspace_manager'){$('#manager-login').hidden=false;$('#connections').hidden=true;}}
}
async function reviewPending(){
  if(authorizationId)await reviewTarget('oauth',authorizationId);else if(initial)await reviewCode();
}
async function fragmentChanged(){
  if(!location.hash)return;
  if(busy){pendingFragment=true;return;}
  consumeFragment();if(identity?.principal_kind==='workspace_manager')await reviewPending();
}
window.addEventListener('hashchange',fragmentChanged);
function clearApproval(){reviewVersion++;approvalTarget=null;$('#approval').hidden=true;$('#approve').disabled=true;$('#deny').disabled=true;}
async function reviewTarget(kind,id){
  clearApproval();const version=reviewVersion;message('Loading connection details…');
  try{
    const connection=await api(`${kind==='oauth'?'/v1/oauth/authorizations':'/v1/agent-connections'}/${encodeURIComponent(id)}`);
    if(version!==reviewVersion)return;
    showApproval(connection,kind);approvalTarget={kind,id,version};
  }catch(e){
    if(version!==reviewVersion)return;
    if(kind==='oauth'&&[404,409].includes(e.status)){sessionStorage.removeItem('scout.pending-authorization');authorizationId='';}
    $('#connection-onboarding').hidden=false;message(e.message);
  }
}
async function reviewCode(){
  if(busy)return;
  authorizationId='';sessionStorage.removeItem('scout.pending-authorization');
  const code=$('#user-code').value.trim().replaceAll('-','').toUpperCase();
  await reviewTarget('native',code);
}
for(const client of Object.keys(clients))$('#client-'+client).addEventListener('click',()=>selectClient(client));
$('#copy-url').addEventListener('click',()=>setupInfo&&copy(setupInfo.mcp_url,'Connection URL copied. Add it in your agent app.'));
$('#test-url').addEventListener('input',renderPrompt);
$('#copy-prompt').addEventListener('click',()=>{const text=prompt();if(text)return copy(text,'Prompt copied. Paste it into your connected agent.');});
$('#refresh-agents').addEventListener('click',async()=>{try{await list();message('Connection status refreshed. An agent is connected after its first authenticated request.');}catch(e){message(e.message);}});
$('#manager-form').addEventListener('submit',async event=>{event.preventDefault();clearApproval();const email=$('#manager-email').value.trim(),password=$('#manager-password').value;$('#manager-password').value='';try{await signIn(email,password);token=password;sessionStorage.setItem('scout.workspace-token',token);identity=null;await ready();}catch(e){message(e.message);}});
$('#code-form').addEventListener('submit',async event=>{event.preventDefault();await reviewCode();});
for(const [id,approve] of [['approve',true],['deny',false]])$('#'+id).addEventListener('click',async()=>{
  const target=approvalTarget;
  if(busy||!target||target.version!==reviewVersion)return;busy=true;$('#approve').disabled=true;$('#deny').disabled=true;
  try{
    const result=await api(`${target.kind==='oauth'?'/v1/oauth/authorizations':'/v1/agent-connections'}/${encodeURIComponent(target.id)}/decision`,{approve});
    if(target!==approvalTarget)return;
    if(target.kind==='oauth'){clearApproval();sessionStorage.removeItem('scout.pending-authorization');message(approve?'Connection allowed. Returning to your agent…':'Connection cancelled. Returning to your agent…');location.assign(result.redirect_uri);return;}
    clearApproval();$('#connection-onboarding').hidden=false;
    message(approve?'Allowed. Your connector will finish connecting.':'Connection cancelled.');await list();
  }catch(e){if(target===approvalTarget){message(e.message);$('#approve').disabled=false;$('#deny').disabled=false;}}finally{busy=false;if(pendingFragment){pendingFragment=false;await fragmentChanged();}}
});
selectClient('desktop');renderPrompt();await loadSetup();
try{const auth=await (await fetch('/v1/auth-mode',{redirect:'error'})).json();development=auth.mode==='local_development';spekios=auth.mode==='spekios';if(development||spekios)token='';if(token||development||spekios)await ready();else $('#manager-login').hidden=false;}catch(e){message(e.message);$('#manager-login').hidden=false;}
