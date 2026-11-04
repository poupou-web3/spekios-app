#!/usr/bin/env node
// Recheck a deployment against every open Spekios issue, then wait for the
// verdicts. Built for CI after a deploy: no dependencies beyond Node 22.
//
//   node scripts/scout-recheck.mjs --candidate https://preview-42.example \
//     [--source https://staging.example] [--label "commit abc123"] [--strict]
//
// Token: SCOUT_TOKEN (an agent credential with runs:write) or, on the Spekios
// machine itself, SCOUT_API_TOKEN from .env. API: SCOUT_API (default local).
// Exit 0 when no issue is still reproducible (with --strict: and every issue
// was checked and resolved), 1 on regressions, 2 when the recheck was refused,
// 3 when it did not finish within --timeout seconds.
import { readFile } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const { values: args } = parseArgs({ options: {
  candidate: { type: 'string' }, source: { type: 'string' }, label: { type: 'string' }, 'recheck-id': { type: 'string' },
  api: { type: 'string' }, timeout: { type: 'string', default: '3600' }, strict: { type: 'boolean', default: false },
} });
const fail = (code, message) => { console.error(message); process.exit(code); };
if (!args.candidate) fail(2, 'Pass --candidate with the deployment URL to recheck.');
const api = (args.api ?? process.env.SCOUT_API ?? 'http://127.0.0.1:18080').replace(/\/+$/, '');
let token = process.env.SCOUT_TOKEN;
if (!token) {
  try { token = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8')).SCOUT_API_TOKEN; } catch { /* Not on the Spekios machine. */ }
}
if (!token) fail(2, 'Set SCOUT_TOKEN to a Spekios agent credential with runs:write.');
// The same recheck ID makes a retried CI step reuse every admitted check.
const recheckId = args['recheck-id'] ?? process.env.SCOUT_RECHECK_ID ?? randomUUID();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recheckId)) fail(2, 'The recheck ID must be a UUID.');

async function call(path, body) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(api + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(60000),
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
      const value = await response.json().catch(() => ({}));
      if (response.ok) return value;
      if (response.status < 500 || attempt >= 5) fail(2, `Spekios refused the recheck: ${value.error ?? 'HTTP ' + response.status}`);
    } catch (error) {
      if (attempt >= 5) fail(2, `Spekios is unreachable at ${api}: ${error.message}`);
    }
    await delay(2000 * attempt);
  }
}

const request = { recheck_id: recheckId, candidate_url: args.candidate };
if (args.source) request.source_origin = args.source;
if (args.label) request.deployment_ref = args.label;
let recheck = await call('/v1/rechecks', request);
console.log(`Recheck ${recheckId}: ${recheck.counts.selected} open issue(s) on ${recheck.candidate_origin}` +
  (recheck.omitted_issues ? `, ${recheck.omitted_issues} more not included` : '') + (recheck.counts.skipped ? `, ${recheck.counts.skipped} not checkable` : ''));
const deadline = Date.now() + Number(args.timeout) * 1000;
let last = '';
while (!recheck.complete) {
  if (Date.now() > deadline) fail(3, `Recheck ${recheckId} did not finish in ${args.timeout}s; ${recheck.counts.pending} check(s) still pending.`);
  await delay(10000);
  recheck = await call(`/v1/rechecks/${recheckId}`);
  const c = recheck.counts, line = `${c.pending} pending · ${c.resolved} resolved · ${c.still_reproducible} still reproducible · ${c.blocked} blocked · ${c.inconclusive} inconclusive`;
  if (line !== last) console.log(line), last = line;
}
for (const item of recheck.items) console.log(`${(item.outcome ?? 'not checkable: ' + item.skipped_reason).padEnd(20)} ${item.title ?? ''} ${api}/issues/${item.issue_id}`);
const c = recheck.counts;
console.log(JSON.stringify({ recheck_id: recheckId, candidate_origin: recheck.candidate_origin, deployment_ref: recheck.deployment_ref, counts: c, omitted_issues: recheck.omitted_issues }));
if (c.still_reproducible) fail(1, `${c.still_reproducible} issue(s) still reproduce on this deployment.`);
if (args.strict && (c.blocked || c.inconclusive || c.skipped || recheck.omitted_issues)) fail(1, 'Strict recheck: some issues could not be confirmed resolved.');
console.log('No open issue reproduces on this deployment.');
