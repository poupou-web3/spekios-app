import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {comparePng} from '../../image-diff/index.mjs';
import {assessmentVision,needsFullAssessment,parseFocusedAssessment} from '../src/assessment-vision.js';
import type {Capture} from '../src/contracts.js';
const require=createRequire(new URL('../../image-diff/package.json',import.meta.url)),{PNG}=require('pngjs');
function png(changed=false){const p=new PNG({width:1440,height:900});p.data.fill(255);if(changed)p.data[(400*1440+300)*4]=0;return PNG.sync.write(p) as Buffer;}
const before={capture:{capture_id:randomUUID(),observation:{url:'https://example.test/draft'}} as Capture,bytes:png()},after={capture:{capture_id:randomUUID(),observation:{url:'https://example.test/draft'}} as Capture,bytes:png(true)};
const command={type:'click' as const,control:{control_id:'save',name:'Save',role:'button' as const,href:null,disabled:false,submits_form:false,ambiguous:false,rect:{x:260,y:360,width:100,height:30}}};
const comparison=()=>comparePng(before.bytes,after.bytes,{beforeCaptureId:before.capture.capture_id,afterCaptureId:after.capture.capture_id}).metadata;
test('assessment stores a before/after derivative pair while retaining both authoritative source IDs',async()=>{
 const artifacts:any[]=[];const store={artifact:async(run:string,kind:string,bytes:Buffer)=>{const a={artifact_id:randomUUID(),kind,byte_length:bytes.length,sha256:'fixture',object_key:'fixture'};artifacts.push(a);return a;}};
 const vision=await assessmentVision(store,randomUUID(),before,after,comparison(),command,true);
 assert.equal(vision.artifactIds.length,2);assert.equal(vision.metadata.mode,'overview_and_crops');
 assert.deepEqual((vision.metadata as any).source_capture_ids,[before.capture.capture_id,after.capture.capture_id]);assert(artifacts.every(a=>a.kind==='assessment_image'));
 for(const eligible of [false])assert.equal((await assessmentVision(store,randomUUID(),before,after,comparison(),command,eligible)).artifactIds.length,0);
 const failed=await assessmentVision({artifact:async()=>{throw new Error('Fixture storage failure');}},randomUUID(),before,after,comparison(),command,true);assert('reason' in failed.metadata);assert.equal(failed.metadata.reason,'optional_derivative_unavailable');
 const identical={...after,bytes:before.bytes};const empty=comparePng(before.bytes,identical.bytes,{beforeCaptureId:before.capture.capture_id,afterCaptureId:after.capture.capture_id}).metadata;
 assert.equal((await assessmentVision(store,randomUUID(),before,identical,empty,command,true)).artifactIds.length,0);
 assert.equal((await assessmentVision(store,randomUUID(),before,after,comparison(),{type:'navigate',url:'https://example.test'},true)).artifactIds.length,0);
});
test('suspicions, uncertainty and missing crop-context acknowledgements require full screenshots',()=>{
 const base={verdict:'no_issue_observed',reason:'Saved',observed_result:'Saved',evidence_capture_ids:['before','after'],expectation_uncertain:false};
 assert.equal(needsFullAssessment(parseFocusedAssessment({...base,needs_full_context:false},['before','after'],true)),false);
 for(const update of [{needs_full_context:true},{verdict:'suspect',needs_full_context:false},{expectation_uncertain:true,needs_full_context:false},{}])assert.equal(needsFullAssessment(parseFocusedAssessment({...base,...update},['before','after'],true)),true);
 assert.throws(()=>parseFocusedAssessment({...base,needs_full_context:'no'},['before','after'],true));
 assert.throws(()=>parseFocusedAssessment({...base,evidence_capture_ids:['fake','after'],needs_full_context:false},['before','after'],true));
});
