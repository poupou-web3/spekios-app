import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const base = new URL(process.argv[2] || 'http://127.0.0.1:18090/');
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) {
  throw new Error('Supply an HTTP(S) docs URL with a trailing slash and no credentials, query or fragment.');
}
const cases = [
  ['', /text\/html/],
  ['agents/workflow/', /text\/html/],
  ['api/jobs/', /text\/html/],
  ['agents/reference/scout_get_report/', /text\/html/],
  ['agents/workflow/index.md', /text\/markdown/],
  ['llms.txt', /text\/plain/],
  ['llms-full.txt', /text\/plain/],
  ['docs-index.json', /application\/json/],
  ['mcp-tools.json', /application\/json/],
  ['openapi.json', /application\/json/],
  ['sitemap-index.xml', /(?:application|text)\/xml/],
  ['robots.txt', /text\/plain/],
  ['pagefind/pagefind.js', /(?:application|text)\/javascript/],
  ['agents/skill/', /text\/html/],
  ['agents/identity/', /text\/html/],
  ['agents/connect/index.md', /text\/markdown/],
  ['skills/scout-qa/SKILL.md', /text\/markdown/],
  ['skills/scout-qa/manifest.json', /application\/json/],
  ['downloads/scout-qa.zip.sha256', /text\/plain/],
];
let count = 0;
let index;
let catalog;
for (const [relative, mime] of cases) {
  const response = await fetch(new URL(relative, base), { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, relative);
  assert.match(response.headers.get('content-type') || '', mime, relative);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff', relative);
  const body = await response.text();
  assert.ok(body.length > 10, relative);
  if (relative === 'docs-index.json') index = JSON.parse(body);
  if (relative === 'mcp-tools.json') {catalog=JSON.parse(body);assert.equal(catalog.interface_version,1);assert.ok(catalog.tools.length>0);}
  if (relative === 'openapi.json') assert.equal(JSON.parse(body).openapi, '3.1.0');
  count++;
}
assert.equal(index.base, base.pathname, 'Container mount differs from generated deployment base.');
const referenceIds=index.documents.filter(doc=>doc.id.startsWith('agents/reference/')).map(doc=>doc.id).sort();
assert.deepEqual(referenceIds,catalog.tools.map(tool=>'agents/reference/'+tool.name).sort(),'Every served tool must have one published reference page.');
const download = await fetch(new URL('downloads/scout-qa.zip', base), { signal: AbortSignal.timeout(10000) });
assert.equal(download.status, 200);
assert.match(download.headers.get('content-type') || '', /application\/zip/);
const zip = Buffer.from(await download.arrayBuffer());
assert.equal(zip.length, index.resources.agent_skill.archive.byte_length);
assert.equal(createHash('sha256').update(zip).digest('hex'), index.resources.agent_skill.archive.sha256);
count++;
for (const relative of ['missing-documentation-route/', 'missing-documentation-route/index.md']) {
  const response = await fetch(new URL(relative, base), { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 404, 'Unknown routes must not return the homepage: ' + relative);
  assert.ok((await response.text()).includes('Page not found'));
  count++;
}
const privateFile = await fetch(new URL('.env', base), { signal: AbortSignal.timeout(10000) });
assert.ok([403,404].includes(privateFile.status), 'Dotfiles must not be exposed.');
const health = await fetch(new URL('/_docs_health', base), { signal: AbortSignal.timeout(10000) });
assert.equal(health.status, 200);
assert.equal((await health.text()).trim(), 'ok');
console.log('Verified ' + (count + 2) + ' static HTTP cases, MIME/headers, contracts, robots, search assets and real 404s at ' + base.href);
