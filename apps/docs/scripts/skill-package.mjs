import { readFile, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const skillRoot = fileURLToPath(new URL('../skills/', import.meta.url));
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function skillFiles(root = skillRoot) {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.name !== 'scout-qa' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid skill identity.');
  if (!Array.isArray(manifest.files) || new Set(manifest.files).size !== manifest.files.length || !manifest.files.includes('SKILL.md')) throw new Error('Invalid skill inventory.');
  const source = await realpath(path.join(root, manifest.name));
  const files = [];
  for (const relative of manifest.files) {
    if (typeof relative !== 'string' || !/^[A-Za-z0-9_/-]+\.(md|yaml)$/.test(relative) || relative.startsWith('/') || relative.includes('..')) throw new Error('Unsafe skill path.');
    const filename = path.join(source, relative);
    if (!(await lstat(filename)).isFile() || !(await realpath(filename)).startsWith(source + path.sep)) throw new Error('Skill files must be regular files inside the package.');
    files.push({ path: relative, bytes: await readFile(filename) });
  }
  if (files.reduce((total, file) => total + file.bytes.length, 0) > 12 * 1024) throw new Error('The lightweight skill must stay below 12 KiB before compression.');
  return { manifest, files };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// A small deterministic ZIP writer: regular UTF-8 files, native deflate, no hooks.
export function skillZip(name, files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const filename = Buffer.from(name + '/' + file.path);
    const compressed = deflateRawSync(file.bytes, { level: 9 });
    const crc = crc32(file.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12); // 1980-01-01, stable across builds.
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(file.bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(file.bytes.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export async function publishSkill(emit, settings) {
  const { manifest, files } = await skillFiles();
  for (const file of files) await emit('skills/' + manifest.name + '/' + file.path, file.bytes);
  const zip = skillZip(manifest.name, files);
  const archivePath = 'downloads/scout-qa.zip';
  await emit(archivePath, zip);
  await emit(archivePath + '.sha256', sha256(zip) + '  scout-qa.zip\n');
  const published = {
    name: manifest.name, version: manifest.version,
    entrypoint: settings.absolute('skills/scout-qa/SKILL.md'),
    installation_guide: settings.absolute('agents/skill/'),
    archive: { url: settings.absolute(archivePath), sha256: sha256(zip), byte_length: zip.length },
    files: files.map((file) => ({
      path: file.path, url: settings.absolute('skills/scout-qa/' + file.path),
      sha256: sha256(file.bytes), byte_length: file.bytes.length,
    })),
  };
  await emit('skills/scout-qa/manifest.json', published);
  return published;
}
