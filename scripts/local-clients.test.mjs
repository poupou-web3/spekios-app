import test from 'node:test';
import assert from 'node:assert/strict';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { putVerified, sha256, sqlString, validateReferenceManifest } from './local-clients.mjs';

const body = bytes => ({ Body: { transformToByteArray: async () => bytes } });

test('existing identical evidence is verified without a write', async () => {
  let writes = 0;
  const bytes = Buffer.from('unchanged evidence');
  await putVerified({ send: async command => {
    if (command instanceof PutObjectCommand) writes++;
    return body(bytes);
  } }, 'capture.png', bytes, 'image/png');
  assert.equal(writes, 0);
});

test('different existing bytes are never overwritten', async () => {
  let writes = 0;
  await assert.rejects(() => putVerified({ send: async command => {
    if (command instanceof PutObjectCommand) writes++;
    return body(Buffer.from('old'));
  } }, 'capture.png', Buffer.from('new'), 'image/png'), /collision/);
  assert.equal(writes, 0);
});

test('new evidence is read back and corruption is rejected', async () => {
  let reads = 0, writes = 0;
  await assert.rejects(() => putVerified({ send: async command => {
    if (command instanceof GetObjectCommand) {
      if (++reads === 1) { const e = new Error(); e.name = 'NoSuchKey'; throw e; }
      return body(Buffer.from('corrupt'));
    }
    writes++;
    return {};
  } }, 'capture.png', Buffer.from('original'), 'image/png'), /hash mismatch/);
  assert.equal(writes, 1); assert.equal(reads, 2);
});

test('access denied does not fall through to overwrite', async () => {
  let writes = 0;
  await assert.rejects(() => putVerified({ send: async command => {
    if (command instanceof PutObjectCommand) writes++;
    const e = new Error('denied'); e.name = 'AccessDenied'; throw e;
  } }, 'capture.png', Buffer.from('image'), 'image/png'), /denied/);
  assert.equal(writes, 0);
});

test('SQL string literals preserve filenames with apostrophes', () => {
  assert.equal(sqlString("it's.png"), "'it''s.png'");
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('concurrent creation accepts equal bytes and rejects conflicting bytes', async () => {
  for (const equal of [true, false]) {
    let reads = 0;
    const bytes = Buffer.from('our capture');
    const request = () => putVerified({ send: async command => {
      if (command instanceof GetObjectCommand) {
        if (++reads === 1) { const error = new Error(); error.name = 'NoSuchKey'; throw error; }
        return body(equal ? bytes : Buffer.from('another capture'));
      }
      assert.equal(command.input.IfNoneMatch, '*');
      const error = new Error(); error.name = 'PreconditionFailed'; throw error;
    } }, 'capture.png', bytes, 'image/png');
    if (equal) await request();
    else await assert.rejects(request, /collision/);
    assert.equal(reads, 2);
  }
});

test('archive validation rejects corrupted identifiers, counts, keys and SQL-bound sizes', () => {
  const uuid = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const hash = sha256(Buffer.from('png'));
  const valid = {
    schema_version: 1, archive_id: uuid(99), bucket: 'qa-evidence',
    purpose: 'design_reference', training_status: 'excluded_reference',
    manifest_key: `design-reference/archives/${uuid(99)}/manifest.json`,
    captures: Array.from({ length: 7 }, (_, i) => ({
      capture_id: uuid(i + 1), event_id: uuid(i + 11), sha256: hash,
      byte_length: 3, media_type: 'image/png', source_filename: `screenshot-${i}.png`,
      ingested_at: '2026-10-21T10:00:00.000Z',
      object_key: `design-reference/blobs/sha256/${hash.slice(0, 2)}/${hash}.png`,
      capture_key: `design-reference/captures/${uuid(i + 1)}.json`,
    })),
  };
  validateReferenceManifest(valid);
  for (const change of [
    m => { m.captures[0].byte_length = '3); DROP TABLE reference_captures; --'; },
    m => { m.captures[0].byte_length = -1; },
    m => { m.captures[0].capture_id = 'not-a-uuid'; },
    m => { m.captures[0].object_key = 'some-other-object'; },
    m => { m.captures[0].event_id = m.captures[1].event_id; },
    m => { m.captures.pop(); },
  ]) {
    const invalid = structuredClone(valid);
    change(invalid);
    assert.throws(() => validateReferenceManifest(invalid));
  }
});
