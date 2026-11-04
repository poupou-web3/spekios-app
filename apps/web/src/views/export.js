// Portable run reports: Markdown, evidence ZIP and JSON, built in the browser from a frozen snapshot.
import {button} from '/assets/ui/components.js';
import {date,esc,short} from '/assets/ui/format.js';
import {api} from '../api.js';
import {render} from '../app.js';
import {state} from '../state.js';
let reportToolsPromise;
export function reportTools(){return reportToolsPromise??=import('/assets/app/report/bundle.js').catch(error=>{reportToolsPromise=null;throw error;});}
export function exportBytes(value){return value==null?'Unknown':`${(value/1024/1024).toFixed(2)} MB`;}
export function exportView(exportState){
  const r=exportState.snapshot,run=r.run,p=exportState.progress,result=exportState.result;
  return `<div class="report-export"><p class="eyebrow">Run ${esc(short(run.run_id))} · ${esc(run.lifecycle)}</p><p class="small muted">Frozen at ${esc(date(exportState.generatedAt))}. This download contains the selected run’s recorded application data; review it before sharing.</p>${run.lifecycle==='active'?'<div class="notice">This run is still active. The report is a partial snapshot, and later actions or uploads are not included.</div>':''}<div class="export-formats"><section><h3>Readable report</h3><p>Steps, expected and observed results, human review history, coverage limits and usage. Evidence is referenced by ID.</p>${button('download-report','Download Markdown','download',`data-format="markdown" ${exportState.busy?'disabled':''}`)}</section><section><h3>Evidence bundle</h3><p>Markdown, the run JSON, original PNGs, masks, recorded JSON artifacts and a SHA-256 manifest. Missing or unverified files are listed as gaps.</p>${button('download-report','Download evidence ZIP','download',`data-format="zip" ${exportState.busy?'disabled':''}`)}</section><section><h3>Recorded data</h3><p>The complete selected run snapshot in the existing JSON format.</p>${button('download-report','Download JSON','download',`data-format="json" ${exportState.busy?'disabled':''}`)}</section></div><p class="small muted">Only this run’s evidence is included. Related reproductions retain their own run IDs and must be exported separately. Provider payloads and private sign-in sessions are not added. This report does not approve data for training.</p><p class="small muted">ZIP limits: 256 evidence files, 8 MB per file and 64 MB per archive. Larger exports can use the JSON report and individual evidence downloads.</p>${exportState.busy?`<div class="export-progress" role="status"><strong>${exportState.format==='zip'?'Verifying recorded evidence…':'Preparing report…'}</strong>${p?`<progress max="${Math.max(1,p.total)}" value="${p.processed}" aria-label="Evidence files processed"></progress><p>${esc(p.processed)} of ${esc(p.total)} processed · ${esc(p.included)} verified · ${esc(p.gaps)} gaps · ${exportBytes(p.verifiedBytes)}</p>`:''}${button('cancel-report-export','Cancel download','close')}</div>`:''}${exportState.error?`<div class="notice error" role="alert">${esc(exportState.error)}</div>`:''}${result?`<div class="export-result notice" role="status"><span>${result.format==='zip'?`Evidence ZIP downloaded: ${esc(result.included)} verified files${result.gaps?` and ${esc(result.gaps)} evidence gaps`:''}. ${result.gaps?'Inspect manifest.json for the missing or unverified files.':'The manifest records verified file hashes.'}`:`${result.format==='markdown'?'Markdown':'JSON'} report downloaded.`}</span></div><p class="small mono">Export ${esc(exportState.exportId)}</p>`:''}</div>`;
}
export function openReportExport(){
  if(!state.report?.run)return;
  closeReportExport();
  state.drawer={title:'Export run report',export:{snapshot:JSON.parse(JSON.stringify(state.report)),exportId:crypto.randomUUID(),generatedAt:new Date().toISOString(),busy:false,progress:null,error:'',result:null,controller:null}};render();
}
export function closeReportExport(){
  if(state.drawer?.export?.controller)state.drawer.export.controller.abort(new DOMException('Export cancelled.','AbortError'));
}
export function downloadBlob(blob,filename){
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
export async function downloadReport(format){
  const d=state.drawer?.export;if(!d||d.busy||!['json','markdown','zip'].includes(format))return;
  const token=state.token,developmentAccess=state.developmentAccess,current=()=>state.connected&&state.drawer?.export===d&&state.token===token&&state.developmentAccess===developmentAccess;
  d.busy=true;d.format=format;d.error='';d.progress=null;d.result=null;d.controller=new AbortController();render();
  try{
    const tools=await reportTools();if(!current()||d.controller.signal.aborted)return;
    const opts={exportId:d.exportId,generatedAt:d.generatedAt};let blob,filename,result;
    if(format==='zip'){
      result=await tools.buildEvidenceBundle(d.snapshot,{...opts,signal:d.controller.signal,fetchFile:async(path,{signal})=>{
        if(!current()){const error=new Error('Workspace disconnected.');error.code='workspace_disconnected';throw error;}
        return api(path,undefined,{},18000,signal);
      },onProgress:progress=>{if(current()){d.progress=progress;render();}}});blob=result.blob;filename=result.filename;
    }else{
      const bytes=format==='json'?tools.reportJson(d.snapshot):tools.reportMarkdown(d.snapshot,opts);
      blob=new Blob([bytes],{type:format==='json'?'application/json':'text/markdown;charset=utf-8'});filename=`spekios-run-${d.snapshot.run.run_id}.${format==='json'?'json':'md'}`;
    }
    if(!current()||d.controller.signal.aborted)return;
    downloadBlob(blob,filename);
    d.result={format,included:result?.manifest.evidence.filter(e=>e.status==='included').length||0,gaps:result?.manifest.evidence.filter(e=>e.status!=='included').length||0};
  }catch(error){if(current())d.error=d.controller.signal.aborted?'Download cancelled. The recorded evidence is unchanged.':error.message||'Report export failed. Try again.';}
  finally{d.busy=false;if(current())render();}
}
