// Markup helpers shared by both apps. Values pass through esc() before they reach HTML.
// stat() skips that for the note only when options.html is set, and the note is already safe markup.
import {esc} from './format.js';
export const icon = key => `<svg aria-hidden="true" viewBox="0 0 24 24">${{
  scout:'<circle cx="12" cy="12" r="7"/><path d="M12 2v5m0 10v5M2 12h5m10 0h5"/><circle cx="12" cy="12" r="1"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  pulse:'<path d="M2 12h5l3-8 4 16 3-8h5"/>',search:'<circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/>',
  arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',chevron:'<path d="m9 5 7 7-7 7"/>',
  globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18"/>',
  play:'<path d="m8 4 12 8-12 8Z"/>',bug:'<path d="M9 7V5l-2-2m8 4V5l2-2M4 10h3m10 0h3M4 17l3-2m10 0 3 2M12 8v12"/><rect x="7" y="7" width="10" height="13" rx="5"/>',
  image:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
  flow:'<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M6 9v9h9m3-9V6H9"/>',
  check:'<path d="m5 12 4 4L19 6"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
  bolt:'<path d="m13 2-9 12h7l-1 8 10-12h-7Z"/>',refresh:'<path d="M20 9a8 8 0 1 0 0 6M20 3v6h-6"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',logout:'<path d="M10 3H4v18h6m-1-9h12m-4-4 4 4-4 4"/>',
  code:'<path d="m8 5-7 7 7 7m8-14 7 7-7 7m-3-14-2 14"/>',database:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',settings:'<path d="M4 6h10m4 0h2M4 12h4m4 0h8M4 18h12m4 0h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',layers:'<path d="m12 3 10 6-10 6L2 9Zm-9 11 9 5 9-5M3 18l9 5 9-5"/>',plus:'<path d="M12 5v14M5 12h14"/>',
}[key]||''}</svg>`;
export function pill(value) {
  const map={cancelling:['Stopping…','amber'],completed:['Completed','green'],active:['Running','blue'],running:['Running','blue'],queued:['Queued',''],failed:['Failed','red'],interrupted:['Interrupted','amber'],blocked:['Needs access','amber'],cancelled:['Cancelled',''],waiting:['Needs sign-in','amber'],no_issue_observed:['No issue observed','green'],suspect:['Needs review','amber'],inconclusive:['Inconclusive',''],reproduced:['Reproduced','amber'],not_reproduced:['Not reproduced','green'],prepared:['Preparing',''],dispatched:['Executing','blue'],skipped:['Replanned before acting','amber'],evidence_failed:['Evidence gap','red'],available:['Available','green'],online:['Online','green']};
  const [label,color]=map[value]||[value||'Not assessed',''];return `<span class="pill ${color}">${esc(label)}</span>`;
}
export const stat = (label,value,note,key,options={}) => `<div class="stat"><div class="stat-label">${esc(label)}${icon(key)}</div><div class="stat-value">${esc(value)}</div><div class="stat-note">${options.html?note:esc(note)}</div></div>`;
export const empty = (title,description,key='layers') => `<div class="empty">${icon(key)}<h3>${esc(title)}</h3><p>${esc(description)}</p></div>`;
export const json = value => `<pre class="json">${esc(JSON.stringify(value,null,2))}</pre>`;
export const button = (action,label,key='',extra='') => `<button class="button" data-action="${action}" ${extra}>${key?icon(key):''}${esc(label)}</button>`;
export function kv(key,value){return `<div class="key-value"><span>${esc(key)}</span><span>${esc(value)}</span></div>`;}
let toastTimer;
export function toast(message){const node=document.querySelector('#toast');node.textContent=message;node.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.classList.remove('visible'),4500);}
