import {appSource} from './support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const runId='00000000-0000-4000-8000-000000000001';
function ui(tools={}){
  const handlers={},documentHandlers={},downloads=[],blobs=[],node={innerHTML:'',classList:{add(){},remove(){}},querySelectorAll(){return[];},addEventListener(type,fn){(handlers[type]??=[]).push(fn);}};
  const document={querySelector(){return node;},getElementById(){return null;},createElement(){const anchor={click(){downloads.push({filename:this.download,url:this.href});}};return anchor;},addEventListener(type,fn){(documentHandlers[type]??=[]).push(fn);}};
  class TestURL extends URL{static createObjectURL(blob){blobs.push(blob);return 'blob:download';}static revokeObjectURL(){}}
  const sandbox={document,window:{addEventListener(){}},location:{pathname:'/workspace',search:'',hash:''},sessionStorage:{getItem(){return null;},setItem(){},removeItem(){}},URL:TestURL,Blob,AbortController,AbortSignal,DOMException,crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000090'},setInterval(){},setTimeout(){},clearTimeout(){}};
  vm.createContext(sandbox);vm.runInContext(appSource('main.js')+'\nglobalThis.testing={state,drawer,openReportExport,closeReportExport,downloadReport,exportView,tools:value=>reportToolsPromise=Promise.resolve(value)};',sandbox);
  const result=sandbox.testing;result.tools(tools);Object.assign(result.state,{connected:true,developmentAccess:true,report:{run:{run_id:runId,lifecycle:'completed',target_url:'https://fixture.test'},actions:[],captures:[],artifacts:[],events:[]}});return {...result,downloads,blobs,handlers,documentHandlers,node};
}
test('export drawer pins a snapshot and explains selected-run scope, integrity and training limits',()=>{
  const app=ui();app.openReportExport();app.state.report.run.target_url='changed';assert.equal(app.state.drawer.export.snapshot.run.target_url,'https://fixture.test');
  const html=app.drawer();for(const label of ['Download Markdown','Download evidence ZIP','Download JSON','Missing or unverified files','Related reproductions retain their own run IDs','does not approve data for training','64 MB per archive'])assert.ok(html.includes(label),label);
  assert.equal(app.downloads.length,0);assert.match(html,/role="dialog"/);
});
test('Markdown and JSON downloads keep the pinned data and stable run filename',async()=>{
  const inputs=[],app=ui({reportMarkdown:(report,opts)=>{inputs.push({report,opts});return '# Snapshot';},reportJson:report=>JSON.stringify(report)});app.openReportExport();const pinned=app.state.drawer.export.snapshot;
  await app.downloadReport('markdown');await app.downloadReport('json');assert.equal(app.downloads.length,2);assert.equal(app.downloads[0].filename,`spekios-run-${runId}.md`);assert.equal(app.downloads[1].filename,`spekios-run-${runId}.json`);assert.equal(inputs[0].report,pinned);assert.equal(inputs[0].opts.exportId,app.state.drawer.export.exportId);assert.equal(await app.blobs[0].text(),'# Snapshot');assert.deepEqual(JSON.parse(await app.blobs[1].text()),JSON.parse(JSON.stringify(pinned)));
});
test('ZIP export records progress and gaps without converting them to a fully complete report',async()=>{
  const app=ui({buildEvidenceBundle:async(report,opts)=>{opts.onProgress({processed:2,total:2,included:1,gaps:1,verifiedBytes:1024});return {blob:new Blob(['archive']),filename:'checked.zip',manifest:{evidence:[{status:'included'},{status:'failed_verification'}]}};}});app.openReportExport();await app.downloadReport('zip');
  assert.equal(app.downloads[0].filename,'checked.zip');assert.equal(app.state.drawer.export.result.gaps,1);assert.match(app.drawer(),/1 verified files and 1 evidence gaps/);assert.match(app.drawer(),/Inspect manifest.json/);
});
test('duplicate clicks make one export and Escape aborts in-flight evidence reads',async()=>{
  let resolve,started,signal,calls=0;const ready=new Promise(r=>started=r),app=ui({buildEvidenceBundle:async(report,opts)=>{calls++;signal=opts.signal;started();return new Promise(r=>resolve=r);}});app.openReportExport();const pending=app.downloadReport('zip');await ready;await app.downloadReport('zip');assert.equal(calls,1);
  app.documentHandlers.keydown[0]({key:'Escape',preventDefault(){}});assert.equal(signal.aborted,true);assert.equal(app.state.drawer,null);
  resolve({blob:new Blob(['archive']),filename:'late.zip',manifest:{evidence:[]}});await pending;assert.equal(app.downloads.length,0);
});
test('an old export cannot download or overwrite a new drawer after reconnecting',async()=>{
  let resolve,started;const ready=new Promise(r=>started=r),app=ui({buildEvidenceBundle:async()=>{started();return new Promise(r=>resolve=r);}});app.openReportExport();const pending=app.downloadReport('zip');await ready;
  app.closeReportExport();app.state.drawer=null;app.state.connected=false;app.state.developmentAccess=false;app.state.connected=true;app.state.developmentAccess=true;app.openReportExport();const newer=app.state.drawer;
  resolve({blob:new Blob(['old']),filename:'old.zip',manifest:{evidence:[]}});await pending;assert.equal(app.downloads.length,0);assert.equal(app.state.drawer,newer);assert.equal(newer.export.result,null);
});
test('export failure preserves the snapshot, displays escaped errors and permits retry',async()=>{
  let fail=true;const app=ui({buildEvidenceBundle:async()=>{if(fail)throw new Error('<script>failure</script>');return {blob:new Blob(['archive']),filename:'retry.zip',manifest:{evidence:[]}};}});app.openReportExport();const pinned=app.state.drawer.export.snapshot;
  await app.downloadReport('zip');assert.equal(app.state.drawer.export.busy,false);assert.equal(app.downloads.length,0);assert.equal(app.state.drawer.export.snapshot,pinned);assert.match(app.drawer(),/&lt;script&gt;/);assert.doesNotMatch(app.drawer(),/<script>/);fail=false;await app.downloadReport('zip');assert.equal(app.downloads.length,1);
});
test('active snapshots are visibly incomplete and invalid formats never start a download',async()=>{
  const app=ui();app.state.report.run.lifecycle='active';app.openReportExport();assert.match(app.drawer(),/still active/);assert.match(app.drawer(),/partial snapshot/);await app.downloadReport('other');assert.equal(app.downloads.length,0);
});
