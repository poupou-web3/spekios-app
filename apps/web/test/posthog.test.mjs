import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {appSource} from './support.mjs';

function workspace(fetch=async()=>({ok:true,status:200,json:async()=>({})})){
  const node={innerHTML:'',classList:{add(){},remove(){}},querySelectorAll(){return[];},addEventListener(){}};
  const sandbox={document:{querySelector(){return node;},getElementById(){return null;},addEventListener(){}},window:{addEventListener(){}},location:{pathname:'/website/https%3A%2F%2Frecorded.test/settings/posthog',search:'',hash:''},sessionStorage:{getItem(){return null;},setItem(){},removeItem(){}},fetch,AbortSignal,URL,setInterval(){},setTimeout(){},clearTimeout(){},crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'}};
  vm.createContext(sandbox);vm.runInContext(appSource('main.js')+'\nglobalThis.testing={state,posthogPanel,posthogProjectView,settingsView,loadPostHog,posthogAction};',sandbox);return sandbox.testing;
}
const base='/v1/websites/'+encodeURIComponent('https://recorded.test')+'/posthog/connections';
const connection={connection_id:'11111111-1111-4111-8111-111111111111',name:'Demo <script>',source_origin:'https://recorded.test',replay_origin:'https://test.test',host:'https://ph.test',project_id:'1',enabled:true,auto_replay:true,sessions:2,workflows:1};
test('PostHog settings escape imported content and distinguish inference from validation',()=>{
  const ui=workspace();Object.assign(ui.state,{websiteOrigin:'https://recorded.test',posthogOrigin:'https://recorded.test',websitePage:'settings',posthog:{vault_ready:true,allowed_hosts:['https://ph.test'],replay_origins:['https://test.test'],connections:[connection]},posthogSelected:connection.connection_id,posthogDetail:{workflows:[{workflow_id:'f',title:'Open <img src=x>',steps:[{action:'observe',label:'Result',value:'<script>never execute</script>'}],issues:['Masked <input>'],executable:false,sessions:2}],sessions:[],replays:[{status:'completed',created_at:'2026-11-03',result:{outcome:'steps_executed',steps:[]}}]}});
  const html=ui.posthogProjectView();assert.doesNotMatch(ui.settingsView(),/PostHog/);assert.match(html,/PostHog journeys/);assert.match(html,/Demo &lt;script&gt;/);assert.match(html,/Open &lt;img src=x&gt;/);assert.doesNotMatch(html,/<script>|<img src=x>/);assert.match(html,/Steps executed; no explicit outcome/);assert.match(html,/Needs information/);assert.match(html,/data-action="posthog-replay"[^>]*disabled/);assert.doesNotMatch(html,/id="exploration-configuration-form"/);
});
test('switching connectors clears old detail and posts to the selected scoped workflow endpoint',async()=>{
  const calls=[],ui=workspace(async(path,options)=>{calls.push([path,options?.method]);return {ok:true,status:200,json:async()=>path===base?{connections:[connection],replay_origins:[],allowed_hosts:[]}: {workflows:[],sessions:[],replays:[]}};});
  Object.assign(ui.state,{developmentAccess:true,connected:true,websiteOrigin:'https://recorded.test',posthogOrigin:'https://recorded.test',websitePage:'settings',view:'workspace',posthogSelected:connection.connection_id});
  await ui.loadPostHog();assert.equal(ui.state.posthog.connections.length,1);assert.equal(ui.state.posthogDetail.workflows.length,0);
  await ui.posthogAction('replay','22222222-2222-4222-8222-222222222222');assert.ok(calls.some(([path,method])=>path===`${base}/${connection.connection_id}/workflows/22222222-2222-4222-8222-222222222222/replay`&&method==='POST'));
});
test('a late connector response cannot restore another login’s imported data',async()=>{
  let release;const ui=workspace(()=>new Promise(resolve=>{release=resolve;}));Object.assign(ui.state,{websiteOrigin:'https://recorded.test',token:'old-login',developmentAccess:false,browserAuth:false});
  const pending=ui.loadPostHog();ui.state.token='new-login';release({ok:true,status:200,json:async()=>({connections:[connection]})});await pending;assert.equal(ui.state.posthog,null);
});
test('switching projects clears the previous analysis and ignores its late response',async()=>{
  let release;
  const ui=workspace(path=>path===base?new Promise(resolve=>{release=resolve;}):Promise.resolve({ok:true,status:200,json:async()=>({connections:[]})}));
  Object.assign(ui.state,{developmentAccess:true,websiteOrigin:'https://recorded.test'});
  const pending=ui.loadPostHog();ui.state.websiteOrigin='https://sibling.test';await ui.loadPostHog();
  release({ok:true,status:200,json:async()=>({connections:[connection]})});await pending;
  assert.equal(ui.state.posthogOrigin,'https://sibling.test');assert.equal(ui.state.posthog.connections.length,0);assert.equal(ui.state.posthogDetail,null);
});
