import {appSource} from './support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
function setup({identity={principal_kind:'workspace_manager',workspace_id:'workspace-A',workspace_name:'My team'},connection={agent_name:'<img src=x onerror=bad()>',workspace_id:'workspace-A',status:'pending',scopes:['runs:read','runs:write'],expires_at:'2099-01-01T00:00:00Z'},agents=[],hash='#code=ABCD1234EF56',cloud=false,intercept}={}){
  const nodes=new Map(),requests=[],copied=[],navigations=[],events={},storage=new Map([['scout.workspace-token','local-manager-fixture']]);
  const node=()=>({value:'',textContent:'',hidden:false,disabled:false,children:[],handlers:{},attributes:{},setAttribute(k,v){this.attributes[k]=v;},addEventListener(name,fn){this.handlers[name]=fn;},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=[...children]}});
  const get=selector=>{if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector)};
  let replaced=false;
  const context={document:{querySelector:get,createElement:node,hidden:false},location:{hash,pathname:'/connect',assign(value){navigations.push(value)}},history:{replaceState(){replaced=true}},sessionStorage:{getItem(key){return storage.get(key)||null},setItem(key,value){storage.set(key,value)},removeItem(key){storage.delete(key)}},window:{addEventListener(key,fn){events[key]=fn}},navigator:{clipboard:{async writeText(value){copied.push(value)}}},setInterval(){return 1},clearInterval(){},URL,URLSearchParams,AbortSignal,Date,encodeURIComponent,fetch:async(path,options)=>{
    requests.push({path,options});const body=path==='/v1/identity'?identity:path==='/v1/agents'?{agents}:path==='/v1/agent-setup'?{mcp_url:cloud?'https://scout.example/mcp':'http://127.0.0.1:18080/mcp',cloud_reachable:cloud}:path.endsWith('/decision')?{status:'approved',redirect_uri:'http://127.0.0.1:54000/callback?code=one-use-code'}:connection;
    return await intercept?.(path,options,body)??{ok:true,status:200,json:async()=>body};
  }};
  vm.createContext(context);
  const source=appSource('connect.js').split("\nselectClient('desktop');renderPrompt();await loadSetup();")[0];
  vm.runInContext(source+'\nglobalThis.testing={ready,list,loadSetup,selectClient,renderPrompt,prompt};',context);
  return {nodes,get,requests,copied,navigations,events,storage,location:context.location,ui:context.testing,replaced:()=>replaced};
}
const submit=ui=>ui.get('#code-form').handlers.submit({preventDefault(){}});
test('native approval is explicit and untrusted agent names render as text',async()=>{
  const ui=setup();await ui.ui.ready();
  assert.equal(ui.replaced(),true);
  assert.equal(ui.get('#agent-name').textContent,'Allow <img src=x onerror=bad()> to connect?');
  assert.equal(ui.get('#approval').hidden,false);
  assert.equal(ui.get('#usage-warning').hidden,false);
  assert.equal(ui.requests.some(r=>r.path.endsWith('/decision')),false);
  assert.match(ui.get('#workspace-label').textContent,/My team/);
  await ui.get('#approve').handlers.click();
  const decision=ui.requests.find(r=>r.path.endsWith('/decision'));
  assert.equal(JSON.parse(decision.options.body).approve,true);
  assert.equal(ui.get('#approval').hidden,true);
});
test('browser OAuth approval returns only to the server-validated callback after a human action',async()=>{
  const ui=setup({hash:'#authorization=fixture-authorization',connection:{agent_name:'My desktop agent',redirect_uri:'http://127.0.0.1:54000/callback',status:'pending',scopes:['runs:read'],expires_at:'2099-01-01T00:00:00Z'}});
  await ui.ui.ready();
  assert.equal(ui.get('#connection-onboarding').hidden,true);
  assert.match(ui.get('#callback-label').textContent,/127.0.0.1:54000/);
  assert.equal(ui.get('#usage-warning').hidden,true);
  assert.deepEqual(ui.navigations,[]);
  assert.equal(ui.requests.some(r=>r.path==='/oauth/token'),false,'Browser does not exchange or store the agent secret');
  await ui.get('#approve').handlers.click();
  assert.equal(ui.requests.filter(r=>r.path.endsWith('/decision')).length,1);
  assert.deepEqual(ui.navigations,['http://127.0.0.1:54000/callback?code=one-use-code']);
});
test('cancelling OAuth is explicit and does not issue an approval',async()=>{
  const ui=setup({hash:'#authorization=fixture-authorization'});await ui.ui.ready();await ui.get('#deny').handlers.click();
  assert.equal(JSON.parse(ui.requests.find(r=>r.path.endsWith('/decision')).options.body).approve,false);
});
test('an agent credential cannot approve another agent as a human',async()=>{
  const ui=setup({identity:{principal_kind:'agent',workspace_id:'workspace-A'}});await ui.ui.ready();
  assert.equal(ui.get('#connections').hidden,true);assert.equal(ui.get('#manager-login').hidden,false);
  assert.equal(ui.requests.some(r=>r.path==='/v1/agents'),false);
});
test('connection status distinguishes approval from actual use and disconnect is scoped',async()=>{
  const ui=setup({agents:[{agent_id:'fixture-agent',name:'<script>bad()</script>',scopes:['runs:read'],expires_at:'2099-01-01T00:00:00Z',last_used_at:null,revoked_at:null,connection_kind:'browser_oauth'}]});await ui.ui.list();
  const article=ui.get('#agent-list').children[0];assert.equal(article.children[0].children[0].textContent,'<script>bad()</script>');
  assert.equal(article.children[0].children[1].textContent,'Approved · waiting for first use');
  await article.children[3].handlers.click();
  assert.ok(ui.requests.some(r=>r.path==='/v1/agents/fixture-agent/revoke'&&r.options.method==='POST'));
  assert.equal(ui.requests.some(r=>r.path.includes('local-manager-fixture')),false);
});
test('expired agents are not reported as connected even when they were used before',async()=>{
  const ui=setup({agents:[{agent_id:'expired',name:'Old connection',scopes:[],expires_at:'2000-01-01T00:00:00Z',last_used_at:'2000-01-01T00:00:00Z'}]});await ui.ui.list();
  assert.equal(ui.get('#agent-list').children[0].children[0].children[1].textContent,'Expired');
});
test('user setup copies a public URL without credentials or checkout commands',async()=>{
  const ui=setup({hash:''});await ui.ui.loadSetup();await ui.get('#copy-url').handlers.click();
  assert.deepEqual(ui.copied,['http://127.0.0.1:18080/mcp']);
  const html=readFileSync(new URL('../connect.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/just mcp|target\/release|SCOUT_API_TOKEN/);
  assert.equal(ui.get('#client-desktop').attributes['aria-pressed'],'true');
});
test('cloud connectors are told when a local server is unreachable',async()=>{
  const ui=setup();await ui.ui.loadSetup();ui.ui.selectClient('claude');
  assert.equal(ui.get('#network-notice').hidden,false);
  assert.match(ui.get('#network-notice').textContent,/cannot reach this local address/);
  const remote=setup({cloud:true});await remote.ui.loadSetup();remote.ui.selectClient('claude');assert.equal(remote.get('#network-notice').hidden,true);
});
test('starter prompt contains no credentials and rejects credential-bearing URLs',async()=>{
  const ui=setup({hash:''});ui.get('#test-url').value='https://my-app.example/settings';ui.ui.renderPrompt();
  await ui.get('#copy-prompt').handlers.click();assert.match(ui.copied[0],/https:\/\/my-app.example\/settings/);
  ui.get('#test-url').value='https://user:secret@my-app.example';ui.ui.renderPrompt();assert.equal(ui.get('#copy-prompt').disabled,true);
  ui.get('#test-url').value='javascript:alert(1)';assert.equal(ui.ui.prompt(),null);
});
test('read-only native approval does not claim permission to spend model usage',async()=>{
  const ui=setup({connection:{agent_name:'Reader',status:'pending',scopes:['runs:read'],expires_at:'2099-01-01T00:00:00Z'}});await submit(ui);assert.equal(ui.get('#usage-warning').hidden,true);
});

test('an existing setup tab handles a new OAuth fragment without a page reload or automatic approval',async()=>{
  const ui=setup({hash:''});await ui.ui.ready();
  ui.location.hash='#authorization=next-browser-request';await ui.events.hashchange();
  assert.ok(ui.requests.some(r=>r.path==='/v1/oauth/authorizations/next-browser-request'));
  assert.equal(ui.get('#approval').hidden,false);
  assert.equal(ui.storage.get('scout.pending-authorization'),'next-browser-request');
  assert.equal(ui.requests.some(r=>r.path.endsWith('/decision')),false);
});

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const approval=name=>({agent_name:name,status:'pending',scopes:['runs:read'],expires_at:'2099-01-01T00:00:00Z'});
test('a new approval lookup hides the previous consent and cannot approve before it is displayed',async()=>{
  const pending=deferred();const ui=setup({hash:'#authorization=first',intercept:(path)=>path==='/v1/oauth/authorizations/second'?pending.promise:undefined});
  await ui.ui.ready();ui.location.hash='#authorization=second';const loading=ui.events.hashchange();
  assert.equal(ui.get('#approval').hidden,true);
  await ui.get('#approve').handlers.click();assert.equal(ui.requests.some(r=>r.path.endsWith('/decision')),false);
  pending.resolve({ok:true,json:async()=>approval('Second agent')});await loading;
  assert.match(ui.get('#agent-name').textContent,/Second agent/);
  await ui.get('#approve').handlers.click();assert.equal(ui.requests.find(r=>r.path.endsWith('/decision')).path,'/v1/oauth/authorizations/second/decision');
});
test('out-of-order approval lookups never replace the newest agent or its decision target',async()=>{
  const old=deferred();const ui=setup({hash:'',intercept:path=>path==='/v1/oauth/authorizations/old'?old.promise:path==='/v1/oauth/authorizations/new'?{ok:true,json:async()=>approval('New agent')}:undefined});await ui.ui.ready();
  ui.location.hash='#authorization=old';const first=ui.events.hashchange();
  ui.location.hash='#authorization=new';await ui.events.hashchange();
  old.resolve({ok:true,json:async()=>approval('Old agent')});await first;
  assert.match(ui.get('#agent-name').textContent,/New agent/);
  await ui.get('#approve').handlers.click();assert.equal(ui.requests.find(r=>r.path.endsWith('/decision')).path,'/v1/oauth/authorizations/new/decision');
});
test('expired workspace access returns to login even after a successful manager lookup',async()=>{
  let expired=false;const ui=setup({hash:'',intercept:path=>expired&&path==='/v1/identity'?{ok:false,status:401,json:async()=>({error:'unauthorized'})}:undefined});await ui.ui.ready();expired=true;await ui.ui.ready();
  assert.equal(ui.get('#manager-login').hidden,false);assert.equal(ui.get('#connections').hidden,true);
});
test('a workspace change while JSON is arriving cannot restore the old manager identity',async()=>{
  const body=deferred(),entered=deferred();const ui=setup({hash:'',intercept:(path,options)=>{
    if(path!=='/v1/identity')return;
    if(options.headers.Authorization==='Bearer local-manager-fixture')return {ok:true,json:()=>{entered.resolve();return body.promise;}};
    return {ok:true,json:async()=>({principal_kind:'workspace_manager',workspace_name:'New workspace'})};
  }});
  const old=ui.ui.ready();await entered.promise;ui.get('#manager-token').value='new-manager';await ui.get('#manager-form').handlers.submit({preventDefault(){}});
  body.resolve({principal_kind:'workspace_manager',workspace_name:'Old workspace'});await old;
  assert.match(ui.get('#workspace-label').textContent,/New workspace/);assert.equal(ui.get('#manager-login').hidden,true);
});
test('native pairing reviews also bind decisions to the latest displayed code',async()=>{
  const pending=deferred();const ui=setup({hash:'',intercept:path=>path==='/v1/agent-connections/OLD'?pending.promise:path==='/v1/agent-connections/NEW'?{ok:true,json:async()=>approval('New native agent')}:undefined});await ui.ui.ready();
  ui.get('#user-code').value='OLD';const old=submit(ui);ui.get('#user-code').value='NEW';await submit(ui);pending.resolve({ok:true,json:async()=>approval('Old native agent')});await old;
  assert.match(ui.get('#agent-name').textContent,/New native agent/);await ui.get('#approve').handlers.click();assert.equal(ui.requests.find(r=>r.path.endsWith('/decision')).path,'/v1/agent-connections/NEW/decision');
});
test('a new connection arriving during a decision is reviewed after the pending decision finishes',async()=>{
  const pending=deferred(),entered=deferred();const ui=setup({intercept:path=>{
    if(path.endsWith('/decision')){entered.resolve();return pending.promise;}
    if(path==='/v1/oauth/authorizations/next')return {ok:true,json:async()=>approval('Next agent')};
  }});await ui.ui.ready();const deciding=ui.get('#approve').handlers.click();await entered.promise;ui.location.hash='#authorization=next';await ui.events.hashchange();
  pending.resolve({ok:true,json:async()=>({status:'approved'})});await deciding;
  assert.match(ui.get('#agent-name').textContent,/Next agent/);assert.equal(ui.get('#approval').hidden,false);assert.equal(ui.requests.filter(r=>r.path.endsWith('/decision')).length,1,'The next connection still needs its own human decision');
});
