import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEvidenceBundle,zipStore,sha256,EXPORT_LIMITS} from '../src/report/bundle.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfV0AAAAASUVORK5CYII=','base64'));
const json=new TextEncoder().encode('{"recorded":true}\n'),options={exportId:id(90),generatedAt:'2026-10-28T15:00:00Z'};
async function fixture(){
  const hash=await sha256(png),jhash=await sha256(json),run=id(1),action=id(2);
  const captures=[3,4].map((n,i)=>({capture_id:id(n),run_id:run,action_id:action,phase:i?'after':'before',status:'available',sha256:hash,byte_length:png.length,object_key:`blobs/${hash}.png`,observation:{url:'https://fixture.test',text:'Page',viewport:{width:800,height:600}}}));
  const artifact={artifact_id:id(5),run_id:run,kind:'action_completion',object_key:`blobs/${jhash}.json`,status:'available',sha256:jhash,byte_length:json.length};
  const report={schema_version:1,run:{run_id:run,lifecycle:'completed',target_url:'https://fixture.test',config:{training_status:'excluded_fixture',runtime_version:'explorer-v1',replay_of:null,execution_mode:'protocol_fixture'}},actions:[{action_id:action,run_id:run,ordinal:1,state:'completed',before_capture_id:id(3),after_capture_id:id(4),spec:{command:{type:'click',control:{name:'Open'}},prediction:{source:'model',expected_result:'Page opens'}},assessment:{verdict:'no_issue_observed',actual:'Page visible'}}],captures,artifacts:[artifact],events:[],finding_reviews:[],reproductions:[],automatic_reproductions:[],model_usage:{attempts:0}};
  return {report,fetchFile:async endpoint=>new Response(endpoint.includes('/artifacts/')?json:png,{headers:{'content-type':endpoint.includes('/artifacts/')?'application/json':'image/png'}})};
}
async function entries(blob){const bytes=new Uint8Array(await blob.arrayBuffer()),v=new DataView(bytes.buffer),files=new Map();let at=0;
  while(v.getUint32(at,true)===0x04034b50){const size=v.getUint32(at+18,true),nameLength=v.getUint16(at+26,true),extra=v.getUint16(at+28,true),name=new TextDecoder().decode(bytes.slice(at+30,at+30+nameLength)),start=at+30+nameLength+extra;assert.equal(v.getUint16(at+8,true),0);files.set(name,bytes.slice(start,start+size));at=start+size;}
  assert.equal(v.getUint32(at,true),0x02014b50);assert.equal(v.getUint32(bytes.length-22,true),0x06054b50);assert.equal(v.getUint16(bytes.length-12,true),files.size);return files;
}
test('bundle keeps distinct capture IDs even for identical PNG bytes and pins every included file hash',async()=>{
  const f=await fixture(),before=JSON.stringify(f.report),progress=[],result=await buildEvidenceBundle(f.report,{...options,fetchFile:f.fetchFile,onProgress:p=>progress.push(p)}),files=await entries(result.blob);
  assert.equal(files.size,6);assert.deepEqual(files.get(`captures/${id(3)}.png`),png);assert.deepEqual(files.get(`captures/${id(4)}.png`),png);assert.deepEqual(files.get(`artifacts/${id(5)}.json`),json);
  const manifest=JSON.parse(new TextDecoder().decode(files.get('manifest.json')));assert.equal(manifest.evidence_status,'all_listed_files_verified');assert.equal(manifest.training_approval,false);assert.equal(manifest.related_run_evidence_included,false);
  for(const file of manifest.files){assert.equal(await sha256(files.get(file.path)),file.sha256);assert.equal(files.get(file.path).length,file.byte_length);}
  assert.equal(JSON.stringify(JSON.parse(new TextDecoder().decode(files.get('report.json')))),before);assert.equal(JSON.stringify(f.report),before);assert.equal(progress.at(-1).processed,3);assert.equal(progress.at(-1).included,3);
});
test('updates to the caller report during a download cannot change the pinned report or Markdown',async()=>{
  const f=await fixture(),result=await buildEvidenceBundle(f.report,{...options,fetchFile:async endpoint=>{f.report.run.target_url='https://changed-after-snapshot.test';f.report.actions[0].spec.prediction.expected_result='changed after snapshot';return f.fetchFile(endpoint);}}),files=await entries(result.blob);
  const source=JSON.parse(new TextDecoder().decode(files.get('report.json'))),markdown=new TextDecoder().decode(files.get('report.md'));
  assert.equal(source.run.target_url,'https://fixture.test');assert.ok(!markdown.includes('changed after snapshot'));assert.ok(!markdown.includes('changed-after-snapshot'));
});
test('checksum, truncated, oversized, MIME and malformed data never enter the ZIP',async()=>{
  const failures=[
    {code:'evidence_checksum_mismatch',body:new Uint8Array(png.length).fill(5),type:'image/png'},
    {code:'evidence_length_mismatch',body:png.slice(0,-1),type:'image/png'},
    {code:'evidence_length_mismatch',body:new Uint8Array(png.length+1),type:'image/png'},
    {code:'evidence_media_type_mismatch',body:png,type:'text/html'},
  ];
  for(const fcase of failures){const f=await fixture(),result=await buildEvidenceBundle(f.report,{...options,fetchFile:async endpoint=>endpoint.includes(`/captures/${id(3)}/`)?new Response(fcase.body,{headers:{'content-type':fcase.type}}):f.fetchFile(endpoint)}),files=await entries(result.blob);
    assert.equal(result.manifest.evidence_status,'contains_gaps');assert.equal(result.manifest.evidence.find(e=>e.id===id(3)).error,fcase.code);assert.equal(files.has(`captures/${id(3)}.png`),false);
  }
  const f=await fixture(),bad=new TextEncoder().encode('<script>bad()</script>');f.report.artifacts[0].sha256=await sha256(bad);f.report.artifacts[0].byte_length=bad.length;
  const result=await buildEvidenceBundle(f.report,{...options,fetchFile:async endpoint=>endpoint.includes('/artifacts/')?new Response(bad,{headers:{'content-type':'application/json'}}):f.fetchFile(endpoint)});
  assert.equal(result.manifest.evidence.find(e=>e.id===id(5)).error,'invalid_json_evidence');
});
test('pending and missing evidence remain explicit gaps without issuing requests',async()=>{
  const f=await fixture();f.report.captures[0].status='pending_upload';f.report.captures[0].sha256=null;f.report.captures[0].byte_length=null;f.report.captures.pop();const requests=[];
  const result=await buildEvidenceBundle(f.report,{...options,fetchFile:async endpoint=>{requests.push(endpoint);return f.fetchFile(endpoint);}});
  assert.deepEqual(requests,[`/v1/artifacts/${id(5)}/content`]);assert.equal(result.manifest.evidence.filter(e=>e.status==='unavailable').length,2);assert.equal(result.manifest.evidence_status,'contains_gaps');
});
test('foreign, malformed, conflicting and unbound capture metadata cannot fetch evidence',async()=>{
  for(const mutate of [r=>r.captures[0].run_id=id(99),r=>r.captures[0].capture_id='../../outside',r=>r.captures.push({...r.captures[0],sha256:'f'.repeat(64)}),r=>r.captures[0].action_id=id(99)]){
    const f=await fixture();mutate(f.report);const requested=[];const result=await buildEvidenceBundle(f.report,{...options,fetchFile:async endpoint=>{requested.push(endpoint);return f.fetchFile(endpoint);}});
    assert.ok(!requested.includes(`/v1/captures/${id(3)}/image`));assert.ok(requested.every(path=>/^\/v1\/(captures|artifacts)\/[0-9a-f-]{36}\/(image|content)$/.test(path)));assert.equal(result.manifest.evidence_status,'contains_gaps');
  }
});
test('per-file, planned total and file-count limits are enforced before oversized reads',async()=>{
  const f=await fixture();f.report.captures[0].byte_length=EXPORT_LIMITS.maxFileBytes+1;let calls=0;
  const result=await buildEvidenceBundle(f.report,{...options,fetchFile:async path=>{calls++;return f.fetchFile(path);}});assert.equal(calls,2);assert.equal(result.manifest.evidence.find(e=>e.id===id(3)).error,'evidence_file_too_large');
  const huge=await fixture();huge.report.artifacts=Array.from({length:10},(_,n)=>({...huge.report.artifacts[0],artifact_id:id(100+n),byte_length:EXPORT_LIMITS.maxFileBytes}));calls=0;
  await assert.rejects(buildEvidenceBundle(huge.report,{...options,fetchFile:async()=>{calls++;}}),/export too large/);assert.equal(calls,0);
  huge.report.artifacts=Array.from({length:257},(_,n)=>({...huge.report.artifacts[0],artifact_id:id(100+n)}));await assert.rejects(buildEvidenceBundle(huge.report,{...options,fetchFile:async()=>{calls++;}}),/too many evidence files/);assert.equal(calls,0);
});
test('cancellation and workspace disconnection stop subsequent downloads',async()=>{
  const f=await fixture(),controller=new AbortController();let calls=0;
  await assert.rejects(buildEvidenceBundle(f.report,{...options,signal:controller.signal,fetchFile:async path=>{calls++;controller.abort(new DOMException('Cancelled','AbortError'));return f.fetchFile(path);}}),/Cancelled/);assert.equal(calls,1);
  calls=0;await assert.rejects(buildEvidenceBundle(f.report,{...options,fetchFile:async()=>{calls++;throw Object.assign(new Error('Disconnected'),{code:'workspace_disconnected'});}}),/Disconnected/);assert.equal(calls,1);
});
test('network failures are recorded without leaking raw error details, while active snapshots stay labeled',async()=>{
  const f=await fixture();f.report.run.lifecycle='active';const result=await buildEvidenceBundle(f.report,{...options,fetchFile:async()=>{throw new Error('private URL or credential');}});
  assert.equal(result.manifest.active_snapshot,true);assert.equal(result.manifest.evidence_status,'contains_gaps');assert.ok(result.manifest.evidence.every(e=>e.error==='evidence_download_failed'));assert.ok(!JSON.stringify(result.manifest).includes('private URL or credential'));
});
test('ZIP store is deterministic, rejects unsafe/duplicate paths and caps bytes',async()=>{
  const files=[{path:'report.json',bytes:new TextEncoder().encode('{}')}];const a=new Uint8Array(await zipStore(files).arrayBuffer()),b=new Uint8Array(await zipStore(files).arrayBuffer());assert.deepEqual(a,b);
  const file=await entries(zipStore(files));assert.equal(new TextDecoder().decode(file.get('report.json')),'{}');
  for(const path of ['../secret','/report.json','https://evil.test','captures/../../../secret','report.json\n'])assert.throws(()=>zipStore([{path,bytes:png}]),/invalid export path/);
  assert.throws(()=>zipStore([...files,...files]),/invalid export path/);
});
