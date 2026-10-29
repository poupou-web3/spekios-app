import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
// Compile and validate before replacing the reviewed snapshot.
const catalog = JSON.parse(execFileSync('cargo', ['run', '--locked', '--quiet', '--manifest-path', 'apps/api/Cargo.toml', '--example', 'export_agent_catalog'], {
  cwd: repository, encoding: 'utf8', maxBuffer: 1024 * 1024,
}));
if (catalog.interface_version !== 1 || !Array.isArray(catalog.tools) || catalog.tools.length === 0) throw new Error('Invalid compiled catalog.');
await mkdir(path.join(root, '.cache'), { recursive: true });
const temporary = path.join(root, '.cache/mcp-tools-' + process.pid + '.json');
try {
  await writeFile(temporary, JSON.stringify(catalog, null, 2) + '\n');
  await rename(temporary, path.join(root, 'src/data/mcp-tools.json'));
} finally {
  await rm(temporary, { force: true });
}
console.log('Exported ' + catalog.tools.length + ' tools atomically. Review, rebuild and run just docs-test.');
