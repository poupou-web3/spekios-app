import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { root, bucket, clients, sha256, jsonBytes, putVerified, postgres, sqlString as q, flushOutbox, validateReferenceManifest } from './local-clients.mjs';

const directory = root + 'artifacts/reference-screenshots/';
const manifestPath = directory + 'manifest.json';
await mkdir(directory, { recursive: true });
let lock;
try { lock = await open(directory + '.archive.lock', 'wx', 0o600); }
catch (error) {
  if (error.code === 'EEXIST') throw new Error('Archive is locked. If no archive process is running, remove artifacts/reference-screenshots/.archive.lock and rerun.');
  throw error;
}

try {
  const sourcePaths = JSON.parse(await readFile(new URL('./reference-sources.json', import.meta.url), 'utf8'));
  const sources = await Promise.all(sourcePaths.map(async path => ({ filename: basename(path), bytes: await readFile(path) })));
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const archiveId = randomUUID(), createdAt = new Date().toISOString();
    manifest = { schema_version: 1, archive_id: archiveId, created_at: createdAt,
      purpose: 'design_reference', training_status: 'excluded_reference', bucket,
      manifest_key: `design-reference/archives/${archiveId}/manifest.json`,
      captures: sources.map(({ filename, bytes }) => {
        const captureId = randomUUID(), hash = sha256(bytes);
        return { capture_id: captureId, event_id: randomUUID(), source_filename: filename,
          sha256: hash, byte_length: bytes.length, media_type: 'image/png',
          object_key: `design-reference/blobs/sha256/${hash.slice(0, 2)}/${hash}.png`,
          capture_key: `design-reference/captures/${captureId}.json`, ingested_at: createdAt };
      }) };
    const temp = await open(manifestPath + '.tmp', 'wx', 0o644);
    try { await temp.writeFile(jsonBytes(manifest)); await temp.sync(); } finally { await temp.close(); }
    await rename(manifestPath + '.tmp', manifestPath);
  }
  validateReferenceManifest(manifest);
  if (sources.length !== manifest.captures.length) throw new Error('Source count changed; existing archive was not modified.');
  const { s3, clickhouse } = await clients();
  for (const entry of manifest.captures) {
    const source = sources.find(s => s.filename === entry.source_filename);
    if (!source || sha256(source.bytes) !== entry.sha256 || source.bytes.length !== entry.byte_length) {
      throw new Error(`Source changed or missing: ${entry.source_filename}`);
    }
    await putVerified(s3, entry.object_key, source.bytes, entry.media_type);
    await putVerified(s3, entry.capture_key, jsonBytes({ ...entry, archive_id: manifest.archive_id,
      purpose: manifest.purpose, training_status: manifest.training_status, bucket }), 'application/json');
  }
  await putVerified(s3, manifest.manifest_key, jsonBytes(manifest), 'application/json');
  const statements = ['BEGIN;'];
  for (const e of manifest.captures) {
    const event = { event_id: e.event_id, event_type: 'reference_capture.archived',
      occurred_at: e.ingested_at.replace('T', ' ').replace('Z', ''), archive_id: manifest.archive_id,
      capture_id: e.capture_id, sha256: e.sha256, byte_length: e.byte_length, bucket,
      object_key: e.object_key, purpose: manifest.purpose, training_status: manifest.training_status };
    statements.push(`INSERT INTO evidence_blobs VALUES (${q(e.sha256)},${q(bucket)},${q(e.object_key)},${e.byte_length},${q(e.media_type)}) ON CONFLICT DO NOTHING;`);
    statements.push(`INSERT INTO reference_captures VALUES (${q(e.capture_id)},${q(manifest.archive_id)},${q(e.sha256)},${q(e.source_filename)},${q(e.ingested_at)},${q(manifest.purpose)},${q(manifest.training_status)}) ON CONFLICT DO NOTHING;`);
    statements.push(`INSERT INTO evidence_outbox(event_id,event_type,occurred_at,payload) VALUES (${q(e.event_id)},${q(event.event_type)},${q(e.ingested_at)},${q(JSON.stringify(event))}::jsonb) ON CONFLICT DO NOTHING;`);
  }
  statements.push('COMMIT;');
  await postgres(statements.join('\n'));
  const exported = await flushOutbox(clickhouse);
  console.log(JSON.stringify({ archive_id: manifest.archive_id, captures_verified: manifest.captures.length,
    total_original_bytes: manifest.captures.reduce((n, c) => n + c.byte_length, 0),
    newly_exported_events: exported, manifest: 'artifacts/reference-screenshots/manifest.json' }, null, 2));
  s3.destroy();
} finally {
  await lock.close();
  await unlink(directory + '.archive.lock');
}
