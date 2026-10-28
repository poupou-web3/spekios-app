import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const path = process.argv[2] ?? '/v1/runs';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
if (!new RegExp(`^(/healthz|/readyz|/v1/capabilities|/v1/model-providers|/v1/usage|/v1/browser-jobs|/v1/operations|/v1/model-requests/${uuid}|/v1/runs(?:/${uuid}(?:/graph)?)?|/v1/captures/${uuid})$`).test(path)) {
  throw new Error('Expected a supported local read path with a valid UUID.');
}
const env = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8'));
if (!env.SCOUT_API_TOKEN) throw new Error('Run node scripts/setup-local.mjs first.');
const response = await fetch('http://127.0.0.1:18080' + path, {
  headers: { Authorization: `Bearer ${env.SCOUT_API_TOKEN}` }, signal: AbortSignal.timeout(10000), redirect: 'error',
});
if (!response.ok) throw new Error(`Local API returned HTTP ${response.status}`);
console.log(JSON.stringify(await response.json(), null, 2));
