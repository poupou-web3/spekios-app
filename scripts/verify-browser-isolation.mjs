import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// The browser sandbox runs every target site. It must hold no Scout credentials
// or volumes, reach none of Scout's storage, API or model services, run
// Chromium's own sandbox, and serve exactly one client per container start.
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const compose = (...args) => docker('compose', ...args);
const ids = service => compose('ps', '-q', service).trim().split('\n').filter(Boolean);
const inspectId = id => JSON.parse(docker('inspect', id))[0];
const inspect = service => inspectId(ids(service)[0]);
const node = (service, script) => JSON.parse(compose('exec', '-T', service, 'node', '-e', script));
const nodeId = (id, script) => JSON.parse(docker('exec', id, 'node', '-e', script));

const sandboxes = ids('browser-sandbox').map(inspectId);
assert.ok(sandboxes.length > 0, 'Start the browser sandbox first.');
for (const sandbox of sandboxes) {
  assert.equal(sandbox.State.Health?.Status, 'healthy', 'Start the browser sandbox first.');
  const secrets = sandbox.Config.Env.map(entry => entry.split('=')[0]).filter(key => /PASSWORD|SECRET|TOKEN|API_KEY|ACCESS_KEY|VAULT|PGHOST|CLICKHOUSE|S3_/.test(key));
  assert.deepEqual(secrets, [], 'The browser sandbox must not receive Scout credentials.');
  assert.deepEqual(sandbox.Mounts, [], 'The browser sandbox must not mount volumes.');
  const networks = Object.keys(sandbox.NetworkSettings.Networks);
  assert.deepEqual(networks.map(name => name.replace(/^.*_/, '')), ['browser']);
  assert.equal(sandbox.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(sandbox.HostConfig.CapDrop, ['ALL']);
  assert.ok(sandbox.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
}
const sandbox = sandboxes[0];
const networks = Object.keys(sandbox.NetworkSettings.Networks);

// Probe by name and by address: Docker isolates bridge networks, not just DNS.
const internal = ['postgres', 'evidence', 'clickhouse', 'api'];
const targets = Object.fromEntries([['postgres', 5432], ['evidence', 8333], ['clickhouse', 8123], ['api', 8080], ['exploration-fixture', 8082]]);
const addresses = Object.fromEntries(internal.map(service => [service, Object.values(inspect(service).NetworkSettings.Networks)[0].IPAddress]));
const probes = [...Object.entries(targets), ...internal.map(service => [addresses[service], targets[service]])];
const reach = nodeId(sandbox.Id, `const net=require('node:net');
const probe=([host,port])=>new Promise(done=>{const s=net.connect({host,port,timeout:3000});s.on('connect',()=>{s.destroy();done('open');});s.on('timeout',()=>{s.destroy();done('timeout');});s.on('error',e=>done(e.code||'error'));});
Promise.all(${JSON.stringify(probes)}.map(async p=>[p[0]+':'+p[1],await probe(p)])).then(r=>console.log(JSON.stringify(Object.fromEntries(r))));`);
for (const [host, port] of probes) if (host !== 'exploration-fixture') assert.notEqual(reach[`${host}:${port}`], 'open', `The browser sandbox reached ${host}:${port}.`);
assert.equal(reach['exploration-fixture:8082'], 'open', 'The browser sandbox must reach the fixture app.');

// The worker's private-login port shares the browser network; it needs the operator token.
let handoff = null;
if (compose('ps', '-q', 'browser-worker').trim()) {
  handoff = nodeId(sandbox.Id, `fetch('http://browser-worker:8083/access/00000000-0000-4000-8000-000000000000/start',{method:'POST'}).then(r=>console.log(JSON.stringify(r.status)),e=>console.log(JSON.stringify(e.cause?.code||'error')))`);
  assert.equal(handoff, 401);
  const worker = node('browser-worker', `const fs=require('node:fs');console.log(JSON.stringify({endpoint:process.env.SCOUT_BROWSER_ENDPOINT,slots:Number(process.env.SCOUT_BROWSER_SLOTS||1),chromium:fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).some(p=>{try{return /chrom/.test(fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0')[0]);}catch{return false;}})}))`);
  assert.equal(worker.endpoint, 'ws://browser-sandbox:3000/browser');
  assert.equal(worker.slots, sandboxes.length, 'Each browser slot needs its own sandbox container.');
  assert.equal(worker.chromium, false, 'The browser worker must not run Chromium.');
}

const chromium = nodeId(sandbox.Id, `const fs=require('node:fs');console.log(JSON.stringify(fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).map(p=>{try{return fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0');}catch{return [];}}).filter(args=>/chrom/.test(args[0]||''))))`);
assert.ok(chromium.length > 0, 'The sandbox must keep a browser ready.');
const chromiumSandbox = !chromium.some(args => args.includes('--no-sandbox'));
if (!sandbox.Config.Env.includes('SCOUT_CHROMIUM_SANDBOX=false')) assert.ok(chromiumSandbox, 'Chromium must run with its own sandbox.');

// One client per container start: a second client to that same container is
// refused, and that container restarts once the first leaves. Other replicas
// keep serving their own runs.
const chosen = sandboxes[0];
const slotAddress = Object.values(chosen.NetworkSettings.Networks).map(network => network.IPAddress).find(Boolean);
assert.ok(slotAddress, 'The sandbox container has no browser-network address.');
const endpoint = `ws://${slotAddress}:3000/browser`;
const session = JSON.parse(compose('run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', 'recorder', '-e', `const {chromium}=require('playwright');(async()=>{
  const endpoint=${JSON.stringify(endpoint)},browser=await chromium.connect(endpoint,{timeout:15000});
  let second='connected';try{await (await chromium.connect(endpoint,{timeout:5000})).close();}catch{second='refused';}
  const page=await (await browser.newContext()).newPage();await page.goto('http://exploration-fixture:8082/branches');
  const result={title:await page.title(),version:browser.version(),second};await browser.close();console.log(JSON.stringify(result));
})().catch(e=>{console.error(e.message);process.exit(1);});`));
assert.equal(session.second, 'refused', 'The sandbox must serve one client at a time.');
assert.ok(session.title);
let restarted;
for (let attempt = 0; attempt < 60 && !restarted; attempt++) {
  await delay(1000);
  const current = inspectId(chosen.Id);
  if (current.State.StartedAt !== chosen.State.StartedAt && current.State.Health?.Status === 'healthy') restarted = current;
}
assert.ok(restarted, 'The sandbox must restart after its client leaves.');
assert.equal(restarted.RestartCount, sandbox.RestartCount + 1);
console.log(JSON.stringify({ result: 'PASS', networks, reach, worker_login_port_status: handoff, chromium_sandbox: chromiumSandbox,
  browser_version: session.version, second_client: session.second, restarts: restarted.RestartCount - sandbox.RestartCount }, null, 2));
