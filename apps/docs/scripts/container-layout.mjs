import { readFile, cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const index = JSON.parse(await readFile(path.join(root, 'dist/docs-index.json'), 'utf8'));
if (!/^\/[a-zA-Z0-9/_-]*\/?$/.test(index.base)) throw new Error('Invalid generated base path.');
const webroot = path.join(root, '.cache/container-root');
await rm(webroot, { recursive: true, force: true });
await mkdir(webroot, { recursive: true });
await cp(path.join(root, 'dist'), path.join(webroot, index.base.slice(1)), { recursive: true });
const prefix = index.base;
const config = [
  'server {',
  '  listen 8080;',
  '  server_name _;',
  '  root /srv/scout-docs;',
  '  index index.html;',
  '  server_tokens off;',
  '  charset utf-8;',
  '  add_header X-Content-Type-Options nosniff always;',
  '  add_header Referrer-Policy strict-origin-when-cross-origin always;',
  '  add_header X-Frame-Options SAMEORIGIN always;',
  '  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;',
  '  error_page 404 ' + prefix + '404.html;',
  '  location = /_docs_health { access_log off; default_type text/plain; return 200 "ok\\n"; }',
  '  location ~ /\\. { deny all; }',
  '  location ~ \\.md$ { types { text/markdown md; } try_files $uri =404; }',
  '  location ~ \\.(txt|sha256)$ { types { text/plain txt sha256; } try_files $uri =404; }',
  '  location / { try_files $uri $uri/ =404; }',
  '}',
].join('\n');
await writeFile(path.join(root, '.cache/default.conf'), config + '\n');
console.log('Prepared unprivileged static server at ' + prefix);
