import {appSource} from './support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

function notificationsUI(){
  const storage=new Map(),shown=[];
  const sandbox={URL,localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},setTimeout(){}};
  vm.createContext(sandbox);
  vm.runInContext(appSource('notifications.js')+'\nglobalThis.ui={observeWorkspace,notificationChanges,notificationsEnabled,setNotificationsEnabled,resetNotifications};',sandbox);
  return {...sandbox.ui,storage,shown};
}
const job=(id,status,extra={})=>({job_id:id,status,run_id:'run-'+id,request:{kind:'explore',target_url:'https://shop.test/cart'},...extra});
const site=(pending)=>({origin:'https://shop.test',pending_findings:pending});

test('the first refresh only records where things stand',()=>{
  const ui=notificationsUI();
  assert.deepEqual(Array.from(ui.observeWorkspace({jobs:[job('a','completed')],websites:[site(9)],requests:[{status:'waiting',access_id:'x',origin:'https://shop.test'}]})),[]);
});
test('a finished test reports its new findings once, and links to them',()=>{
  const ui=notificationsUI();ui.observeWorkspace({jobs:[job('a','running')],websites:[site(1)]});
  const events=ui.observeWorkspace({jobs:[job('a','completed')],websites:[site(3)]});
  assert.equal(events.length,1,'The findings belong to the finished test, not a second notification.');
  assert.equal(events[0].title,'2 new findings');assert.equal(events[0].href,'/workspace/run-a/findings');assert.equal(events[0].tone,'attention');
  const quiet=ui.observeWorkspace({jobs:[job('b','running')],websites:[site(3)]});ui.observeWorkspace({jobs:[job('b','running')],websites:[site(3)]});
  const finished=ui.observeWorkspace({jobs:[job('b','completed')],websites:[site(3)]});
  assert.equal(quiet.length,0);assert.equal(finished[0].title,'Test finished');assert.match(finished[0].detail,/nothing new to review/);
});
test('failures stay until dismissed; cancellations, queued work and automatic rechecks are not news',()=>{
  const ui=notificationsUI();
  ui.observeWorkspace({jobs:[job('f','running'),job('c','running'),job('child','running',{parent_job_id:'f'})]});
  const events=ui.observeWorkspace({jobs:[job('f','failed',{error:'Model call failed'}),job('c','cancelled'),job('child','completed',{parent_job_id:'f'}),job('new','queued')]});
  assert.equal(events.length,1);assert.equal(events[0].title,'Test failed');assert.equal(events[0].sticky,true);assert.match(events[0].detail,/shop\.test · Model call failed/);
});
test('findings that arrive mid-test and new sign-in requests are notified once',()=>{
  const ui=notificationsUI(),request={status:'waiting',access_id:'login',origin:'https://shop.test'};
  ui.observeWorkspace({jobs:[job('a','running')],websites:[site(0)],requests:[]});
  const events=ui.observeWorkspace({jobs:[job('a','running')],websites:[site(1)],requests:[request]});
  assert.deepEqual(Array.from(events,e=>e.title),['1 new finding','Sign-in requested']);assert.equal(events[1].action,'open-activity');assert.equal(events[1].sticky,true);
  assert.equal(ui.observeWorkspace({jobs:[job('a','running')],websites:[site(1)],requests:[request]}).length,0);
  assert.equal(ui.observeWorkspace({jobs:[job('a','running')],websites:[site(0)],requests:[]}).length,0,'Reviewing findings lowers the count without a notification.');
});
test('a fix check links to its issue and notifications can be turned off',()=>{
  const ui=notificationsUI(),fix=status=>job('v',status,{request:{kind:'verify_fix',candidate_url:'https://staging.shop.test/',issue_id:'issue-1'}});
  ui.observeWorkspace({jobs:[fix('running')]});
  const [event]=ui.observeWorkspace({jobs:[fix('completed')]});
  assert.equal(event.title,'Fix check finished');assert.equal(event.href,'/issues/issue-1');assert.equal(event.detail,'staging.shop.test');
  assert.equal(ui.notificationsEnabled(),true);ui.setNotificationsEnabled(false);assert.equal(ui.notificationsEnabled(),false);assert.equal(ui.storage.get('scout.notifications'),'off');
});
