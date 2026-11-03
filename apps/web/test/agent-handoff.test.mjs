import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {appSource} from './support.mjs';
function setup(deny=false){
  const copied=[];let selected=false,focused=null;
  const node=()=>({children:[],handlers:{},append(...items){for(const n of items)n.parent=this;this.children.push(...items)},setAttribute(){},addEventListener(k,v){this.handlers[k]=v},showModal(){this.open=true},close(){this.open=false},remove(){this.parent.children=this.parent.children.filter(c=>c!==this)},focus(){focused=this},select(){selected=true},setSelectionRange(a,b){this.selection=[a,b]}});
  const body=node(),find=(root,id)=>root.id===id?root:root.children.map(c=>find(c,id)).find(Boolean);
  const context={document:{body,createElement:node,getElementById:id=>find(body,id),activeElement:node()},navigator:{clipboard:{writeText:async text=>{if(deny)throw Error('Denied');copied.push(text);}}}};
  vm.createContext(context);vm.runInContext(appSource('agent-handoff.js')+'\nglobalThis.api={showAgentHandoff,closeAgentHandoff};',context);
  return {api:context.api,find:id=>find(body,id),copied,get selected(){return selected},get focused(){return focused}};
}
test('preview and clipboard use the exact API text and opening starts at the beginning',async()=>{
  const u=setup(),text='# Finding\n<img src=x onerror=bad()>\nRecord only';const d=u.api.showAgentHandoff({agent_description:{format:'text/markdown',text}},{title:'<script>bad()</script>',revision:7});
  assert.equal(u.find('agent-handoff-preview').value,text);assert.deepEqual([...u.find('agent-handoff-preview').selection],[0,0]);assert.equal(u.find('agent-handoff-preview').scrollTop,0);
  assert.equal(d.children[0].textContent,'<script>bad()</script>');assert.equal(u.copied.length,0);
  await d.children.find(n=>n.className==='row').children[0].handlers.click();assert.deepEqual(u.copied,[text]);
  u.api.closeAgentHandoff();assert.equal(u.find('agent-handoff-dialog'),undefined);
});
test('clipboard denial selects the full preview for manual copying',async()=>{
  const u=setup(true),d=u.api.showAgentHandoff({agent_description:{format:'text/markdown',text:'Recorded context'}});
  await d.children.find(n=>n.className==='row').children[0].handlers.click();assert.equal(u.selected,true);assert.equal(u.focused,u.find('agent-handoff-preview'));assert.match(d.children.at(-1).textContent,/copy it manually/);
});
test('missing server description is not replaced with an invented client summary',()=>{
  const u=setup();assert.throws(()=>u.api.showAgentHandoff({title:'Only a title'}),/API description is unavailable/);assert.equal(u.find('agent-handoff-dialog'),undefined);
});
