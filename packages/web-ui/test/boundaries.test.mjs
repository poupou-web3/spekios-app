import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {linkSource} from '../testing/link.mjs';

// Deployment boundaries: the customer workspace (served by scout-api) and the operator back office
// (its own container) share only packages/web-ui. Neither app may reach into the other.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const files = dir => readdirSync(join(root, dir)).flatMap(name => {
  const path = join(dir, name);
  return statSync(join(root, path)).isDirectory() ? files(path) : [path];
});
const sources = dir => files(dir).filter(path => /\.(js|css|html)$/.test(path)).map(path => [path, readFileSync(join(root, path), 'utf8')]);
const imports = text => Array.from(text.matchAll(/(?:^import\s*\{[^}]*\}\s*from\s*|import\()'([^']+)'/gm), match => match[1]);

test('the shared UI package imports only its own modules',() => {
  for (const [path, text] of sources('packages/web-ui/src')) {
    for (const specifier of imports(text)) assert.match(specifier, /^\.\/[\w-]+\.js$/, `${path} imports ${specifier}`);
  }
});

test('each app imports only its own modules and the shared package',() => {
  for (const app of ['apps/web/src', 'apps/backoffice/src']) {
    for (const [path, text] of sources(app)) {
      for (const specifier of imports(text)) {
        assert.ok(specifier.startsWith('/assets/ui/') || specifier.startsWith('/assets/app/') || /^\.\.?\//.test(specifier), `${path} imports ${specifier}`);
        if (/^\.\.?\//.test(specifier)) {
          const target = fileURLToPath(new URL(specifier, pathToFileURL(join(root, path))));
          assert.ok(target.startsWith(join(root, app)), `${path} leaves its app through ${specifier}`);
        }
      }
    }
  }
});

test('the customer workspace ships no back office views, routes or links',() => {
  for (const [path, text] of [...sources('apps/web/src'), ...sources('apps/web').filter(([path]) => path.endsWith('.html'))]) {
    assert.doesNotMatch(text, /#\/operations|data-action="ops-tab"|opsOverview|modelsView|eventsView|Back office/i, path);
  }
});

test('the linker rejects duplicate top-level names and reassigned imports',() => {
  const dir = mkdtempSync(join(tmpdir(), 'scout-link-'));
  try {
    const app = pathToFileURL(dir + '/');
    writeFileSync(join(dir, 'a.js'), "export let counter = 0;\nexport function shared(){}\n");
    writeFileSync(join(dir, 'b.js'), "import {shared} from './a.js';\nexport function shared(){}\n");
    assert.throws(() => linkSource(app, 'b.js'), /Top-level shared is declared/);
    writeFileSync(join(dir, 'c.js'), "import {counter} from './a.js';\nexport function bump(){counter+=1;}\n");
    assert.throws(() => linkSource(app, 'c.js'), /assigns the imported binding counter/);
    writeFileSync(join(dir, 'e.js'), "import {counter} from './a.js';\nexport const both = () => [counter, ...shared()];\n");
    assert.throws(() => linkSource(app, 'e.js'), /uses shared from .* without importing it/);
    writeFileSync(join(dir, 'f.js'), "import {counter} from './a.js';\nexport const text = () => `shared ${counter} 'shared' /shared/`; // shared\n");
    assert.doesNotThrow(() => linkSource(app, 'f.js'));
    writeFileSync(join(dir, 'd.js'), "import {counter} from './a.js';\nexport const read = () => counter === 0;\n");
    assert.match(linkSource(app, 'd.js'), /let counter = 0;[\s\S]*const read/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
