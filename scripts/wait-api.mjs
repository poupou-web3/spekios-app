import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
const env=parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));
const end=Date.now()+30000;
let ready=false;
while(Date.now()<end) {
  try {
    const r=await fetch('http://127.0.0.1:18080/readyz',{headers:{Authorization:`Bearer ${env.SCOUT_API_TOKEN}`},signal:AbortSignal.timeout(2000),redirect:'error'});
    if(r.ok) { ready=true;break; }
  } catch {}
  await new Promise(r=>setTimeout(r,500));
}
if(!ready) throw new Error('API gateway did not become ready after schema bootstrap. Inspect docker compose logs api.');
console.log('Rust API and model gateway are ready.');
