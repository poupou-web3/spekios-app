import { chromium, type Browser } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';

// Target sites run in the browser sandbox container whenever an endpoint is
// configured. The sandbox holds no Scout credentials, joins only the browser
// network and serves one connection before it restarts, so every run gets a
// fresh browser. Without an endpoint Chromium runs in this process's container;
// tests use that for fixtures served in-process.
export type BrowserIsolation = 'sandbox' | 'local';
export const BROWSER_SANDBOX_WAIT_MS = 90_000;
export const browserEndpoint = () => process.env.SCOUT_BROWSER_ENDPOINT?.trim() || null;

export async function openBrowser(signal: AbortSignal, waitMs = BROWSER_SANDBOX_WAIT_MS): Promise<{ browser: Browser; isolation: BrowserIsolation }> {
  const endpoint = browserEndpoint();
  if (!endpoint) return { isolation: 'local', browser: await chromium.launch({ headless: true, chromiumSandbox: false,
    env: { PATH: process.env.PATH ?? '', HOME: '/tmp', LANG: 'C.UTF-8' } }) };
  // A restarting or busy sandbox refuses connections; wait for the next one.
  const deadline = Date.now() + waitMs;
  for (;;) {
    signal.throwIfAborted();
    try { return { isolation: 'sandbox', browser: await chromium.connect(endpoint, { timeout: 15_000 }) }; }
    catch { if (Date.now() >= deadline) throw new Error('The browser sandbox is unavailable. Start it with docker compose up -d browser-sandbox.'); }
    await delay(500, undefined, { signal }).catch(() => signal.throwIfAborted());
  }
}
