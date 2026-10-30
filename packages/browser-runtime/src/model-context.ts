import type { BrowserCommand, Capture, ObservedControl } from './contracts.js';

// The gateway accepts prompts up to this many UTF-8 bytes. Requests are fitted
// below it with room for the operator focus that is added after fitting.
export const PROMPT_LIMIT_BYTES = 65536;
const FIT_LIMIT_BYTES = PROMPT_LIMIT_BYTES - 10240;
// Full-scale budgets. fitContext scales them down until a request fits.
export const CONTEXT_BUDGETS = { page_text_chars: 4000, page_controls_bytes: 6000, plan_controls_bytes: 20000, plan_history: 8, assessment_history: 4 };
export type ContextScale = number;

// Prompt projections are bounded independently of immutable full observations.
// Exact control IDs, labels and option values are never rewritten for execution.
export function controlContext(controls: ObservedControl[], byteBudget=10000) {
  const result: ObservedControl[]=[];
  let size=2, truncated=false;
  for(const control of controls){
    const projected={...control};
    if(projected.href && projected.href.length>240) { projected.href=projected.href.slice(0,240); truncated=true; }
    if(projected.options){
      const options=[];
      let optionBytes=0;
      for(const option of projected.options){
        const bytes=Buffer.byteLength(JSON.stringify(option));
        if(optionBytes+bytes>1800){truncated=true;break;}
        options.push(option); optionBytes+=bytes;
      }
      projected.options_truncated=projected.options_truncated||options.length!==projected.options.length;
      projected.options=options;
    }
    const bytes=Buffer.byteLength(JSON.stringify(projected))+1;
    if(size+bytes>byteBudget){truncated=true;continue;}
    result.push(projected);size+=bytes;
  }
  return {controls:result,controls_truncated:truncated,omitted_controls:controls.length-result.length};
}
export function pageContext(capture: Capture, scale: ContextScale = 1){
  const o=capture.observation,textLimit=Math.floor(CONTEXT_BUDGETS.page_text_chars*scale);
  const controls=controlContext(o.controls??[],Math.floor(CONTEXT_BUDGETS.page_controls_bytes*scale));
  return {capture_id:capture.capture_id,screenshot_sha256:capture.sha256,url:o.url.slice(0,300),url_truncated:o.url.length>300,
    title:o.title?.slice(0,200),text:o.text?.slice(0,textLimit),text_truncated:o.text_truncated||(o.text?.length??0)>textLimit,
    ...controls,controls_truncated:controls.controls_truncated||o.controls_truncated,observation_error:o.observation_error,
    observed_at:o.observed_at,screenshot_finished_at:o.screenshot_finished_at};
}
export function commandContext(command: BrowserCommand){
  if(command.type==='navigate')return {...command,url:command.url.slice(0,300),url_truncated:command.url.length>300};
  const {control,...action}=command;
  return {...action,control:{control_id:control.control_id,role:control.role,name:control.name,scroll_target:control.scroll_target,in_viewport:control.in_viewport}};
}
export function historyContext(history: unknown[], count: number){
  return history.slice(-Math.max(1,count));
}
// Build the largest request that fits. Smaller scales shorten page text,
// control lists and history; the final scale is recorded with the request.
export function fitContext<T>(build: (scale: ContextScale) => T): { input: T; scale: ContextScale } {
  for (const scale of [1, .75, .5, .35, .25]) {
    const input = build(scale);
    if (Buffer.byteLength(JSON.stringify(input)) <= FIT_LIMIT_BYTES) return { input, scale };
  }
  return { input: build(.15), scale: .15 };
}
