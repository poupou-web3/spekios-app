import {esc} from '/assets/ui/format.js';
import {toast} from '/assets/ui/components.js';
import {api,get} from './api.js';
import {render} from './app.js';
import {state} from './state.js';

const messages={posthog_project_origin_mismatch:'This connection must use the selected Spekios project’s website.',posthog_private_key_required:'Use a private personal API key (phx_), not the public website token (phc_).',posthog_request_failed:'Could not reach PostHog. Check the region and project ID, then retry.',posthog_response_invalid:'PostHog returned an unsupported response. Check the selected region and project.',posthog_analysis_format_unsupported:'PostHog returned unsupported analytics data. The background worker will retry.',posthog_host_not_allowed:'Ask your administrator to allow this PostHog host.',posthog_access_denied:'Check that the API key has query:read and session_recording:read access to this project.',posthog_rate_limited:'PostHog is rate limiting requests. Import will retry shortly.',posthog_endpoint_unavailable:'This PostHog instance does not expose the requested API.',posthog_vault_not_configured:'Secure connection storage is not configured.',posthog_connection_exists:'This project and website are already connected.',posthog_replay_already_queued:'This workflow already has a queued or running replay.',posthog_replay_origin_not_allowed:'Browser replay is only enabled for configured test environments.',posthog_response_limit:'This recording exceeds the import size limit.',posthog_event_limit:'This session exceeds the 500-event import limit.',worker_restarted_after_dispatch:'The worker restarted. This run was not repeated automatically.',recorded_observation_mismatch:'The current app did not match a recorded observation.',browser_interaction_failed:'A recorded interaction could not run in the current app.',selector_missing_or_ambiguous:'A recorded control is missing or matches more than one element.',connection_paused_or_removed:'The connection was paused or removed.'};
const explain=code=>messages[code]||String(code||'').replaceAll('_',' ');
const when=value=>value?new Date(value).toLocaleString():'Waiting for first import';
const sameSession=(s)=>s[0]===state.token&&s[1]===state.developmentAccess&&s[2]===state.browserAuth;

const posthogBase=origin=>`/v1/websites/${encodeURIComponent(origin)}/posthog/connections`;
export async function loadPostHog(){
  const source=state.websiteOrigin;
  if(state.posthogOrigin!==source){state.posthog=null;state.posthogDetail=null;state.posthogSelected=null;state.posthogError='';state.posthogOrigin=source;}
  if(!source)return;
  const session=[state.token,state.developmentAccess,state.browserAuth];
  const active=()=>sameSession(session)&&source===state.websiteOrigin;
  try{
    const data=await get(posthogBase(source));
    if(!active())return;
    state.posthog=data;state.posthogError='';
    if(!data.connections.some(c=>c.connection_id===state.posthogSelected)){state.posthogSelected=data.connections[0]?.connection_id||null;state.posthogDetail=null;}
    const id=state.posthogSelected;
    if(id){const detail=await get(`${posthogBase(source)}/${id}`);if(active()&&id===state.posthogSelected)state.posthogDetail=detail;}
    else state.posthogDetail=null;
  }catch(error){if(active())state.posthogError=explain(error.message);}
}

export function posthogProjectView(){
  return `<div class="page-heading"><div><p class="eyebrow">Project settings</p><h1>PostHog</h1><p>${esc(state.websiteOrigin)} · Analytics and connections for this project.</p></div></div><div class="posthog-settings">${posthogPanel()}</div>`;
}
export function posthogPanel(){
  const data=state.posthogOrigin===state.websiteOrigin?state.posthog:null,connections=data?.connections||[],selected=connections.find(c=>c.connection_id===state.posthogSelected),detail=state.posthogDetail;
  return `<div class="settings-section-head"><h2 id="settings-section-title">PostHog journeys</h2><p>Analyze website events, discover recorded flows, and validate them in a test environment.</p></div>
  <section class="panel settings-card"><div class="settings-card-head"><div><h3>PostHog connections</h3><p>Connections belong to this Spekios project. Only its website events and sessions are imported. Your API key stays on the server.</p></div><button type="button" class="button primary" data-action="add-posthog" ${!data?.vault_ready||!data?.allowed_hosts?.length?'disabled':''}>Connect PostHog</button></div><div class="settings-card-body">
  ${state.posthogError?`<p role="alert" class="notice">${esc(state.posthogError)}</p>`:''}
  ${!data?'<p class="muted">Loading connections…</p>':!data.vault_ready?'<p class="notice">Secure connection storage needs to be enabled by your administrator.</p>':!data.allowed_hosts.length?'<p class="notice">Ask your administrator to configure the PostHog hosts this workspace can connect to.</p>':''}
  ${data?.worker_ready===false?'<p class="notice" role="status">The PostHog background worker is offline. Saved connections will import when it starts.</p>':''}
  ${connections.length?`<div class="posthog-connections">${connections.map(c=>`<button type="button" class="button ${c.connection_id===state.posthogSelected?'primary':''}" data-action="select-posthog" data-id="${esc(c.connection_id)}" aria-pressed="${c.connection_id===state.posthogSelected}">${esc(c.name)} · ${c.sessions} sessions</button>`).join('')}</div>`:'<p class="muted">Connect a website to see event analytics. Enable session recording in PostHog to discover journeys as well. Keep demo data in its own project.</p>'}
  </div></section>
  ${selected?`<section class="panel settings-card"><div class="settings-card-head"><div><h3>${esc(selected.name)}</h3><p>${esc(selected.source_origin)} · Project ${esc(selected.project_id)}</p></div><span class="pill">${!selected.enabled?'Paused':selected.error?'Needs attention':selected.syncing?'Importing':!selected.last_synced_at?'Waiting for import':'Connected'}</span></div><div class="settings-card-body"><p class="small muted">${esc(selected.host)} · Last full import: ${esc(when(selected.last_synced_at))} · ${selected.sessions} sessions · ${selected.workflows} discovered flows.</p>${selected.error?`<p class="notice" role="alert">${esc(explain(selected.error))}</p>`:''}<div class="row"><button type="button" class="button" data-action="posthog-sync" data-id="${esc(selected.connection_id)}">${selected.enabled?'Sync now':'Resume import'}</button>${selected.enabled?`<button type="button" class="button quiet" data-action="posthog-pause" data-id="${esc(selected.connection_id)}">Pause</button>`:''}<button type="button" class="button quiet" data-action="posthog-remove" data-id="${esc(selected.connection_id)}">Disconnect and delete imported data</button></div><p class="small muted">${selected.auto_replay?'New completed, executable journeys are validated automatically once.':'New journeys appear automatically. Start browser validation from a flow below.'} Recorded outcomes are inferred expectations; they do not establish correct product behavior.</p></div></section>
  ${detail?analyticsCard(selected,detail)+workflowCards(selected,detail,data):'<p class="muted">Loading recorded journeys…</p>'}`:''}`;
}
function analyticsCard(connection,detail){
  const a=detail.analysis,totals=a?.totals;
  const count=n=>Number(n||0).toLocaleString();
  const list=items=>items?.length?`<ul class="posthog-results">${items.map(item=>`<li><span>${esc(item.label)}</span><strong>${esc(count(item.count))}</strong></li>`).join('')}</ul>`:'<p class="muted">No events in this period.</p>';
  const days=[];
  if(a){const start=new Date(a.from);for(let i=0;i<7;i++){const date=new Date(start);date.setUTCDate(date.getUTCDate()+i);const key=date.toISOString().slice(0,10);days.push({date:key,events:a.daily.find(d=>d.date===key)?.events||0});}}
  const max=Math.max(1,...days.map(d=>d.events));
  return `<section class="panel settings-card"><div class="settings-card-head"><div><h3>Website analytics</h3><p>Last seven calendar days (UTC), for ${esc(connection.source_origin)} only. Synthetic visits are excluded.</p></div></div><div class="settings-card-body">
  ${detail.analysis_error?`<p class="notice" role="alert">Analysis refresh: ${esc(explain(detail.analysis_error))}. ${a?'Showing the last successful results.':'The worker will retry.'}</p>`:''}
  ${!a?'<p class="muted">Waiting for the first analysis. Event metrics do not require session recording.</p>':`<p class="small muted">Updated ${esc(when(detail.analysis_updated_at))}. Refreshes every five minutes.</p><dl class="posthog-metrics">${[['Events','events'],['Visitors','visitors'],['Sessions','sessions'],['Page views','pageviews'],['Exceptions','exceptions'],['Rage clicks','rageclicks'],['Dead clicks','deadclicks']].map(([label,key])=>`<div><dt>${label}</dt><dd>${esc(count(totals[key]))}</dd></div>`).join('')}</dl><h4>Daily events</h4><ul class="posthog-daily">${days.map(d=>`<li><span>${esc(d.date.slice(5))}</span><meter min="0" max="${max}" value="${Number(d.events)}" aria-label="Events on ${esc(d.date)}">${Number(d.events)}</meter><strong>${esc(count(d.events))}</strong></li>`).join('')}</ul><div class="posthog-breakdowns"><div><h4>Top events</h4>${list(a.top_events)}</div><div><h4>Top pages</h4>${list(a.top_pages)}</div></div>`}</div></section>`;
}
function workflowCards(connection,detail,data){
  const canReplay=connection.enabled&&data.replay_origins.includes(connection.replay_origin);
  return `<section class="panel settings-card"><div class="settings-card-head"><div><h3>Discovered flows</h3><p>Latest 30 flows. Equivalent recorded steps are grouped together.</p></div></div><div class="settings-card-body posthog-flows">${detail.workflows.length?detail.workflows.map(f=>`<details data-disclosure="posthog-${esc(f.workflow_id)}"><summary><strong>${esc(f.title)}</strong><span class="small muted">${f.sessions} session${f.sessions===1?'':'s'} · ${f.steps.length} steps · ${f.executable?'Ready to execute':'Needs information'}</span></summary><ol>${f.steps.map(s=>`<li><strong>${esc(s.action)}</strong> ${esc(s.label)}${s.action==='observe'?`<span class="small muted">Recorded observation: ${esc(s.value)}</span>`:''}</li>`).join('')}</ol>${f.issues.length?`<ul class="small muted">${f.issues.map(issue=>`<li>${esc(issue)}</li>`).join('')}</ul>`:''}<button type="button" class="button" data-action="posthog-replay" data-id="${esc(f.workflow_id)}" ${!f.executable||!canReplay?'disabled':''}>Replay in test browser</button>${!canReplay?'<p class="small muted">An administrator must allow this website as a resettable test environment before browser execution.</p>':''}</details>`).join(''):'<p class="muted">No flows imported yet. Use the connected website, finish a recorded session, then sync.</p>'}</div></section>
  <section class="panel settings-card"><div class="settings-card-head"><div><h3>Browser validations</h3><p>Latest 20 attempts. Runs use fresh browsers and never inherit a recorded user’s login.</p></div></div><div class="settings-card-body">${detail.replays.length?`<ul class="posthog-results">${detail.replays.map(r=>`<li><strong>${esc(r.status)}</strong> · ${esc(when(r.created_at))}${r.automatic?' · automatic':''}<span class="small muted">${r.result?.outcome==='matched_observations'?'Matched the recorded observations':r.result?.outcome==='steps_executed'?'Steps executed; no explicit outcome was recorded':esc(explain(r.result?.error)||'Waiting for the background worker')}${r.result?.steps?` · ${r.result.steps.length} steps completed`:''}</span></li>`).join('')}</ul>`:'<p class="muted">No browser validations yet.</p>'}</div></section>
  <section class="panel settings-card"><div class="settings-card-head"><div><h3>Imported sessions</h3><p>Latest 30 sessions; import starts with the last seven days.</p></div></div><div class="settings-card-body"><ul class="posthog-results">${detail.sessions.map(s=>`<li><strong>${esc(when(s.started_at))}</strong> · ${s.event_count} events · ${s.ongoing?'still recording':'completed'}<span class="small muted">Recording data: ${esc(explain(s.snapshot_status))}${s.issues?.length?' · '+esc(s.issues.map(explain).join(' ')):''}</span></li>`).join('')||'<li class="muted">Waiting for recordings from this website.</li>'}</ul></div></section>`;
}

export function openPostHogDialog(){
  if(document.getElementById('posthog-dialog'))return;
  const source=state.websiteOrigin,session=[state.token,state.developmentAccess,state.browserAuth];
  const data=state.posthog;if(!source||state.posthogOrigin!==source||!data?.allowed_hosts?.length)return;
  const dialog=document.createElement('dialog');dialog.id='posthog-dialog';dialog.className='provider-key-dialog';
  dialog.innerHTML=`<form><h2>Connect a PostHog website</h2><p class="small muted">Use the demo’s separate PostHog project, or a project you manage. Spekios verifies both read permissions before saving. Analysis and journey imports then run in the background.</p><label>Connection name<input name="name" required maxlength="60" autocomplete="off" placeholder="PostHog demo"></label><label>PostHog region<select name="host">${data.allowed_hosts.map(h=>`<option value="${esc(h)}">${esc(h)}</option>`).join('')}</select></label><label>PostHog project ID or dashboard URL<input name="project_id" required maxlength="256" placeholder="12345 or https://eu.posthog.com/project/12345" autocomplete="off"></label><label>Spekios project website<input name="source_origin" type="url" required readonly value="${esc(source)}"></label><p class="small muted">Fixed to this project. Connect each other website from its own project settings.</p><label>Test website origin (optional)<input name="replay_origin" type="url" placeholder="Defaults to recorded website" autocomplete="off"></label><p class="small muted">Use a test deployment with matching routes. Leave blank to replay against the recorded website.</p><p class="small muted">Create a dedicated read key in <a data-posthog-key-link href="${esc(data.allowed_hosts[0])}/settings/user-api-keys" target="_blank" rel="noopener noreferrer">PostHog account settings</a>. Give it query:read and session_recording:read, and restrict project access to this PostHog project.</p><label>Personal API key<input name="api_key" type="password" required minlength="8" maxlength="4096" autocomplete="off" spellcheck="false"></label><p class="small muted">Grant query:read and session_recording:read for this project. This is a private read key, separate from the public token installed on the website.</p><label class="row"><input name="auto_replay" type="checkbox" disabled> Automatically validate new completed journeys on this test website</label><p class="small muted" data-replay-hint>Automatic browser runs are available only for configured resettable test websites.</p><p role="alert" class="small error" data-error></p><div class="row"><button type="button" class="button" data-close>Cancel</button><button type="submit" class="button primary">Verify and connect</button></div></form>`;
  dialog.querySelector('[name="host"]').addEventListener('change',event=>{dialog.querySelector('[data-posthog-key-link]').href=event.target.value+'/settings/user-api-keys';});
  const opener=document.activeElement,secret=dialog.querySelector('[name="api_key"]');
  const close=()=>{secret.value='';dialog.close();dialog.remove();opener?.focus?.();};
  dialog.querySelector('[data-close]').addEventListener('click',close);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  const updateReplay=()=>{let origin='';try{const url=new URL(dialog.querySelector('[name="replay_origin"]').value||dialog.querySelector('[name="source_origin"]').value);if(url.pathname==='/'&&!url.search&&!url.hash)origin=url.origin;}catch{}const checkbox=dialog.querySelector('[name="auto_replay"]');checkbox.disabled=!data.replay_origins.includes(origin);if(checkbox.disabled)checkbox.checked=false;};
  for(const fieldName of ['source_origin','replay_origin'])dialog.querySelector(`[name="${fieldName}"]`).addEventListener('input',updateReplay);
  dialog.querySelector('form').addEventListener('submit',async event=>{
    event.preventDefault();const form=new FormData(event.target),body={name:String(form.get('name')).trim(),host:form.get('host'),project_id:form.get('project_id'),source_origin:source,api_key:form.get('api_key'),replay_origin:String(form.get('replay_origin')||'').trim()||null,auto_replay:form.has('auto_replay')};
    try{if(!/^[0-9]{1,20}$/.test(body.project_id)){const url=new URL(body.project_id),match=url.pathname.match(/^\/project\/([0-9]{1,20})(?:\/|$)/);if(url.origin!==body.host||!match)throw new Error();body.project_id=match[1];}}catch{dialog.querySelector('[data-error]').textContent='Enter a numeric project ID or a dashboard URL from the selected PostHog region.';body.api_key='';return;}
    if(String(body.api_key).startsWith('phc_')){dialog.querySelector('[data-error]').textContent=explain('posthog_private_key_required');body.api_key='';return;}
    secret.value='';form.delete('api_key');dialog.querySelectorAll('button').forEach(b=>b.disabled=true);dialog.querySelector('[data-error]').textContent='Checking project access and read permissions…';
    try{const response=await api(posthogBase(source),body),created=await response.json();if(source!==state.websiteOrigin||!sameSession(session)){close();return;}state.posthogSelected=created.connection_id;state.posthogDetail=null;close();await loadPostHog();render();toast('PostHog connected. Background import is queued.');}
    catch(error){dialog.querySelector('[data-error]').textContent=explain(error.message);dialog.querySelectorAll('button').forEach(b=>b.disabled=false);}
    finally{body.api_key='';}
  });
  updateReplay();document.body.append(dialog);dialog.showModal();dialog.querySelector('[name="name"]').focus();
}
export async function posthogAction(action,id){
  const source=state.websiteOrigin;if(!source)return;
  try{
    if(action==='select'){state.posthogSelected=id;state.posthogDetail=null;render();}
    else if(action==='replay')await api(`${posthogBase(source)}/${state.posthogSelected}/workflows/${id}/replay`,{});
    else await api(`${posthogBase(source)}/${id}/${action}`,{});
    await loadPostHog();render();
    if(action==='replay')toast('Browser validation queued.');
  }catch(error){toast(explain(error.message));}
}
