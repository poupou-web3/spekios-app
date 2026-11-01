import {websiteHref} from '../websites.js';
// Run page: summary, panels and the Actions / Findings / Flow map tabs.
import {button,empty,icon,pill,stat} from '/assets/ui/components.js';
import {date,elapsed,esc,fixture,name,number,providerName,runStatus,short} from '/assets/ui/format.js';
import {estimateCost,priceLabel,tokenCounts,tokenSplit,tokenSum,usd} from '/assets/ui/usage.js';
import {cancelButton,restartButton} from '../jobs.js';
import {state} from '../state.js';
import {actionDetail,actionName,expected} from './action.js';
import {automaticPanel} from './automatic.js';
import {flowView} from './flow.js';
import {filteredFindings,findingStatus,humanReviewPill} from './review.js';
import {steeringPanel} from './steering.js';
import {modelRequestFailure} from '../report/model-failure.js';
const modelsSettings='<a href="#/settings/models">Settings → Models</a>';
import {priceLink} from './settings.js';
// Saved model prices, or the cost the provider reported, estimate what the run's model calls cost.
// The card links to the prices: the first model without one, or the model list.
export function costStat(usage){
  const estimate=estimateCost(usage,state.settings.savedModels),unpriced=estimate.unpriced;
  const value=estimate.usd==null?'No price yet':usd(estimate.usd,estimate.partial),action=label=>` <span class="stat-action">${label}${icon('arrow')}</span>`;
  const note=unpriced.length?`No price for ${unpriced.slice(0,2).map(m=>esc(m.model)).join(', ')}${unpriced.length>2?` and ${unpriced.length-2} more`:''}.${action('Add a price')}`:!estimate.rows.length?'No model calls yet':`${estimate.rows.every(r=>r.basis==='reported')?'Cost reported by the provider':'From your model prices'}.${action('Edit prices')}`;
  const body=`<div class="stat-label">Estimated cost${icon('clock')}</div><div class="stat-value">${esc(value)}</div><div class="stat-note">${note}</div>`;
  if(!estimate.rows.length)return `<div class="stat">${body}</div>`;
  return `<a class="stat stat-link" href="${esc(unpriced.length?priceLink(unpriced[0].provider,unpriced[0].model):'#/settings/models')}">${body}</a>`;
}
// Tokens and estimated cost for each model the run used, collapsed by default.
export function usagePanel(usage){
  const estimate=estimateCost(usage,state.settings.savedModels);if(!estimate.rows.length)return '';
  const saved=state.settings.savedModels||[],label=m=>saved.find(s=>s.provider===m.provider&&s.model===m.model)?.label;
  const cost=r=>r.usd==null?`<a class="usage-price-link" href="${esc(priceLink(r.provider,r.model))}">Add a price</a>`:`${esc(usd(r.usd,r.partial))}${r.basis==='reported'?'<div class="table-sub">Provider-reported</div>':''}`;
  const total=tokenCounts(usage);
  return `<details class="panel usage-panel" data-disclosure="model-usage"><summary><span class="usage-summary"><strong>Model usage</strong><span class="small muted">${number(estimate.rows.length)} model${estimate.rows.length===1?'':'s'} · ${esc(tokenSplit(usage))} · ${esc(tokenSum(usage))} total · ${esc(estimate.usd==null?'no price yet':usd(estimate.usd,estimate.partial))}</span></span><span class="usage-toggle">Details</span></summary><div class="table-wrap"><table><thead><tr><th>Model</th><th>Calls</th><th>Input tokens</th><th>Output tokens</th><th>Total tokens</th><th>Price</th><th>Estimated cost</th></tr></thead><tbody>${estimate.rows.map(r=>`<tr><td><div class="table-title">${esc(label(r)||r.model)}</div><div class="table-sub">${esc(providerName(r.provider))}${label(r)?` · ${esc(r.model)}`:''}</div></td><td>${number(r.attempts)}</td><td>${r.tokens.input==null?'Unknown':number(r.tokens.input)}</td><td>${r.tokens.output==null?'Unknown':number(r.tokens.output)}</td><td>${esc(tokenSum(r))}</td><td class="small">${esc(priceLabel(r.price))}${r.price.source?`<div class="table-sub">${r.price.source==='yours'?'Your price':'Known price'}</div>`:''}</td><td>${cost(r)}</td></tr>`).join('')}</tbody><tfoot><tr><th scope="row">All models</th><td>${number(usage.attempts)}</td><td>${total.input==null?'Unknown':number(total.input)}</td><td>${total.output==null?'Unknown':number(total.output)}</td><td>${esc(tokenSum(usage))}</td><td></td><td>${esc(estimate.usd==null?'Unknown':usd(estimate.usd,estimate.partial))}</td></tr></tfoot></table></div><p class="small muted usage-note">Tokens are what providers reported; “≥” means some calls did not report usage yet. Estimates use each model’s price per million input and output tokens from ${modelsSettings}, or the cost the provider reported when a model has no price. They are not a bill.</p></details>`;
}
export function runView(){
  if(!state.report)return '<div class="loading" role="status">Loading run evidence…</div>';
  const report=state.report,run=report.run,suspects=report.actions.filter(a=>a.assessment?.verdict==='suspect');
  const pending=suspects.filter(a=>findingStatus(a)==='needs_review'),confirmed=suspects.filter(a=>findingStatus(a)==='confirmed'),dismissed=suspects.filter(a=>findingStatus(a)==='dismissed');
  const actions=state.tab==='findings'?filteredFindings():report.actions;
  if(state.tab==='findings'&&!actions.some(a=>a.action_id===state.actionId))state.actionId=actions[0]?.action_id;
  const usage=report.model_usage||{},completed=report.actions.filter(a=>a.state==='completed').length;
  const limit=Number(run.config?.limits?.max_actions),executed=report.actions.filter(a=>a.dispatched_at||a.state==='completed').length;
  const description=run.cancel_requested_at&&run.lifecycle==='active'?'Stopping after the current in-flight work':run.config?.stop_reason?.replaceAll('_',' ')||(run.lifecycle==='active'?'Exploration in progress':'Recorded run finished');
  const progress=Number.isFinite(limit)&&limit>0?`<div class="run-progress"><div class="progress-label"><span>${number(executed)} of ${number(limit)} allowed actions used</span><span>Action budget · coverage is not a percentage</span></div><meter min="0" max="${limit}" value="${Math.min(executed,limit)}" aria-label="Browser action budget used">${executed} of ${limit}</meter></div>`
    :run.config?.limits&&run.config.limits.max_actions===null?`<div class="run-progress"><div class="progress-label"><span>${number(executed)} actions · no action limit</span><span>Runs until nothing new is left or a configured limit is reached</span></div></div>`:'';
  return `<div class="page-heading"><div><a class="button quiet" href="${websiteHref(state.websiteOrigin,'tests')}">${icon('layers')}All tests</a><div class="row"><span class="eyebrow">${run.config.replay_of?'Reproduction':'Exploration'} / ${esc(short(run.run_id))}</span>${fixture(run)?'<span class="tag">TEST DATA</span>':''}</div><h1>${esc(name(run))}</h1><p>${esc(run.config.viewport_profile||'desktop')} · ${date(run.created_at)} · ${elapsed(run.created_at,run.finished_at)}${memoryLabel(run)}</p></div><div class="heading-actions">${pill(runStatus(run))}${cancelButton('run',run)}${restartButton('run',run)}${button('export-run','Export report','download')}</div></div>${run.cancel_requested_at&&run.lifecycle==='active'?`<div class="notice" role="status">${icon('clock')}Stopping exploration. Recorded evidence is retained. The worker must acknowledge the request; model calls already sent may still finish.</div>`:''}${runErrorNotice(report)}<section class="panel run-summary"><div class="summary-cell"><span class="summary-label">Execution</span><strong class="summary-value">${esc(description)}</strong><span class="small muted">${completed} completed · ${report.actions.length} action records</span></div><div class="summary-cell"><span class="summary-label">Application</span><span class="small mono">${esc(run.target_url)}</span><span class="small muted">${esc(run.config.model_connection?.model||'Model not recorded')}</span></div>${progress}</section><div class="stats review-stats">${stat('Actions recorded',number(report.actions.length),`${completed} completed · other records may be pending or skipped`,'layers')}${stat('Findings to review',number(pending.length),`${number(dismissed.length)} human dismissed candidates`,'bug')}${stat('Human confirmed',number(confirmed.length),'Reviewer decisions, separate from AI suspicion','check')}${stat('Screenshots recorded',number(report.captures.length+(report.events||[]).filter(e=>e.event_type==='action.settling_frame').length),'Before, after and settling frames','image')}${stat('Model tokens',tokenSum(usage),`${tokenSplit(usage)} · ${number(usage.attempts)} calls`,'bolt')}${costStat(usage)}</div>${usagePanel(usage)}${steeringPanel()}${fixVerificationPanel()}${automaticPanel()}<div class="tabs" role="tablist" aria-label="Run views">${[['actions','Actions','layers',report.actions.length],['findings','Findings','bug',suspects.length],['flow','Flow map','flow',report.graph?.states.length??0]].map(([tab,label,key,count])=>`<button id="run-tab-${tab}" class="tab ${state.tab===tab?'active':''}" role="tab" aria-selected="${state.tab===tab}" aria-controls="run-panel" tabindex="${state.tab===tab?'0':'-1'}" data-action="tab" data-value="${tab}">${icon(key)}${label}<span>${count}</span></button>`).join('')}</div><section id="run-panel" role="tabpanel" aria-labelledby="run-tab-${esc(state.tab)}" tabindex="0">${state.tab==='findings'?`<p class="view-description">All AI candidates remain recorded, including dismissed findings. Choose a status to review.</p><div class="finding-filters segmented" aria-label="Filter findings">${[['needs_review','Needs review',pending.length],['confirmed','Human confirmed',confirmed.length],['dismissed','Dismissed',dismissed.length],['all','All candidates',suspects.length]].map(([value,label,count])=>`<button data-action="finding-filter" data-value="${value}" class="${(state.findingFilter||'needs_review')===value?'active':''}" aria-pressed="${(state.findingFilter||'needs_review')===value}">${label} ${count}</button>`).join('')}</div>`:''}${state.tab==='flow'?flowView():actions.length?`<div class="run-layout"><aside class="action-list" aria-label="Recorded actions"><h3>${state.tab==='findings'?'Recorded candidates':'Action timeline'}<span>${actions.length} steps</span></h3>${actions.map(a=>`<button class="action-row ${state.actionId===a.action_id?'selected':''}" data-action="select-action" data-id="${esc(a.action_id)}" aria-pressed="${state.actionId===a.action_id}"><span class="step-number">${a.ordinal}</span><span class="step-copy"><h3>${esc(actionName(a))}</h3>${a.assessment?.verdict==='suspect'?`${humanReviewPill(a)}<span class="small muted model-suspicion">AI suspicion</span>`:pill(a.state==='cancelled'?'cancelled':a.assessment?.verdict||a.state)}<p>${esc(expected(a).slice(0,110))}</p></span></button>`).join('')}</aside><div class="action-detail">${actionDetail()}</div></div>`:state.tab==='findings'?empty('No findings in this filter','Switch filters to inspect other candidates. Recorded checks do not establish that the entire app is bug-free.','check'):empty('No actions recorded yet','The worker has not recorded an action for this run.','clock')}</section><div class="helper">${icon('info')}Coverage is bounded. Unvisited flows and unsupported interactions remain untested.</div>`;
}
// Whether earlier runs of this app guided the exploration.
export function runErrorNotice(report){
  const run=report?.run,failure=modelRequestFailure(report);
  if(!run?.error)return '';
  const tone=run.lifecycle==='cancelled'?'':'error';
  if(!failure)return `<div class="notice ${tone}">${icon('info')}<span>${esc(run.error)}</span></div>`;
  return `<div class="notice ${tone}" role="alert">${icon('info')}<div><strong>${esc(failure.title)}</strong><p>${esc(failure.detail)}</p><p class="small mono">Request ${esc(failure.requestId)}</p></div></div>`;
}
export function memoryLabel(run){
  const memory=run.config?.app_memory;if(!memory||run.config.replay_of)return '';
  if(!memory.enabled)return ' · Fresh exploration';
  const prior=memory.scopes?.[0]?.prior_runs??0;
  return prior?` · Guided by ${number(prior)} earlier run${prior===1?'':'s'}`:' · First remembered run';
}
export function persistentIssueLink(action){
  const issue=state.report?.persistent_issues?.find(i=>i.action_id===action.action_id);
  const id=issue?.issue_id||state.report?.run?.config?.fix_verification?.issue_id;
  return id?`<div class="notice"><span>Issue ${esc(id)}</span><a class="button" href="/issues#${esc(id)}">History & verify fix</a></div>`:'';
}
export function fixVerificationPanel(){
  const check=state.report?.fix_verification;if(!check)return '';
  const outcome={resolved:'Resolved on candidate',still_reproducible:'Still reproducible',blocked:'Blocked',inconclusive:'Inconclusive'}[check.outcome]||check.status;
  return `<section class="notice"><div><strong>Candidate fix verification · ${esc(outcome)}</strong><p>${esc(check.result?.reason||'Checking the original recorded behavior in a fresh browser.')}</p><p class="small muted">This result applies to this candidate deployment.</p></div><a class="button" href="/issues#${esc(check.issue_id)}">Issue history & both evidence sets</a></section>`;
}
