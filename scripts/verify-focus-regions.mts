// Integration fixtures test transport/evidence and fallback, not model quality.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Store} from '../packages/browser-runtime/src/store.js';
import {explore} from '../packages/browser-runtime/src/explorer.js';
import {ModelClient} from '../packages/browser-runtime/src/model-client.js';
import {explorerReply} from '../infra/model-fixture/explorer.mjs';
const require=createRequire(new URL('../packages/browser-runtime/package.json',import.meta.url));
const {Pool}=require('pg'),{S3Client}=require('@aws-sdk/client-s3'),{chromium}=require('playwright');
const pngRequire=createRequire(new URL('../packages/image-diff/package.json',import.meta.url)),{PNG}=pngRequire('pngjs');
assert.equal(process.env.SCOUT_FOCUS_E2E,'1');assert.equal(process.env.PGHOST,'127.0.0.1');assert.equal(process.env.PGDATABASE,'focus_regions_e2e');
const root=resolve(new URL('..',import.meta.url).pathname),temp=await mkdtemp(join(tmpdir(),'focus-regions-'));
const token=randomBytes(32).toString('hex'),pool=new Pool({host:process.env.PGHOST,port:Number(process.env.PGPORT),database:process.env.PGDATABASE,user:process.env.PGUSER,password:process.env.POSTGRES_PASSWORD});
const objects=new Map<string,Buffer>(),calls:any[]=[];let api:any,store:Store|undefined,browserServer:any;
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const server=createServer(async(req,res)=>{try{
 const url=new URL(req.url!,'http://localhost'),path=decodeURIComponent(url.pathname);const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks);
 if(path==='/meta'){
   const wire=JSON.parse(body.toString()),input=JSON.parse(wire.input[0].content[0].text),images=wire.input[0].content.filter((c:any)=>c.type==='input_image').map((c:any)=>Buffer.from(c.image_url.split(',')[1],'base64'));
   const reply=explorerReply(input);
   if(input.action?.type==='click'&&input.response_schema?.needs_full_context!==undefined&&(input.visual_input?.mode==='overview_and_crops'&&input.after.url.includes('/context-needed')||input.after?.url.includes('/context-unavailable')))reply.needs_full_context=true;
   if(input.after?.url.includes('/suspicion')&&input.action?.type==='click'){reply.verdict='suspect';reply.reason='The fixture requests a fresh full-screen assessment.';}
   calls.push({input,images});res.setHeader('content-type','application/json');res.end(JSON.stringify({id:randomUUID(),status:'completed',model:wire.model,output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(reply)}]}],usage:{input_tokens:20,output_tokens:10}}));return;
 }
 if(path.startsWith('/qa-evidence/')){
   if(req.method==='PUT'){if(objects.has(path)&&req.headers['if-none-match']==='*'){res.writeHead(412);res.end();return;}objects.set(path,body);res.setHeader('etag','"'+sha(body)+'"');res.end();return;}
   const object=objects.get(path);if(!object){res.writeHead(404);res.end();return;}
   res.setHeader('content-length',object.length);res.setHeader('etag','"'+sha(object)+'"');res.setHeader('last-modified',new Date('2026-01-01').toUTCString());res.end(req.method==='HEAD'?undefined:object);return;
 }
 if(path==='/clickhouse'){res.end();return;}
 res.setHeader('content-type','text/html');
 const noChange=path==='/broken';
 res.end(`<!doctype html><title>Draft editor</title><style>body{font-family:Arial;margin:80px}button,button:hover,button:focus,button:active{background:#eee;color:black;border:1px solid black;outline:none;box-shadow:none}#state{margin-top:24px}</style><h1>Draft editor</h1><p>Manage and save your draft.</p><button onclick="${noChange?'void 0':"document.getElementById('state').textContent='Saved'"}">Save draft</button><p id="state">Ready</p>`);
 }catch(error){res.writeHead(500);res.end(String(error));}});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const fixture=`http://127.0.0.1:${(server.address() as any).port}`;
const reserve=createServer();await new Promise<void>(r=>reserve.listen(0,'127.0.0.1',r));const port=(reserve.address() as any).port;await new Promise<void>(r=>reserve.close(()=>r()));const endpoint=`http://127.0.0.1:${port}`;
const env={...process.env,SCOUT_API_TOKEN:token,SCOUT_API_BIND:`127.0.0.1:${port}`,SCOUT_PUBLIC_ORIGIN:'',SCOUT_DEV_AUTH_BYPASS:'false',SCOUT_ALLOWED_ORIGINS:fixture,SPEKIOS_AUTH_ORIGIN:'',SPEKIOS_ISSUER:'',SPEKIOS_CLIENT_ID:'',SPEKIOS_CLIENT_SECRET:'',SPEKIOS_REDIRECT_URI:'',SCOUT_PROVIDER_VAULT_KEY:randomBytes(32).toString('hex'),SCOUT_MODEL_TEST_MODE:'1',SCOUT_MODEL_FIXTURE_URL:fixture,S3_ENDPOINT:fixture,S3_ACCESS_KEY_ID:'disposable-focus-storage',S3_SECRET_ACCESS_KEY:'disposable-focus-storage-secret',CLICKHOUSE_URL:fixture+'/clickhouse',CLICKHOUSE_PASSWORD:'disposable-focus-clickhouse',MODEL_SPOOL:join(temp,'gateway'),RECORDER_SPOOL:join(temp,'recorder'),SCOUT_BROWSER_ENDPOINT:'',PGSSLMODE:'disable'};
Object.assign(process.env,env);
const s3=new S3Client({endpoint:fixture,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:env.S3_ACCESS_KEY_ID,secretAccessKey:env.S3_SECRET_ACCESS_KEY}});
async function request(path:string,body?:any){const r=await fetch(endpoint+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};}
try{
 api=spawn(join(root,'apps/api/target/debug/scout-api'),[],{cwd:root,env,stdio:['ignore','ignore','pipe']});let log='';api.stderr.on('data',(b:Buffer)=>log=(log+b).slice(-8000));
 for(let n=0;n<100;n++){if(api.exitCode!==null)throw Error(log);try{const ready=await request('/v1/model-providers');if(ready.data.gateway_ready)break;}catch{}await delay(100);}
 store=await new Store({pool,s3}).open();console.log('Isolated gateway ready.');
 const client=new ModelClient({provider:'meta',model:'scout-focus-fixture',freeOnly:false},endpoint,token);
 assert.equal(await client.ready(),'protocol_fixture');
 async function run(path:string){
  browserServer=await chromium.launchServer({host:'127.0.0.1',headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});process.env.SCOUT_BROWSER_ENDPOINT=browserServer.wsEndpoint();
  console.log('Checking fixture '+path);const result=await explore(store!,fixture+path,{client,allowedOrigins:[fixture],maxActions:2,appMemory:true,maxDurationMs:90000,autoReproduce:false});
  await browserServer.close();browserServer=null;assert.equal(result.report.run.lifecycle,'completed',result.report.run.error??log);assert.equal(result.report.actions.length,2);return result.report;
 }
 const normal=await run('/working'),action=normal.actions[1],visual=action.comparison.assessment_images;
 assert.equal(visual.mode,'overview_and_crops');assert(visual.pixel_fraction<.65);
 assert(action.comparison.focus_regions.regions.every((r:any)=>r.width*r.height<=normal.run.config.viewport.width*normal.run.config.viewport.height/4));
 assert.equal(sha(await store.captureBytes(action.after_capture_id)),normal.captures.find((c:any)=>c.capture_id===action.after_capture_id).sha256);assert.equal(action.assessment.verdict,'no_issue_observed');
 const received=calls.find(c=>c.input.task==='assessment'&&c.input.action.type==='click'&&c.input.after.url===fixture+'/working');assert(received);assert.equal(received.images.length,2);
 for(const image of received.images){const p=PNG.sync.read(image);assert.equal(p.width,visual.width);assert.equal(p.height,visual.height);}
 assert.equal(received.input.site_context.entry_url,fixture+'/working');assert(received.input.site_context.requirements_source.includes('not_provided'));
 assert(received.input.instruction.includes('focus crops first'));assert.deepEqual(received.input.visual_input.source_capture_ids,[action.before_capture_id,action.after_capture_id]);
 const requests=(await pool.query('SELECT spec FROM model_requests WHERE action_id=$1',[action.action_id])).rows;assert(requests.some((r:any)=>r.spec?.assessment_image_ids?.length===2));
 const full=await run('/context-needed'),clicked=full.actions[1];assert(clicked.assessment.visual_screening);assert.equal(clicked.assessment.verdict,'no_issue_observed');
 const fullCall=calls.filter(c=>c.input.action?.type==='click'&&c.input.after.url===fixture+'/context-needed');assert.equal(fullCall.length,2);assert.equal(fullCall[1].input.visual_input.mode,'full');
 assert(fullCall[1].images.every((b:Buffer)=>PNG.sync.read(b).width===normal.run.config.viewport.width));
 const unavailable=await run('/context-unavailable');assert.equal(unavailable.actions[1].assessment.verdict,'inconclusive');assert(unavailable.actions[1].assessment.visual_screening);
 const suspected=await run('/suspicion');assert(suspected.actions[1].assessment.visual_screening);assert.equal(suspected.actions[1].assessment.verdict,'suspect');
 const broken=await run('/broken');assert.equal(broken.actions[1].comparison.counts.changed_pixels,0);assert.equal(broken.actions[1].comparison.assessment_images.mode,'full');assert.equal(broken.actions[1].assessment.verdict,'suspect');
 // The gateway refuses unrelated artifacts and mismatched authoritative pairs.
 const raw=action.comparison.raw_mask_artifact.artifact_id,spec={request_id:randomUUID(),run_id:normal.run.run_id,action_id:action.action_id,provider:'meta',model:'scout-focus-fixture',prompt:'Local admission test',capture_ids:[action.before_capture_id,action.after_capture_id],assessment_image_ids:[raw,raw],free_only:false,max_attempts:1};
 assert.equal((await request('/v1/model-requests',spec)).data.error,'assessment_image_unavailable_or_unlinked');
 assert.equal((await request('/v1/model-requests',{...spec,request_id:randomUUID(),assessment_image_ids:visual.artifacts.map((a:any)=>a.artifact_id),capture_ids:[action.after_capture_id,action.before_capture_id]})).data.error,'assessment_image_unavailable_or_unlinked');
 const foreign=full.actions[1].comparison.assessment_images.artifacts.map((a:any)=>a.artifact_id);assert.equal((await request('/v1/model-requests',{...spec,request_id:randomUUID(),assessment_image_ids:foreign})).data.error,'assessment_image_unavailable_or_unlinked');
 const imageKey='/qa-evidence/'+visual.artifacts[0].object_key,originalBytes=objects.get(imageKey)!;objects.set(imageKey,Buffer.from('corrupted fixture bytes'));
 const tamperedId=randomUUID(),beforeCalls=calls.length;assert.equal((await request('/v1/model-requests',{...spec,request_id:tamperedId,assessment_image_ids:visual.artifacts.map((a:any)=>a.artifact_id)})).status,202);
 let tampered:any;for(let n=0;n<100;n++){tampered=(await request('/v1/model-requests/'+tamperedId)).data;if(tampered.request.state==='failed')break;await delay(100);}
 assert.equal(tampered.request.state,'failed');assert.equal(tampered.calls.length,0);assert.equal(calls.length,beforeCalls);objects.set(imageKey,originalBytes);
 const out=join(root,'artifacts/focus-regions');await mkdir(out,{recursive:true});await writeFile(join(out,'before-model.png'),received.images[0]);await writeFile(join(out,'after-model.png'),received.images[1]);
 await writeFile(join(out,'verification.json'),JSON.stringify({passed:true,pixel_fraction:visual.pixel_fraction,source_pixels:visual.source_pixels_per_image,sent_pixels:visual.sent_pixels_per_image,checks:['real explorer and gateway','quarter-area capped regions','original evidence retained','reduced overview plus native crops actually dispatched','site context preserved','full-screen context request fallback','suspicions checked on full screenshots','zero-change failure retains full evidence','unrelated or mismatched artifacts refused','corrupted derivative refused before provider dispatch','insufficient full-screen context remains inconclusive'],live_provider_calls:0,token_savings_measured:false},null,2)+'\n');
 console.log('Focus-region browser/gateway verification passed; '+Math.round(visual.pixel_fraction*100)+'% of source image pixels sent in the localized fixture. No live provider calls.');
}finally{await browserServer?.close();await store?.close();if(api&&api.exitCode===null){const done=new Promise(r=>api.once('exit',r));api.kill('SIGTERM');await done;}await pool.end();s3.destroy();await new Promise<void>(r=>server.close(()=>r()));await rm(temp,{recursive:true,force:true});}
