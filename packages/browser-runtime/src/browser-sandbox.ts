import { chromium, type Browser } from 'playwright';
import { lookup } from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Store } from './store.js';

// Target sites run in the browser sandbox containers whenever an endpoint is
// configured. A sandbox holds no Scout credentials, joins only the browser
// network and serves one connection before it restarts, so every run gets a
// fresh browser. Without an endpoint Chromium runs in this process's container;
// tests use that for fixtures served in-process.
export type BrowserIsolation = 'sandbox' | 'local';
export type OpenedBrowser = { browser: Browser; isolation: BrowserIsolation; slot: number | null; release: () => Promise<void> };
export const BROWSER_SANDBOX_WAIT_MS = 90_000;
export const browserEndpoint = () => process.env.SCOUT_BROWSER_ENDPOINT?.trim() || null;
// One slot per sandbox container, shared by every worker and CLI process.
export function browserSlots() {
  const slots = Number(process.env.SCOUT_BROWSER_SLOTS ?? '1');
  if (!Number.isInteger(slots) || slots < 1 || slots > 8) throw new Error('SCOUT_BROWSER_SLOTS must be an integer from 1 to 8.');
  return slots;
}

// A slot is an advisory lock on its own connection. Releasing destroys that
// connection, which frees the lock even if the unlock could not be sent.
async function reserveSlot(store: Store, signal: AbortSignal) {
  const client = await store.pool.connect();
  try {
    for (;;) {
      for (let slot = 0; slot < browserSlots(); slot++) {
        const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', ['browser-slot:' + slot]);
        if (rows[0].acquired) return { slot, release: async () => client.release(true) };
      }
      await delay(1000, undefined, { signal }).catch(() => signal.throwIfAborted());
    }
  } catch (error) { client.release(true); throw error; }
}

// A scaled sandbox service resolves to one address per container. Busy or
// restarting sandboxes refuse connections, so each address is tried in turn.
async function connectSandbox(endpoint: string, signal: AbortSignal, waitMs: number) {
  const url = new URL(endpoint), deadline = Date.now() + waitMs;
  for (;;) {
    signal.throwIfAborted();
    const addresses = (await lookup(url.hostname, { all: true, family: 4 }).catch(() => [])).sort(() => Math.random() - .5);
    for (const { address } of addresses) {
      try { return await chromium.connect(`${url.protocol}//${address}:${url.port}${url.pathname}`, { timeout: 15_000 }); }
      catch { /* Try the next sandbox. */ }
    }
    if (Date.now() >= deadline) throw new Error('The browser sandbox is unavailable. Start it with docker compose up -d browser-sandbox.');
    await delay(500, undefined, { signal }).catch(() => signal.throwIfAborted());
  }
}

export async function openBrowser(store: Store, signal: AbortSignal, waitMs = BROWSER_SANDBOX_WAIT_MS): Promise<OpenedBrowser> {
  const endpoint = browserEndpoint();
  if (!endpoint) return { isolation: 'local', slot: null, release: async () => {}, browser: await chromium.launch({ headless: true, chromiumSandbox: false,
    env: { PATH: process.env.PATH ?? '', HOME: '/tmp', LANG: 'C.UTF-8' } }) };
  // Waiting for a slot has no deadline: a run queues behind running ones.
  const reserved = await reserveSlot(store, signal);
  try { return { isolation: 'sandbox', slot: reserved.slot, release: reserved.release, browser: await connectSandbox(endpoint, signal, waitMs) }; }
  catch (error) { await reserved.release(); throw error; }
}
