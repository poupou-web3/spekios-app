// Larchwood's HTTP server. No dependencies. One server serves one set of
// active bugs: all of them (the default), none (--fixed), or a chosen list.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { productBySlug } from './catalogue.mjs';
import { cartPage, dealsPage, helpPage, homePage, infoPage, notFoundPage, productPage, queryString, shopPage, shopQuery, trackPage, trackStatusPage } from './pages.mjs';

export const manifest = JSON.parse(readFileSync(new URL('./bugs.json', import.meta.url), 'utf8'));
export const BUG_IDS = manifest.bugs.map(bug => bug.id);

// "all", "none" or a comma-separated list of bug IDs.
export function parseBugs(spec = 'all') {
  if (spec === 'all') return new Set(BUG_IDS);
  if (spec === 'none' || spec === '') return new Set();
  const ids = spec.split(',').map(id => id.trim()).filter(Boolean);
  const unknown = ids.filter(id => !BUG_IDS.includes(id));
  if (unknown.length) throw new Error(`Unknown bug ID: ${unknown.join(', ')}. Known: ${BUG_IDS.join(', ')}.`);
  return new Set(ids);
}

const MAX_SESSIONS = 10_000;

export function createShop({ bugs = new Set(BUG_IDS) } = {}) {
  // Adds per browser session, for flaky-add. A fresh browser starts at zero.
  const adds = new Map();
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://larchwood');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    let session = /(?:^|;\s*)lw_sid=([0-9a-f-]{36})/.exec(req.headers.cookie ?? '')?.[1];
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (!session) {
      session = randomUUID();
      headers['Set-Cookie'] = `lw_sid=${session}; Path=/; HttpOnly; SameSite=Lax`;
    }
    const send = (status, body, type = 'text/html; charset=utf-8') => {
      res.writeHead(status, { ...headers, 'Content-Type': type });
      res.end(req.method === 'HEAD' ? undefined : body);
    };

    if (path === '/api/cart/items') {
      if (req.method !== 'POST') return send(405, '{"error":"Method not allowed"}', 'application/json');
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { raw += chunk; if (raw.length > 2048) req.destroy(); });
      req.on('end', () => {
        let input;
        try { input = JSON.parse(raw); } catch { return send(400, '{"error":"Invalid request"}', 'application/json'); }
        const product = productBySlug.get(input?.product);
        const quantity = Number(input?.quantity);
        if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) return send(400, '{"error":"Invalid request"}', 'application/json');
        if (!product.inStock) return send(409, '{"error":"Sold out"}', 'application/json');
        if (adds.size >= MAX_SESSIONS && !adds.has(session)) adds.clear();
        const count = (adds.get(session) ?? 0) + 1;
        adds.set(session, count);
        if (bugs.has('flaky-add') && count % 2 === 0) return send(503, '{"error":"Service unavailable"}', 'application/json');
        send(200, JSON.stringify({ ok: true }), 'application/json');
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed', 'text/plain; charset=utf-8');

    if (path === '/') return send(200, homePage({ bugs }));
    if (path === '/shop') return send(200, shopPage({ bugs, params: url.searchParams }));
    if (path.startsWith('/product/')) {
      const product = productBySlug.get(path.slice('/product/'.length));
      if (!product) return send(404, notFoundPage({ bugs }));
      // Only a well-formed shop query is carried back to the results.
      const from = queryString(shopQuery(new URLSearchParams(url.searchParams.get('from') ?? '')));
      return send(200, productPage({ bugs, product, from }));
    }
    if (path === '/cart') return send(200, cartPage({ bugs }));
    if (path === '/deals') return send(200, dealsPage({ bugs }));
    if (path === '/help') return send(200, helpPage({ bugs }));
    if (path === '/track') return send(200, trackPage({ bugs }));
    if (path === '/track/status') {
      if (bugs.has('tracking-500')) return send(500, 'Internal Server Error', 'text/plain; charset=utf-8');
      return send(200, trackStatusPage({ bugs, number: String(url.searchParams.get('number') ?? '').trim().slice(0, 12) }));
    }
    if (path === '/shipping-returns' && bugs.has('returns-404')) return send(404, notFoundPage({ bugs }));
    if (['/about', '/shipping-returns', '/checkout'].includes(path)) return send(200, infoPage({ bugs, path }));
    send(404, notFoundPage({ bugs }));
  };
}

export async function startShop({ port = 0, host = '127.0.0.1', bugs = new Set(BUG_IDS) } = {}) {
  const server = createServer(createShop({ bugs }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const actual = server.address().port;
  return {
    port: actual, bugs,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actual}`,
    close: () => new Promise((resolve, reject) => { server.closeAllConnections?.(); server.close(error => error ? reject(error) : resolve()); }),
  };
}
