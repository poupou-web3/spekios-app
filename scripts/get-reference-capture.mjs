import { writeFile } from 'node:fs/promises';
import { clients, bucket, getObject, sha256, isUuid, validateReferenceCapture } from './local-clients.mjs';

const [captureId, outputPath, ...extra] = process.argv.slice(2);
if (!isUuid(captureId) || !outputPath || extra.length) {
  throw new Error('Usage: node scripts/get-reference-capture.mjs <capture-uuid> <new-output.png>');
}
const { s3 } = await clients();
try {
  const entry = JSON.parse(await getObject(s3, `design-reference/captures/${captureId}.json`));
  validateReferenceCapture(entry);
  if (entry.capture_id !== captureId || entry.bucket !== bucket || entry.purpose !== 'design_reference'
    || entry.training_status !== 'excluded_reference') throw new Error('Capture identity or classification mismatch.');
  const bytes = await getObject(s3, entry.object_key);
  if (bytes.length !== entry.byte_length || sha256(bytes) !== entry.sha256) throw new Error('Capture integrity check failed.');
  await writeFile(outputPath, bytes, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ capture_id: captureId, sha256: entry.sha256, byte_length: bytes.length, output: outputPath }));
} finally { s3.destroy(); }
