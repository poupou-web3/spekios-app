// Flow map: planning decisions, discovery tree, states and transitions.
import {button,empty,icon,pill} from '/assets/ui/components.js';
import {esc,short} from '/assets/ui/format.js';
import {state} from '../state.js';
import {actionName} from './action.js';
const MODES={breadth:'New territory',depth:'Deep journey',rewalk:'Re-walk'};
// Another view of a screen the run already reached (scrolled, a form partly
// filled, a menu closed again) belongs to that screen. Older runs have none.
const screenOf=(graph,node)=>{const id=node.planning?.screen_state_id;return id&&graph.states.some(s=>s.state_id===id)?id:null;};
// A screen's controls across its views: a control tried in any view is tried.
function screenControls(graph,ids){
  const controls=new Map();
  graph.frontier.forEach((f,i)=>{if(!ids.includes(f.state_id)||f.control?.role==='scroll')return;const key=f.control_id??`${f.state_id}:${i}`;if(f.status==='attempted'||!controls.has(key))controls.set(key,f.status);});
  const statuses=[...controls.values()],tried=statuses.filter(s=>s==='attempted').length,blocked=statuses.filter(s=>s==='blocked').length;
  return {controls:statuses.length-blocked,tried,blocked,untried:statuses.length-blocked-tried};
}
// Depth reached and coverage at each level of the discovery tree, and how the
// run shared its actions between strategies. Live runs compute it from the graph.
export function coverageView(graph){
  const states=graph.states.filter(s=>/^https?:/.test(s.url)&&s.planning);
  if(!states.length)return '';
  const levels=new Map();
  for(const node of states.filter(s=>!screenOf(graph,s))){
    const depth=node.planning.depth??0,level=levels.get(depth)??{depth,states:0,controls:0,tried:0,blocked:0};level.states++;
    const counts=screenControls(graph,[node.state_id,...states.filter(s=>screenOf(graph,s)===node.state_id).map(s=>s.state_id)]);
    level.controls+=counts.controls;level.tried+=counts.tried;level.blocked+=counts.blocked;
    levels.set(depth,level);
  }
  const rows=[...levels.values()].sort((a,b)=>a.depth-b.depth).map(l=>`<tr><td>${l.depth}</td><td>${l.states}</td><td>${l.tried} / ${l.controls}</td><td>${l.controls?Math.round(l.tried/l.controls*100):100}%</td><td>${l.blocked}</td></tr>`).join('');
  const counts={breadth:0,depth:0,rewalk:0};for(const s of graph.selections??[])if(s.strategy?.mode in counts)counts[s.strategy.mode]++;
  const shares=graph.selections?.findLast(s=>s.strategy)?.strategy?.shares;
  const split=Object.values(counts).some(Boolean)?`<p class="small muted">Planned actions, including travel: ${Object.entries(MODES).map(([mode,label])=>`${label} ${counts[mode]}${shares?` (share now ${Math.round(shares[mode]*100)}%)`:''}`).join(' · ')}.</p>`:'';
  return `<section class="panel settings-panel"><div class="panel-header"><h2>Depth and coverage</h2><span class="pill">${Math.max(...levels.keys())} deep</span></div><p class="small muted">Depth counts screens from the entry page along the discovery tree; scrolling or filling a form stays on the same screen. Coverage is usable controls tried on the screens at that depth; blocked controls need a handoff or could not be used.</p>${split}<div class="table-wrap"><table><thead><tr><th>Depth</th><th>Screens</th><th>Controls tried</th><th>Coverage</th><th>Blocked</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
export function planningView(graph){
  const latest=graph.selections?.at(-1);
  if(!latest)return coverageView(graph);
  const label=id=>'S'+(graph.states.findIndex(s=>s.state_id===id)+1);
  const rows=(latest.ranked_paths||[]).map(path=>`<tr><td><strong>${esc(path.name)}</strong><div class="table-sub">${path.path_state_ids.map(label).join(' → ')} → ${esc(path.name)}</div></td><td>${Math.round(path.likelihood*100)}/100</td><td>${Math.round((path.path_likelihood_score??path.path_likelihood_estimate)*100)}/100</td><td>${path.travel_steps}</td><td>${esc(path.reason)}</td></tr>`).join('');
  return `<section class="panel planner-panel"><div class="panel-header"><h2>Latest planning decision</h2><span>${latest.strategy?`<span class="pill">${esc(MODES[latest.strategy.mode]??latest.strategy.mode)}</span> `:''}<span class="pill">${latest.purpose==='return'?'Returning to a branch':latest.purpose==='resume'?'Reopening a page from earlier runs':latest.selected?.rewalk?'Repeating a recorded transition':'Exploring a new step'}</span></span></div><div class="planner-explanation"><strong>${esc(latest.selected.name)}</strong><p>${esc(latest.selected.reason)}</p><p class="small muted">Scores rank hypotheses about user intent; they are not measured probabilities. The path score multiplies scores along the discovery path. Changed pixels help choose what to inspect; they do not establish a bug.</p></div><div class="table-wrap"><table><thead><tr><th>Candidate journey</th><th>Next-action score</th><th>Path score</th><th>Return steps</th><th>Why explore it</th></tr></thead><tbody>${rows}</tbody></table></div></section>${discoveryTree(graph)}${coverageView(graph)}`;
}
// Each screen appears once, under the screen it was first reached from, with
// the action that reached it. Its other views are listed with it, and what
// was found from them hangs under the screen.
export function discoveryTree(graph){
  const label=id=>'S'+(graph.states.findIndex(s=>s.state_id===id)+1);
  const states=graph.states.filter(s=>s.url!=='about:blank'),actions=state.report?.actions??[];
  const via=node=>{const edge=(graph.edges??[]).find(e=>e.to_state_id===node.state_id&&e.from_state_id===node.planning?.parent_state_id),action=edge&&actions.find(a=>a.action_id===edge.action_id);return action?actionName(action):'Reached';};
  const address=(url,from)=>{if(url===from)return 'Same address';try{const u=new URL(url),f=new URL(from);return u.origin===f.origin?u.pathname+u.search+u.hash:url;}catch{return url;}};
  const renderNode=(node,parent,seen)=>{
    if(seen.has(node.state_id))return '';
    const views=states.filter(s=>screenOf(graph,s)===node.state_id),ids=[node.state_id,...views.map(s=>s.state_id)],visited=new Set([...seen,...ids]);
    const children=states.filter(s=>!screenOf(graph,s)&&ids.includes(s.planning?.parent_state_id)&&!visited.has(s.state_id));
    const counts=screenControls(graph,ids);
    const head=parent?`<strong>${esc(via(node))}</strong><span class="small muted">${esc(address(node.url,parent.url))}</span>`:`<strong>${esc(node.url)}</strong><span class="small muted">Entry page</span>`;
    const also=views.length?`<p class="small muted">Same screen: ${views.map(v=>`${label(v.state_id)} after ${esc(via(v))}`).join(' · ')}</p>`:'';
    return `<li><div><span class="pill">${label(node.state_id)}</span>${head}<span class="small muted">${counts.tried} tried · ${counts.untried} untried${counts.blocked?` · ${counts.blocked} blocked`:''}</span></div>${also}${children.length?`<ul>${children.map(child=>renderNode(child,node,visited)).join('')}</ul>`:''}</li>`;
  };
  const roots=states.filter(s=>!screenOf(graph,s)&&!states.some(p=>p.state_id===s.planning?.parent_state_id));
  return `<section class="panel settings-panel"><h2>Discovery tree</h2><p class="small muted">Each screen appears once, under the screen it was first reached from, with the action that reached it. Scrolled views and other states of the same screen are listed with it. Returns and repeated visits are in the transitions table below.</p><ul class="discovery-tree">${roots.map(node=>renderNode(node,null,new Set())).join('')}</ul></section>`;
}
export function flowView(){
  const graph=state.report.graph;if(!graph)return empty('No exploration graph','This recorder fixture has an action timeline but no model exploration graph.','flow');
  const nodeName=id=>'S'+(graph.states.findIndex(n=>n.state_id===id)+1);
  return `${planningView(graph)}<div class="flow-grid">${graph.states.map((node,index)=>{const controls=graph.frontier.filter(f=>f.state_id===node.state_id);return `<article class="state-card"><span class="pill">State ${index+1}</span><strong>${esc(node.url)}</strong><p class="small muted">${controls.filter(f=>f.status==='attempted').length} attempted · ${controls.filter(f=>f.status==='unexplored').length} unexplored · ${controls.filter(f=>f.status==='blocked').length} blocked</p><p class="mono">${esc(node.state_id)}</p></article>`;}).join('')}</div><section class="panel"><div class="panel-header"><h2>Executed transitions</h2><span class="small muted">Exact screenshot and page-state identity</span></div><div class="table-wrap"><table><thead><tr><th>Transition</th><th>Action</th><th>Assessment</th><th></th></tr></thead><tbody>${graph.edges.map(edge=>{const action=state.report.actions.find(a=>a.action_id===edge.action_id);return `<tr><td><div class="transition"><span>${nodeName(edge.from_state_id)}</span>${icon('arrow')}<span>${nodeName(edge.to_state_id)}</span>${edge.from_state_id===edge.to_state_id?'<small class="muted">Same state</small>':''}</div></td><td>${esc(action? actionName(action):short(edge.action_id))}</td><td>${pill(action?.assessment?.verdict)}</td><td>${button('select-action','Evidence','image',`data-id="${edge.action_id}"`)}</td></tr>`;}).join('')}</tbody></table></div></section><section class="panel settings-panel"><h2>Unvisited and blocked controls</h2>${graph.frontier.filter(f=>f.status!=='attempted').map(f=>`<div class="key-value"><span>${esc(f.control.name)} <small>${nodeName(f.state_id)}</small></span><span>${esc((f.reason||f.status).replaceAll('_',' '))}</span></div>`).join('')||'<p class="small muted">No additional controls were recorded in these states.</p>'}</section>`;
}
