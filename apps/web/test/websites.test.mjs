import {appSource} from './support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

function websiteUI(){
  const storage=new Map(),sandbox={URL,Date,sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}};
  vm.createContext(sandbox);vm.runInContext(appSource('websites.js')+'\nglobalThis.ui={websiteOrigin,websiteHref,normalizeTargetUrl,dockerAddress,websiteLaunchHint,updateWebsiteLaunchHint,groupWebsites,websiteSidebar,websiteFavicon,bindWebsiteFavicons,rememberWebsiteShortcut,websiteShortcuts,clearWebsiteNavigation};',sandbox);
  return {...sandbox.ui,storage};
}
const runId='11111111-1111-4111-8111-111111111111';
test('website groups merge entry paths and default ports while preserving staging and local environments',()=>{
  const ui=websiteUI(),runs=['https://Example.com/fr/','https://example.com:443/pricing','https://staging.example.com/','http://localhost:3000/','http://localhost:4000/'].map(target_url=>({target_url}));
  const sites=ui.groupWebsites([],runs);
  assert.equal(sites.length,4);assert.equal(sites[0].origin,'https://example.com');assert.equal(sites[0].run_count,2);
  assert.equal(ui.websiteOrigin('javascript:alert(1)'), '');assert.equal(ui.websiteOrigin('https://user:secret@example.com/'),'');
});
test('the full catalog keeps older websites selectable independently of the latest run page',()=>{
  const ui=websiteUI(),catalog=[{origin:'https://old.example',run_count:80,target_url:'https://old.example/signup'}];
  const sites=ui.groupWebsites(catalog,[{target_url:'https://new.example/'},{target_url:'https://new.example/checkout'}]);
  assert.equal(sites[0].run_count,80);assert.equal(sites[1].run_count,2);
  const html=ui.websiteSidebar({websites:sites,origin:'https://old.example',page:'tests'});
  assert.match(html,/old\.example/);assert.match(html,/80 tests/);assert.match(html,/origin=https%3A%2F%2Fold\.example/);
  assert.equal((html.match(/href="#\/website\/https%3A%2F%2Fold\.example"/g)||[]).length,2);
  assert.match(html,/<a class="brand" href="#\/workspace"/);assert.match(html,/<a class="all-projects" href="#\/workspace">/);
  assert.match(ui.websiteSidebar({websites:sites,origin:'https://old.example',external:true}),/<a class="all-projects" href="\/#\/workspace">/);
});
test('recent shortcuts use their destination and stay scoped to the selected website',()=>{
  const ui=websiteUI(),run={run_id:runId,target_url:'https://a.example/checkout',created_at:'2026-11-01T10:00:00Z'};
  ui.rememberWebsiteShortcut('https://a.example','flow',run);ui.rememberWebsiteShortcut('https://a.example','findings',run);ui.rememberWebsiteShortcut('https://a.example','issues');
  ui.rememberWebsiteShortcut('https://b.example','overview');
  const html=ui.websiteSidebar({origin:'https://a.example'});
  assert.match(html,/Flow map/);assert.match(html,/Findings/);assert.match(html,new RegExp(runId+'/flow'));assert.match(html,new RegExp(runId+'/findings'));
  assert.deepEqual(Array.from(ui.websiteShortcuts('https://b.example'),s=>s.kind),['overview']);
  ui.rememberWebsiteShortcut('https://a.example','flow',run);
  assert.equal(ui.websiteShortcuts('https://a.example').length,3);assert.equal(ui.websiteShortcuts('https://a.example')[0].kind,'flow');
  ui.clearWebsiteNavigation();assert.equal(ui.storage.size,0);
});
test('favicons load from the website without a referrer and fall back through same-origin icon paths',()=>{
  const ui=websiteUI(),handlers={};ui.bindWebsiteFavicons({addEventListener:(kind,fn)=>handlers[kind]=fn});
  assert.match(ui.websiteFavicon('https://example.com/path?q=secret'),/src="https:\/\/example.com\/favicon.ico"/);
  assert.match(ui.websiteFavicon('https://example.com'),/referrerpolicy="no-referrer"/);
  const image={dataset:{websiteIcon:'https://example.com',iconPath:'/favicon.ico'},remove(){this.removed=true;}};
  handlers.error({target:image});assert.equal(image.src,'https://example.com/favicon.png');
  handlers.load({target:image});assert.match(ui.websiteFavicon('https://example.com'),/favicon.png/);
  handlers.error({target:image});handlers.error({target:image});handlers.error({target:image});
  assert.equal(image.removed,true);assert.doesNotMatch(ui.websiteFavicon('https://example.com'),/<img/);
  assert.doesNotMatch(ui.websiteFavicon('javascript:alert(1)'),/<img/);
});
test('website names, URL drafts and stored shortcut paths cannot inject markup into the shared sidebar',()=>{
  const ui=websiteUI(),attack='"><img src=x onerror=bad()><script>bad()</script>';
  ui.rememberWebsiteShortcut('https://example.com','run',{run_id:runId,target_url:'https://example.com/'+attack});
  const html=ui.websiteSidebar({origin:'https://example.com',newUrl:attack,error:attack});
  assert.doesNotMatch(html,/<img src=x|<script>/);assert.match(html,/&lt;script&gt;/);
  assert.match(html,/id="website-launch-form"/);assert.match(html,/Start test for new URL/);
});


test('the shared switcher preserves main’s local and Docker URL handling without rewriting explicit URLs',()=>{
  const ui=websiteUI();
  for(const [value,expected] of [['larchwood:8084/shop','http://larchwood:8084/shop'],['host.docker.internal:4100','http://host.docker.internal:4100'],['localhost:3000','http://localhost:3000'],['acme.dev:8443/x','https://acme.dev:8443/x'],['https://localhost:4100/shop','https://localhost:4100/shop'],['host.docker.internal.acme.dev','https://host.docker.internal.acme.dev']])assert.equal(ui.normalizeTargetUrl(value),expected);
  assert.equal(ui.dockerAddress('[::1]:8080'),'http://host.docker.internal:8080');
  assert.match(ui.websiteSidebar({newUrl:'localhost:4100/shop'}),/open http:\/\/host.docker.internal:4100/);
  assert.doesNotMatch(ui.websiteLaunchHint('host.docker.internal:4100'),/where localhost/);
  const input={invalid:true,removeAttribute(){this.invalid=false;}},hint={textContent:'Old validation error',className:'small error',role:'alert',removeAttribute(){this.role=null;}},container={querySelector:selector=>selector==='#website-url'?input:hint};
  ui.updateWebsiteLaunchHint(container,'localhost:3000');assert.match(hint.textContent,/host.docker.internal:3000/);assert.equal(input.invalid,false);assert.equal(hint.role,null);
  ui.updateWebsiteLaunchHint(container,'acme.dev');assert.equal(hint.textContent,'Same website? Its tests stay together.');assert.equal(hint.className,'small muted');
});

test('the switcher on standalone customer pages shows Docker guidance and submits a local hostname using http',async()=>{
  const handlers={},saved=new Map(),writes=[],destinations=[],input={removeAttribute(){},focus(){}},hint={removeAttribute(){}},disclosure={open:false};let draws=0;
  const slot={dataset:{workspaceSidebar:''},set innerHTML(html){draws++;this.html=html;},querySelector:selector=>selector==='details'?disclosure:selector==='#website-launch-error'?hint:input,addEventListener:(type,fn)=>handlers[type]=fn};
  const sandbox={URL,URLSearchParams,Date,document:{querySelector:selector=>selector==='[data-workspace-sidebar]'?slot:null,addEventListener(){}},location:{search:'',assign:url=>destinations.push(url)},sessionStorage:{getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)},crypto:{randomUUID:()=>runId}};
  vm.createContext(sandbox);vm.runInContext(appSource('website-page.js')+'\nglobalThis.mount=mountWebsitePage;',sandbox);
  await sandbox.mount({page:'issues',request:async(path,body)=>{if(body){writes.push(body);return {job:{job_id:runId}};}return {runs:[],websites:[]};}});
  const drawn=draws;handlers.input({target:{id:'website-url',value:'localhost:4100'}});assert.match(hint.textContent,/host.docker.internal:4100/);assert.equal(draws,drawn,'Typing must preserve the input and its focus.');
  handlers.input({target:{id:'website-url',value:'larchwood:8084/shop'}});assert.doesNotMatch(hint.textContent,/where localhost/);
  await handlers.submit({target:{id:'website-launch-form'},preventDefault(){}});
  assert.equal(writes[0].target_url,'http://larchwood:8084/shop');assert.equal(writes[0].auth_mode,'auto');assert.deepEqual(destinations,['/#/website/http%3A%2F%2Flarchwood%3A8084'],'A new test opens its project, which follows the job.');
});

test('standalone pages draw their sidebar and account menu before the website list arrives',async()=>{
  let release;const slot={dataset:{workspaceSidebar:''},html:'',set innerHTML(html){this.html=html;},get innerHTML(){return this.html;},querySelector:()=>null,addEventListener(){}};
  const header={html:'',set innerHTML(html){this.html=html;},querySelector:()=>null,addEventListener(){}};
  const sandbox={URL,URLSearchParams,Date,document:{querySelector:selector=>selector==='[data-workspace-sidebar]'?slot:selector==='.connection-top .row'?header:null,addEventListener(){}},location:{search:''},localStorage:{getItem:()=>null,setItem(){}},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},crypto:{randomUUID:()=>runId}};
  vm.createContext(sandbox);vm.runInContext(appSource('website-page.js')+'\nglobalThis.mount=mountWebsitePage;',sandbox);
  const mounted=sandbox.mount({page:'connect',identity:{workspace_name:'Larchwood team'},mode:{development:false,spekios:false},request:path=>path==='/v1/runs'?new Promise(resolve=>release=()=>resolve({runs:[],websites:[{origin:'https://a.example',run_count:3}]})):Promise.resolve(path==='/v1/browser-jobs'?{workers:[{available:true}]}:{gateway_ready:true})});
  await new Promise(setImmediate);
  assert.match(slot.html,/workspace-sidebar/,'Connect your agent uses the workspace sidebar, drawn at once.');assert.doesNotMatch(slot.html,/website-switcher/);
  assert.match(header.html,/Account and workspace: Larchwood team/);assert.match(header.html,/data-action="logout"/);assert.doesNotMatch(header.html,/Browser worker/,'Status not loaded yet is left out.');
  release();await mounted;
  assert.match(slot.html,/a\.example/);assert.match(header.html,/Browser worker<\/span><span class="small muted">Online/);
});
