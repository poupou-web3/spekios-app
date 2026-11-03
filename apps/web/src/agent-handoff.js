// A frozen preview of the exact description supplied to API agents. App text
// stays text; background refreshes never replace the open dialog's contents.
export function closeAgentHandoff(){const d=document.getElementById?.('agent-handoff-dialog');if(d){d.close?.();d.remove?.();}}
export function showAgentHandoff(packet,{title='Finding for your agent',revision}={}){
  const description=packet?.agent_description;
  if(description?.format!=='text/markdown'||typeof description.text!=='string'||!description.text.trim())throw new Error('The API description is unavailable. Refresh the finding and try again.');
  closeAgentHandoff();const opener=document.activeElement,d=document.createElement('dialog');d.id='agent-handoff-dialog';d.className='agent-handoff-dialog';
  const make=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
  const heading=make('h2',title);heading.id='agent-handoff-title';d.setAttribute('aria-labelledby',heading.id);
  const note=make('p','This is the same finding description returned to API agents. Review it, then copy it to your coding agent.');note.className='small muted';
  const context=make('p',revision?`Issue revision ${revision} · preview captured when opened`:'Preview captured when opened');context.className='small muted';
  const preview=make('textarea');preview.id='agent-handoff-preview';preview.readOnly=true;preview.value=description.text;preview.rows=18;preview.setAttribute('aria-label','Finding description for your agent');preview.spellcheck=false;
  const status=make('p');status.className='small';status.setAttribute('role','status');
  const actions=make('div');actions.className='row';const copy=make('button','Copy description');copy.type='button';copy.className='button primary';const close=make('button','Close');close.type='button';close.className='button';
  const dismiss=()=>{closeAgentHandoff();opener?.focus?.();};close.addEventListener('click',dismiss);d.addEventListener('cancel',e=>{e.preventDefault();dismiss();});
  copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(preview.value);status.textContent='Copied. Paste this description into your coding agent.';}catch{preview.focus();preview.select();status.textContent='Clipboard access is unavailable. The description is selected so you can copy it manually.';}});
  actions.append(copy,close);d.append(heading,note,context,preview,actions,status);document.body.append(d);d.showModal();preview.setSelectionRange?.(0,0);preview.scrollTop=0;copy.focus();return d;
}
