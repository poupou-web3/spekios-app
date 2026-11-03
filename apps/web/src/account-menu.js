// The account menu (top right) shared by the workspace and the separately served customer pages:
// who is signed in, whether tests can run, appearance, pop-up notifications and sign-out.
import {icon} from '/assets/ui/components.js';
import {esc} from '/assets/ui/format.js';
import {themeSwitch} from '/assets/ui/theme.js';
import {notificationsEnabled} from './notifications.js';

export function accountMenuMarkup({name='',development=false,browserAuth=false,worker=null,gateway=null,external=false}={}){
  const label=name||'Your workspace',initial=(label.trim()[0]||'S').toUpperCase();
  const how=development?'Local development · sign-in disabled':browserAuth?'Signed in with your Spekios account':'Signed in with the workspace token';
  // Unknown status (not loaded yet) is left out rather than shown as a problem.
  const status=(ready,text,on,off)=>ready==null?'':`<li><i class="dot ${ready?'green':'amber'}" aria-hidden="true"></i><span>${text}</span><span class="small muted">${ready?on:off}</span></li>`;
  const rows=status(worker,'Browser worker','Online','Offline')+status(gateway,'Model gateway','Ready','Not ready');
  return `<details class="account-menu" data-disclosure="account-menu"><summary class="avatar" aria-label="Account and workspace: ${esc(label)}">${esc(initial)}</summary><div class="account-panel"><div class="account-head"><span class="avatar" aria-hidden="true">${esc(initial)}</span><div><strong>${esc(label)}</strong><span class="small muted">${esc(how)}</span></div></div>${rows?`<ul class="account-status" aria-label="Workspace status">${rows}</ul>`:''}<div class="account-row"><span>Theme</span>${themeSwitch()}</div><label class="account-row account-toggle"><span>Pop-up notifications<span class="small muted">New findings, finished and stopped tests, sign-in requests</span></span><input id="notifications-toggle" type="checkbox" ${notificationsEnabled()?'checked':''}></label><nav class="account-links" aria-label="Account"><a href="/settings">${icon('settings')}Workspace settings</a><a href="/connect">${icon('code')}Connect your agent</a></nav>${development?'':`<button type="button" class="account-signout" data-action="logout">${icon('logout')}Sign out</button>`}</div></details>`;
}
