// Ordered runtime events for the selected run.
import {empty,icon,json} from '/assets/ui/components.js';
import {date,esc,short} from '/assets/ui/format.js';
import {state} from '../state.js';
export function eventsView(){
  if(!state.report)return empty('Choose a run','Select a run above to inspect its ordered execution events.','code');
  const all=state.report.events||[],search=String(state.eventSearch||'').toLowerCase(),events=all.filter(e=>[e.event_type,e.action_id,e.event_id,e.seq].join(' ').toLowerCase().includes(search));
  return `<section class="panel"><div class="panel-header"><div><h2>Execution event log <span class="small muted">${events.length} of ${all.length} events</span></h2><p class="small muted">Ordered runtime events for ${esc(short(state.report.run?.run_id))}. Provider request and response details are in Model calls.</p></div><label class="search">${icon('search')}<span class="sr-only">Filter events</span><input id="event-search" placeholder="Filter type, sequence or ID…" value="${esc(state.eventSearch||'')}"></label></div><div class="event-list">${events.map(e=>`<details class="event" data-event="${esc(e.event_id)}" ${state.expanded.has(e.event_id)?'open':''}><summary><span class="mono">#${esc(e.seq)}</span><strong>${esc(e.event_type)}</strong><time>${esc(date(e.occurred_at))}</time>${icon('chevron')}</summary>${e.action_id?`<p class="small">Action <span class="mono">${esc(e.action_id)}</span></p>`:''}${json(e)}</details>`).join('')||empty(all.length?'No matching events':'No execution events',all.length?'Try another event type, sequence or ID.':'This run has no recorded runtime events in the current report.','code')}</div></section>`;
}
