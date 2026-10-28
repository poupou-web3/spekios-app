import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { root, clients, bucket, getObject, sha256, jsonBytes, postgres, validateReferenceManifest } from './local-clients.mjs';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';

const manifest = JSON.parse(await readFile(root + 'artifacts/reference-screenshots/manifest.json', 'utf8'));
validateReferenceManifest(manifest);
const { s3, clickhouse } = await clients();
const anonymous = await fetch(`http://127.0.0.1:18333/${bucket}/${manifest.captures[0].object_key}`, { signal: AbortSignal.timeout(10000) });
assert.equal(anonymous.status, 403, 'Unauthenticated image access must be denied');
await anonymous.arrayBuffer();
assert.equal(new Set(manifest.captures.map(c => c.capture_id)).size, 7);
assert.equal(sha256(await getObject(s3, manifest.manifest_key)), sha256(jsonBytes(manifest)));
for (const e of manifest.captures) {
  const bytes = await getObject(s3, e.object_key);
  assert.equal(sha256(bytes), e.sha256);
  assert.equal(bytes.length, e.byte_length);
  const capture = JSON.parse(await getObject(s3, e.capture_key));
  assert.equal(capture.capture_id, e.capture_id);
  assert.equal(capture.sha256, e.sha256);
  assert.equal(capture.purpose, 'design_reference');
  assert.equal(capture.training_status, 'excluded_reference');
}
const pg = JSON.parse(await postgres("SELECT json_build_object('captures',(SELECT count(*) FROM reference_captures),'blobs',(SELECT count(*) FROM evidence_blobs),'pending',(SELECT count(*) FROM evidence_outbox WHERE exported_at IS NULL),'events',(SELECT count(*) FROM evidence_outbox));"));
assert.equal(pg.captures, 7); assert.equal(pg.blobs, 7); assert.equal(pg.pending, 0); assert.equal(pg.events, 7);
const pgRows = JSON.parse(await postgres("SELECT json_agg(json_build_object('capture_id',capture_id,'sha256',sha256) ORDER BY capture_id) FROM reference_captures;"));
assert.deepEqual(pgRows, manifest.captures.map(e => ({capture_id:e.capture_id,sha256:e.sha256})).sort((a,b) => a.capture_id.localeCompare(b.capture_id)));
const ch = JSON.parse(await clickhouse('SELECT count() AS events, uniqExact(capture_id) AS captures FROM scout.evidence_events_current FORMAT JSONEachRow'));
assert.equal(Number(ch.events), 7); assert.equal(Number(ch.captures), 7);
const objects = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'design-reference/' }));
assert.equal(objects.IsTruncated, false);
assert.equal(objects.KeyCount, 15);
console.log(JSON.stringify({ result: 'PASS', anonymous_object_http_status: anonymous.status, verified_captures: 7, bucket_objects: objects.KeyCount,
  postgres: pg, clickhouse: ch, archive_id: manifest.archive_id }, null, 2));
s3.destroy();
