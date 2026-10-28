import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ActionSpec } from './contracts.js';

export async function fixture() {
  const server = createServer((request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`<!doctype html><html><head><title>Scout recorder fixture</title><style>
      body{font:16px system-ui;background:#fff;color:#18202a;margin:40px}
      button{background:#eee;color:#18202a;border:1px solid #777;padding:10px 16px;margin-right:8px;font:inherit;outline:none}
      #pixel{position:absolute;left:700px;top:100px;width:1px;height:1px;background:rgb(128,128,128)}
      </style></head><body><h1>Recorded action fixture</h1><p data-testid='status'>Ready</p>
      <button onclick="document.querySelector('[data-testid=status]').textContent='Saved'">Save</button>
      <button>Broken save</button>
      <button onclick="const p=document.getElementById('pixel');p.style.background='rgb(129,128,128)';p.dataset.state='changed'">Tiny change</button>
      <div id='pixel' data-testid='pixel' data-state='original'></div></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return { url, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

export function plan(url: string, variant: 'working' | 'broken' | 'tiny' | 'timeout' = 'working'): ActionSpec[] {
  return [
    { command: { type: 'navigate', url }, prediction: { source: 'fixture_defined', description: 'The fixture loads at the requested URL.', expected: { kind: 'url_equals', value: url } } },
    { command: { type: 'click', button: variant === 'working' ? 'Save' : variant === 'broken' ? 'Broken save' : variant === 'tiny' ? 'Tiny change' : 'Missing button' },
      prediction: { source: 'fixture_defined', description: variant === 'tiny' ? 'The pixel changes its state and red channel by one.' : 'Saving updates the status to Saved.',
        expected: variant === 'tiny' ? { kind: 'attribute_equals', testId: 'pixel', attribute: 'data-state', value: 'changed' } : { kind: 'text_equals', testId: 'status', value: 'Saved' } } },
  ];
}
