import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const bucket = 'qa-evidence';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export const sqlString = value => "'" + String(value).replaceAll("'", "''") + "'";
export const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

export function validateReferenceCapture(entry) {
  if (!entry || !isUuid(entry.capture_id) || !isUuid(entry.event_id)
    || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)
    || !Number.isSafeInteger(entry.byte_length) || entry.byte_length < 1
    || entry.media_type !== 'image/png'
    || typeof entry.source_filename !== 'string' || !/^[A-Za-z0-9_.-]+\.png$/.test(entry.source_filename)
    || typeof entry.ingested_at !== 'string' || !Number.isFinite(Date.parse(entry.ingested_at))
    || entry.object_key !== `design-reference/blobs/sha256/${entry.sha256.slice(0, 2)}/${entry.sha256}.png`
    || entry.capture_key !== `design-reference/captures/${entry.capture_id}.json`) {
    throw new Error('Invalid reference capture metadata; no objects or database rows were changed.');
  }
}

export function validateReferenceManifest(manifest) {
  if (!manifest || manifest.schema_version !== 1 || !isUuid(manifest.archive_id)
    || manifest.bucket !== bucket || manifest.purpose !== 'design_reference'
    || manifest.training_status !== 'excluded_reference'
    || manifest.manifest_key !== `design-reference/archives/${manifest.archive_id}/manifest.json`
    || !Array.isArray(manifest.captures) || manifest.captures.length !== 7) {
    throw new Error('Invalid reference archive manifest; no objects or database rows were changed.');
  }
  manifest.captures.forEach(validateReferenceCapture);
  for (const field of ['capture_id', 'event_id', 'source_filename']) {
    if (new Set(manifest.captures.map(c => c[field])).size !== manifest.captures.length) {
      throw new Error(`Duplicate ${field} in reference archive.`);
    }
  }
}

export async function clients() {
  const env = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8'));
  for (const key of ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'CLICKHOUSE_PASSWORD']) {
    if (!env[key]) throw new Error(`Missing ${key}; run node scripts/setup-local.mjs`);
  }
  const s3 = new S3Client({
    endpoint: 'http://127.0.0.1:18333', region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    maxAttempts: 3,
  });
  const clickhouse = async query => {
    const response = await fetch('http://127.0.0.1:18123/?async_insert=0&wait_end_of_query=1', {
      method: 'POST', headers: { 'X-ClickHouse-User': 'scout', 'X-ClickHouse-Key': env.CLICKHOUSE_PASSWORD },
      body: query, signal: AbortSignal.timeout(30000),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`ClickHouse HTTP ${response.status}: ${body.slice(0, 500)}`);
    return body;
  };
  return { s3, clickhouse };
}

export async function getObject(s3, key) {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await object.Body.transformToByteArray());
}

// Never silently overwrite an existing immutable evidence object with different bytes.
export async function putVerified(s3, key, bytes, contentType) {
  let existing;
  try { existing = await getObject(s3, key); }
  catch (error) {
    if (error.name !== 'NoSuchKey' && error.$metadata?.httpStatusCode !== 404) throw error;
  }
  if (existing) {
    if (sha256(existing) !== sha256(bytes)) throw new Error(`Immutable evidence collision: ${key}`);
    return;
  }
  try {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes,
      IfNoneMatch: '*', ContentType: contentType, Metadata: { sha256: sha256(bytes) } }));
  } catch (error) {
    // Another writer may create the key after our first read. A conditional
    // conflict is successful only if the stored bytes are exactly ours.
    if (error.$metadata?.httpStatusCode !== 412 && error.name !== 'PreconditionFailed') throw error;
    if (sha256(await getObject(s3, key)) !== sha256(bytes)) throw new Error(`Immutable evidence collision: ${key}`);
    return;
  }
  if (sha256(await getObject(s3, key)) !== sha256(bytes)) throw new Error(`Readback hash mismatch: ${key}`);
}

export function postgres(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-X', '-qAt',
      '-U', 'scout', '-d', 'scout', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { cwd: root });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`PostgreSQL command failed (${code}): ${stderr.slice(0, 1000)}`)));
    child.stdin.on('error', () => {});
    child.stdin.end(sql);
  });
}

// Export only committed PostgreSQL outbox rows. Stable IDs tolerate crash after insert.
export async function flushOutbox(clickhouse) {
  const data = await postgres("SELECT coalesce(json_agg(payload ORDER BY occurred_at), '[]'::json) FROM evidence_outbox WHERE exported_at IS NULL;");
  const events = JSON.parse(data);
  if (!events.length) return 0;
  await clickhouse('INSERT INTO scout.evidence_events FORMAT JSONEachRow\n' + events.map(e => JSON.stringify(e)).join('\n'));
  const ids = events.map(e => sqlString(e.event_id)).join(',');
  await postgres(`UPDATE evidence_outbox SET exported_at=now() WHERE event_id IN (${ids});`);
  return events.length;
}
