import {appSource} from './support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

function websiteUI(){
  const storage=new Map(),sandbox={URL,Date,sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}};
  vm.createContext(sandbox);vm.runInContext(appSource('websites.js')+'\nglobalThis.ui={websiteOrigin,websiteHref,groupWebsites,websiteSidebar,websiteFavicon,bindWebsiteFavicons,rememberWebsiteShortcut,websiteShortcuts,clearWebsiteNavigation};',sandbox);
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
  assert.equal((html.match(/href="#\/website\/https%3A%2F%2Fold\.example"/g)||[]).length,3);
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
