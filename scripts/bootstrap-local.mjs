import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { root, postgres } from './local-clients.mjs';

async function sqlFiles(directory) {
  const names = (await readdir(new URL(directory, import.meta.url)))
    .filter(name => name.endsWith('.sql'))
    .sort();
  return Promise.all(names.map(name => readFile(new URL(directory + name, import.meta.url), 'utf8')));
}

// Idempotent bootstrap also handles volumes created before these initialization
// files existed. This is not a general schema migration engine. Filename order
// matches scripts/apply-schemas.sh and the database image entrypoints.
for (const file of await sqlFiles('../infra/postgres/')) {
  await postgres(file);
}
const sql = (await sqlFiles('../infra/clickhouse/')).join('\n');
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
