import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PNG } from 'pngjs';
import { comparePng, compareFiles, changedPixelsInRects, LIMITS } from '../index.mjs';

const exec = promisify(execFile);
const ids = { beforeCaptureId: 'cap-before', afterCaptureId: 'cap-after' };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fixture(width, height, mutate = () => {}, options = {}) {
  const image = new PNG({ width, height });
  image.data.fill(100);
  for (let index = 3; index < image.data.length; index += 4) image.data[index] = 255;
  mutate(image.data);
  return PNG.sync.write(image, options);
}
const pixel = (png, x, y) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)];

test('control relevance counts actual changed pixels, including one pixel, rather than a broad bounding box',()=>{
  const before=fixture(5,3),after=fixture(5,3,data=>{data[0]=101;data[(2*5+4)*4]=101;});
  const {rawMaskPng}=comparePng(before,after,ids);
  assert.deepEqual(changedPixelsInRects(rawMaskPng,[{x:0,y:0,width:1,height:1},{x:2,y:1,width:1,height:1},{x:-1,y:-1,width:7,height:5}]),[
    {changed_pixels:1,sampled_pixels:1},{changed_pixels:0,sampled_pixels:1},{changed_pixels:2,sampled_pixels:15},
  ]);
});

test('identical pixels yield an empty opaque mask, exact byte hashes, and separate capture references', () => {
  const input = fixture(3, 2);
  const original = Buffer.from(input);
  const result = comparePng(input, input, ids);
  assert.deepEqual(input, original);
  assert.equal(result.metadata.before.sha256, hash(input));
  assert.equal(result.metadata.after.sha256, hash(input));
  assert.equal(result.metadata.before_capture_id, ids.beforeCaptureId);
  assert.equal(result.metadata.after_capture_id, ids.afterCaptureId);
  assert.equal(result.metadata.counts.changed_pixels, 0);
  assert.equal(result.metadata.decoded_pixels_identical, true);
  assert.equal(result.metadata.changed_bbox, null);
  assert.equal(result.geometryMaskPng, null);
  assert.equal(result.metadata.bug_verdict, null);
  assert.deepEqual(pixel(PNG.sync.read(result.rawMaskPng), 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(pixel(PNG.sync.read(result.absoluteDeltaPng), 0, 0), [0, 0, 0, 0]);
});

test('one channel changing by one at one pixel survives without thresholding', () => {
  const before = fixture(4, 3);
  const after = fixture(4, 3, (data) => { data[(1 * 4 + 2) * 4] = 101; });
  const { metadata, rawMaskPng, absoluteDeltaPng } = comparePng(before, after, ids);
  assert.equal(metadata.counts.changed_pixels, 1);
  assert.equal(metadata.max_overlap_channel_delta, 1);
  assert.deepEqual(metadata.changed_bbox, { x: 2, y: 1, width: 1, height: 1 });
  const mask = PNG.sync.read(rawMaskPng);
  assert.deepEqual(pixel(mask, 2, 1), [255, 255, 255, 255]);
  assert.deepEqual(pixel(mask, 1, 1), [0, 0, 0, 255]);
  assert.deepEqual(pixel(PNG.sync.read(absoluteDeltaPng), 2, 1), [1, 0, 0, 0]);
});

test('alpha-only changes and RGB changes under fully transparent pixels are preserved', () => {
  const before = fixture(2, 1, (data) => { data[7] = 0; });
  const after = fixture(2, 1, (data) => { data[3] = 254; data[4] = 103; data[7] = 0; });
  const result = comparePng(before, after, ids);
  assert.equal(result.metadata.counts.overlap_changed_pixels, 2);
  const delta = PNG.sync.read(result.absoluteDeltaPng);
  assert.deepEqual(pixel(delta, 0, 0), [0, 0, 0, 1]);
  assert.deepEqual(pixel(delta, 1, 0), [3, 0, 0, 0]);
});

test('dimension changes mark added and removed areas without fabricating pixels outside both images', () => {
  const result = comparePng(fixture(3, 1), fixture(1, 3), ids);
  assert.equal(result.metadata.geometry_changed, true);
  assert.deepEqual(result.metadata.counts, {
    changed_pixels: 4, overlap_pixels: 1, overlap_changed_pixels: 0,
    added_pixels: 2, removed_pixels: 2, union_pixels: 5, outside_both_pixels: 4,
  });
  assert.deepEqual(result.metadata.changed_bbox, { x: 0, y: 0, width: 3, height: 3 });
  const geometry = PNG.sync.read(result.geometryMaskPng);
  assert.deepEqual(pixel(geometry, 1, 0), [255, 0, 255, 255]);
  assert.deepEqual(pixel(geometry, 0, 1), [0, 255, 0, 255]);
  assert.deepEqual(pixel(geometry, 1, 1), [0, 0, 0, 255]);
  assert.deepEqual(pixel(PNG.sync.read(result.rawMaskPng), 1, 1), [0, 0, 0, 255]);
  assert.deepEqual(pixel(PNG.sync.read(result.absoluteDeltaPng), 1, 0), [0, 0, 0, 0]);
});

test('pixel equality is separate from PNG byte equality', () => {
  const before = fixture(3, 2, undefined, { filterType: 0 });
  const after = fixture(3, 2, undefined, { filterType: 4 });
  assert.notDeepEqual(before, after);
  const result = comparePng(before, after, ids);
  assert.equal(result.metadata.encoded_bytes_identical, false);
  assert.equal(result.metadata.decoded_pixels_identical, true);
});

test('invalid, truncated, corrupt, unsupported, and oversized inputs fail explicitly', () => {
  const good = fixture(1, 1);
  assert.throws(() => comparePng(Buffer.from('not a PNG'), good, ids), /PNG header/);
  assert.throws(() => comparePng(good.subarray(0, good.length - 2), good, ids), /PNG ending|truncated/);
  const corrupt = Buffer.from(good);
  corrupt[29] ^= 1; // IHDR CRC, not the dimension fields.
  assert.throws(() => comparePng(corrupt, good, ids), /could not be decoded as a valid PNG/);
  const huge = Buffer.from(good);
  huge.writeUInt32BE(LIMITS.side + 1, 16);
  assert.throws(() => comparePng(huge, good, ids), /exceeds image limits/);
  const precision = Buffer.from(good);
  precision[24] = 16;
  assert.throws(() => comparePng(precision, good, ids), /only 8-bit/);
  const interlaced = Buffer.from(good);
  interlaced[28] = 1;
  assert.throws(() => comparePng(interlaced, good, ids), /interlace/);
  assert.throws(() => comparePng(Buffer.alloc(LIMITS.inputBytes + 1), good, ids), /no larger than/);
});

test('union canvas is bounded even when each input is individually small', () => {
  const wide = fixture(LIMITS.side, 1);
  const tall = fixture(1, LIMITS.side);
  assert.throws(() => comparePng(wide, tall, ids), /Comparison canvas exceeds/);
});

test('capture occurrences must be valid and distinct', () => {
  const input = fixture(1, 1);
  assert.throws(() => comparePng(input, input), /beforeCaptureId/);
  assert.throws(() => comparePng(input, input, { ...ids, afterCaptureId: ids.beforeCaptureId }), /distinct/);
});

test('RGB screenshots compare losslessly against equivalent opaque RGBA screenshots', () => {
  const rgb = fixture(2, 2, undefined, { colorType: 2 });
  const rgba = fixture(2, 2);
  const result = comparePng(rgb, rgba, ids);
  assert.equal(result.metadata.counts.changed_pixels, 0);
  assert.equal(result.metadata.encoded_bytes_identical, false);
});

test('CLI writes verified derivatives and metadata to a fresh directory; reruns never overwrite', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'scout-diff-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const beforePath = path.join(dir, 'before.png');
  const afterPath = path.join(dir, 'after.png');
  const out = path.join(dir, 'result');
  const before = fixture(2, 1);
  const after = fixture(3, 1);
  await Promise.all([writeFile(beforePath, before), writeFile(afterPath, after)]);
  const args = [new URL('../cli.mjs', import.meta.url).pathname, '--before', beforePath, '--after', afterPath,
    '--out', out, '--before-id', ids.beforeCaptureId, '--after-id', ids.afterCaptureId];
  const { stdout } = await exec(process.execPath, args);
  assert.equal(JSON.parse(stdout).added_pixels, 1);
  const metadataBytes = await readFile(path.join(out, 'metadata.json'));
  const metadata = JSON.parse(metadataBytes);
  for (const artifact of [metadata.raw_mask, metadata.absolute_delta, metadata.geometry_mask]) {
    assert.equal(hash(await readFile(path.join(out, artifact.file))), artifact.sha256);
  }
  assert.equal((await stat(out)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(out, 'metadata.json'))).mode & 0o777, 0o600);
  await assert.rejects(exec(process.execPath, args), /EEXIST/);
  assert.deepEqual(await readFile(path.join(out, 'metadata.json')), metadataBytes);
  assert.deepEqual(await readFile(beforePath), before);
  assert.deepEqual(await readFile(afterPath), after);
});

test('bad file input creates no partial output directory', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'scout-diff-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const beforePath = path.join(dir, 'bad.png');
  const afterPath = path.join(dir, 'after.png');
  await Promise.all([writeFile(beforePath, 'bad input'), writeFile(afterPath, fixture(1, 1))]);
  await assert.rejects(compareFiles({ beforePath, afterPath, outputDirectory: path.join(dir, 'out'), ...ids }), /PNG header/);
  assert.deepEqual((await readdir(dir)).sort(), ['after.png', 'bad.png']);
});
