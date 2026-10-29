import test from 'node:test';
import assert from 'node:assert/strict';
import { FrontierPlanner, type BrowserCommand } from '../src/frontier-planner.js';
import { blockedReason } from '../src/exploration-policy.js';
import type { Capture, ObservedControl } from '../src/contracts.js';
import { viewportProfile } from '../src/viewports.js';

const button = (id: string): ObservedControl => ({control_id:id,role:'button',name:id,href:null,disabled:false,ambiguous:false,submits_form:false});
const capture = (url: string, controls: ObservedControl[]) => ({observation:{url,controls}} as Capture);
const proposal = (id: string, likelihood: number) => ({control_id:id,likelihood,goal:`Use ${id}`,expected_result:`${id} becomes visible`});
const command = (id: string): BrowserCommand => ({type:'click',control:button(id)});

test('a newly revealed changed control can outrank a slightly likelier unchanged control',()=>{
  const planner = new FrontierPlanner('http://app/');
  planner.observe('root',capture('http://app/',[button('menu')]),undefined,{},1,true);
  planner.observe('menu',capture('http://app/',[button('item'),button('help')]),'root',{
    item:{newly_exposed:true,changed_pixels:1,sampled_pixels:100},
    help:{newly_exposed:false,changed_pixels:0,sampled_pixels:100},
  },.9);
  planner.plan('menu',[proposal('help',.8),proposal('item',.65)]);
  const ranked=planner.rank('menu',4);
  assert.equal(ranked[0].control_id,'item');
  assert.equal(ranked[0].components.changed_control,.1);
  assert.equal(ranked[0].path_likelihood_score,.9*.65);
  assert.deepEqual(ranked[0].path_state_ids,['root','menu']);
  assert.match(ranked[0].reason,/1 changed pixels/);
});
test('dead ends return through recorded routes, reserving budget for the unexplored branch',()=>{
  const planner = new FrontierPlanner('http://app/');
  planner.observe('root',capture('http://app/',[button('a'),button('b')]),undefined,{},1,true);
  planner.transition({from_state_id:'blank',to_state_id:'root',command:{type:'navigate',url:'http://app/'},source_action_id:'initial',expected_result:'Root appears'},'no_issue_observed');
  planner.plan('root',[proposal('a',.9),proposal('b',.6)]);
  planner.attempted('root',command('a'),false);
  planner.observe('leaf',capture('http://app/a',[]),'root',{},.9);
  planner.transition({from_state_id:'root',to_state_id:'leaf',command:command('a'),source_action_id:'a',expected_result:'A appears'},'no_issue_observed');
  assert.equal(planner.rank('leaf',1).length,0);
  const next=planner.rank('leaf',2)[0];
  assert.equal(next.control_id,'b');
  assert.equal(next.route[0].reset,true);
  assert.equal(next.route[0].source_action_id,'initial');
  planner.transition({...next.route[0],to_state_id:'unexpected'},'no_issue_observed',next.route[0]);
  assert.equal(planner.rank('leaf',2).length,0,'A failed restoration must not be silently retried.');
});
test('a route through a suspect transition is never reused to reach another frontier',()=>{
  const planner = new FrontierPlanner('http://app/');
  planner.observe('root',capture('http://app/',[]),undefined,{},1,true);
  planner.observe('unreachable',capture('http://app/panel',[button('details')]),'root',{},.8);
  planner.plan('unreachable',[proposal('details',.9)]);
  planner.transition({from_state_id:'root',to_state_id:'unreachable',command:command('panel'),source_action_id:'suspect',expected_result:'Panel appears'},'suspect');
  assert.equal(planner.rank('root',10).length,0);
});
test('covered and unsafe controls cannot gain eligibility from high likelihood',()=>{
  const planner = new FrontierPlanner('http://app/');
  const covered={...button('covered'),occluded:true};
  assert.equal(blockedReason(covered,'http://app'),'covered_or_unclickable_control');
  planner.observe('root',capture('http://app/',[covered,button('Buy')]),undefined,{},1,true);
  planner.plan('root',[proposal('covered',1),proposal('Buy',1)]);
  assert.deepEqual(planner.rank('root',12),[]);
  assert.throws(()=>viewportProfile('arbitrary'),/Viewport/);
});

test('replanning replaces old scores without forgetting already attempted controls',()=>{
  const planner = new FrontierPlanner('http://app/');
  planner.observe('root',capture('http://app/',[button('old'),button('new'),button('visited')]),undefined,{},1,true);
  planner.plan('root',[proposal('old',1),proposal('visited',.9)]);
  planner.attempted('root',command('visited'),false);
  planner.plan('root',[proposal('new',.6),proposal('visited',1)]);
  assert.deepEqual(planner.rank('root',3).map(p=>p.control_id),['new']);
  planner.plan('root',[]);
  assert.deepEqual(planner.rank('root',3),[]);
});

test('return routing follows a shorter observed path through cycles without rediscovering visited actions',()=>{
  const planner = new FrontierPlanner('http://app/');
  for(const [id,controls,parent] of [
    ['root',['next'],''],['branch',['leaf','unexplored'],'root'],['leaf',['back'],'branch'],
  ] as const) planner.observe(id,capture(`http://app/${id}`,controls.map(button)),parent||undefined,{},1,id==='root');
  const transition=(from:string,to:string,control:string)=>planner.transition({from_state_id:from,to_state_id:to,
    command:command(control),source_action_id:control,expected_result:`${to} appears`},'no_issue_observed');
  planner.transition({from_state_id:'blank',to_state_id:'root',command:{type:'navigate',url:'http://app/'},source_action_id:'initial',expected_result:'Root appears'},'no_issue_observed');
  transition('root','branch','next'); transition('branch','leaf','leaf'); transition('leaf','branch','back');
  planner.plan('branch',[proposal('leaf',1),proposal('unexplored',.8)]);
  planner.attempted('branch',command('leaf'),false);
  const ranked=planner.rank('leaf',2);
  assert.equal(ranked.length,1);
  assert.equal(ranked[0].control_id,'unexplored');
  assert.deepEqual(ranked[0].route.map(step=>step.source_action_id),['back']);
  assert.equal(planner.rank('leaf',1).length,0);
  assert.deepEqual(ranked[0].path_state_ids,['root','branch']);
});

test('a new focus prefers fresh rankings while keeping routes and covered controls',()=>{
  const planner=new FrontierPlanner('http://app/');
  planner.observe('root',capture('http://app/',[button('old'),button('visited')]),undefined,{},1,true);
  planner.plan('root',[proposal('old',1),proposal('visited',1)]);
  planner.attempted('root',command('visited'),false);
  planner.transition({from_state_id:'blank',to_state_id:'root',command:{type:'navigate',url:'http://app/'},source_action_id:'open',expected_result:'Root appears'},'no_issue_observed');
  planner.observe('leaf',capture('http://app/leaf',[button('new')]),'root');
  planner.refocus();
  planner.plan('leaf',[proposal('new',.01)]);
  assert.deepEqual(planner.rank('leaf',3).map(p=>[p.control_id,p.focus_stale]),[['new',false],['old',true]]);
  planner.plan('leaf',[]);
  assert.equal(planner.rank('leaf',2)[0].control_id,'old','Unexplored recorded branches remain reachable');
  assert.equal(planner.available('root').some(c=>c.control_id==='visited'),false);
});
