import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { siteSettings } from './site.mjs';
import { sha256, skillFiles, skillZip } from './skill-package.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.resolve(root, process.env.DOCS_TEST_DIST || 'dist');
const index = JSON.parse(await readFile(path.join(dist, 'docs-index.json'), 'utf8'));
const catalog = JSON.parse(await readFile(path.join(root, 'src/data/mcp-tools.json'), 'utf8'));
const decode = (value) => value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([a-zA-Z:_-]+)="([^"]*)"/g)].map((match) => [match[1], decode(match[2])]));
const html = new Map();
const ids = new Map();
for (const doc of index.documents) {
  const filename = localFile(doc.url);
  const body = await readFile(filename, 'utf8');
  html.set(filename, body);
  ids.set(filename, new Set([...body.matchAll(/\bid="([^"]*)"/g)].map((match) => decode(match[1]))));
}

function localFile(href) {
  const url = new URL(href, index.site + index.base);
  assert.equal(url.origin, index.site);
  assert.ok(url.pathname.startsWith(index.base), 'Link escapes configured base: ' + href);
  const relative = decodeURIComponent(url.pathname.slice(index.base.length));
  const filename = path.resolve(dist, relative.endsWith('/') || !relative ? relative + 'index.html' : relative);
  assert.ok(filename.startsWith(dist + path.sep), 'Link escapes dist: ' + href);
  return filename;
}
async function checkLink(href, source) {
  const url = new URL(href, source);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== index.site) return;
  const filename = localFile(url.href);
  assert.ok((await stat(filename)).isFile(), 'Missing target: ' + url.href + ' from ' + source);
  if (url.hash && filename.endsWith('.html')) {
    const set = ids.get(filename);
    if (set) assert.ok(set.has(decodeURIComponent(url.hash.slice(1))), 'Missing anchor: ' + url.href);
  }
}
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const filename = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(filename));
    else result.push(filename);
  }
  return result;
}

test('deployment URL validation and private preview defaults', () => {
  assert.equal(siteSettings({}).indexable, false);
  const subpath = siteSettings({ DOCS_SITE_URL: 'https://docs.example.test', DOCS_BASE_PATH: '/scout' });
  assert.equal(subpath.base, '/scout/');
  assert.equal(subpath.absolute('llms.txt'), 'https://docs.example.test/scout/llms.txt');
  assert.equal(subpath.href('/agents/workflow/'), '/scout/agents/workflow/');
  assert.equal(subpath.indexable, true);
  assert.equal(siteSettings({ DOCS_SITE_URL: 'https://docs.example.test', DOCS_INDEXABLE: 'false' }).indexable, false);
  for (const env of [
    { DOCS_SITE_URL: 'ftp://docs.example.test' },
    { DOCS_SITE_URL: 'https://user:password@docs.example.test' },
    { DOCS_SITE_URL: 'https://docs.example.test/path' },
    { DOCS_SITE_URL: 'https://docs.example.test/?token=value' },
    { DOCS_BASE_PATH: '/scout/../' },
    { DOCS_BASE_PATH: '/scout//' },
    { DOCS_INDEXABLE: 'yes' },
    { DOCS_INDEXABLE: 'true' },
  ]) assert.throws(() => siteSettings(env));
});

test('every guide ships indexable text, unique metadata and a Markdown alternate', async () => {
  const source=path.join(root,'src/content/docs');
  const sourceIds=(await files(source)).filter(file=>file.endsWith('.md')).map(file=>path.relative(source,file).replaceAll(path.sep,'/').slice(0,-3)).filter(id=>id!=='404');
  assert.deepEqual(index.documents.map(doc=>doc.id).sort(),sourceIds.sort(),'Every authored/generated guide must appear exactly once in the published index.');
  const titles = new Set();
  const descriptions = new Set();
  for (const doc of index.documents) {
    const body = html.get(localFile(doc.url));
    assert.equal((body.match(/<h1\b/g) || []).length, 1, doc.url);
    assert.ok(body.includes(doc.title) || doc.id === 'index', doc.url);
    const tags = [...body.matchAll(/<(?:link|meta)\b[^>]*>/g)].map((match) => attrs(match[0]));
    const canonicals = tags.filter((tag) => tag.rel === 'canonical');
    assert.equal(canonicals.length, 1);
    assert.equal(canonicals[0].href, doc.url);
    assert.equal(tags.find((tag) => tag.name === 'description')?.content, doc.description);
    assert.equal(tags.find((tag) => tag.rel === 'alternate' && tag.type === 'text/markdown')?.href, doc.markdown_url);
    assert.equal(tags.find((tag) => tag.rel === 'describedby')?.href, index.site + index.base + 'llms.txt');
    const robot = tags.find((tag) => tag.name === 'robots')?.content;
    assert.equal(robot.includes('noindex'), !index.indexable);
    const structured = body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(structured, doc.url);
    const graph = JSON.parse(structured[1])['@graph'];
    const article = graph.find((node) => node['@type'] === 'TechArticle');
    assert.equal(article.headline, doc.headline);
    assert.equal(article.url, doc.url);
    assert.equal(article.dateModified, doc.reviewed);
    assert.ok(graph.some((node) => node['@type'] === 'BreadcrumbList'));
    assert.ok(body.includes('data-pagefind-body'), 'Missing search content ' + doc.url);
    assert.ok(!titles.has(doc.title), 'Duplicate title ' + doc.title);
    assert.ok(!descriptions.has(doc.description), 'Duplicate description ' + doc.title);
    titles.add(doc.title);
    descriptions.add(doc.description);
  }
});

test('HTML navigation, assets and in-page anchors resolve within the deployment prefix', async () => {
  for (const doc of index.documents) {
    const body = html.get(localFile(doc.url));
    for (const match of body.matchAll(/<(?:a|link|script|img)\b[^>]*>/g)) {
      const tag = attrs(match[0]);
      if (tag.href || tag.src) await checkLink(tag.href || tag.src, doc.url);
    }
  }
});

test('Markdown exports and both LLM indexes contain usable complete documentation links', async () => {
  const full = await readFile(path.join(dist, 'llms-full.txt'), 'utf8');
  const llms = await readFile(path.join(dist, 'llms.txt'), 'utf8');
  assert.equal((llms.match(/^# /gm) || []).length, 1);
  assert.ok(llms.startsWith('# ScoutQA\n\n> '));
  for (const doc of index.documents) {
    const markdown = await readFile(localFile(doc.markdown_url), 'utf8');
    assert.ok(markdown.startsWith('# ' + doc.title + '\n'));
    assert.ok(markdown.includes('Source: ' + doc.url));
    assert.ok(markdown.includes('Reviewed: ' + doc.reviewed));
    assert.ok(full.includes(markdown.trim()), 'Missing full-corpus page ' + doc.url);
    assert.ok(!markdown.startsWith('---'));
    assert.ok(!markdown.includes('import ' + '{'), 'Unexpected MDX import');
    let fence = false;
    for (const line of markdown.split('\n')) {
      if (/^\s*(~{3,}|\x60{3,})/.test(line)) { fence = !fence; continue; }
      if (fence) continue;
      for (const link of line.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
        assert.ok(/^https?:/.test(link[1]), 'Relative machine link: ' + link[1]);
        await checkLink(link[1], doc.url);
      }
    }
  }
  for (const link of llms.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) await checkLink(link[1], index.site + index.base);
});

test('published MCP schemas exactly match the Rust-exported snapshot and all tool pages', async () => {
  const published = JSON.parse(await readFile(path.join(dist, 'mcp-tools.json'), 'utf8'));
  assert.deepEqual(published, catalog);
  assert.equal(new Set(catalog.tools.map(tool=>tool.name)).size,catalog.tools.length);
  for (const tool of catalog.tools) {
    assert.ok(index.documents.some((doc) => doc.id === 'agents/reference/' + tool.name));
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
  }
});

test('the lightweight skill download matches its sources, checksums and live tool names', async () => {
  const { manifest, files } = await skillFiles();
  const published = JSON.parse(await readFile(path.join(dist, 'skills/scout-qa/manifest.json'), 'utf8'));
  const archive = await readFile(path.join(dist, 'downloads/scout-qa.zip'));
  assert.deepEqual(archive, skillZip(manifest.name, files));
  assert.equal(published.version, manifest.version);
  assert.equal(published.archive.sha256, sha256(archive));
  assert.equal(published.archive.byte_length, archive.length);
  assert.ok(archive.length < 8192, 'Keep the distribution below 8 KiB compressed.');
  assert.equal((await readFile(path.join(dist, 'downloads/scout-qa.zip.sha256'), 'utf8')).split(/\s/)[0], sha256(archive));
  assert.deepEqual(index.resources.agent_skill, published);
  const names = new Set(catalog.tools.map((tool) => tool.name));
  for (const file of files) {
    const bytes = await readFile(path.join(dist, 'skills/scout-qa', file.path));
    assert.deepEqual(bytes, file.bytes);
    const metadata = published.files.find((value) => value.path === file.path);
    assert.equal(metadata.sha256, sha256(bytes));
    assert.equal(metadata.byte_length, bytes.length);
    await checkLink(metadata.url, index.site + index.base);
    for (const match of bytes.toString('utf8').matchAll(/\bscout_[a-z_]+\b/g)) assert.ok(names.has(match[0]), 'Unknown skill tool ' + match[0]);
  }
  assert.equal(files.length, 3);
  assert.ok(files.find((file) => file.path === 'SKILL.md').bytes.length <= 4096, 'Keep the loaded entry point below 4 KiB.');
  await checkLink(published.archive.url, index.site + index.base);
  await checkLink(published.installation_guide, index.site + index.base);
});

test('OpenAPI is valid and shares exact agent inputs, strict submissions and real async status codes', async () => {
  const spec = JSON.parse(await readFile(path.join(dist, 'openapi.json'), 'utf8'));
  await SwaggerParser.validate(structuredClone(spec));
  assert.equal(spec.openapi, '3.1.0');
  assert.deepEqual(spec.paths['/v1/agent/tools/{name}'].post['x-scout-tool-input-schemas'], Object.fromEntries(catalog.tools.map((tool) => [tool.name, tool.inputSchema])));
  assert.ok(spec.paths['/v1/browser-jobs'].post.responses['202']);
  assert.ok(spec.paths['/v1/browser-jobs'].post.responses['200']);
  assert.ok(spec.paths['/v1/exploration-settings'].post.responses['201']);
  assert.equal(spec.components.schemas.ModelRequest.properties.max_attempts.default, 2);
  assert.equal(spec.components.schemas.ModelRequest.properties.max_output_tokens.default, 1024);
  assert.equal(spec.components.schemas.SettingsSubmission.additionalProperties, false);
  assert.equal(spec.components.schemas.JobSubmission.oneOf[0].additionalProperties, false);
  assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
  assert.deepEqual(spec.paths['/healthz'].get.security, []);
});

test('robots, sitemap and local search match the selected indexing policy', async () => {
  const robots = await readFile(path.join(dist, 'robots.txt'), 'utf8');
  assert.equal(robots.includes('Disallow: /'), !index.indexable);
  if (index.indexable) {
    assert.ok(robots.includes('Sitemap: ' + index.site + index.base + 'sitemap-index.xml'));
    const sitemap = await readFile(path.join(dist, 'sitemap-0.xml'), 'utf8');
    for (const doc of index.documents) assert.ok(sitemap.includes('<loc>' + doc.url + '</loc>'), 'Sitemap omits ' + doc.url);
    assert.ok(!sitemap.includes('/404.html'));
  }
  const searchFiles = await files(path.join(dist, 'pagefind'));
  assert.ok(searchFiles.some((filename) => filename.endsWith('pagefind.js')));
  assert.ok(searchFiles.some((filename) => filename.endsWith('.pf_index')));
});

test('the public build excludes local private paths, environment files and recorded evidence', async () => {
  for (const filename of await files(dist)) {
    const relative = path.relative(dist, filename);
    assert.ok(!/(^|\/)(?:\.env(?:\.|$)|auth-vault|spool|artifacts|\.git)(?:\/|$)/.test(relative), relative);
    if (!/\.(?:html|js|json|txt|md|css|xml)$/.test(filename)) continue;
    const body = await readFile(filename, 'utf8');
    assert.ok(!/\/Users\/|\/home\/runnr|codex-clipboard-|ghp_[A-Za-z0-9]{20}|github_pat_[A-Za-z0-9]{20}/.test(body), relative);
    assert.ok(!/SCOUT_API_TOKEN=[a-f0-9]{32,}|(?:OPENAI|ANTHROPIC|OPENROUTER)_API_KEY=sk-[A-Za-z0-9-]{20,}/.test(body), relative);
  }
});
