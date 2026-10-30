// Flow map: planning decisions, discovery tree, states and transitions.
import {button,empty,icon,pill} from '/assets/ui/components.js';
import {esc,short} from '/assets/ui/format.js';
import {state} from '../state.js';
import {actionName} from './action.js';
export function planningView(graph){
  const latest=graph.selections?.at(-1);
  if(!latest)return '';
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
  return `<section class="panel planner-panel"><div class="panel-header"><h2>Latest planning decision</h2><span class="pill">${latest.purpose==='return'?'Returning to a branch':latest.purpose==='resume'?'Reopening a page from earlier runs':'Exploring a new step'}</span></div><div class="planner-explanation"><strong>${esc(latest.selected.name)}</strong><p>${esc(latest.selected.reason)}</p><p class="small muted">Scores rank hypotheses about user intent; they are not measured probabilities. The path score multiplies scores along the discovery path. Changed pixels help choose what to inspect; they do not establish a bug.</p></div><div class="table-wrap"><table><thead><tr><th>Candidate journey</th><th>Next-action score</th><th>Path score</th><th>Return steps</th><th>Why explore it</th></tr></thead><tbody>${rows}</tbody></table></div></section><section class="panel settings-panel"><h2>Discovery tree</h2><p class="small muted">First-discovery relationships are shown here. Return routes and cycles remain in the transition graph below.</p><ul class="discovery-tree">${states.filter(s=>!states.some(parent=>parent.state_id===s.planning?.parent_state_id)).map(node=>renderNode(node)).join('')}</ul></section>`;
}
export function flowView(){
  const graph=state.report.graph;if(!graph)return empty('No exploration graph','This recorder fixture has an action timeline but no model exploration graph.','flow');
  const nodeName=id=>'S'+(graph.states.findIndex(n=>n.state_id===id)+1);
  return `${planningView(graph)}<div class="flow-grid">${graph.states.map((node,index)=>{const controls=graph.frontier.filter(f=>f.state_id===node.state_id);return `<article class="state-card"><span class="pill">State ${index+1}</span><strong>${esc(node.url)}</strong><p class="small muted">${controls.filter(f=>f.status==='attempted').length} attempted · ${controls.filter(f=>f.status==='unexplored').length} unexplored · ${controls.filter(f=>f.status==='blocked').length} blocked</p><p class="mono">${esc(node.state_id)}</p></article>`;}).join('')}</div><section class="panel"><div class="panel-header"><h2>Executed transitions</h2><span class="small muted">Exact screenshot and page-state identity</span></div><div class="table-wrap"><table><thead><tr><th>Transition</th><th>Action</th><th>Assessment</th><th></th></tr></thead><tbody>${graph.edges.map(edge=>{const action=state.report.actions.find(a=>a.action_id===edge.action_id);return `<tr><td><div class="transition"><span>${nodeName(edge.from_state_id)}</span>${icon('arrow')}<span>${nodeName(edge.to_state_id)}</span>${edge.from_state_id===edge.to_state_id?'<small class="muted">Same state</small>':''}</div></td><td>${esc(action? actionName(action):short(edge.action_id))}</td><td>${pill(action?.assessment?.verdict)}</td><td>${button('select-action','Evidence','image',`data-id="${edge.action_id}"`)}</td></tr>`;}).join('')}</tbody></table></div></section><section class="panel settings-panel"><h2>Unvisited and blocked controls</h2>${graph.frontier.filter(f=>f.status!=='attempted').map(f=>`<div class="key-value"><span>${esc(f.control.name)} <small>${nodeName(f.state_id)}</small></span><span>${esc((f.reason||f.status).replaceAll('_',' '))}</span></div>`).join('')||'<p class="small muted">No additional controls were recorded in these states.</p>'}</section>`;
}
