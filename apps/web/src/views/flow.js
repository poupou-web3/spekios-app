// Flow map: planning decisions, discovery tree, states and transitions.
import {button,empty,icon,pill} from '/assets/ui/components.js';
import {esc,short} from '/assets/ui/format.js';
import {state} from '../state.js';
import {actionName} from './action.js';
const MODES={breadth:'New territory',depth:'Deep journey',rewalk:'Re-walk'};
// Depth reached and coverage at each level of the discovery tree, and how the
// run shared its actions between strategies. Live runs compute it from the graph.
export function coverageView(graph){
  const states=graph.states.filter(s=>/^https?:/.test(s.url)&&s.planning);
  if(!states.length)return '';
  const levels=new Map();
  for(const node of states){
    const depth=node.planning.depth??0,level=levels.get(depth)??{depth,states:0,controls:0,tried:0,blocked:0};level.states++;
    for(const f of graph.frontier.filter(f=>f.state_id===node.state_id&&f.control?.role!=='scroll')){if(f.status==='attempted'){level.controls++;level.tried++;}else if(f.status==='blocked')level.blocked++;else level.controls++;}
    levels.set(depth,level);
  }
  const rows=[...levels.values()].sort((a,b)=>a.depth-b.depth).map(l=>`<tr><td>${l.depth}</td><td>${l.states}</td><td>${l.tried} / ${l.controls}</td><td>${l.controls?Math.round(l.tried/l.controls*100):100}%</td><td>${l.blocked}</td></tr>`).join('');
  const counts={breadth:0,depth:0,rewalk:0};for(const s of graph.selections??[])if(s.strategy?.mode in counts)counts[s.strategy.mode]++;
  const shares=graph.selections?.findLast(s=>s.strategy)?.strategy?.shares;
  const split=Object.values(counts).some(Boolean)?`<p class="small muted">Planned actions, including travel: ${Object.entries(MODES).map(([mode,label])=>`${label} ${counts[mode]}${shares?` (share now ${Math.round(shares[mode]*100)}%)`:''}`).join(' · ')}.</p>`:'';
  return `<section class="panel settings-panel"><div class="panel-header"><h2>Depth and coverage</h2><span class="pill">${Math.max(...levels.keys())} deep</span></div><p class="small muted">Depth counts steps from the entry page along the discovery tree. Coverage is usable controls tried on the screens at that depth; blocked controls need a handoff or could not be used.</p>${split}<div class="table-wrap"><table><thead><tr><th>Depth</th><th>Screens</th><th>Controls tried</th><th>Coverage</th><th>Blocked</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
export function planningView(graph){
  const latest=graph.selections?.at(-1);
  if(!latest)return coverageView(graph);
  const label=id=>'S'+(graph.states.findIndex(s=>s.state_id===id)+1);
  const rows=(latest.ranked_paths||[]).map(path=>`<tr><td><strong>${esc(path.name)}</strong><div class="table-sub">${path.path_state_ids.map(label).join(' → ')} → ${esc(path.name)}</div></td><td>${Math.round(path.likelihood*100)}/100</td><td>${Math.round((path.path_likelihood_score??path.path_likelihood_estimate)*100)}/100</td><td>${path.travel_steps}</td><td>${esc(path.reason)}</td></tr>`).join('');
  const states=graph.states.filter(s=>s.url!=='about:blank');
  const renderNode=(node,seen=new Set())=>{
    if(seen.has(node.state_id))return '';
    const visited=new Set([...seen,node.state_id]);
    const children=states.filter(s=>s.planning?.parent_state_id===node.state_id);
    const remaining=graph.frontier.filter(f=>f.state_id===node.state_id&&f.status==='unexplored').length;
    return `<li><div><span class="pill">${label(node.state_id)}</span><strong>${esc(node.url)}</strong><span class="small muted">${remaining} unvisited controls</span></div>${children.length?`<ul>${children.map(child=>renderNode(child,visited)).join('')}</ul>`:''}</li>`;
  };
  return `<section class="panel planner-panel"><div class="panel-header"><h2>Latest planning decision</h2><span>${latest.strategy?`<span class="pill">${esc(MODES[latest.strategy.mode]??latest.strategy.mode)}</span> `:''}<span class="pill">${latest.purpose==='return'?'Returning to a branch':latest.purpose==='resume'?'Reopening a page from earlier runs':latest.selected?.rewalk?'Repeating a recorded transition':'Exploring a new step'}</span></span></div><div class="planner-explanation"><strong>${esc(latest.selected.name)}</strong><p>${esc(latest.selected.reason)}</p><p class="small muted">Scores rank hypotheses about user intent; they are not measured probabilities. The path score multiplies scores along the discovery path. Changed pixels help choose what to inspect; they do not establish a bug.</p></div><div class="table-wrap"><table><thead><tr><th>Candidate journey</th><th>Next-action score</th><th>Path score</th><th>Return steps</th><th>Why explore it</th></tr></thead><tbody>${rows}</tbody></table></div></section><section class="panel settings-panel"><h2>Discovery tree</h2><p class="small muted">First-discovery relationships are shown here. Return routes and cycles remain in the transition graph below.</p><ul class="discovery-tree">${states.filter(s=>!states.some(parent=>parent.state_id===s.planning?.parent_state_id)).map(node=>renderNode(node)).join('')}</ul></section>${coverageView(graph)}`;
}
export function flowView(){
  const graph=state.report.graph;if(!graph)return empty('No exploration graph','This recorder fixture has an action timeline but no model exploration graph.','flow');
  const nodeName=id=>'S'+(graph.states.findIndex(n=>n.state_id===id)+1);
  return `${planningView(graph)}<div class="flow-grid">${graph.states.map((node,index)=>{const controls=graph.frontier.filter(f=>f.state_id===node.state_id);return `<article class="state-card"><span class="pill">State ${index+1}</span><strong>${esc(node.url)}</strong><p class="small muted">${controls.filter(f=>f.status==='attempted').length} attempted · ${controls.filter(f=>f.status==='unexplored').length} unexplored · ${controls.filter(f=>f.status==='blocked').length} blocked</p><p class="mono">${esc(node.state_id)}</p></article>`;}).join('')}</div><section class="panel"><div class="panel-header"><h2>Executed transitions</h2><span class="small muted">Exact screenshot and page-state identity</span></div><div class="table-wrap"><table><thead><tr><th>Transition</th><th>Action</th><th>Assessment</th><th></th></tr></thead><tbody>${graph.edges.map(edge=>{const action=state.report.actions.find(a=>a.action_id===edge.action_id);return `<tr><td><div class="transition"><span>${nodeName(edge.from_state_id)}</span>${icon('arrow')}<span>${nodeName(edge.to_state_id)}</span>${edge.from_state_id===edge.to_state_id?'<small class="muted">Same state</small>':''}</div></td><td>${esc(action? actionName(action):short(edge.action_id))}</td><td>${pill(action?.assessment?.verdict)}</td><td>${button('select-action','Evidence','image',`data-id="${edge.action_id}"`)}</td></tr>`;}).join('')}</tbody></table></div></section><section class="panel settings-panel"><h2>Unvisited and blocked controls</h2>${graph.frontier.filter(f=>f.status!=='attempted').map(f=>`<div class="key-value"><span>${esc(f.control.name)} <small>${nodeName(f.state_id)}</small></span><span>${esc((f.reason||f.status).replaceAll('_',' '))}</span></div>`).join('')||'<p class="small muted">No additional controls were recorded in these states.</p>'}</section>`;
}
