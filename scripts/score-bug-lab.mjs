#!/usr/bin/env node
// Score one or more Scout runs of the Larchwood shop against its bug list.
//
//   node scripts/score-bug-lab.mjs RUN_ID [RUN_ID...] [--json] [--api http://127.0.0.1:18080]
//
// Token: SCOUT_TOKEN, else SCOUT_API_TOKEN from this checkout's .env. With the
// local development bypass on, no token is needed. Reads runs only.
import { readFile } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';
import { formatReport, scoreRun } from '../apps/bug-lab/score.mjs';

const { values: args, positionals: runIds } = parseArgs({ allowPositionals: true, options: {
  json: { type: 'boolean', default: false }, api: { type: 'string' }, manifest: { type: 'string' },
} });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!runIds.length || !runIds.every(id => uuid.test(id))) {
  console.error('Pass one or more run IDs: node scripts/score-bug-lab.mjs RUN_ID [RUN_ID...]');
  process.exit(2);
}
const api = (args.api ?? process.env.SCOUT_API ?? 'http://127.0.0.1:18080').replace(/\/+$/, '');
let token = process.env.SCOUT_TOKEN;
if (!token) {
  try { token = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8')).SCOUT_API_TOKEN; } catch { /* Not on the Scout machine, or bypass mode. */ }
}
const manifest = JSON.parse(await readFile(args.manifest ?? new URL('../apps/bug-lab/bugs.json', import.meta.url), 'utf8'));

const scores = [];
for (const id of runIds) {
  const response = await fetch(`${api}/v1/runs/${id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, redirect: 'error', signal: AbortSignal.timeout(30000) })
    .catch(error => { console.error(`Scout is unreachable at ${api}: ${error.message}`); process.exit(2); });
  if (!response.ok) {
    console.error(`Run ${id}: HTTP ${response.status}${response.status === 401 ? ' (set SCOUT_TOKEN)' : ''}`);
    process.exit(2);
  }
  scores.push(scoreRun(await response.json(), manifest));
}
console.log(args.json ? JSON.stringify(scores, null, 2) : formatReport(scores));
