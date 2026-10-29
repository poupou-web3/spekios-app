import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (args, env) => execFileSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
try {
  for (const [name, base] of [['public-root', '/'], ['public-subpath', '/scout/']]) {
    const output = '.cache/' + name;
    const env = { ...process.env, DOCS_SITE_URL: 'https://docs.example.test', DOCS_BASE_PATH: base, DOCS_INDEXABLE: 'true', DOCS_TEST_DIST: output };
    console.log('Verify public deployment at ' + base);
    run(['scripts/prepare.mjs'], env);
    run(['scripts/astro.mjs', 'build', '--outDir', output], env);
    run(['--test', 'scripts/docs.test.mjs'], env);
  }
} finally {
  run(['scripts/prepare.mjs'], process.env);
}
