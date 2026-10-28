import { randomBytes } from 'node:crypto';
import { appendFile, chmod, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../.env', import.meta.url));
try {
  const existing = await readFile(path, 'utf8');
  for (const key of ['POSTGRES_PASSWORD', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'CLICKHOUSE_PASSWORD']) {
    if (!new RegExp(`^${key}=[A-Za-z0-9_-]{24,}$`, 'm').test(existing)) {
      throw new Error(`${key} is missing or invalid in .env. Existing credentials were not changed.`);
    }
  }
  await chmod(path, 0o600);
  if (!/^SCOUT_API_TOKEN=/m.test(existing)) {
    await appendFile(path, `\nSCOUT_API_TOKEN=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  } else if (!/^SCOUT_API_TOKEN=[A-Za-z0-9_-]{32,}$/m.test(existing)) {
    throw new Error('SCOUT_API_TOKEN is invalid. Existing credentials were not changed.');
  }
  console.log('Existing .env preserved; permissions set to 0600.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const token = () => randomBytes(32).toString('hex');
  const value = ['# Local development credentials. Keep private.',
    `POSTGRES_PASSWORD=${token()}`, `S3_ACCESS_KEY_ID=${token()}`,
    `S3_SECRET_ACCESS_KEY=${token()}`, `CLICKHOUSE_PASSWORD=${token()}`, `SCOUT_API_TOKEN=${token()}`, ''].join('\n');
  await writeFile(path, value, { mode: 0o600, flag: 'wx' });
  console.log('Created .env with independent random credentials and permissions 0600.');
}
