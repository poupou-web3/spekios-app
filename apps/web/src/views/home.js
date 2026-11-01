// Workspace home: launch form, setup checklist and the runs table.
import {button,empty,icon,pill} from '/assets/ui/components.js';
import {date,elapsed,esc,fixture,name,number,providerName,runStatus,short} from '/assets/ui/format.js';
import {continueButton,restartButton,STOPPED} from '../jobs.js';
import {state} from '../state.js';
import {freeModel} from './settings.js';
import {estimateCost,tokenSplit,tokenSum,usd} from '/assets/ui/usage.js';
import {selectedWebsite,websiteRuns} from '../website-state.js';
import {browserTargetUrl,dockerAddress,normalizeTargetUrl,websiteHref,websiteLabel,websitePath} from '../websites.js';
// A run's tokens with their input/output split and estimated cost, for the runs table.
export function runUsage(usage){
  if(!usage)return '<span class="small muted">—</span>';
  if(!Number(usage.attempts))return '<span class="small muted">No model calls</span>';
  const estimate=estimateCost(usage,state.settings.savedModels);
  return `${esc(tokenSum(usage))}<div class="table-sub">${esc(tokenSplit(usage))}</div><div class="table-sub">${estimate.usd==null?'No price yet':`${esc(usd(estimate.usd,estimate.partial))} estimated`}</div>`;
}
// Projects a test can run under: those settings give a model or limits, named by their label when they have one.
export function launchProjects(){
  const projects=new Map();
  for(const p of Array.isArray(state.settings.projectModels)?state.settings.projectModels:[])if(p?.projectId)projects.set(p.projectId,p);
  for(const o of Array.isArray(state.settings.limitOverrides)?state.settings.limitOverrides:[])if(o?.projectId&&!projects.has(o.projectId))projects.set(o.projectId,{projectId:o.projectId});
  return [...projects.values()];
}
// Models a single test can choose: the saved list. With free-only on, paid OpenRouter models are left out.
export function launchModels(){
  const restricted=state.settings.provider==='openrouter'&&state.settings.freeOnly===true;
  return (Array.isArray(state.settings.savedModels)?state.settings.savedModels:[]).filter(m=>m?.provider&&m?.model&&!(restricted&&m.provider==='openrouter'&&!freeModel(m.model)));
}
const choiceOf=m=>`${m.provider}|${m.model}`;
// The model the next test will use: chosen for this test, else its project's, else the default.
export function launchModel(){
  const chosen=launchModels().find(m=>choiceOf(m)===state.launchModel);
  if(chosen)return {provider:chosen.provider,model:chosen.model,label:chosen.label||chosen.model,source:'run'};
  const project=launchProjects().find(p=>p.projectId===state.launchProject);
  if(project?.provider&&project?.model)return {provider:project.provider,model:project.model,label:project.model,source:'project'};
  return {provider:state.settings.provider,model:state.settings.model,label:state.settings.model,source:'default'};
}
export function canStart(){const model=launchModel();return state.providers.gateway_ready===true&&state.workers.some(w=>w.available)&&state.providers.providers.some(p=>p.provider===model.provider&&p.configured)&&!!model.model;}
const VIEWPORTS=[['desktop','Desktop'],['tablet','Tablet'],['mobile','Mobile']];
const SIGN_IN=[['auto','Ask when sign-in is detected','Sign in when asked'],['sign_in','Sign in before testing','Sign in first'],['public','Public pages only','Public pages only']];
export function launchStatus(){
  if(state.launchError)return `<p id="launch-status" class="landing-status error" role="alert">${icon('info')}<span>${esc(state.launchError)}</span></p>`;
  const docker=dockerAddress(state.url);
  if(docker)return `<p id="launch-status" class="landing-status" role="status"><i class="dot amber"></i><span>The test browser runs in Docker, where localhost is not this computer. This test will open ${esc(docker)}.</span></p>`;
  const model=launchModel(),provider=state.providers.providers.find(p=>p.provider===model.provider),settings='<a href="#/settings/models">Settings</a>',actions=Number(state.settings.maxActions);
  const [tone,text]=!state.lastUpdatedAt?['',state.error?'Workspace status unavailable.':'Checking your workspace…']
    :!model.provider||!model.model?['amber',`Choose a model in ${settings} to start testing.`]
    :!provider?.configured?['amber',`${esc(providerName(model.provider))} is not configured on this server. Choose another model ${model.source==='run'?'under the options below':`in ${settings}`}.`]
    :!state.workers.some(w=>w.available)?['amber','Waiting for the browser worker. Your recorded tests are still available.']
    :state.providers.gateway_ready!==true?['amber','Waiting for the model gateway.']
    :['green',['Ready',esc(providerName(model.provider)),esc(model.model)+(model.source==='project'?' (project model)':model.source==='run'?' (this test)':''),(actions>0?`up to ${number(actions)} actions`:'no action limit'),...(state.providers.test_mode?['simulated model']:[])].join(' · ')];
  return `<p id="launch-status" class="landing-status" role="status"><i class="dot ${tone}"></i><span>${text}</span></p>`;
}
export function hero(){
  const viewport=state.viewportProfile||state.settings.viewportProfile||'desktop';
  const project=launchProjects().find(p=>p.projectId===state.launchProject),model=launchModel();
  const summary=[VIEWPORTS.find(([value])=>value===viewport)?.[1]||'Desktop',SIGN_IN.find(([value])=>value===state.authMode)?.[2]||SIGN_IN[0][2],...(project?[project.label||'Project '+short(project.projectId)]:[]),...(model.source==='run'?[model.label]:[]),...(automaticEnabled()?['Rechecks on']:[])].join(' · ');
  return `<section class="landing" aria-labelledby="landing-title"><p class="eyebrow"><span class="signal-dot" aria-hidden="true"></span>${state.websiteOrigin?'Website overview':'A fresh pair of eyes'}</p><h1 id="landing-title">${state.websiteOrigin?`A fresh look at<br><span>${esc(websiteLabel(state.websiteOrigin))}.</span>`:'What should we explore?'}</h1><p class="landing-lead">${state.websiteOrigin?'Explore a new journey, or return to a previous test.':'Let Spekios try your website and find what needs attention.'}</p><form id="run-form" class="landing-form" novalidate><label class="landing-field">${icon('globe')}<span class="sr-only">Application URL</span><input id="target-url" name="url" type="text" inputmode="url" required maxlength="2048" placeholder="your-app.example" autocomplete="url" autocapitalize="off" spellcheck="false" aria-describedby="launch-status"${state.launchError?' aria-invalid="true"':''} value="${esc(state.url)}"></label><button type="submit" class="button primary landing-start" ${!canStart()||state.submitting?'disabled':''}>${state.submitting?'Starting…':`Start testing${icon('arrow')}`}</button></form>${launchStatus()}<details class="landing-options" data-disclosure="launch-options"><summary>${icon('settings')}<span class="landing-options-summary">${esc(summary)}</span><span class="landing-options-change">Change</span></summary><div class="landing-options-body"><div class="landing-options-grid"><label>Screen size<select id="viewport-profile" name="viewport_profile" form="run-form">${VIEWPORTS.map(([value,label])=>`<option value="${value}" ${viewport===value?'selected':''}>${label}</option>`).join('')}</select></label>${authOptions()}${launchChoices()}</div>${automaticOptions()}<p class="small muted landing-options-note">You can sign in yourself when Spekios asks. Private login activity is excluded from screenshots, model inputs and training evidence. Google and other external identity providers are not supported in this local handoff yet.</p></div></details></section>`;
}
// Project and model for this test. Hidden until settings name a project or list a model.
export function launchChoices(){
  const projects=launchProjects(),models=launchModels();
  if(!projects.length&&!models.length)return '';
  const project=projects.find(p=>p.projectId===state.launchProject),inherited=project?.model?`${project.model} (project)`:`${state.settings.model||'not chosen'} (default)`;
  const projectSelect=projects.length?`<label>Project<select id="launch-project" name="project_id" form="run-form"><option value="">No project</option>${projects.map(p=>`<option value="${esc(p.projectId)}" ${p.projectId===state.launchProject?'selected':''}>${esc(p.label||short(p.projectId))}${p.model?` · ${esc(p.model)}`:''}</option>`).join('')}</select></label>`:'';
  const modelSelect=models.length?`<label>Model<select id="launch-model" name="model" form="run-form"><option value="">${esc(inherited)}</option>${models.map(m=>`<option value="${esc(choiceOf(m))}" ${choiceOf(m)===state.launchModel?'selected':''}>${esc(m.label?`${m.label} (${m.model})`:m.model)} · ${esc(providerName(m.provider))}</option>`).join('')}</select></label>`:'';
  return projectSelect+modelSelect;
}
export function automaticEnabled(){return state.autoReproduce ?? state.settings.autoReproduce===true;}
export function automaticOptions(){
  const enabled=automaticEnabled(),cases=Math.max(1,Math.min(3,Number(state.settings.maxAutoReproductions)||2)),actions=Math.max(1,Math.min(100,Number(state.settings.maxAutoReplayActions)||12));
  return `<div class="automatic-options"><label><input id="auto-reproduce" name="auto_reproduce" form="run-form" type="checkbox" ${enabled?'checked':''} aria-describedby="automatic-help"> Automatically recheck suspected bugs</label><p id="automatic-help" class="small muted">${enabled?`After exploration, use fresh browsers for up to ${cases} suspected bugs and ${actions} additional browser actions in total. Checks use additional model calls. Reproduced findings still need human review.`:'Optional fresh-browser checks use additional model calls. Findings remain subject to human review.'}</p></div>`;
}
export function explorationRequest(form){
  state.url=browserTargetUrl(form.get('url'));const session=form.get('session_id');
  const model=launchModel(),project=launchProjects().some(p=>p.projectId===state.launchProject)?state.launchProject:'';
  // Free-only stays on unless this test deliberately picks a paid OpenRouter model.
  const choice=model.source==='run'?{model:{provider:model.provider,model:model.model,free_only:!(model.provider==='openrouter'&&!freeModel(model.model))}}:{};
  return {kind:'explore',target_url:state.url,viewport_profile:form.get('viewport_profile'),auth_mode:form.get('auth_mode')||'auto',auto_reproduce:automaticEnabled(),...(session?{session_id:session}:{}),...(project?{project_id:project}:{}),...choice};
}
function targetOrigin(){try{return new URL(normalizeTargetUrl(state.url)).origin;}catch{return '';}}
export function sessionChoices(){
  const origin=targetOrigin(),sessions=(state.access.sessions||[]).filter(s=>s.origin===origin&&!s.revoked_at&&new Date(s.expires_at)>new Date()&&s.execution_mode===(state.providers.test_mode?'protocol_fixture':'live'));
  return `<option value="">Start without a saved session</option>${sessions.map(s=>`<option value="${s.session_id}" ${state.sessionId===s.session_id?'selected':''}>Saved ${date(s.created_at)} · expires ${date(s.expires_at)}</option>`).join('')}`;
}
// Typing a URL never redraws the page: a redraw replaces the form and swallows the click or Enter that submits it.
// Only the saved sessions follow the URL, and only when its origin changes.
export function updateTargetUrl(value){
  const origin=targetOrigin(),docker=dockerAddress(state.url);state.url=value;
  if(state.launchError||dockerAddress(value)!==docker){
    if(state.launchError){state.launchError='';document.getElementById?.('target-url')?.removeAttribute('aria-invalid');}
    const status=document.getElementById?.('launch-status');if(status)status.outerHTML=launchStatus();
  }
  if(targetOrigin()===origin)return;
  state.sessionId='';const select=document.getElementById?.('app-session');if(select)select.innerHTML=sessionChoices();
}
export function authOptions(){
  return `<label>Sign-in<select form="run-form" name="auth_mode" id="auth-mode">${SIGN_IN.map(([value,label])=>`<option value="${value}" ${state.authMode===value?'selected':''}>${label}</option>`).join('')}</select></label><label>Saved app session<select form="run-form" name="session_id" id="app-session" ${state.authMode==='public'?'disabled':''}>${sessionChoices()}</select></label>`;
}
export function workspaceRuns(){
  const search=state.search.toLowerCase().trim();
  return websiteRuns().filter(r=>{
    if(state.runMode==='test'&&!fixture(r)||state.runMode==='live'&&(fixture(r)||r.config?.execution_mode!=='live'))return false;
    if(state.runFilter==='needs_review'&&(!Number(r.summary?.pending_findings)||r.config?.replay_of))return false;
    if(state.runFilter==='attention'&&!STOPPED.includes(r.lifecycle))return false;
    if(['active','completed'].includes(state.runFilter)&&r.lifecycle!==state.runFilter)return false;
    return [r.target_url,r.run_id,r.config?.model_connection?.model,r.config?.viewport_profile].join(' ').toLowerCase().includes(search);
  });
}
export function workspaceSetup(){
  const provider=state.providers.providers.find(p=>p.provider===state.settings.provider),gateway=state.providers.gateway_ready===true,worker=state.workers.some(w=>w.available),model=!!provider?.configured&&!!state.settings.model;
  if(gateway&&worker&&model)return '';
  return `<section class="panel workspace-onboarding"><div class="panel-header"><div><h2>Ready to explore?</h2><p class="small muted">Recorded results remain available while you finish setup.</p></div><a class="button" href="#/settings/models">${icon('settings')}Open settings</a></div><div class="setup-checklist">${[[gateway,'Model gateway',gateway?'Ready for requests':'Waiting for the gateway'],[model,'Model connection',model?providerName(state.settings.provider)+' is configured':'Choose an available provider and model in Settings'],[worker,'Browser worker',worker?'Online and ready':'Waiting for the local worker']].map(([ready,label,description])=>`<div class="setup-step"><span class="step-status ${ready?'ready':'pending'}">${icon(ready?'check':'clock')}</span><div><strong>${label}</strong><p class="small muted">${esc(description)}</p></div></div>`).join('')}</div></section>`;
}
export function landingSteps(){
  const steps=[['globe','Paste a URL','Production, staging or a preview: any page your team can open in a browser.'],['scout','Spekios explores','It clicks through the likely paths like a new user and predicts each result before acting.'],['bug','Review what broke','Every surprise comes with before and after screenshots for your team to confirm.']];
  return `<section class="landing-steps" aria-label="How Spekios works">${steps.map(([key,title,text],index)=>`<div class="landing-step"><span class="landing-step-icon">${icon(key)}</span><span class="landing-step-number">0${index+1}</span><h2>${title}</h2><p>${text}</p></div>`).join('')}</section>`;
}
export function recentTests(){
  const runs=workspaceRuns();
  const filters=[['all','All runs'],['active','Running'],['needs_review','Needs review'],['completed','Completed'],['attention','Stopped / blocked']];
  const recent=`<section class="panel landing-recent"><div class="panel-header"><div><h2>Test history</h2><p class="small muted">${runs.length} of ${websiteRuns().length} loaded tests · ${state.websiteOrigin?`${number(selectedWebsite()?.run_count??state.runTotal)} tests on ${esc(websiteLabel(state.websiteOrigin))}`:`latest 50 runs`}</p></div><label class="search">${icon('search')}<span class="sr-only">Search tests</span><input id="run-search" type="search" placeholder="Search tests…" value="${esc(state.search)}"></label></div><div class="run-toolbar"><div class="filter-group" aria-label="Filter runs">${filters.map(([value,label])=>`<button class="filter-chip ${state.runFilter===value?'active':''}" data-action="run-filter" data-value="${value}" aria-pressed="${state.runFilter===value}">${label}</button>`).join('')}</div><label class="small muted">Data <select id="run-mode"><option value="all" ${state.runMode==='all'?'selected':''}>All data</option><option value="live" ${state.runMode==='live'?'selected':''}>Live model runs</option><option value="test" ${state.runMode==='test'?'selected':''}>Test fixtures</option></select></label></div>${runs.length?`<div class="table-wrap"><table><thead><tr><th>Application / run</th><th>Status</th><th>Review</th><th>Actions</th><th>Model usage</th><th>Started / duration</th><th><span class="sr-only">Continue, run again, or open</span></th></tr></thead><tbody>${runs.map(r=>`<tr><td><a class="table-link" href="#/workspace/${esc(r.run_id)}"><div class="table-title">${esc(name(r))}${fixture(r)?'<span class="tag">TEST DATA</span>':''}</div><div class="table-sub">${esc(short(r.run_id))} · ${esc(r.config?.viewport_profile||'desktop')} · ${r.config?.replay_of?'Reproduction':r.config?.runtime_version==='explorer-v1'?'Exploration':'Recorder fixture'}</div></a></td><td>${pill(runStatus(r))}</td><td>${r.config?.replay_of?'<span class="small muted">See source finding</span>':r.summary?Number(r.summary.pending_findings)>0?`<a class="pill amber" href="#/workspace/${esc(r.run_id)}" data-action="open-findings" data-id="${esc(r.run_id)}">${number(r.summary.pending_findings)} to review</a>`:Number(r.summary.confirmed_findings)>0?`<span class="pill green">${number(r.summary.confirmed_findings)} confirmed</span>`:'<span class="small muted">No pending candidates</span>':'<span class="small muted">Not loaded</span>'}</td><td>${number(r.summary?.actions)}</td><td>${runUsage(r.model_usage)}</td><td class="muted">${date(r.created_at)}<div class="table-sub">${elapsed(r.created_at,r.finished_at)}</div></td><td><div class="table-actions">${continueButton(r,true)}${restartButton('run',r,true)}<a class="button icon" href="#/workspace/${esc(r.run_id)}" aria-label="Open ${esc(name(r))}">${icon('arrow')}</a></div></td></tr>`).join('')}</tbody></table></div>`:empty(state.runs.length?'No runs match these filters':'Tests you start appear here',state.runs.length?'Change the status, data filter or search to see more runs.':'Paste a URL above and Spekios will keep the result here.','search')}</section>`;
  return recent+((state.runOffset||state.runNextOffset!==null)?`<div class="website-pagination"><button class="button" data-action="runs-page" data-offset="${Math.max(0,state.runOffset-50)}" ${!state.runOffset?'disabled':''}>Previous</button><span class="small muted">${number(state.runOffset+1)}–${number(state.runOffset+websiteRuns().length)} of ${number(state.runTotal)}</span><button class="button" data-action="runs-page" data-offset="${state.runNextOffset??0}" ${state.runNextOffset===null?'disabled':''}>Next</button></div>`:'');
}
export function overviewTests(){
  const runs=websiteRuns().slice(0,2);
  if(!runs.length)return state.websiteOrigin?`<section class="website-recent">${empty('Your first test starts here','Start a test above. Its history and findings will stay with this website.','globe')}</section>`:landingSteps();
  return `<section class="website-recent"><div class="website-section-heading"><h2>Recent tests</h2><a class="button quiet" href="${websiteHref(state.websiteOrigin,'tests')}">View all tests ${icon('arrow')}</a></div><div class="website-test-grid">${runs.map(run=>`<article class="website-test-card"><a class="website-test-link" href="#/workspace/${esc(run.run_id)}"><header><span class="small muted">${date(run.created_at)}</span>${pill(runStatus(run))}</header><h3>${run.config?.replay_of?'Fresh-browser reproduction':'Website exploration'}</h3><p class="small muted">${esc(state.websiteOrigin?websitePath(run.target_url):name(run))} · ${esc(run.config?.viewport_profile||'desktop')}${fixture(run)?' · Test data':''}</p><footer><span>${number(run.summary?.actions)} actions${run.config?.replay_of?' · See source finding':run.summary?` · ${number(run.summary.pending_findings)} findings to review`:' · Summary not loaded'}</span>${icon('arrow')}</footer></a><div class="website-test-actions">${continueButton(run,true)}${restartButton('run',run,true)}</div></article>`).join('')}</div></section>`;
}
export function home(){
  return state.websitePage==='tests'?`<div class="page-heading"><div><p class="eyebrow">Website history</p><h1>Tests</h1><p>${esc(state.websiteOrigin?websiteLabel(state.websiteOrigin):'Your workspace')}</p></div><a class="button primary" href="${websiteHref(state.websiteOrigin)}" data-action="focus-launch">${icon('plus')}New test</a></div>${recentTests()}`:`${hero()}${workspaceSetup()}${overviewTests()}`;
}
