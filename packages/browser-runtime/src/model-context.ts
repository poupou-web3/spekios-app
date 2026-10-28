import type { BrowserCommand, Capture, ObservedControl } from './contracts.js';

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
export function pageContext(capture: Capture){
  const o=capture.observation,controls=controlContext(o.controls??[],3500);
  return {capture_id:capture.capture_id,screenshot_sha256:capture.sha256,url:o.url.slice(0,300),url_truncated:o.url.length>300,
    title:o.title?.slice(0,200),text:o.text?.slice(0,1500),text_truncated:o.text_truncated||(o.text?.length??0)>1500,
    ...controls,controls_truncated:controls.controls_truncated||o.controls_truncated,observation_error:o.observation_error,
    observed_at:o.observed_at,screenshot_finished_at:o.screenshot_finished_at};
}
export function commandContext(command: BrowserCommand){
  if(command.type==='navigate')return {...command,url:command.url.slice(0,300),url_truncated:command.url.length>300};
  const {control,...action}=command;
  return {...action,control:{control_id:control.control_id,role:control.role,name:control.name,scroll_target:control.scroll_target}};
}
