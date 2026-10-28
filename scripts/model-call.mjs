import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
const file=process.argv[2];
if(!file) throw new Error('Usage: node scripts/model-call.mjs request.json');
const body=await readFile(file,'utf8');
if(Buffer.byteLength(body)>65536) throw new Error('Model request exceeds 64 KiB.');
JSON.parse(body);
const env=parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));
if(!env.SCOUT_API_TOKEN) throw new Error('Run node scripts/setup-local.mjs first.');
const r=await fetch('http://127.0.0.1:18080/v1/model-requests',{
  method:'POST',headers:{Authorization:`Bearer ${env.SCOUT_API_TOKEN}`,'content-type':'application/json'},
  body,signal:AbortSignal.timeout(15000),redirect:'error',
});
const result=await r.json();
if(!r.ok) throw new Error(`Model request rejected (${r.status}): ${result.error ?? 'invalid_request'}`);
console.log(JSON.stringify(result,null,2));
