import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {spawnSync} from 'node:child_process';
import {buildEvidenceBundle,reportMarkdown,reportEvidence} from '../apps/web/report-bundle.js';

const env=parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));
const fetchFile=(path,{signal}={})=>fetch('http://127.0.0.1:18080'+path,{headers:{Authorization:`Bearer ${env.SCOUT_API_TOKEN}`},signal:signal||AbortSignal.timeout(20000),redirect:'error'});
const get=async path=>{const r=await fetchFile(path);assert.equal(r.status,200,path);return r.json();};
const before=await get('/v1/operations'),{runs}=await get('/v1/runs'),reports=[];
for(const run of runs){const report=await get('/v1/runs/'+run.run_id);const markdown=reportMarkdown(report,{exportId:randomUUID(),generatedAt:new Date().toISOString()});assert.ok(markdown.replaceAll('\\','').includes(run.run_id));assert.ok(markdown.length>100);assert.ok(Array.isArray(reportEvidence(report)));reports.push(report);}
const selected=[reports.find(r=>!r.run.config.replay_of&&r.finding_reviews.some(v=>v.disposition==='confirmed')),reports.find(r=>r.captures.some(c=>c.status==='failed')),reports.find(r=>r.run.config.replay_of&&r.run.lifecycle==='completed')];
assert.ok(selected.every(Boolean),'Stored examples must include human review, a failed capture and a completed replay.');
const directory=new URL('../artifacts/report-export/',import.meta.url);await mkdir(directory,{recursive:true});const results=[];
for(const report of selected){
  const exportId=randomUUID(),result=await buildEvidenceBundle(report,{exportId,generatedAt:new Date().toISOString(),fetchFile});
  const path=new URL(result.filename,directory);await writeFile(path,new Uint8Array(await result.blob.arrayBuffer()));
  // Python's independent ZIP reader checks CRC32, path safety and byte hashes.
  const verified=spawnSync('python3',['-c',[
    'import sys,zipfile,json,hashlib,re',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' assert z.testzip() is None',
    ' names=z.namelist(); assert len(names)==len(set(names))',
    ' assert all(re.fullmatch(r"(?:report\\.(?:json|md)|manifest\\.json|(?:captures|artifacts)/[0-9a-f-]{36}\\.(?:png|json))",n) for n in names)',
    ' manifest=json.loads(z.read("manifest.json")); report=json.loads(z.read("report.json"))',
    ' assert manifest["source_run_id"]==report["run"]["run_id"]',
    ' assert set(names)=={"manifest.json"}|{f["path"] for f in manifest["files"]}',
    ' for f in manifest["files"]:',
    '  data=z.read(f["path"]); assert len(data)==f["byte_length"]; assert hashlib.sha256(data).hexdigest()==f["sha256"]',
    ' for e in manifest["evidence"]:',
    '  if e["status"]=="included":',
    '   data=z.read(e["path"]); assert len(data)==e["byteLength"]; assert hashlib.sha256(data).hexdigest()==e["sha256"]',
    '  else: assert e.get("path") not in names',
    ' print(json.dumps({"files":len(names),"verified":sum(e["status"]=="included" for e in manifest["evidence"]),"gaps":sum(e["status"]!="included" for e in manifest["evidence"])}))',
  ].join('\n'),path.pathname],{encoding:'utf8'});
  assert.equal(verified.status,0,verified.stderr);const check=JSON.parse(verified.stdout);if(report.captures.some(c=>c.status==='failed'))assert.ok(check.gaps>0);
  assert.equal(result.manifest.training_approval,false);assert.equal(result.manifest.related_run_evidence_included,false);results.push({run_id:report.run.run_id,path:path.pathname,...check});
}
const after=await get('/v1/operations');for(const key of ['runs','runtime_events','model_calls','captures'])assert.equal(after[key],before[key],`Export must not change ${key}.`);
const result={status:'passed',verified_at:new Date().toISOString(),reports_rendered:reports.length,archives:results,checks:['stored_reports_render_without_new_inference','confirmed_review_and_replay_remain_distinct','failed_capture_is_explicit_gap','independent_zip_crc_and_sha256_validation','only_manifest_listed_paths_present','no_model_calls_or_evidence_mutations']};
await writeFile(new URL('verification.json',directory),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
