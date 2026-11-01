import test from 'node:test';
import assert from 'node:assert/strict';
import { FrontierPlanner, UNRANKED_MEMORY_SCORE, type BrowserCommand } from '../src/frontier-planner.js';
import { blockedReason } from '../src/exploration-policy.js';
import { jumpableUrl, mapSnapshot, MEMORY_VERSION, type MapTransition, type MemorySnapshot, type RememberedControl } from '../src/app-memory.js';
import { transitionKey } from '../src/app-map.js';
import { commandFor } from '../src/interaction-contract.js';
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
test('an unverified route is not replayed, but its observed safe URL can be reopened',()=>{
  const planner = new FrontierPlanner('http://app/');
  planner.observe('root',capture('http://app/',[]),undefined,{},1,true);
  planner.observe('unreachable',capture('http://app/panel',[button('details')]),'root',{},.8);
  planner.plan('unreachable',[proposal('details',.9)]);
  planner.transition({from_state_id:'root',to_state_id:'unreachable',command:command('panel'),source_action_id:'suspect',expected_result:'Panel appears'},'suspect');
  const next = planner.rank('root',10)[0];
  assert.equal(next.route[0].reopen,true);
  assert.deepEqual(next.route[0].command,{type:'navigate',url:'http://app/panel'});
});

test('successful returns stay usable beyond two trips even when the page has a suspect finding',()=>{
  const planner = new FrontierPlanner('http://app/');
  start(planner,[button('open')]);
  planner.observe('leaf',capture('http://app/leaf',[button('more')]),'root');
  planner.plan('leaf',[proposal('more',.9)]);
  const step={from_state_id:'root',to_state_id:'leaf',command:command('open'),source_action_id:'open',expected_result:'Leaf opens'};
  planner.transition(step,'suspect',undefined,true);
  for(let i=0;i<6;i++){
    assert.equal(planner.rank('root',2)[0].route[0].command.type,'click');
    planner.transition(step,'suspect',step,true);
  }
  assert.equal(planner.rank('root',2)[0].route[0].source_action_id,'open');
});

test('a changed return learns its actual destination without assuming the old screen was restored',()=>{
  const planner=new FrontierPlanner('http://app/');
  start(planner,[]);
  for(const id of ['expected','actual']){
    planner.observe(id,capture(`http://app/${id}`,[button(id)]),'root');
    planner.plan(id,[proposal(id,.9)]);
  }
  const step={from_state_id:'root',to_state_id:'expected',command:command('open'),source_action_id:'open',expected_result:'Expected opens'};
  planner.transition(step,'no_issue_observed');
  planner.transition({...step,to_state_id:'actual'},'inconclusive',step,true);
  const paths=planner.rank('root',3);
  assert.equal(paths.find(p=>p.state_id==='actual')!.route[0].to_state_id,'actual');
  assert.equal(paths.find(p=>p.state_id==='expected')!.route[0].reopen,true);
});

test('route selection prefers reliable travel while keeping shorter alternatives within the action budget',()=>{
  const planner=new FrontierPlanner('http://app/');
  start(planner,[]);
  planner.observe('via',capture('http://app/',[]),'root');
  planner.observe('target',capture('http://app/',[button('more')]),'via');
  planner.plan('target',[proposal('more',.9)]);
  const direct={from_state_id:'root',to_state_id:'target',command:command('shortcut'),source_action_id:'shortcut',expected_result:'Target opens'};
  planner.transition(direct,'no_issue_observed');
  planner.transition({...direct,to_state_id:'root'},'inconclusive',direct,false);
  // Fresh evidence reestablishes the route, retaining its past failure cost.
  planner.transition(direct,'no_issue_observed');
  planner.transition({...direct,to_state_id:'via',command:command('via')},'no_issue_observed');
  planner.transition({...direct,from_state_id:'via',command:command('next')},'no_issue_observed');
  assert.deepEqual(planner.rank('root',3)[0].route.map(s=>s.command.type==='click'?s.command.control.name:''),['via','next']);
  assert.equal(planner.rank('root',2)[0].route[0].source_action_id,'shortcut');
});

test('failure to restore one transient state does not disable a reliable return to another state at the same URL',()=>{
  const planner=new FrontierPlanner('http://app/');
  start(planner,[button('other')]);
  planner.plan('root',[proposal('other',.8)]);
  planner.observe('transient',capture('http://app/',[button('next')]),'root');
  planner.plan('transient',[proposal('next',.9)]);
  planner.observe('leaf',capture('http://app/leaf',[]),'transient');
  const shortcut=planner.rank('leaf',3).find(p=>p.state_id==='transient')!.route[0];
  assert.equal(shortcut.reopen,true);
  planner.transition({...shortcut,to_state_id:'root'},'no_issue_observed',shortcut,true);
  const remaining=planner.rank('leaf',3);
  assert.ok(remaining.some(p=>p.state_id==='root'));
  assert.ok(!remaining.some(p=>p.state_id==='transient'));
});

test('navigation failure cannot establish a return route and form writes are not replayed as travel',()=>{
  const planner=new FrontierPlanner('http://app/');
  start(planner,[]);
  planner.observe('panel',capture('http://app/',[button('more')]),'root');
  planner.plan('panel',[proposal('more',.9)]);
  const step={from_state_id:'root',to_state_id:'panel',command:command('open'),source_action_id:'open',expected_result:'Panel opens'};
  planner.transition(step,'no_issue_observed',undefined,false);
  assert.equal(planner.rank('root',3).length,0);
  planner.transition({...step,command:{type:'fill',value:'draft',control:{...button('field'),role:'textbox',input_type:'text'}}},'no_issue_observed',undefined,true);
  assert.equal(planner.rank('root',3).length,0);
});

test('an unavailable control stays blocked across states on its page while sibling controls remain available',()=>{
  const planner=new FrontierPlanner('http://app/');
  start(planner,[button('gone'),button('other')]);
  planner.blockControl('root','gone');
  planner.observe('updated',capture('http://app/',[button('gone'),button('other')]),'root');
  assert.deepEqual(planner.available('updated').map(c=>c.name),['other']);
  assert.equal(planner.coverage().reduce((n,l)=>n+l.blocked,0),2);
});

test('deferring a changing page preserves exits through observed safe links and excludes unsafe destinations',()=>{
  const planner=new FrontierPlanner('http://app/');
  start(planner,[{...button('next'),role:'link',href:'http://app/leaf'},
    {...button('outside'),role:'link',href:'https://other.test/'},
    {...button('token'),role:'link',href:'http://app/next?token=private'}]);
  planner.deferPage('root','persistent_page_drift');
  assert.equal(planner.available('root').length,0);
  const paths=planner.rank('root',1,'breadth');
  assert.deepEqual(paths.map(p=>p.route[0].command),[{type:'navigate',url:'http://app/leaf'}]);
  assert.equal(paths[0].route[0].recovery,true);
  planner.attempted('root',paths[0].route[0].command,true);
  assert.equal(planner.rank('root',2,'breadth').length,0,'Recovery navigation is attempted only once.');
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

type Remembered = Partial<RememberedControl> & { url: string; control_id: string };
function memory(pages: { url: string; path?: number; truncated?: boolean }[], controls: Remembered[], priorRuns = 1): MemorySnapshot {
  const remembered = controls.map(c => ({ role: 'button', name: c.control_id, href: null, attempts: 0, best_likelihood: null,
    last_verdict: null, last_observed_result: null, blocked_reason: null, ...c }) as RememberedControl);
  const byPage = new Map<string, RememberedControl[]>();
  for (const c of remembered) byPage.set(c.url, [...(byPage.get(c.url) ?? []), c]);
  return { version: MEMORY_VERSION, scope_id: 'scope', scope: { origin: 'http://app', viewport_profile: 'desktop', viewport: { width: 1920, height: 1080 }, auth_scope: 'public', execution_mode: 'protocol_fixture' },
    prior_runs: priorRuns, truncated: false, controls: new Map(remembered.map(c => [c.control_id, c])), by_page: byPage,
    pages: new Map(pages.map(p => [p.url, { url: p.url, title: p.url, visits: 1, best_path_score: p.path ?? null, controls_truncated: p.truncated ?? false, last_run_id: 'earlier-run', last_action_id: 'earlier-action' }])) };
}
const start = (planner: FrontierPlanner, controls: ObservedControl[]) => {
  planner.observe('root', capture('http://app/', controls), undefined, {}, 1, true);
  planner.transition({from_state_id:'blank',to_state_id:'root',command:{type:'navigate',url:'http://app/'},source_action_id:'open',expected_result:'Root appears'},'no_issue_observed');
  planner.attempted('blank', {type:'navigate',url:'http://app/'}, false);
};

test('controls already tried in earlier runs yield to untried and newly appeared controls',()=>{
  const planner = new FrontierPlanner('http://app/', memory([{url:'http://app/'}], [
    {url:'http://app/',control_id:'tried',attempts:2,last_verdict:'no_issue_observed'},
    {url:'http://app/',control_id:'untried'},
  ]));
  start(planner, [button('tried'), button('untried'), button('fresh')]);
  planner.plan('root', [proposal('tried', .9), proposal('untried', .7), proposal('fresh', .6)]);
  const ranked = planner.rank('root', 5);
  assert.deepEqual(ranked.map(p => p.control_id), ['fresh', 'untried', 'tried']);
  const tried = ranked.find(p => p.control_id === 'tried')!, fresh = ranked[0];
  assert.equal(tried.components.earlier_run_coverage, .2);
  assert.equal(tried.components.novelty, 0);
  assert.match(tried.reason, /already tried in earlier runs \(last: no issue observed\)/);
  assert.equal(fresh.components.new_since_earlier_runs, .1);
  assert.match(fresh.reason, /not seen on this page in earlier runs/);
});

test('a truncated earlier observation cannot make a control look new',()=>{
  const planner = new FrontierPlanner('http://app/', memory([{url:'http://app/',truncated:true}], []));
  start(planner, [button('maybe-new')]);
  planner.plan('root', [proposal('maybe-new', .5)]);
  assert.equal(planner.rank('root', 3)[0].components.new_since_earlier_runs, 0);
});

test('a continuation opens an unfinished page before repeating the entry page',()=>{
  const snapshot = memory([{url:'http://app/'},{url:'http://app/products',path:.7}], [
    {url:'http://app/',control_id:'products',attempts:1,last_verdict:'no_issue_observed'},
    {url:'http://app/products',control_id:'faq',best_likelihood:.4},
  ]);
  snapshot.prefer_unfinished = true;
  const planner = new FrontierPlanner('http://app/', snapshot);
  start(planner, [button('products')]);
  planner.plan('root', [proposal('products', .99)]);
  const ranked = planner.rank('root', 3);
  assert.equal(ranked[0].control_id, 'faq');
  assert.match(ranked[0].reason, /continuing an exploration that stopped on this page/);
  const ordinary = new FrontierPlanner('http://app/', memory([{url:'http://app/'},{url:'http://app/products',path:.7}], [
    {url:'http://app/',control_id:'products',attempts:1,last_verdict:'no_issue_observed'},
    {url:'http://app/products',control_id:'faq',best_likelihood:.4},
  ]));
  start(ordinary, [button('products')]);
  ordinary.plan('root', [proposal('products', .99)]);
  assert.equal(ordinary.rank('root', 3)[0].control_id, 'products');
});

test('an unfinished remembered page competes as a resume step and is observed again',()=>{
  const planner = new FrontierPlanner('http://app/', memory([{url:'http://app/'},{url:'http://app/products',path:.7}], [
    {url:'http://app/',control_id:'products',attempts:1,last_verdict:'no_issue_observed'},
    {url:'http://app/products',control_id:'compare',attempts:1,last_verdict:'no_issue_observed',best_likelihood:.9},
    {url:'http://app/products',control_id:'faq',best_likelihood:.6},
  ]));
  start(planner, [button('products')]);
  planner.plan('root', [proposal('products', .7)]);
  const ranked = planner.rank('root', 3);
  assert.deepEqual(ranked.map(p => p.control_id), ['faq', 'products']);
  const resume = ranked[0];
  assert.equal(resume.travel_steps, 1);
  assert.deepEqual(resume.route[0].command, {type:'navigate',url:'http://app/products'});
  assert.deepEqual(resume.route[0].memory, {url:'http://app/products',title:'http://app/products',open_controls:1,source_run_id:'earlier-run'});
  assert.equal(resume.likelihood, .6);
  assert.match(resume.reason, /1 untried controls remembered from 1 earlier run/);
  assert.deepEqual(planner.rank('root', 1).map(p => p.control_id), ['products'], 'A resume needs room for the navigation and one action.');
  planner.attempted('root', {type:'navigate',url:'http://app/products'}, false);
  assert.deepEqual(planner.rank('root', 3).map(p => p.control_id), ['products'], 'A page is reopened at most once per run.');
});

test('remembered pages are skipped once visited, when finished, unranked by default and stale under focus',()=>{
  const snapshot = memory([{url:'http://app/'},{url:'http://app/done'},{url:'http://app/blocked'},{url:'http://app/unranked'},{url:'http://app/visited'}], [
    {url:'http://app/done',control_id:'done',attempts:1},
    {url:'http://app/blocked',control_id:'pay',blocked_reason:'payment_or_transaction_requires_handoff'},
    {url:'http://app/unranked',control_id:'unranked'},
    {url:'http://app/visited',control_id:'visited'},
  ]);
  const planner = new FrontierPlanner('http://app/', snapshot);
  start(planner, []);
  planner.observe('visited', capture('http://app/visited', [button('visited')]), 'root', {}, 1);
  let ranked = planner.rank('root', 4);
  assert.deepEqual(ranked.map(p => p.route[0]?.command), [{type:'navigate',url:'http://app/unranked'}]);
  assert.equal(ranked[0].likelihood, UNRANKED_MEMORY_SCORE);
  assert.equal(ranked[0].focus_stale, false);
  planner.refocus();
  ranked = planner.rank('root', 4);
  assert.equal(ranked[0].focus_stale, true, 'Earlier-run hints never outrank fresh rankings for a new focus.');
  assert.deepEqual(new FrontierPlanner('http://app/', null).rank('root', 4), []);
});

test('remembered URLs with secrets, sign-out or risky actions are never reopened',()=>{
  const origin = 'https://app.example';
  for (const url of [origin + '/products', origin + '/search?q=notebook', origin + '/#/settings', origin + '/docs/guide.html'])
    assert.equal(jumpableUrl(url, origin), true, url);
  for (const url of ['https://v2.bubblemaps.io/eth', 'https://intel.bubblemaps.io/', 'https://www.bubblemaps.io/'])
    assert.equal(jumpableUrl(url, 'https://bubblemaps.io'), true, url);
  for (const url of [origin + '/reset?token=abc', origin + '/invite?code=1', origin + '/callback?state=x&session=y', origin + '/logout', origin + '/account/sign-out',
    origin + '/items/delete', origin + '/checkout', origin + '/billing/upgrade', 'https://other.example/products', 'http://app.example/products',
    'https://user:pass@app.example/', origin + '/%E0%A4%A', 'not a url', 'https://notbubblemaps.io/', 'https://b.github.io/'])
    assert.equal(jumpableUrl(url, origin), false, url);
  assert.equal(jumpableUrl('https://notbubblemaps.io/', 'https://bubblemaps.io'), false);
  assert.equal(jumpableUrl('https://evil.co.uk/', 'https://www.example.co.uk'), false);
  assert.equal(jumpableUrl('https://shop.example.co.uk/products', 'https://www.example.co.uk'), true);
});

const link = (id: string, href: string): ObservedControl => ({control_id:id,role:'link',name:id,href,disabled:false,ambiguous:false,submits_form:false});
const step = (from: string, to: string, cmd: BrowserCommand, id: string) => ({from_state_id:from,to_state_id:to,command:cmd,source_action_id:id,expected_result:`${to} appears`});

test('new territory shares actions between top-level areas; a journey prefers deeper screens nearby',()=>{
  const planner = new FrontierPlanner('http://app/');
  start(planner, [button('orders'), button('help')]);
  planner.plan('root', [proposal('orders', .9), proposal('help', .5)]);
  planner.attempted('root', command('orders'), false);
  planner.observe('orders', capture('http://app/orders', [button('next')]), 'root', {}, .9);
  planner.transition(step('root', 'orders', command('orders'), 'a1'), 'no_issue_observed');
  let current = 'orders';
  // Fourteen more actions deep inside the orders area.
  for (let i = 1; i <= 14; i++) {
    const id = `orders-${i}`;
    planner.plan(current, [proposal('next', .9)]);
    planner.attempted(current, command('next'), false);
    planner.observe(id, capture(`http://app/orders?page=${i}`, [button('next'), button('details')]), current, {}, .9);
    planner.transition(step(current, id, command('next'), `n${i}`), 'no_issue_observed');
    current = id;
  }
  planner.plan(current, [proposal('next', .9), proposal('details', .8)]);
  const plain = planner.rank(current, 20);
  assert.equal(plain[0].state_id, current, 'Without a strategy the local control wins.');
  const breadth = planner.rank(current, 20, 'breadth');
  assert.equal(breadth[0].control_id, 'help', 'An area past its fair share yields to another top-level control.');
  assert.equal(breadth[0].route[0].reset, true);
  const local = breadth.find(p => p.state_id === current)!;
  assert.equal(local.strategy!.branch_state_id, 'orders');
  assert.equal(local.strategy!.branch_actions, 14);
  assert.equal(local.strategy!.fair_share, 6, 'Short runs keep the slack: six actions per area.');
  assert.ok(local.strategy!.factor < .5);
  assert.match(local.reason, /its area already took 14 actions \(fair share 6\)/);
  const depth = planner.rank(current, 20, 'depth');
  assert.equal(depth[0].state_id, current, 'A journey keeps going where it is.');
  assert.equal(depth[0].strategy!.depth, 15);
  assert.ok(depth.find(p => p.control_id === 'help')!.priority < depth[0].priority);
});

test('new territory returns to a screen whose remaining controls were never ranked',()=>{
  const planner = new FrontierPlanner('http://app/');
  start(planner, [button('a'), button('b'), button('c')]);
  planner.plan('root', [proposal('a', .9)]);
  planner.attempted('root', command('a'), false);
  planner.observe('leaf', capture('http://app/a', []), 'root', {}, .9);
  planner.transition(step('root', 'leaf', command('a'), 'a'), 'no_issue_observed');
  assert.deepEqual(planner.rank('leaf', 5), [], 'Unranked controls are never chosen without a strategy.');
  assert.deepEqual(planner.rank('leaf', 5, 'depth'), []);
  const [revisit] = planner.rank('leaf', 5, 'breadth');
  assert.equal(revisit.unranked, 2);
  assert.equal(revisit.state_id, 'root');
  assert.equal(revisit.route.length, 1);
  assert.match(revisit.reason, /2 controls here have not been ranked yet/);
  assert.deepEqual(planner.rank('root', 5, 'breadth'), [], 'Where the run is, the next plan ranks them.');
});

test('a re-walk repeats a transition earlier runs recorded on an equivalent screen, once per run',()=>{
  const products = link('products', 'http://app/products'), country: ObservedControl = {...button('country'),role:'combobox',options:[{value:'fr',label:'France',disabled:false},{value:'de',label:'Germany',disabled:false}]};
  const root = 'a'.repeat(32), list = 'b'.repeat(32), elsewhere = 'c'.repeat(32);
  const click = commandFor(products, {type:'click'}), choose = commandFor(country, {type:'select',value:'de'});
  const row = (cmd: BrowserCommand, to: string, verdict: MapTransition['last_verdict'], choice?: string) => ({ from_key: root, control_key: transitionKey(cmd).key, to_key: to,
    entry_key: transitionKey(cmd).entry, action: cmd.type, control: { role: 'x', name: 'x', ...(choice ? { choice } : {}) }, attempts: 2, last_verdict: verdict, last_observed_result: 'Products list' });
  const snapshot = { ...memory([], []), map: mapSnapshot([{state_key:root,page_template:'http://app/',min_depth:0,runs:2},{state_key:list,page_template:'http://app/products',min_depth:1,runs:2}],
    [row(click, list, 'no_issue_observed'), row(click, elsewhere, 'suspect'), row(choose, root, 'no_issue_observed', 'de'), row({...choose,value:'fr'} as BrowserCommand, root, 'no_issue_observed')]) };
  const planner = new FrontierPlanner('http://app/', snapshot);
  planner.observe('root', capture('http://app/', [products, country]), undefined, {}, 1, true, root);
  planner.transition({from_state_id:'blank',to_state_id:'root',command:{type:'navigate',url:'http://app/'},source_action_id:'open',expected_result:'Root appears'},'no_issue_observed');
  const ranked = planner.rank('root', 5, 'rewalk');
  assert.deepEqual(ranked.map(p => [p.name, p.action]), [['products', {type:'click'}], ['country', {type:'select',value:'de'}]], 'A select without a recorded choice cannot be repeated.');
  assert.deepEqual(ranked[0].rewalk!.known_to_keys, [list, elsewhere]);
  assert.equal(ranked[0].expected_result, 'Products list');
  assert.ok(ranked[0].priority > ranked[1].priority, 'A transition with a suspect outcome or several destinations is rechecked first.');
  assert.match(ranked[0].reason, /led to 2 different screens/);
  assert.equal(planner.mapKnown(list), true);
  assert.equal(planner.mapKnown('d'.repeat(32)), false);
  assert.deepEqual(planner.earlier(root, click), { known_to_keys: [list, elsewhere], attempts: 4, last_verdict: 'no_issue_observed', last_observed_result: 'Products list' });
  assert.equal(planner.earlier(root, {...click, type:'submit'} as BrowserCommand), null);
  planner.attempted('root', click, false);
  assert.deepEqual(planner.rank('root', 5, 'rewalk').map(p => p.name), ['country']);
  assert.deepEqual(new FrontierPlanner('http://app/').rank('root', 5, 'rewalk'), [], 'Nothing is re-walked without a map.');
});

test('another item of a list already tried is deprioritized, and coverage is reported by depth',()=>{
  const key = 'e'.repeat(32), shoes = link('shoes', 'http://app/products/1'), hats = link('hats', 'http://app/products/2');
  const planner = new FrontierPlanner('http://app/');
  planner.observe('root', capture('http://app/', [shoes, hats, button('Delete all')]), undefined, {}, 1, true, key);
  planner.transition({from_state_id:'blank',to_state_id:'root',command:{type:'navigate',url:'http://app/'},source_action_id:'open',expected_result:'Root appears'},'no_issue_observed');
  planner.plan('root', [proposal('shoes', .8), proposal('hats', .8)]);
  assert.equal(planner.rank('root', 3)[0].components.repeated_entry, 0);
  planner.attempted('root', commandFor(shoes), false);
  planner.observe('shoes', capture('http://app/products/1', [button('add'), button('back')]), 'root', {}, .8, false, 'f'.repeat(32));
  planner.transition(step('root', 'shoes', commandFor(shoes), 's'), 'no_issue_observed');
  const hat = planner.rank('shoes', 5).find(p => p.control_id === 'hats')!;
  assert.equal(hat.components.repeated_entry, .2);
  assert.match(hat.reason, /equivalent control was already tried/);
  assert.deepEqual(planner.coverage(), [
    { depth: 0, states: 1, controls: 2, tried: 1, blocked: 1, coverage: .5 },
    { depth: 1, states: 1, controls: 2, tried: 0, blocked: 0, coverage: 0 },
  ]);
});

test('another view of a screen keeps its depth, its area and counts once in coverage',()=>{
  const home = 'a'.repeat(32), docs = 'b'.repeat(32), menu = 'c'.repeat(32), page = 'd'.repeat(32);
  const planner = new FrontierPlanner('http://app/');
  planner.observe('root', capture('http://app/', [button('menu'), button('docs')]), undefined, {}, 1, true, home);
  planner.observe('scrolled', capture('http://app/', [button('menu'), button('docs')]), 'root', {}, .5, false, home);
  planner.attempted('scrolled', command('docs'), false);
  planner.observe('docs', capture('http://app/docs', [button('next')]), 'scrolled', {}, .8, false, docs);
  planner.observe('docs-scrolled', capture('http://app/docs', [button('next')]), 'docs', {}, 1, false, docs);
  planner.observe('page', capture('http://app/docs/2', [button('back')]), 'docs-scrolled', {}, .8, false, page);
  // Closing a menu deep in the tree shows the entry screen again.
  planner.observe('back', capture('http://app/', [button('menu'), button('docs')]), 'page', {}, .8, false, home);
  planner.observe('menu-open', capture('http://app/', [button('menu'), button('docs'), button('item')]), 'back', {}, .7, false, menu);
  const meta = (id: string) => [planner.metadata(id).depth, planner.metadata(id).screen_state_id];
  assert.deepEqual(['root', 'scrolled', 'docs', 'docs-scrolled', 'page', 'back', 'menu-open'].map(meta),
    [[0, null], [0, 'root'], [1, null], [1, 'docs'], [2, null], [0, 'root'], [1, null]], 'Depth counts screens, not views.');
  assert.equal(planner.screenSeen(home), true);
  assert.equal(planner.screenSeen('e'.repeat(32)), false);
  planner.plan('page', [proposal('back', .8)]);
  assert.equal(planner.rank('page', 5, 'breadth')[0].strategy!.branch_state_id, 'docs', 'A view belongs to its screen\'s area.');
  planner.plan('menu-open', [proposal('item', .8)]);
  assert.equal(planner.rank('menu-open', 5, 'breadth').find(p => p.control_id === 'item')!.strategy!.branch_state_id, 'menu-open');
  assert.deepEqual(planner.coverage().map(l => [l.depth, l.states, l.controls, l.tried]), [[0, 1, 2, 1], [1, 2, 4, 0], [2, 1, 1, 0]],
    'The entry screen and its views are one screen, and docs was tried in one of them.');
});
