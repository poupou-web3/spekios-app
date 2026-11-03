// Workspace landing at #/workspace: every project (one website origin each), what needs attention
// across them and the latest tests. With no project yet it is the first-test page.
import {icon,pill} from '/assets/ui/components.js';
import {date,esc,fixture,name,number,runStatus} from '/assets/ui/format.js';
import {state} from '../state.js';
import {workspaceWebsites} from '../website-state.js';
import {websiteFavicon,websiteHref,websiteLabel,websiteLaunchHint,websiteOrigin,websitePath} from '../websites.js';
import {hero,landingSteps,workspaceSetup} from './home.js';

const runsOf=origin=>state.runs.filter(run=>websiteOrigin(run.target_url)===origin);
const loadedCount=(origin,key)=>runsOf(origin).reduce((sum,run)=>sum+(run.config?.replay_of?0:Number(run.summary?.[key])||0),0);
// The catalog counts every run of the website. An older API without those counts falls back to the loaded runs.
function siteCount(site,key){const value=Number(site[key]);return Number.isFinite(value)&&site[key]!=null?value:loadedCount(site.origin,key);}
function activeWork(origin){
  const run=runsOf(origin).find(r=>r.lifecycle==='active');
  const job=state.jobs.find(j=>['queued','running'].includes(j.status)&&websiteOrigin(j.request?.target_url)===origin);
  return {run,job,active:!!run||!!job||Number(state.websites.find(site=>site.origin===origin)?.active_runs)>0};
}
function testKind(run){return run.config?.fix_verification?'Fix check':run.config?.replay_of?'Fresh-browser recheck':'Exploration';}
// Findings are reviewed on a run's Findings tab. Open the newest loaded run that still has some, else the project.
function findingsHref(origin){const run=runsOf(origin).find(r=>!r.config?.replay_of&&Number(r.summary?.pending_findings)>0);return run?'#/workspace/'+run.run_id+'/findings':websiteHref(origin);}

function attention(sites){
  const signIns=(state.access.requests||[]).filter(request=>['waiting','active'].includes(request.status)).map(request=>`<button type="button" class="attention-card" data-action="open-activity"><span class="small muted">${esc(websiteLabel(request.origin))}</span><strong>${request.status==='active'?'Private sign-in in progress':'Sign-in requested'}</strong><span class="attention-link">Open Activity</span></button>`);
  const reviews=sites.map(site=>[site,siteCount(site,'pending_findings')]).filter(([,count])=>count>0).sort((a,b)=>b[1]-a[1]).slice(0,3)
    .map(([site,count])=>`<a class="attention-card" href="${esc(findingsHref(site.origin))}"><span class="small muted">${esc(websiteLabel(site.origin))}</span><strong>${number(count)} ${count===1?'finding':'findings'} to review</strong><span class="attention-link">Start reviewing${icon('arrow')}</span></a>`);
  const cards=[...signIns,...reviews];
  return cards.length?`<section class="workspace-section" aria-labelledby="attention-title"><h2 id="attention-title">Needs you</h2><div class="attention-grid">${cards.join('')}</div></section>`:'';
}

function projectCard(site){
  const pending=siteCount(site,'pending_findings'),confirmed=siteCount(site,'confirmed_findings'),tests=Number(site.run_count)||runsOf(site.origin).length;
  const work=activeWork(site.origin),label=websiteLabel(site.origin);
  const status=work.active?`<a class="project-status running" href="${work.run?'#/workspace/'+esc(work.run.run_id):websiteHref(site.origin)}"><i class="dot green" aria-hidden="true"></i>${work.run?`Running now · ${number(work.run.summary?.actions)} steps`:'Starting a test'}</a>`
    :site.last_test_at?`<span class="project-status">Last test ${esc(date(site.last_test_at))}</span>`:'<span class="project-status">No tests yet</span>';
  return `<article class="project-card"><header>${websiteFavicon(site.origin)}<div><h3><a href="${websiteHref(site.origin)}">${esc(label)}</a></h3><p class="small muted mono project-path" title="${esc(site.target_url?websitePath(site.target_url):'/')}">${esc(site.target_url?websitePath(site.target_url):'/')}</p></div></header><dl class="project-stats"><div><dt>To review</dt><dd class="${pending?'attention':''}">${number(pending)}</dd></div><div><dt>Confirmed</dt><dd>${number(confirmed)}</dd></div><div><dt>Tests</dt><dd>${number(tests)}</dd></div></dl><footer>${status}<a class="button" href="${websiteHref(site.origin)}" aria-label="Open ${esc(label)}">Open${icon('arrow')}</a></footer></article>`;
}

function latest(){
  const runs=state.runs.slice(0,6);if(!runs.length)return '';
  return `<section class="workspace-section" aria-labelledby="latest-title"><h2 id="latest-title">Latest across projects</h2><ol class="workspace-latest">${runs.map(run=>`<li><span class="small muted">${esc(date(run.created_at))}</span><span class="workspace-latest-text"><strong>${esc(websiteLabel(websiteOrigin(run.target_url)))}</strong> · ${esc(testKind(run))}${fixture(run)?' · test data':''}${Number(run.summary?.pending_findings)&&!run.config?.replay_of?` · ${number(run.summary.pending_findings)} to review`:''}</span>${pill(runStatus(run))}<a href="#/workspace/${esc(run.run_id)}" aria-label="Open ${esc(name(run))}">Open</a></li>`).join('')}</ol></section>`;
}

function launch(){
  const error=state.websiteLaunchError;
  return `<form id="website-launch-form" class="workspace-launch" novalidate><label for="website-url">Test a new URL</label><div><input id="website-url" name="url" type="text" inputmode="url" maxlength="2048" required placeholder="https://your-website.com" autocomplete="url" autocapitalize="off" spellcheck="false" value="${esc(state.websiteUrl)}" aria-describedby="website-launch-error"${error?' aria-invalid="true"':''}><button class="button primary" type="submit" ${state.submitting?'disabled':''}>${state.submitting?'Starting…':`Start${icon('arrow')}`}</button></div><p id="website-launch-error" class="small ${error?'error':'muted'}" ${error?'role="alert"':''}>${esc(error||websiteLaunchHint(state.websiteUrl))}</p></form>`;
}

export function landingView(){
  const sites=workspaceWebsites();
  // Nothing loaded yet is not an empty workspace: say so instead of offering the first-test page.
  if(!sites.length&&!state.lastUpdatedAt)return `<div class="workspace-landing"><header class="workspace-heading"><div><p class="eyebrow">Workspace</p><h1>Your projects</h1>${state.error?`<p class="notice error" role="alert">${icon('info')}<span>Your projects could not load: ${esc(state.error)}</span></p><p><button class="button" data-action="refresh">${icon('refresh')}Try again</button></p>`:'<p class="muted" role="status">Loading your projects…</p>'}</div></header></div>`;
  if(!sites.length)return `${hero()}${workspaceSetup()}${landingSteps()}`;
  const running=sites.filter(site=>activeWork(site.origin).active).length,pending=sites.reduce((sum,site)=>sum+siteCount(site,'pending_findings'),0);
  const summary=[`${number(sites.length)} ${sites.length===1?'project':'projects'}`,...(running?[`${number(running)} running`]:[]),pending?`${number(pending)} ${pending===1?'finding':'findings'} waiting for review`:'nothing waiting for review'].join(' · ');
  return `<div class="workspace-landing"><header class="workspace-heading"><div><p class="eyebrow">Workspace</p><h1>Your projects</h1><p class="muted">${esc(summary)}</p></div>${launch()}</header>${workspaceSetup()}${attention(sites)}<section class="workspace-section" aria-labelledby="projects-title"><h2 id="projects-title">Projects</h2><div class="project-grid">${sites.map(projectCard).join('')}</div></section>${latest()}</div>`;
}
