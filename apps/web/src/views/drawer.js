// Side drawer for raw records, full-resolution evidence and report export.
import {button,icon,json} from '/assets/ui/components.js';
import {esc} from '/assets/ui/format.js';
import {state} from '../state.js';
import {exportView} from './export.js';
export function drawer(){
  const d=state.drawer;if(!d)return '';
  let body=d.loading?'<div class="loading">Loading request…</div>':d.error?`<div class="notice error">${esc(d.error)}</div>`:d.raw?json(d.raw):'';
  if(d.export)body=exportView(d.export);
  if(d.image)body=`<p class="small muted">${esc(d.image.alt)}. The original PNG remains unchanged.</p><div class="row evidence-tools">${button('image-scale',d.image.fit?'View actual pixels':'Fit to panel','image')}<span class="pill">${d.image.fit?'Fit to panel':'Actual pixels · 100%'}</span></div><div class="evidence-canvas ${d.image.fit?'fit-resolution':'native-resolution'}" data-image-path="${esc(d.image.path)}" data-alt="${esc(d.image.alt)}" tabindex="0" role="region" aria-label="Scrollable screenshot"><span class="loading">Loading recorded image…</span></div>`;
  return `<div class="drawer-backdrop" data-action="close-drawer"><section class="drawer ${d.image?'evidence-drawer':''}" role="dialog" aria-modal="true" aria-labelledby="drawer-title"><div class="drawer-head"><h2 id="drawer-title">${esc(d.title||'Execution details')}</h2><button class="button icon" data-action="close-drawer" aria-label="Close details">${icon('close')}</button></div><div class="drawer-body">${body}</div></section></div>`;
}
