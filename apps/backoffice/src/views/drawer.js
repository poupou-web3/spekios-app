// Side drawer for raw job records and model call details.
import {icon,json} from '/assets/ui/components.js';
import {esc} from '/assets/ui/format.js';
import {state} from '../state.js';
import {modelDrawer} from './models.js';
export function drawer(){
  const d=state.drawer;if(!d)return '';
  let body=d.loading?'<div class="loading">Loading request…</div>':d.error?`<div class="notice error">${esc(d.error)}</div>`:d.raw?json(d.raw):'';
  if(d.model)body=modelDrawer(d.model);
  return `<div class="drawer-backdrop" data-action="close-drawer"><section class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title"><div class="drawer-head"><h2 id="drawer-title">${esc(d.title||'Execution details')}</h2><button class="button icon" data-action="close-drawer" aria-label="Close details">${icon('close')}</button></div><div class="drawer-body">${body}</div></section></div>`;
}
