// Live service logs: every container's output from ClickHouse, newest at the bottom.
import {button,empty,icon,json} from '/assets/ui/components.js';
import {esc,number,short} from '/assets/ui/format.js';
import {get} from '../api.js';
import {render} from '../app.js';
import {state} from '../state.js';

export const LOG_LEVELS=[['debug','Debug and above'],['info','Info and above'],['warning','Warnings and errors'],['error','Errors only']];
// Lines kept in the browser; older ones stay in ClickHouse behind "Load older".
export const MAX_LOG_ROWS=1500;
const PAGE=300;
// Shown inline in a row's summary, in this order, when the line carries them.
const SUMMARY=['provider','model','endpoint','method','route','path','status','http_status','state','elapsed_ms','input_tokens','output_tokens','kind','verdict','error','job_id','run_id','request_id','action_id','attempt'];

export function freshLogs(previous={}){
  return {rows:[],ids:new Set(),cursor:null,services:previous.services||[],exclude:previous.exclude||new Set(),level:previous.level||'info',q:previous.q||'',
    runOnly:previous.runOnly||false,live:previous.live??true,follow:true,loading:false,error:'',hasOlder:false,expanded:new Set(),generation:(previous.generation||0)+1,
    checkedAt:null,retention:previous.retention||14,started:false,unseen:0,cleared:null};
}

// state.logs holds the Logs tab: lines, cursor and filters. Filters carry over when it is reset.
state.logs=freshLogs();

// Adds lines by log_id, keeps them ordered by time and drops the oldest past the cap.
export function mergeLogs(rows,incoming,ids,max=MAX_LOG_ROWS){
  let added=0;
  for(const row of incoming||[]){if(!row?.log_id||ids.has(row.log_id))continue;ids.add(row.log_id);rows.push(row);added++;}
  if(!added)return {rows,added,trimmed:0};
  rows.sort((a,b)=>a.ts<b.ts?-1:a.ts>b.ts?1:a.log_id<b.log_id?-1:a.log_id>b.log_id?1:0);
  const trimmed=Math.max(0,rows.length-max);
  for(const row of rows.splice(0,trimmed))ids.delete(row.log_id);
  return {rows,added,trimmed};
}

export function logQuery(logs,runId,extra={}){
  const params=new URLSearchParams({level:logs.level,limit:String(PAGE)});
  if(logs.exclude.size)params.set('exclude',[...logs.exclude].sort().join(','));
  if(logs.q.trim())params.set('q',logs.q.trim());
  if(logs.runOnly&&runId)params.set('run_id',runId);
  for(const [key,value] of Object.entries(extra))params.set(key,value);
  return '/v1/admin/logs?'+params;
}

function stale(generation){return generation!==state.logs.generation;}
function failed(error){
  state.logs.error=error.status===403?'Operator access is required to read service logs.':error.code==='logs_unavailable'
    ?'Logs are unavailable. Check that the log-collector service is running and the ClickHouse schema is applied.':error.message||'Logs could not be loaded.';
}

// Newest page for the current filters; the tail continues from its cursor.
export async function loadLogs(){
  state.logs=freshLogs(state.logs);
  const logs=state.logs,generation=logs.generation;logs.started=true;logs.loading=true;render();
  try{
    const page=await get(logQuery(logs,state.runId));
    if(stale(generation))return;
    mergeLogs(logs.rows,page.logs,logs.ids);
    Object.assign(logs,{cursor:page.cursor,hasOlder:!!page.has_more,services:page.services||logs.services,retention:page.retention_days||logs.retention,checkedAt:new Date().toISOString()});
  }catch(error){if(!stale(generation))failed(error);}
  finally{if(!stale(generation)){logs.loading=false;render();}}
}

let polling=false;
export async function pollLogs(){
  const logs=state.logs;
  if(polling||logs.loading||!logs.cursor||!logs.live)return;
  polling=true;const generation=logs.generation;let added=0;
  try{
    // A burst can fill several pages; drain them before the next tick.
    for(let page=0;page<5;page++){
      const next=await get(logQuery(logs,state.runId,{after:logs.cursor}));
      if(stale(generation))return;
      const merged=mergeLogs(logs.rows,next.logs,logs.ids);added+=merged.added;
      if(merged.trimmed)logs.hasOlder=true;
      logs.cursor=next.cursor;
      if(!next.has_more)break;
    }
    logs.error='';logs.checkedAt=new Date().toISOString();
  }catch(error){if(!stale(generation))failed(error);}
  finally{polling=false;}
  if(stale(generation))return;
  if(!logs.follow)logs.unseen+=added;
  // Re-rendering would clear a text selection inside the list; wait for it to end.
  if(!selectingLogs())render();
}

export async function olderLogs(){
  const logs=state.logs,oldest=logs.rows[0];
  if(!oldest||logs.loading)return;
  const generation=logs.generation;logs.loading=true;logs.follow=false;render();
  try{
    const page=await get(logQuery(logs,state.runId,{before:oldest.ts}));
    if(stale(generation))return;
    // Older lines go on top; keep the newest when the cap is reached.
    const kept=logs.rows.length;mergeLogs(logs.rows,page.logs,logs.ids,Math.max(MAX_LOG_ROWS,kept+PAGE));
    logs.hasOlder=!!page.has_more;
  }catch(error){if(!stale(generation))failed(error);}
  finally{if(!stale(generation)){logs.loading=false;render();}}
}

export function selectingLogs(){
  const selection=globalThis.getSelection?.();
  return !!(selection&&!selection.isCollapsed&&selection.anchorNode?.parentElement?.closest?.('.log-list'));
}

const pad=(n,width=2)=>String(n).padStart(width,'0');
export function stamp(ts){
  const d=new Date(String(ts||'').slice(0,23)+'Z');
  if(Number.isNaN(d.getTime()))return {date:'',time:String(ts||'')};
  return {date:`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`,time:`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(),3)}`};
}

function inline(value,key){
  const text=typeof value==='object'?JSON.stringify(value):String(value);
  return /_id$/.test(key)&&/^[0-9a-f-]{36}$/.test(text)?short(text):text.length>80?text.slice(0,79)+'…':text;
}
export function summary(row){
  const fields=row.fields&&typeof row.fields==='object'?row.fields:null;
  if(!fields)return `<span class="log-text">${esc(row.message)}</span>`;
  const keys=[...SUMMARY.filter(key=>key in fields),...Object.keys(fields).filter(key=>!SUMMARY.includes(key))].slice(0,9);
  return `<strong class="log-text">${esc(row.message)}</strong>${keys.map(key=>`<span class="log-kv"><span>${esc(key)}=</span>${esc(inline(fields[key],key))}</span>`).join('')}`;
}

function detail(row){
  const at=stamp(row.ts);
  return `<div class="log-detail"><div class="log-facts"><span>UTC <span class="mono">${esc(row.ts)}</span></span><span>Local ${esc(at.date)} ${esc(at.time)}</span><span>${esc(row.replica||row.service)} · ${esc(row.stream)}</span>${row.request_id?`<span>Request <span class="mono">${esc(row.request_id)}</span></span>`:''}</div>${row.run_id?`<div class="log-actions">${button('log-run','Only this run\'s logs','search',`data-run="${esc(row.run_id)}"`)}<a class="button" href="#/models/${esc(row.run_id)}">Model calls for run ${esc(short(row.run_id))} ${icon('arrow')}</a></div>`:''}${row.fields?json(row.fields):`<pre class="json">${esc(row.message)}</pre>`}</div>`;
}

function rowView(row){
  const at=stamp(row.ts),level=['debug','info','warning','error'].includes(row.level)?row.level:'info';
  return `<details class="log-row ${level}" data-log="${esc(row.log_id)}" ${state.logs.expanded.has(row.log_id)?'open':''}><summary><time datetime="${esc(row.ts)}" title="${esc(row.ts)} UTC"><span class="log-date">${esc(at.date)} </span>${esc(at.time)}</time><span class="log-level">${esc(level==='warning'?'warn':level)}</span><span class="log-service" title="${esc(row.replica||row.service)}">${esc(row.service)}</span><span class="log-message">${summary(row)}</span></summary>${detail(row)}</details>`;
}

function status(logs){
  if(logs.loading&&!logs.rows.length)return 'Loading logs…';
  const parts=[`${number(logs.rows.length)} lines in view`,`kept ${logs.retention} days`];
  if(logs.live)parts.unshift(logs.checkedAt?`Live · checked ${stamp(logs.checkedAt).time.slice(0,8)}`:'Live');
  else parts.unshift('Paused');
  return parts.join(' · ');
}

export function logsView(){
  const logs=state.logs,run=state.runId;
  const services=[...new Set([...logs.services.map(s=>s.service),...logs.exclude])].sort();
  const chips=services.map(name=>{const on=!logs.exclude.has(name),seen=logs.services.find(s=>s.service===name);return `<button class="log-chip ${on?'on':''}" data-action="log-service" data-service="${esc(name)}" aria-pressed="${on}" title="${seen?`${number(seen.lines)} lines in the last 24 hours`:'No lines in the last 24 hours'}">${esc(name)}</button>`;}).join('');
  let body;
  if(logs.error&&!logs.rows.length)body=empty('Logs unavailable',logs.error,'info');
  else if(!logs.rows.length&&logs.cleared)body=empty('View cleared',`Cleared at ${stamp(logs.cleared).time.slice(0,8)}. New lines appear here as they arrive.`,'code');
  else if(!logs.rows.length&&!logs.loading)body=logs.services.length||logs.q||logs.exclude.size||logs.runOnly
    ?empty('No matching lines','Nothing in the retained logs matches these filters. Lower the level, clear the search or include more services.','search')
    :empty('No logs collected yet','No container output reached ClickHouse in the last 24 hours. Start the collector with docker compose up -d log-socket log-collector.','code');
  else body=`${logs.hasOlder?`<div class="log-older">${button('log-older',logs.loading?'Loading…':'Load older lines','refresh',logs.loading?'disabled':'')}</div>`:''}${logs.rows.map(rowView).join('')}`;
  return `<section class="panel logs-panel"><div class="panel-header"><div><h2>Service logs</h2><p class="small muted">Every container's stdout and stderr, as logged, newest at the bottom. Scout lines are structured; prompts, model output and credentials are never logged.</p></div><button class="button ${logs.live?'primary':''}" data-action="log-live" aria-pressed="${logs.live}">${icon(logs.live?'pulse':'play')}${logs.live?'Live':'Paused'}</button></div><div class="queue-toolbar log-toolbar"><label class="search">${icon('search')}<span class="sr-only">Search logs</span><input id="log-search" placeholder="Search message or fields…" value="${esc(logs.q)}" autocomplete="off"></label><label class="small muted">Level <select id="log-level">${LOG_LEVELS.map(([value,label])=>`<option value="${value}" ${logs.level===value?'selected':''}>${label}</option>`).join('')}</select></label><label class="small muted log-run-filter"><input type="checkbox" id="log-run-only" ${logs.runOnly&&run?'checked':''} ${run?'':'disabled'}> ${run?`Only run ${esc(short(run))}`:'Pick a run above to filter by it'}</label>${button('log-clear','Clear view','close')}</div>${services.length?`<div class="log-services" aria-label="Services">${chips}</div>`:''}<div class="log-status small muted" role="status">${esc(status(logs))}${logs.error&&logs.rows.length?` · <span class="log-error">${esc(logs.error)}</span>`:''}</div><div class="log-list" role="log" aria-live="off" tabindex="0">${body}</div>${!logs.follow&&logs.rows.length?`<div class="log-jump">${button('log-latest',logs.unseen?`${number(logs.unseen)} new lines · jump to latest`:'Jump to latest','arrow')}</div>`:''}</section>`;
}
