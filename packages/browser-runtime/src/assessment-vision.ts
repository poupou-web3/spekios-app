import {assessmentImageSheets} from '../../image-diff/index.mjs';
import {ATTENTION_VERSION} from '../../image-diff/attention.mjs';
import type {Capture} from './contracts.js';
import {parseAssessment} from './exploration-policy.js';
import type {BrowserCommand} from './frontier-planner.js';
import type {Store} from './store.js';
export const FOCUS_INSTRUCTION='Inspect the native-resolution focus crops first using visual_input.panels, then compare the expected result with page text, controls, diagnostics and the reduced whole-page overview. Changes only guide attention. Check for expected changes that are absent and failures outside the crops. Set needs_full_context=true if relevant detail or surrounding context is not readable, if the expected result cannot be located, or if the overview suggests a wider problem. Never infer success just from a changed crop.';
export async function assessmentVision(store:Pick<Store,'artifact'>,runId:string,before:{capture:Capture;bytes:Buffer},after:{capture:Capture;bytes:Buffer},comparison:any,command:BrowserCommand,eligible:boolean){
  const full=(reason:string)=>({metadata:{version:ATTENTION_VERSION,mode:'full',reason},artifactIds:[] as string[]});
  if(!eligible)return full('replay_or_unsettled_action');
  if(command.type==='navigate'||command.type==='scroll'||command.type==='computer'||command.type==='click'&&command.control.role==='link')return full('page_or_navigation_action');
  if(before.capture.observation.url!==after.capture.observation.url)return full('page_changed');
  if(!comparison.counts.changed_pixels)return full('no_visual_change_expected_result_still_requires_check');
  const sheets=assessmentImageSheets(before.bytes,after.bytes,comparison,command.control.rect);
  if(!('images' in sheets)||!sheets.images)return full('reason' in sheets?sheets.reason:'full_context_required');
  const {images,...metadata}=sheets;
  if(images.some(image=>image.length>4*1024*1024))return full('derivative_too_large');
  const artifacts=[];
  try{for(const image of images)artifacts.push(await store.artifact(runId,'assessment_image',image,'png'));}
  catch{return full('optional_derivative_unavailable');}
  return {metadata:{...metadata,source_capture_ids:[before.capture.capture_id,after.capture.capture_id],artifacts},artifactIds:artifacts.map(a=>a.artifact_id)};
}
export function parseFocusedAssessment(value:unknown,captureIds:string[],focused:boolean){
  if(!focused)return {...parseAssessment(value,captureIds),needs_full_context:false};
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid focused assessment.');
  const {needs_full_context,...rest}=value as Record<string,unknown>;
  if(needs_full_context!==undefined&&typeof needs_full_context!=='boolean')throw new Error('Invalid full-context request.');
  return {...parseAssessment(rest,captureIds),needs_full_context:needs_full_context??true};
}
export function needsFullAssessment(result:{verdict:string;expectation_uncertain:boolean;needs_full_context?:unknown}){
  return result.verdict!=='no_issue_observed'||result.expectation_uncertain||result.needs_full_context===true;
}
