import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openapi } from './openapi.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
const snapshot = JSON.parse(await readFile(path.join(root, 'src/data/mcp-tools.json'), 'utf8'));
const live = JSON.parse(execFileSync('cargo', ['run', '--locked', '--quiet', '--manifest-path', 'apps/api/Cargo.toml', '--example', 'export_agent_catalog'], {
  cwd: repository, encoding: 'utf8', maxBuffer: 1024 * 1024,
}));
assert.deepEqual(snapshot, live, 'Tool catalog drift. Run just docs-sync-api, rebuild and review.');
const router = await readFile(path.join(repository, 'apps/api/src/lib.rs'), 'utf8');
const routes = [...router.matchAll(/\.route\(\s*"([^"]+)",\s*([\s\S]*?)\)\s*(?=\n\s*\.(?:route|layer|route_layer)|;)/g)];
const methods = new Map(routes.map((match) => [match[1], {
  get: /\bget\s*\(/.test(match[2]),
  post: /\bpost\s*\(/.test(match[2]),
}]));
const spec = openapi(snapshot);
let count = 0;
for (const [route, operations] of Object.entries(spec.paths)) {
  assert.ok(methods.has(route), 'OpenAPI path missing from Axum router: ' + route);
  for (const method of Object.keys(operations)) {
    assert.ok(methods.get(route)[method], 'OpenAPI method missing from Axum router: ' + method + ' ' + route);
    count++;
  }
}
console.log('Verified compiled catalog and ' + count + ' documented operations against the Axum router; no services or model calls.');
