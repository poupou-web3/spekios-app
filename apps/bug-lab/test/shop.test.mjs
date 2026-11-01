// HTTP-level checks of the Larchwood shop. The Chromium checks that every bug
// really shows in a browser are in packages/browser-runtime/test/bug-lab.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUG_IDS, manifest, parseBugs, startShop } from '../shop.mjs';
import { products } from '../catalogue.mjs';

const MATCH_KEYS = ['before', 'after', 'role', 'control', 'command', 'value', 'after_text', 'every'];

test('the bug list is complete and well-formed', () => {
  const ids = [...manifest.bugs, ...manifest.decoys].map(entry => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'IDs are unique');
  assert.equal(manifest.bugs.length, 14);
  assert.equal(manifest.decoys.length, 4);
  for (const bug of manifest.bugs) {
    for (const field of ['id', 'type', 'title', 'page', 'viewport', 'expected', 'actual']) assert.equal(typeof bug[field], 'string', `${bug.id}.${field}`);
    assert.match(bug.id, /^[a-z0-9-]+$/);
    assert.ok(['easy', 'wrong-data', 'visual', 'hard'].includes(bug.type), bug.id);
    assert.ok(['any', 'mobile'].includes(bug.viewport), bug.id);
    assert.ok(Array.isArray(bug.steps) && bug.steps.length, bug.id);
    assert.ok(bug.evidence.every(kind => ['screen', 'network', 'console'].includes(kind)), bug.id);
  }
  for (const entry of [...manifest.bugs, ...manifest.decoys]) {
    assert.ok(Object.keys(entry.match).length, entry.id);
    for (const [key, value] of Object.entries(entry.match)) {
      assert.ok(MATCH_KEYS.includes(key), `${entry.id}: unknown match key ${key}`);
      if (key === 'every') assert.ok(Number.isInteger(value) && value > 1, entry.id);
      else if (key !== 'role' && key !== 'command') assert.doesNotThrow(() => new RegExp(value), `${entry.id}.${key}`);
    }
  }
  for (const decoy of manifest.decoys) assert.equal(typeof decoy.behaviour, 'string', decoy.id);
});

test('bug switches accept all, none or known IDs only', () => {
  assert.equal(parseBugs('all').size, BUG_IDS.length);
  assert.equal(parseBugs('none').size, 0);
  assert.deepEqual([...parseBugs('price-sort, cart-total')], ['price-sort', 'cart-total']);
  assert.throws(() => parseBugs('price-sort,nonsense'), /Unknown bug ID: nonsense/);
});

async function withShops(fn) {
  const buggy = await startShop({ bugs: parseBugs('all') }), fixed = await startShop({ bugs: parseBugs('none') });
  try { await fn(buggy, fixed); } finally { await Promise.all([buggy.close(), fixed.close()]); }
}
const get = (shop, path, init) => fetch(shop.url + path, { redirect: 'manual', ...init });
const text = async (shop, path) => (await get(shop, path)).text();
const count = html => Number(/<p>(\d+) products?/.exec(html)?.[1]);
const cardPrices = html => [...html.matchAll(/<span class="card-price">(?:<s>[^<]*<\/s>)?([^<]*)<\/span>/g)].map(m => m[1]);

test('pages that fail only when their bug is on', () => withShops(async (buggy, fixed) => {
  assert.equal((await get(buggy, '/shipping-returns')).status, 404);
  assert.equal((await get(fixed, '/shipping-returns')).status, 200);
  const failed = await get(buggy, '/track/status?number=12345');
  assert.equal(failed.status, 500);
  assert.equal(await failed.text(), 'Internal Server Error');
  assert.match(await text(fixed, '/track/status?number=12345'), /Order not found/);
  assert.match(await text(fixed, '/track/status?number=10482'), /Order 10482[\s\S]*Shipped/);
}));

test('shop results: search, stock filter and price sort', () => withShops(async (buggy, fixed) => {
  assert.equal(count(await text(buggy, '/shop?q=lamp')), 24);
  assert.equal(count(await text(fixed, '/shop?q=lamp')), 3);
  assert.match(await text(buggy, '/shop?q=lamp'), /Results for “lamp”/);
  assert.match(await text(fixed, '/shop?q=zzzz'), /No products match “zzzz”/);

  assert.match(await text(buggy, '/shop?stock=1'), /class="badge">Sold out/);
  assert.equal(count(await text(fixed, '/shop?stock=1')), 21);
  for (const page of [1, 2, 3]) assert.doesNotMatch(await text(fixed, `/shop?stock=1&page=${page}`), /class="badge">Sold out/);

  assert.deepEqual(cardPrices(await text(fixed, '/shop?sort=price-asc')), ['Free', '€9', '€12', '€18', '€24', '€29', '€35', '€42']);
  assert.deepEqual(cardPrices(await text(buggy, '/shop?sort=price-asc')).slice(0, 4), ['Free', '€110', '€12', '€1,250']);
  assert.deepEqual(cardPrices(await text(fixed, '/shop?sort=price-desc')).slice(0, 3), ['€1,250', '€780', '€450']);
}));

test('Back to results keeps the shop query only when lost-filters is off', () => withShops(async (buggy, fixed) => {
  const from = encodeURIComponent('category=Lighting&sort=price-asc');
  assert.match(await text(fixed, `/product/rattan-desk-lamp?from=${from}`), /href="\/shop\?category=Lighting&amp;sort=price-asc">Back to results/);
  assert.match(await text(buggy, `/product/rattan-desk-lamp?from=${from}`), /href="\/shop">Back to results/);
  // Cards carry the query of the results they were opened from.
  assert.match(await text(fixed, '/shop?category=Lighting&page=1'), /href="\/product\/brass-table-lamp\?from=category%3DLighting"/);
  assert.match(await text(fixed, '/shop'), /href="\/product\/brass-table-lamp"/);
}));

test('every second add in a browser session fails only when flaky-add is on', () => withShops(async (buggy, fixed) => {
  const add = async (shop, cookie) => {
    const response = await get(shop, '/api/cart/items', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify({ product: 'oak-side-table', quantity: 1 }) });
    return { status: response.status, cookie: cookie ?? response.headers.get('set-cookie').split(';')[0] };
  };
  for (const [shop, statuses] of [[buggy, [200, 503, 200, 503]], [fixed, [200, 200, 200, 200]]]) {
    let cookie;
    const seen = [];
    for (let i = 0; i < 4; i++) { const result = await add(shop, cookie); cookie = result.cookie; seen.push(result.status); }
    assert.deepEqual(seen, statuses);
    assert.equal((await add(shop)).status, 200, 'a new session starts again');
  }
  const soldOut = await get(fixed, '/api/cart/items', { method: 'POST', body: JSON.stringify({ product: 'walnut-bench', quantity: 1 }) });
  assert.equal(soldOut.status, 409);
  assert.equal((await get(fixed, '/api/cart/items', { method: 'POST', body: 'not json' })).status, 400);
  assert.equal((await get(fixed, '/api/cart/items')).status, 405);
}));

// Every address a visitor can reach from the home page, in each build.
async function crawl(shop) {
  const seen = new Map(), queue = ['/'];
  while (queue.length && seen.size < 400) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    const response = await get(shop, path);
    const body = await response.text();
    seen.set(path, { status: response.status, body });
    for (const [, href] of body.replace(/<script[\s\S]*?<\/script>/g, '').matchAll(/href="(\/[^"#]*)/g)) {
      const next = href.replace(/&amp;/g, '&');
      if (!seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

test('the fixed shop has no dead links, and the buggy one only the planted ones', () => withShops(async (buggy, fixed) => {
  const fixedPages = await crawl(fixed);
  const failing = [...fixedPages].filter(([, page]) => page.status !== 200).map(([path]) => path);
  assert.deepEqual(failing, []);
  for (const product of products) assert.ok([...fixedPages.keys()].some(path => path.startsWith('/product/' + product.slug)), product.slug);

  const buggyFailing = [...await crawl(buggy)].filter(([, page]) => page.status !== 200).map(([path]) => path);
  assert.deepEqual(buggyFailing, ['/shipping-returns']);
}));

test('nothing a browser receives gives a bug away', () => withShops(async (buggy, fixed) => {
  const forbidden = /\b(bugs?|buggy|broken|seed(ed)?|planted|fixtures?|intentional(ly)?|deliberate(ly)?|scout|spekios|flaky|defects?|known issues?)\b/i;
  const extra = ['/shop?q=lamp', '/shop?stock=1&sort=price-asc&view=list', '/track/status?number=10482', '/track/status?number=1', '/nope'];
  for (const shop of [buggy, fixed]) {
    const pages = await crawl(shop);
    for (const path of extra) { const response = await get(shop, path); pages.set(path, { status: response.status, body: await response.text() }); }
    for (const [path, page] of pages) {
      assert.doesNotMatch(path, forbidden, path);
      assert.doesNotMatch(page.body, forbidden, `${path} contains a giveaway word`);
      for (const id of BUG_IDS) assert.ok(!page.body.includes(id), `${path} contains the bug ID ${id}`);
    }
    const response = await get(shop, '/');
    assert.doesNotMatch(JSON.stringify([...response.headers]), forbidden);
  }
}));
