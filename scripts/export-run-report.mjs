import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {buildEvidenceBundle} from '../apps/web/report-bundle.js';

const runId=process.argv[2];
if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId||''))throw new Error('Usage: node scripts/export-run-report.mjs RUN_UUID');
const env=parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));
const fetchFile=(path,{signal}={})=>fetch('http://127.0.0.1:18080'+path,{headers:{Authorization:`Bearer ${env.SCOUT_API_TOKEN}`},signal:signal||AbortSignal.timeout(20000),redirect:'error'});
const response=await fetchFile(`/v1/runs/${runId}`);if(!response.ok)throw new Error(`Run request failed (${response.status}).`);
const report=await response.json(),exportId=randomUUID(),directory=new URL(`../artifacts/run-reports/${exportId}/`,import.meta.url);
const result=await buildEvidenceBundle(report,{exportId,generatedAt:new Date().toISOString(),fetchFile});
await mkdir(directory,{recursive:true,mode:0o700});const output=new URL(result.filename,directory);await writeFile(output,new Uint8Array(await result.blob.arrayBuffer()),{mode:0o600});
console.log(JSON.stringify({export_id:exportId,source_run_id:runId,path:output.pathname,evidence_status:result.manifest.evidence_status,verified_files:result.manifest.evidence.filter(e=>e.status==='included').length,gaps:result.manifest.evidence.filter(e=>e.status!=='included').length},null,2));
