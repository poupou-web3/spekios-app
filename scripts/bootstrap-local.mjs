import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { root, postgres } from './local-clients.mjs';

// Explicit idempotent bootstrap also handles volumes created before these
// initialization files existed. This is not a general schema migration engine.
for (const file of ['001-evidence.sql', '002-runtime.sql', '003-model-gateway.sql', '004-exploration.sql', '005-reproduction.sql', '006-browser-jobs.sql', '007-frontier-planning.sql', '008-browser-access.sql', '009-action-outcomes.sql', '010-cancellation.sql', '011-finding-reviews.sql', '012-automatic-reproduction.sql', '013-exploration-settings.sql', '014-agent-identity.sql', '015-agent-oauth.sql', '016-issue-verification.sql', '017-run-steering.sql', '018-meta-provider.sql', '019-app-memory.sql']) {
  await postgres(await readFile(new URL('../infra/postgres/' + file, import.meta.url), 'utf8'));
}
const sql = (await Promise.all(['001-evidence.sql', '002-runtime.sql', '003-model-gateway.sql', '004-agent-identity.sql', '005-issue-events.sql'].map(file => readFile(new URL('../infra/clickhouse/' + file, import.meta.url), 'utf8')))).join('\n');
await new Promise((resolve, reject) => {
  const child = spawn('docker', ['compose', 'exec', '-T', 'clickhouse', 'sh', '-c',
    'clickhouse-client --host 127.0.0.1 --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --receive_timeout 45 --multiquery'],
  { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve() : reject(new Error(`ClickHouse bootstrap failed (${code}): ${stderr.slice(0, 1000)}`)));
  child.stdin.on('error', () => {});
  child.stdin.end(sql);
});
console.log('PostgreSQL and ClickHouse evidence, runtime, model and exploration schemas are ready.');
