import { connect, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

// Entrypoint of the browser sandbox container. Chromium listens on loopback;
// the network port accepts exactly one client and relays it there. When that
// client leaves, the browser closes and the process exits so Docker restarts
// the container: processes, cookies and /tmp from one run never reach the next.
const PORT = 3000, BROWSER_PORT = 3001, startedAt = Date.now();
const server = await chromium.launchServer({ host: '127.0.0.1', port: BROWSER_PORT, wsPath: '/browser', headless: true,
  chromiumSandbox: process.env.SCOUT_CHROMIUM_SANDBOX !== 'false', env: { PATH: process.env.PATH ?? '', HOME: '/tmp', LANG: 'C.UTF-8' } });
let finishing = false;
const finish = async (code: number) => {
  if (finishing) return;
  finishing = true;
  await server.close().catch(() => {});
  // Docker backs off restarts of containers that ran for under ten seconds.
  await delay(Math.max(0, 10_000 - (Date.now() - startedAt)));
  process.exit(code);
};
server.on('close', () => void finish(1));
const front = createServer(client => {
  front.close();
  const browser = connect(BROWSER_PORT, '127.0.0.1');
  // Playwright accepts only loopback Host headers on a loopback listener. This
  // relay is the sandbox's one network entry, so it presents the upgrade as local.
  let head = Buffer.alloc(0);
  const upgrade = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) { if (head.length > 16384) client.destroy(); return; }
    client.off('data', upgrade);
    const request = head.subarray(0, end).toString('latin1').replace(/^host:.*$/im, `Host: 127.0.0.1:${BROWSER_PORT}`);
    browser.write(Buffer.concat([Buffer.from(request, 'latin1'), head.subarray(end)]));
    client.pipe(browser);
  };
  client.on('data', upgrade);
  browser.pipe(client);
  for (const socket of [client, browser]) {
    socket.on('error', () => socket.destroy());
    socket.on('close', () => { client.destroy(); browser.destroy(); void finish(0); });
  }
});
front.listen(PORT, '0.0.0.0');
process.on('SIGTERM', () => void server.close().catch(() => {}).finally(() => process.exit(0)));
