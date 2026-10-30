import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';

export const DIFFERENCE_VERSION = 'raw-rgba-v1';
export const LIMITS = Object.freeze({
  inputBytes: 16 * 1024 * 1024,
  pixels: 8_388_608,
  side: 8192,
});
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function requireCaptureId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a 1–128 character stable capture ID (letters, digits, _, ., :, -).`);
  }
}

function dimensionsAllowed(width, height, label) {
  if (width < 1 || height < 1 || width > LIMITS.side || height > LIMITS.side || width * height > LIMITS.pixels) {
    throw new Error(`${label} exceeds image limits: ${LIMITS.pixels} pixels and ${LIMITS.side} pixels per side.`);
  }
}

// Check dimensions before invoking a decoder or allocating the output canvas.
function inspectHeader(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.inputBytes) {
    throw new Error(`${label} must be a Buffer no larger than ${LIMITS.inputBytes} bytes.`);
  }
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error(`${label} is not a valid PNG header.`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  dimensionsAllowed(width, height, label);
  // Browser screenshots are 8-bit RGB/RGBA. Reject higher precision rather than
  // downsampling it and silently losing the very small differences we promise.
  if (bytes[24] !== 8 || ![2, 6].includes(bytes[25])) {
    throw new Error(`${label}: only 8-bit RGB/RGBA screenshots are supported; no lossy conversion is performed.`);
  }
  // pngjs uses an unbounded inflate path for interlaced input. Browser PNG
  // screenshots do not require it, so reject it before decompression.
  if (bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) {
    throw new Error(`${label} has unsupported PNG compression, filtering, or interlace settings.`);
  }
  let offset = 8;
  let hasData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error(`${label} contains a truncated PNG chunk.`);
    if (type === 'acTL') throw new Error(`${label}: animated PNG is unsupported; capture an explicit frame.`);
    if (type === 'IHDR' && offset !== 8) throw new Error(`${label} contains multiple PNG headers.`);
    if (type === 'IDAT') hasData = true;
    if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length || !hasData) throw new Error(`${label} has an invalid PNG ending.`);
      return { width, height };
    }
    offset = end;
  }
  throw new Error(`${label} is missing its PNG ending.`);
}

function decode(bytes, label) {
  try {
    return PNG.sync.read(bytes, { checkCRC: true });
  } catch (error) {
    throw new Error(`${label} could not be decoded as a valid PNG: ${error.message}`, { cause: error });
  }
}

/** Count exact changed pixels under observed, viewport-clipped control rectangles. */
export function changedPixelsInRects(maskBytes, rectangles) {
  inspectHeader(maskBytes, 'Difference mask');
  if (!Array.isArray(rectangles) || rectangles.length > 256) throw new Error('Expected at most 256 control rectangles.');
  const mask = decode(maskBytes, 'Difference mask');
  return rectangles.map(rect => {
    if (!rect || !['x','y','width','height'].every(key => Number.isFinite(rect[key])) || rect.width < 0 || rect.height < 0) return null;
    const left = Math.max(0, Math.floor(rect.x)), right = Math.min(mask.width, Math.ceil(rect.x+rect.width));
    const top = Math.max(0, Math.floor(rect.y)), bottom = Math.min(mask.height, Math.ceil(rect.y+rect.height));
    let changed = 0;
    for (let y=top; y<bottom; y++) for (let x=left; x<right; x++) if (mask.data[(y*mask.width+x)*4] !== 0) changed++;
    return { changed_pixels: changed, sampled_pixels: Math.max(0,right-left)*Math.max(0,bottom-top) };
  });
}

/** Compare unaligned screenshot pixels. Neither original Buffer is mutated. */
export function comparePng(beforeBytes, afterBytes, { beforeCaptureId, afterCaptureId } = {}) {
  requireCaptureId(beforeCaptureId, 'beforeCaptureId');
  requireCaptureId(afterCaptureId, 'afterCaptureId');
  if (beforeCaptureId === afterCaptureId) throw new Error('Before and after must have distinct capture occurrence IDs, even for identical bytes.');
  const beforeSize = inspectHeader(beforeBytes, 'Before screenshot');
  const afterSize = inspectHeader(afterBytes, 'After screenshot');
  const width = Math.max(beforeSize.width, afterSize.width);
  const height = Math.max(beforeSize.height, afterSize.height);
  dimensionsAllowed(width, height, 'Comparison canvas');
  const before = decode(beforeBytes, 'Before screenshot');
  const after = decode(afterBytes, 'After screenshot');
  const raw = new PNG({ width, height });
  const absoluteDelta = new PNG({ width, height });
  const geometryChanged = before.width !== after.width || before.height !== after.height;
  const geometry = geometryChanged ? new PNG({ width, height }) : null;
  let overlapChanged = 0;
  let added = 0;
  let removed = 0;
  let maxChannelDelta = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      raw.data[out + 3] = 255;
      if (geometry) geometry.data[out + 3] = 255;
      const inBefore = x < before.width && y < before.height;
      const inAfter = x < after.width && y < after.height;
      let changed = false;
      if (inBefore && inAfter) {
        const b = (y * before.width + x) * 4;
        const a = (y * after.width + x) * 4;
        for (let channel = 0; channel < 4; channel++) {
          const delta = Math.abs(before.data[b + channel] - after.data[a + channel]);
          absoluteDelta.data[out + channel] = delta;
          maxChannelDelta = Math.max(maxChannelDelta, delta);
          if (delta !== 0) changed = true;
        }
        if (changed) overlapChanged++;
      } else if (inAfter) {
        added++;
        changed = true;
        geometry.data[out + 1] = 255; // Green: area present only after.
      } else if (inBefore) {
        removed++;
        changed = true;
        geometry.data[out] = 255;
        geometry.data[out + 2] = 255; // Magenta: area present only before.
      }
      if (changed) {
        raw.data[out] = raw.data[out + 1] = raw.data[out + 2] = 255;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const overlapPixels = Math.min(before.width, after.width) * Math.min(before.height, after.height);
  const changedPixels = overlapChanged + added + removed;
  const rawMaskPng = PNG.sync.write(raw);
  const absoluteDeltaPng = PNG.sync.write(absoluteDelta);
  const geometryMaskPng = geometryChanged ? PNG.sync.write(geometry) : null;
  const metadata = {
    difference_id: randomUUID(),
    difference_version: DIFFERENCE_VERSION,
    created_at: new Date().toISOString(),
    before_capture_id: beforeCaptureId,
    after_capture_id: afterCaptureId,
    before: { capture_id: beforeCaptureId, sha256: sha256(beforeBytes), bytes: beforeBytes.length, ...beforeSize },
    after: { capture_id: afterCaptureId, sha256: sha256(afterBytes), bytes: afterBytes.length, ...afterSize },
    canvas: { width, height, alignment: 'top-left; no registration, resize, crop, or color correction' },
    geometry_changed: geometryChanged,
    encoded_bytes_identical: beforeBytes.equals(afterBytes),
    decoded_pixels_identical: changedPixels === 0,
    counts: {
      changed_pixels: changedPixels,
      overlap_pixels: overlapPixels,
      overlap_changed_pixels: overlapChanged,
      added_pixels: added,
      removed_pixels: removed,
      union_pixels: overlapPixels + added + removed,
      outside_both_pixels: width * height - overlapPixels - added - removed,
    },
    max_overlap_channel_delta: maxChannelDelta,
    changed_bbox: changedPixels ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
    raw_mask: { file: 'raw-mask.png', sha256: sha256(rawMaskPng), black: 'unchanged or outside both images', white: 'any RGBA change or added/removed geometry', threshold: 0 },
    absolute_delta: { file: 'absolute-delta.png', sha256: sha256(absoluteDeltaPng), channels: 'RGBA contains the unsigned absolute difference of each source channel, including alpha; not a display overlay', missing_pixels: 'zero-filled outside overlap; consult geometry mask and source dimensions; these deltas are undefined' },
    geometry_mask: geometryMaskPng ? { file: 'geometry-mask.png', sha256: sha256(geometryMaskPng), green: 'added', magenta: 'removed', black: 'overlap or outside both images' } : null,
    bug_verdict: null,
  };
  return { metadata, rawMaskPng, absoluteDeltaPng, geometryMaskPng };
}

async function readBounded(file) {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Input must be a regular file.');
    if (stat.size > LIMITS.inputBytes) throw new Error(`Input exceeds ${LIMITS.inputBytes} bytes.`);
    // Read at most the cap plus one, even if a file grows after stat().
    const bytes = Buffer.alloc(Math.min(stat.size + 1, LIMITS.inputBytes + 1));
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
      if (!bytesRead) break;
      position += bytesRead;
    }
    if (position > stat.size) throw new Error('Input changed size while reading; recapture immutable evidence.');
    return bytes.subarray(0, position);
  } finally {
    await handle.close();
  }
}

/** A fresh output directory is required. Existing files are never overwritten. */
export async function compareFiles({ beforePath, afterPath, outputDirectory, beforeCaptureId, afterCaptureId }) {
  const [beforeBytes, afterBytes] = await Promise.all([readBounded(beforePath), readBounded(afterPath)]);
  const result = comparePng(beforeBytes, afterBytes, { beforeCaptureId, afterCaptureId });
  const out = path.resolve(outputDirectory);
  await mkdir(out, { mode: 0o700 });
  try {
    await writeFile(path.join(out, 'raw-mask.png'), result.rawMaskPng, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(out, 'absolute-delta.png'), result.absoluteDeltaPng, { flag: 'wx', mode: 0o600 });
    if (result.geometryMaskPng) {
      await writeFile(path.join(out, 'geometry-mask.png'), result.geometryMaskPng, { flag: 'wx', mode: 0o600 });
    }
    // Metadata is the completion marker and is written after all derivatives.
    await writeFile(path.join(out, 'metadata.json'), `${JSON.stringify(result.metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return result.metadata;
  } catch (error) {
    await rm(out, { recursive: true, force: true });
    throw error;
  }
}
