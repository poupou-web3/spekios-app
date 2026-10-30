import type { Page } from 'playwright';
import type { BrowserCommand, Capture } from './contracts.js';
import { blockedReason, observeControls } from './exploration-policy.js';
import { testFormRules, type TestFormRule } from './form-policy.js';
import { commandAction, commandFor } from './interaction-contract.js';
import { isDeepStrictEqual } from 'node:util';

export function observedCommand(command: BrowserCommand, capture: Capture, origin: string): BrowserCommand {
  if (command.type === 'navigate') return command;
  const control = capture.observation.controls?.find(c=>c.control_id===command.control.control_id);
  if (!control || control.role!==command.control.role || control.name!==command.control.name || control.href!==command.control.href || blockedReason(control,origin)) throw new Error('Selected control is no longer available.');
  if (command.type==='scroll' && !isDeepStrictEqual(control.scroll_target,command.control.scroll_target)) throw new Error('Recorded scroll target has changed.');
  if (command.type==='submit' && !isDeepStrictEqual(control.form,command.control.form)) throw new Error('Recorded form contract has changed.');
  return commandFor(control,commandAction(command));
}
export async function validateDispatch(page: Page, command: BrowserCommand, rules: TestFormRule[] = testFormRules()) {
  if (command.type==='navigate' || command.control.role==='scroll') return;
  const locator=page.getByRole(command.control.role,{name:command.control.name,exact:true});
  if (await locator.count()!==1) throw new Error('Selected control does not resolve uniquely.');
  if(command.type==='submit') {
    const current=(await observeControls(page,rules)).controls.find(c=>c.control_id===command.control.control_id);
    if(!current||blockedReason(current,new URL(page.url()).origin)||!isDeepStrictEqual(current.form,command.control.form)) throw new Error('Form permission or destination changed before dispatch.');
  }
}
export type Reveal = { from: { x: number; y: number }; to: { x: number; y: number } };
// Bring a chosen control that was observed below the fold into view before the
// action's before capture, using the same document scroll as a scroll action.
// Nested scrolling containers are never scrolled.
export async function revealControl(page: Page, command: BrowserCommand): Promise<Reveal|null> {
  if (command.type==='navigate' || command.control.role==='scroll' || command.control.in_viewport!==false) return null;
  const locator=page.getByRole(command.control.role,{name:command.control.name,exact:true});
  if (await locator.count()!==1) throw new Error('Selected control does not resolve uniquely.');
  return locator.evaluate(async element => {
    const from={x:scrollX,y:scrollY},rect=element.getBoundingClientRect();
    const maxY=Math.max(0,(document.scrollingElement?.scrollHeight??0)-innerHeight);
    window.scrollTo({left:scrollX,top:Math.round(Math.min(maxY,Math.max(0,scrollY+rect.top-innerHeight/3))),behavior:'instant'});
    await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
    return {from,to:{x:scrollX,y:scrollY}};
  },undefined,{timeout:2000});
}
export async function dispatch(page: Page, command: BrowserCommand, rules?: TestFormRule[]): Promise<string|null> {
  if (command.type==='navigate') {
    const response=await page.goto(command.url,{waitUntil:'domcontentloaded',timeout:10000});
    return response && response.status()>=400 ? `Navigation returned HTTP ${response.status()}` : null;
  }
  if (command.type==='scroll') {
    const target=command.control.scroll_target!;
    await page.evaluate(async ({x,y})=>{
      window.scrollTo({left:x,top:y,behavior:'instant'});
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
    },target);
    return null;
  }
  if (command.control.role==='scroll') throw new Error('Invalid scroll command.');
  const locator=page.getByRole(command.control.role,{name:command.control.name,exact:true});
  switch(command.type) {
    case 'submit':
      await validateDispatch(page,command,rules);
      // Use the real submitter: native validation, submit events and overrides
      // must run exactly as they do for a person clicking the button.
      await locator.click({timeout:2000}); break;
    case 'click': await locator.click({timeout:2000}); break;
    case 'fill': await locator.fill(command.value,{timeout:2000}); break;
    case 'select': await locator.selectOption({value:command.value},{timeout:2000}); break;
    case 'set_checked': await locator.setChecked(command.checked,{timeout:2000}); break;
  }
  return null;
}
