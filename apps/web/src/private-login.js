// Live private sign-in for protected test apps. Never recorded as evidence or sent to a model.
import {toast} from '/assets/ui/components.js';
import {esc} from '/assets/ui/format.js';
import {api} from './api.js';
import {refresh} from './app.js';
import {state} from './state.js';
// This live view is deliberately separate from imageCache and recorded evidence.
export let privateLogin=null,privateFrame=null,privateFrameUrl=null,privateTimer=null,privateBusy=false;
async function privateRequest(action,body){
  const login=privateLogin;if(!login)throw new Error('Login window is closed.');
  const response=await api(`/v1/browser-access/${login.id}/${action}`,body,{'X-Spekios-Access-Lease':login.lease});
  if(privateLogin!==login)throw new Error('Login window is closed.');return response;
}
function privateStatus(message){const node=document.getElementById('private-status');if(node)node.textContent=message;}
async function privateScreen(){
  clearTimeout(privateTimer);if(!privateLogin||(privateBusy&&!privateLogin.accountCreating))return;
  const login=privateLogin;
  try{
    if(login.accountCreating){
      const access=await (await api('/v1/browser-access')).json();await syncPrivateAccess(access.requests);
      if(privateLogin!==login)return;
    }
    const response=await privateRequest('screen');const blob=await response.blob();
    if(privateLogin!==login)return;
    const frame=response.headers.get('x-scout-frame-id'),url=URL.createObjectURL(blob),image=document.getElementById('private-screen');
    if(!image){URL.revokeObjectURL(url);return;}
    const previous=privateFrameUrl;privateFrameUrl=url;privateFrame=frame;image.src=url;
    if(previous)URL.revokeObjectURL(previous);
  }catch(error){
    if(['access not found','access closed','lease required'].includes(error.message)){
      if(login.accountCredentials){const access=await (await api('/v1/browser-access')).json();await syncPrivateAccess(access.requests);if(privateLogin!==login){void refresh();return;}}
      await closePrivateLogin(false);toast('The private login session has ended.');void refresh();return;
    }
    privateStatus(error.message);
  }
  if(privateLogin===login)privateTimer=setTimeout(privateScreen,1500);
}
async function privateInput(input){
  if(privateBusy||!privateLogin)return;privateBusy=true;clearTimeout(privateTimer);
  try{await privateRequest('input',{input_id:crypto.randomUUID(),...input});privateStatus('Input sent to the test browser.');}
  catch(error){privateStatus(error.message==='stale frame'?'The view changed. Click the field again.':error.message==='not editable'?'Click an input field in the app image first.':error.message);}
  finally{privateBusy=false;if(privateLogin)void privateScreen();}
}
function downloadAccount(account){
  const url=URL.createObjectURL(new Blob([JSON.stringify(account,null,2)+'\n'],{type:'application/json'})),a=document.createElement('a');
  a.href=url;a.download='spekios-test-account.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function accountNotice(account){
  const box=document.getElementById('private-login');
  box.innerHTML=`<div class="private-backdrop"><section class="private-dialog" role="dialog" aria-modal="true" aria-labelledby="private-title"><div class="private-body"><h2 id="private-title">Test account ready</h2><p>The run is continuing with the new account for ${esc(account.email)}.</p><p>Download its generated credentials before closing this window.</p><div class="private-controls"><button class="button primary" data-account="download">Download account details</button><button class="button" data-account="close">Close</button></div></div></section></div>`;
  box.onclick=e=>{const action=e.target.closest('[data-account]')?.dataset.account;if(action==='download')downloadAccount(account);if(action==='close'){box.replaceChildren();box.onclick=null;}};
  box.querySelector('button')?.focus();
}
function accountBusy(busy){
  const box=document.getElementById('private-login');
  for(const button of box.querySelectorAll('[data-private]'))if(!['cancel','download-account'].includes(button.dataset.private))button.disabled=busy;
  for(const control of box.querySelectorAll('#private-text-form input,#private-text-form button,#private-remember'))control.disabled=busy;
}
export async function syncPrivateAccess(requests){
  const login=privateLogin;if(!login)return;
  const row=(requests||[]).find(a=>a.access_id===login.id);
  if(row&&['waiting','active'].includes(row.status)){
    if(login.accountRequest&&row.verification?.startsWith('account_creation_help_')){
      login.accountCreating=false;privateBusy=false;
      accountBusy(false);
      const messages={verification_required:'Email verification, phone verification or a CAPTCHA needs your help. Complete it in the private browser, then continue testing.',signup_not_found:'No supported sign-up form was found. You can create the account in the private browser.',signup_not_completed:'The sign-up form did not complete. Check the private browser before continuing.',unsupported_signup:'This sign-up flow needs your help. Complete it in the private browser.'};
      privateStatus(messages[row.verification.slice('account_creation_help_'.length)]||messages.unsupported_signup);
    }
    return;
  }
  const account=login.accountCredentials;
  await closePrivateLogin(false);
  if(row?.status==='completed'&&account)accountNotice(account);
}
export async function openPrivateLogin(id,createAccount=false){
  if(privateLogin)return;
  try{
    const runId=state.access.requests.find(a=>a.access_id===id)?.run_id;
    if(!runId)throw new Error('Refresh the workspace to reopen this login.');
    const identity=createAccount&&state.browserAuth?await (await api('/v1/browser-access/account-identity')).json():null;
    const response=await (await api(`/v1/browser-access/${id}/start`,{client_id:crypto.randomUUID()})).json();
    privateLogin={id,runId,lease:response.lease};
    const box=document.getElementById('private-login');
    box.innerHTML=`<div class="private-backdrop"><section class="private-dialog" role="dialog" aria-modal="true" aria-labelledby="private-title"><div class="drawer-head"><div><h2 id="private-title">Sign in to your test app</h2><p class="small muted">Live private view · not recorded · Spekios is paused</p></div><button class="button" data-private="cancel">Cancel run</button></div><div class="private-body"><p>Click a field in the image, then type or paste into the box below. Use Tab and Enter to move through the login form. Complete any verification code yourself.</p><img id="private-screen" alt="Live view of your private test browser" tabindex="0"><div class="private-controls"><button class="button" data-private="key" data-key="Shift+Tab">Previous field</button><button class="button" data-private="key" data-key="Tab">Next field</button><button class="button" data-private="key" data-key="Enter">Enter</button><button class="button" data-private="key" data-key="Backspace">Backspace</button><button class="button" data-private="scroll" data-direction="up">Scroll up</button><button class="button" data-private="scroll" data-direction="down">Scroll down</button></div><form id="private-text-form"><label for="private-text">Type into the selected field</label><div class="private-controls"><input id="private-text" type="password" maxlength="2048" autocomplete="off" placeholder="Text is sent only to this test browser"><button class="button" type="submit">Send text</button></div></form><p id="private-status" role="status">Opening the private browser…</p><label class="private-remember"><input id="private-remember" type="checkbox"> Save this app session on this machine for 24 hours</label><div class="private-controls"><button class="button primary" data-private="complete">I'm signed in · continue testing</button><span class="small muted">Google and external provider login are not supported yet.</span></div></div></section></div>`;
    if(createAccount){
      document.getElementById('private-title').textContent='Create a test account';
      box.querySelector('.private-body').insertAdjacentHTML('afterbegin',`<form id="private-account-form"><p>Spekios will try to create its own test account with a generated password. ${identity?.source==='lovable'&&identity.email?'The email comes from your connected Spekios account. Review it or use a dedicated test email before creating an account on this site.':'Use a dedicated test email you can access.'}</p><label for="private-account-email">Test email</label><input id="private-account-email" type="email" required maxlength="254" autocomplete="off"><label for="private-account-name">Account name</label><input id="private-account-name" required maxlength="80" value="Spekios QA" autocomplete="off"><div class="private-controls"><button class="button primary" type="submit">Try creating an account</button><button class="button" type="button" data-private="download-account" hidden>Download account details</button></div></form>`);
      if(identity?.source==='lovable'&&typeof identity.email==='string')document.getElementById('private-account-email').value=identity.email;
    }
    box.onclick=async e=>{
      if(e.target.id==='private-screen'){
        const image=e.target,r=image.getBoundingClientRect();if(!privateFrame)return;
        await privateInput({type:'click',frame_id:privateFrame,x:(e.clientX-r.left)*image.naturalWidth/r.width,y:(e.clientY-r.top)*image.naturalHeight/r.height});return;
      }
      const button=e.target.closest('[data-private]');if(!button)return;
      if(button.dataset.private==='download-account'&&privateLogin?.accountCredentials)downloadAccount(privateLogin.accountCredentials);
      if(button.dataset.private==='cancel'){try{await closePrivateLogin(true);await refresh();}catch(error){privateStatus(error.message);if(privateLogin)void privateScreen();}}
      if(button.dataset.private==='key')await privateInput({type:'key',key:button.dataset.key});
      if(button.dataset.private==='scroll')await privateInput({type:'scroll',direction:button.dataset.direction});
      if(button.dataset.private==='complete'&&!privateBusy){
        privateBusy=true;clearTimeout(privateTimer);
        try{await privateRequest('complete',{remember:document.getElementById('private-remember').checked});const account=privateLogin?.accountCredentials;await closePrivateLogin(false);if(account)accountNotice(account);toast('App access checked. Exploration is continuing.');await refresh();}
        catch(error){privateStatus(error.message==='login not complete'?'Sign-in is not complete. Finish the app login, then try again.':error.message);}
        finally{privateBusy=false;if(privateLogin)void privateScreen();}
      }
    };
    box.onsubmit=async e=>{
      if(e.target.id==='private-account-form'){
        e.preventDefault();if(privateBusy||!privateLogin)return;
        const login=privateLogin;
        login.accountRequest??={attempt_id:crypto.randomUUID(),email:document.getElementById('private-account-email').value.trim(),name:document.getElementById('private-account-name').value.trim(),remember:document.getElementById('private-remember').checked};
        for(const input of e.target.querySelectorAll('input'))input.readOnly=true;
        privateBusy=true;clearTimeout(privateTimer);privateStatus('Creating a test account…');
        try{
          const result=await (await privateRequest('create-account',login.accountRequest)).json();
          login.accountCredentials=result.account;login.accountCreating=result.status==='creating';
          e.target.querySelector('[type="submit"]').disabled=true;
          e.target.querySelector('[data-private="download-account"]').hidden=false;
          accountBusy(login.accountCreating);
          privateBusy=login.accountCreating;
        }catch(error){privateBusy=false;privateStatus('The account request could not be confirmed. Retrying uses the same account details. '+error.message);}
        if(privateLogin===login)void privateScreen();return;
      }
      if(e.target.id!=='private-text-form')return;e.preventDefault();const input=document.getElementById('private-text'),value=input.value;input.value='';if(value)await privateInput({type:'text',value});
    };
    box.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();privateStatus('Use Cancel run to close this private session.');}if(e.target.id==='private-screen'&&['Tab','Enter','Backspace','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();void privateInput({type:'key',key:e.shiftKey&&e.key==='Tab'?'Shift+Tab':e.key});}};
    document.getElementById('private-screen').focus();void privateScreen();
  }catch(error){toast(error.message);}
}
export async function closePrivateLogin(cancel){
  clearTimeout(privateTimer);
  if(cancel&&privateLogin)await api('/v1/runs/'+privateLogin.runId+'/cancel',{});
  privateLogin=null;privateFrame=null;privateBusy=false;
  if(privateFrameUrl)URL.revokeObjectURL(privateFrameUrl);privateFrameUrl=null;
  const box=document.getElementById('private-login');if(box){box.replaceChildren();box.onclick=null;box.onsubmit=null;box.onkeydown=null;}
}
