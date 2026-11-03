import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {computerCommand,validateComputerAction,validateComputerDispatch,dispatchComputer,ComputerRecoveryBudget} from '../src/computer-use.js';
import {observedCommand} from '../src/browser-interactions.js';
import type {Capture} from '../src/contracts.js';
const capture={sha256:'a'.repeat(64),observation:{url:'https://app.test/',viewport:{width:800,height:600}}} as Capture;
const envelope=(action:unknown)=>({computer_call:{type:'computer_call',call_id:'call1',pending_safety_checks:[],actions:[action]}});
test('native computer output is typed, bounded and tied to the exact screenshot',()=>{
  const command=computerCommand(envelope({type:'click',button:'left',x:50,y:40}),capture);
  assert.equal(command.type,'computer');assert.equal(command.control.role,'visual');
  assert.equal(observedCommand(command,capture,'https://app.test'),command);
  assert.throws(()=>observedCommand(command,{...capture,sha256:'b'.repeat(64)},'https://app.test'),/screenshot changed/);
  for(const action of [{type:'type',text:'password'},{type:'keypress',keys:['Enter']},{type:'click',button:'right',x:1,y:1},{type:'click',button:'left',x:800,y:0},{type:'move',x:NaN,y:1},{type:'scroll',x:1,y:1,scroll_x:0,scroll_y:99999},{type:'drag',path:[{x:1,y:1}]},{type:'click',button:'left',x:1,y:1,execute:'script'}])
    assert.throws(()=>computerCommand(envelope(action),capture),JSON.stringify(action));
  assert.throws(()=>computerCommand({computer_call:{...envelope({}).computer_call,pending_safety_checks:[{id:'unsafe'}]}},capture),/safety checks/);
  assert.throws(()=>computerCommand({computer_call:{...envelope({}).computer_call,actions:[{type:'move',x:1,y:1},{type:'move',x:2,y:2}]}},capture),/one action/);
  assert.deepEqual(validateComputerAction({type:'drag',path:[{x:1,y:1},{x:30,y:30}]},capture.observation.viewport).type,'drag');
});
test('recovery has hard run, page and unchanged-screen bounds',()=>{
  const budget=new ComputerRecoveryBudget();assert.equal(budget.take(capture),true);assert.equal(budget.take(capture),false);
  for(let i=1;i<=2;i++)assert.equal(budget.take({...capture,sha256:String(i)}),true);
  assert.equal(budget.take({...capture,sha256:'4'}),false);
  for(let i=0;i<3;i++)assert.equal(budget.take({...capture,sha256:'other'+i,observation:{...capture.observation,url:'https://app.test/other'}}),true);
  assert.equal(budget.take({...capture,sha256:'new',observation:{...capture.observation,url:'https://app.test/new'}}),false);
  const disabled=new ComputerRecoveryBudget();disabled.disabled=true;assert.equal(disabled.take(capture),false);
});
test('visual driver scrolls panels, hovers and drags while guarding forms and unsafe targets',{skip:process.env.SCOUT_COMPUTER_BROWSER_TEST!=='1'},async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:capture.observation.viewport});
    await page.setContent(`<style>body{margin:0}#panel{position:absolute;left:20px;top:20px;width:180px;height:100px;overflow:auto}#content{height:900px}#item{position:absolute;left:300px;top:20px;width:80px;height:60px;background:blue}button,form{position:absolute;top:300px}#danger{left:10px}form{left:180px}#safe{left:400px}</style><div id="panel"><div id="content">Scroll list</div></div><div id="item" draggable="true">Card</div><button id="danger">Delete all</button><form><button>Save</button></form><button id="safe">Preview</button><script>document.querySelector('#item').addEventListener('mousedown',()=>window.dragged=true);document.querySelector('#safe').addEventListener('mouseover',()=>window.hovered=true);</script>`);
    const command=(a:unknown)=>computerCommand(envelope(a),capture);
    await dispatchComputer(page,command({type:'scroll',x:70,y:50,scroll_x:0,scroll_y:400}));
    await page.waitForFunction(()=>document.querySelector('#panel')!.scrollTop>0);
    await dispatchComputer(page,command({type:'move',x:430,y:310}));assert.equal(await page.evaluate(()=>(window as any).hovered),true);
    await dispatchComputer(page,command({type:'drag',path:[{x:330,y:40},{x:500,y:80}]}));assert.equal(await page.evaluate(()=>(window as any).dragged),true);
    await assert.rejects(validateComputerDispatch(page,command({type:'click',button:'left',x:30,y:310})),/handoff/);
    await page.locator('form button').evaluate(e=>{(e as HTMLElement).style.position='static';});
    const formButton=await page.locator('form button').boundingBox();assert(formButton);
    await assert.rejects(validateComputerDispatch(page,command({type:'click',button:'left',x:formButton.x+3,y:formButton.y+3})),/handoff/);
    await assert.rejects(validateComputerDispatch(page,command({type:'drag',path:[{x:430,y:310},{x:500,y:400}]})),/draggable/);
    await dispatchComputer(page,command({type:'click',button:'left',x:430,y:310}));
  }finally{await browser.close();}
});
