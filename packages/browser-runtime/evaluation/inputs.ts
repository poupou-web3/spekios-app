import {pageContext,commandContext,fitContext} from '../src/model-context.js';
import {ASSESSMENT_INSTRUCTION,FOCUS_INSTRUCTION} from '../src/assessment-vision.js';
// Labels, original verdicts and human reference descriptions are deliberately
// outside this projection. Both arms share all context except visual guidance.
export function assessmentInput(source:any,before:any,after:any,comparison:any,visualContext:any,cropped:boolean){
 const captures=[before.capture_id,after.capture_id];
 return fitContext(scale=>({task:'assessment',action:commandContext(source.command),prediction:source.prediction,before:pageContext(before,scale),after:pageContext(after,scale),pixel_comparison:comparison,visual_input:cropped?visualContext:{mode:'full'},site_context:{entry_url:source.entry_url,requirements_source:'No separate product brief. Recorded expectations are hypotheses.'},action_outcome:source.outcome,recent_history:source.recent_history,tool_error:null,instruction:(cropped?FOCUS_INSTRUCTION+' ':'')+ASSESSMENT_INSTRUCTION,response_schema:{verdict:'no_issue_observed | suspect | inconclusive',reason:'string',observed_result:'string',evidence_capture_ids:captures,expectation_uncertain:'boolean',...(cropped?{needs_full_context:'boolean'}:{})}})).input;
}
