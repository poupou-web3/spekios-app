import {reportEvidence,reportMarkdown,reportSummary} from './export.js';

export {reportEvidence,reportMarkdown,reportSummary};
export const EXPORT_LIMITS=Object.freeze({maxEvidenceFiles:256,maxFileBytes:8*1024*1024,maxReportBytes:8*1024*1024,maxArchiveBytes:64*1024*1024,timeoutMs:120000});
const encoder=new TextEncoder(),uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const safePath=/^(?:report\.(?:json|md)|manifest\.json|(?:captures|artifacts)\/[0-9a-f-]{36}\.(?:png|json))$/;
const pngSignature=[137,80,78,71,13,10,26,10];
export class ReportExportError extends Error{constructor(code){super(code.replaceAll('_',' '));this.name='ReportExportError';this.code=code;}}
const fail=code=>{throw new ReportExportError(code);};
const abort=signal=>{if(signal?.aborted)throw signal.reason||new DOMException('Export cancelled.','AbortError');};
export function reportJson(report){return encoder.encode(JSON.stringify(report,null,2)+'\n');}
export async function sha256(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
function context(report,options){
  const runId=report?.run?.run_id,exportId=options.exportId||crypto.randomUUID(),generatedAt=options.generatedAt||new Date().toISOString();
  if(!uuid.test(runId||'')||!uuid.test(exportId)||!Number.isFinite(Date.parse(generatedAt)))fail('invalid_export_identity');
  return {runId,exportId,generatedAt};
}
function validDescriptor(entry,runId){
  if(!uuid.test(entry.id||'')||entry.runId!==runId||!['capture','artifact'].includes(entry.kind))return false;
  const base=entry.kind==='capture'?'captures':'artifacts',extension=entry.kind==='capture'?'png':entry.mediaType==='image/png'?'png':entry.mediaType==='application/json'?'json':null;
  return extension!==null&&entry.path===`${base}/${entry.id}.${extension}`&&entry.endpoint===(entry.kind==='capture'?`/v1/captures/${entry.id}/image`:`/v1/artifacts/${entry.id}/content`)&&/^[0-9a-f]{64}$/.test(entry.sha256||'')&&Number.isSafeInteger(entry.byteLength)&&entry.byteLength>0;
}
async function readVerified(response,entry,signal){
  abort(signal);
  if(!response?.ok)fail('evidence_request_failed');
  const type=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if(type!==entry.mediaType)fail('evidence_media_type_mismatch');
  const length=response.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)!==entry.byteLength))fail('evidence_length_mismatch');
  if(!response.body?.getReader)fail('evidence_stream_unavailable');
  const reader=response.body.getReader(),chunks=[];let count=0,finished=false;
  try{
    while(true){abort(signal);const next=await reader.read();if(next.done){finished=true;break;}
      count+=next.value.byteLength;if(count>entry.byteLength||count>EXPORT_LIMITS.maxFileBytes)fail('evidence_length_mismatch');chunks.push(next.value);
    }
  }finally{if(!finished)try{await reader.cancel();}catch{}reader.releaseLock();}
  if(count!==entry.byteLength)fail('evidence_length_mismatch');
  const bytes=new Uint8Array(count);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  if(await sha256(bytes)!==entry.sha256)fail('evidence_checksum_mismatch');
  if(entry.mediaType==='image/png'&&pngSignature.some((b,i)=>bytes[i]!==b))fail('invalid_png_evidence');
  if(entry.mediaType==='application/json')try{JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('invalid_json_evidence');}
  return bytes;
}

let crcTable;
function crc32(bytes){
  crcTable??=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
  let crc=0xffffffff;for(const b of bytes)crc=crcTable[(crc^b)&255]^(crc>>>8);return(crc^0xffffffff)>>>0;
}
// ZIP STORE keeps lossless PNG bytes unchanged and needs no browser dependency.
// The standard ZIP32 bounds are much larger than our explicit memory limit.
export function zipStore(files,generatedAt='1980-01-01T00:00:00Z'){
  if(!Array.isArray(files)||files.length>EXPORT_LIMITS.maxEvidenceFiles+3)fail('too_many_export_files');
  const parts=[],directory=[],seen=new Set();let offset=0,total=0;
  const when=new Date(generatedAt);if(!Number.isFinite(when.getTime()))fail('invalid_export_time');
  const year=Math.max(1980,Math.min(2107,when.getUTCFullYear())),day=((year-1980)<<9)|((when.getUTCMonth()+1)<<5)|when.getUTCDate(),time=(when.getUTCHours()<<11)|(when.getUTCMinutes()<<5)|(when.getUTCSeconds()>>1);
  for(const file of files){
    if(!safePath.test(file.path)||seen.has(file.path)||!(file.bytes instanceof Uint8Array))fail('invalid_export_path');seen.add(file.path);
    const name=encoder.encode(file.path),size=file.bytes.length,crc=crc32(file.bytes),header=new Uint8Array(30+name.length),view=new DataView(header.buffer);
    total+=size+name.length*2+76;if(total>EXPORT_LIMITS.maxArchiveBytes)fail('export_too_large');
    view.setUint32(0,0x04034b50,true);view.setUint16(4,20,true);view.setUint16(6,0x800,true);view.setUint16(10,time,true);view.setUint16(12,day,true);view.setUint32(14,crc,true);view.setUint32(18,size,true);view.setUint32(22,size,true);view.setUint16(26,name.length,true);header.set(name,30);parts.push(header,file.bytes);
    const central=new Uint8Array(46+name.length),c=new DataView(central.buffer);c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);c.setUint16(12,time,true);c.setUint16(14,day,true);c.setUint32(16,crc,true);c.setUint32(20,size,true);c.setUint32(24,size,true);c.setUint16(28,name.length,true);c.setUint32(42,offset,true);central.set(name,46);directory.push(central);offset+=header.length+size;
  }
  const centralSize=directory.reduce((sum,p)=>sum+p.length,0),end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,centralSize,true);e.setUint32(16,offset,true);
  if(offset+centralSize+end.length>EXPORT_LIMITS.maxArchiveBytes)fail('export_too_large');
  return new Blob([...parts,...directory,end],{type:'application/zip'});
}

export async function buildEvidenceBundle(report,options={}){
  const json=reportJson(report);
  if(json.length>EXPORT_LIMITS.maxReportBytes)fail('report_snapshot_too_large');
  // Pin again at the module boundary so all outputs use the exact same data,
  // even when a caller updates its report object while downloads are pending.
  report=JSON.parse(new TextDecoder().decode(json));
  const {runId,exportId,generatedAt}=context(report,options),descriptors=reportEvidence(report);
  if(descriptors.length>EXPORT_LIMITS.maxEvidenceFiles)fail('too_many_evidence_files');
  const timeout=AbortSignal.timeout(EXPORT_LIMITS.timeoutMs),signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
  if(typeof options.fetchFile!=='function')fail('evidence_fetcher_required');
  const files=[{path:'report.json',bytes:json}],evidence=[],paths=new Set();let verifiedBytes=0,processed=0;
  const progress=()=>options.onProgress?.({processed,total:descriptors.length,included:evidence.filter(e=>e.status==='included').length,gaps:evidence.filter(e=>e.status!=='included').length,verifiedBytes});
  const declared=descriptors.filter(d=>d.status==='available'&&validDescriptor(d,runId)).reduce((sum,d)=>sum+d.byteLength,0);
  // Leave room for the Markdown, manifest and ZIP directory before any reads.
  if(declared+json.length+1024*1024>EXPORT_LIMITS.maxArchiveBytes)fail('export_too_large');
  progress();
  for(const entry of descriptors){
    abort(signal);const result={...entry,recordedStatus:entry.status,status:'not_included',error:null};
    if(entry.status!=='available'){result.status=entry.status==='invalid'?'invalid_metadata':'unavailable';result.error=entry.error||'evidence_not_available_at_snapshot';}
    else if(!validDescriptor(entry,runId)){result.status='invalid_metadata';result.error=entry.error||'invalid_evidence_metadata';}
    else if(paths.has(entry.path)){result.status='invalid_metadata';result.error='duplicate_evidence_path';}
    else if(entry.byteLength>EXPORT_LIMITS.maxFileBytes){result.status='not_included';result.error='evidence_file_too_large';}
    else{
      paths.add(entry.path);
      try{
        const response=await options.fetchFile(entry.endpoint,{signal}),bytes=await readVerified(response,entry,signal);abort(signal);
        verifiedBytes+=bytes.length;if(verifiedBytes+json.length+1024*1024>EXPORT_LIMITS.maxArchiveBytes)fail('export_too_large');
        files.push({path:entry.path,bytes});result.status='included';result.verifiedSha256=await sha256(bytes);result.verifiedBytes=bytes.length;
      }catch(error){abort(signal);if(error?.name==='AbortError'||error?.code==='workspace_disconnected')throw error;result.status='failed_verification';result.error=error instanceof ReportExportError?error.code:'evidence_download_failed';}
    }
    evidence.push(result);processed++;progress();
  }
  abort(signal);
  const markdown=encoder.encode(reportMarkdown(report,{exportId,generatedAt,bundle:true,evidence}));if(markdown.length>EXPORT_LIMITS.maxReportBytes)fail('report_markdown_too_large');files.push({path:'report.md',bytes:markdown});
  const fileManifest=[];for(const f of files){abort(signal);fileManifest.push({path:f.path,byte_length:f.bytes.length,sha256:await sha256(f.bytes)});}
  const manifest={schema_version:1,export_kind:'scout_run_report',export_id:exportId,generated_at:generatedAt,source_run_id:runId,source_lifecycle:report.run.lifecycle,active_snapshot:report.run.lifecycle==='active',evidence_status:!evidence.length?'no_evidence_listed':evidence.every(e=>e.status==='included')?'all_listed_files_verified':'contains_gaps',training_approval:false,related_run_evidence_included:false,integrity_scope:'Downloaded bytes match the recorded length and SHA256; this does not confirm product behavior or provenance.',limits:EXPORT_LIMITS,summary:reportSummary(report),files:fileManifest,evidence};
  const manifestBytes=reportJson(manifest);if(manifestBytes.length>EXPORT_LIMITS.maxReportBytes)fail('export_manifest_too_large');files.push({path:'manifest.json',bytes:manifestBytes});abort(signal);
  return {blob:zipStore(files,generatedAt),manifest,filename:`spekios-run-${runId}-evidence.zip`};
}
