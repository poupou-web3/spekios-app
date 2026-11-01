#!/usr/bin/env node
// Larchwood: a small shop that ships with known bugs, for measuring what a
// Scout exploration finds. No dependencies; needs Node 22 or later.
//
//   node apps/bug-lab/server.mjs                     all bugs on, port 4100
//   node apps/bug-lab/server.mjs --fixed             the same shop, every bug fixed
//   node apps/bug-lab/server.mjs --bugs price-sort,cart-total
//   node apps/bug-lab/server.mjs --pair --port 8084  bugs on 8084, fixed on 8085
//
// The bug list is apps/bug-lab/bugs.json. See docs/exploration/bug-lab.md.
import { parseArgs } from 'node:util';
import { BUG_IDS, parseBugs, startShop } from './shop.mjs';

let options;
try {
  options = parseArgs({ options: {
    port: { type: 'string', default: '4100' }, host: { type: 'string', default: '127.0.0.1' },
    fixed: { type: 'boolean', default: false }, bugs: { type: 'string' }, pair: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  } }).values;
} catch (error) { console.error(error.message); process.exit(2); }

if (options.help) {
  console.log(`Usage: node apps/bug-lab/server.mjs [--port 4100] [--host 127.0.0.1] [--fixed | --bugs id,id] [--pair]

  --fixed   serve the shop with every bug fixed
  --bugs    serve only these bugs: ${BUG_IDS.join(', ')}
  --pair    serve the bugs on --port and the fixed shop on --port + 1`);
  process.exit(0);
}

const port = Number(options.port);
if (!Number.isInteger(port) || port < 1 || port > 65534) { console.error('--port must be a port number.'); process.exit(2); }
if (options.fixed && options.bugs) { console.error('Use either --fixed or --bugs, not both.'); process.exit(2); }

let bugs;
try { bugs = options.fixed ? new Set() : parseBugs(options.bugs ?? 'all'); } catch (error) { console.error(error.message); process.exit(2); }

const shops = [await startShop({ port, host: options.host, bugs })];
if (options.pair) shops.push(await startShop({ port: port + 1, host: options.host, bugs: new Set() }));

for (const shop of shops) {
  const label = shop.bugs.size === 0 ? 'every bug fixed' : shop.bugs.size === BUG_IDS.length ? `all ${BUG_IDS.length} bugs` : `${shop.bugs.size} of ${BUG_IDS.length} bugs`;
  console.log(`Larchwood (${label}) on ${shop.url}`);
}
if (options.host === '127.0.0.1' || options.host === 'localhost') {
  console.log(`Scout's browser runs in Docker. Give it http://host.docker.internal:${port}` +
    `${options.pair ? ` (fixed: http://host.docker.internal:${port + 1})` : ''} and add that origin to SCOUT_ALLOWED_ORIGINS.`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { Promise.all(shops.map(shop => shop.close())).then(() => process.exit(0), () => process.exit(1)); });
}
