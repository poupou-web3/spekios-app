import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { root, clients, bucket, getObject, putVerified, postgres, sqlString, flushOutbox, validateReferenceManifest, sha256 } from './local-clients.mjs';

const manifest = JSON.parse(await readFile(root + 'artifacts/reference-screenshots/manifest.json', 'utf8'));
validateReferenceManifest(manifest);
const { s3, clickhouse } = await clients();
const probeKey = `verification/${randomUUID()}.bin`;
let probeCreated = false;
const temporary = await mkdtemp(join(tmpdir(), 'scout-capture-check-'));
try {
  const capture = manifest.captures[0];
  const output = join(temporary, 'capture.png');
  await promisify(execFile)(process.execPath, [root + 'scripts/get-reference-capture.mjs', capture.capture_id, output]);
  assert.equal(sha256(await readFile(output)), capture.sha256);
  await assert.rejects(() => promisify(execFile)(process.execPath,
    [root + 'scripts/get-reference-capture.mjs', capture.capture_id, output]), /EEXIST/);
  const original = Buffer.from('scout storage conditional-write verification');
  await putVerified(s3, probeKey, original, 'application/octet-stream');
  probeCreated = true;
  await assert.rejects(() => s3.send(new PutObjectCommand({
    Bucket: bucket, Key: probeKey, Body: Buffer.from('must not replace original'), IfNoneMatch: '*',
  })), error => error.$metadata?.httpStatusCode === 412, 'S3 must enforce conditional creation');
  assert.deepEqual(await getObject(s3, probeKey), original);

  // Replay one real archive event, as after an exporter crash. Required domain
  // state is unchanged; only its acknowledgement is reset for this local test.
  const id = sqlString(manifest.captures[0].event_id);
  await postgres(`UPDATE evidence_outbox SET exported_at=NULL WHERE event_id=${id};`);
  await assert.rejects(() => flushOutbox(async () => { throw new Error('simulated exporter outage'); }), /simulated exporter outage/);
  assert.equal(await postgres(`SELECT count(*) FROM evidence_outbox WHERE event_id=${id} AND exported_at IS NULL;`), '1');
  await flushOutbox(clickhouse);
  assert.equal(await postgres('SELECT count(*) FROM evidence_outbox WHERE exported_at IS NULL;'), '0');
  const counts = JSON.parse(await clickhouse('SELECT count() AS events, uniqExact(capture_id) AS captures FROM scout.evidence_events_current FORMAT JSONEachRow'));
  assert.equal(Number(counts.events), 7);
  assert.equal(Number(counts.captures), 7);
  console.log(JSON.stringify({ result: 'PASS', capture_id_retrieval: true, overwrite_refused: true,
    conditional_creation: true, failed_export_retained: true,
    duplicate_delivery_logical_events: Number(counts.events), archive_id: manifest.archive_id }));
} finally {
  if (probeCreated) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: probeKey }));
  s3.destroy();
  await rm(temporary, { recursive: true, force: true });
}
