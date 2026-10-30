import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { linkSource } from '../packages/web-ui/testing/link.mjs';

// Render persisted API snapshots as strings. No browser is launched or controlled.
const env = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8'));
const get = async path => {
  const response = await fetch('http://127.0.0.1:18080' + path, {
    headers: { Authorization: `Bearer ${env.SCOUT_API_TOKEN}` },
    signal: AbortSignal.timeout(10000), redirect: 'error',
  });
  assert.equal(response.status, 200, path);
  return response.json();
};
const source = await readFile(new URL('../apps/web/src/main.js', import.meta.url), 'utf8');
const served = await (await fetch('http://127.0.0.1:18080/assets/app/main.js')).text();
const sha = value => createHash('sha256').update(value).digest('hex');
assert.equal(sha(served), sha(source), 'Rebuild the API to serve the current interface.');
// The customer workspace and the operator back office are linked and rendered separately.
const link = (app, names) => {
  const root = { innerHTML: '', addEventListener() {}, querySelectorAll() { return []; } };
  const sandbox = {
    document: { querySelector() { return root; }, addEventListener() {} },
    window: { addEventListener() {} }, sessionStorage: { getItem() { return null; } },
    setInterval() {}, URL,
  };
  vm.createContext(sandbox);
  vm.runInContext(linkSource(new URL(`../apps/${app}/src/`, import.meta.url), 'main.js') + `\nglobalThis.ui={${names}};`, sandbox);
  return sandbox.ui;
};
const { state, home, runView } = link('web', 'state,home,runView');
const backoffice = link('backoffice', 'state,operations,drawer');
const [runs, jobs, providers, overview, usage] = await Promise.all([
  '/v1/runs', '/v1/browser-jobs', '/v1/model-providers', '/v1/operations', '/v1/usage',
].map(get));
Object.assign(state, { runs: runs.runs, jobs: jobs.jobs, workers: jobs.workers, settings: jobs.settings, providers });
Object.assign(backoffice.state, { runs: runs.runs, jobs: jobs.jobs, workers: jobs.workers,
  settings: jobs.settings, providers, operations: overview, usage });
state.access=await get('/v1/browser-access');
assert.match(home(), /Paste a URL/);assert.match(home(), /id="target-url"/);assert.match(home(), /Start testing/);
const fixture = JSON.parse(await readFile(new URL('../artifacts/workspace/verification.json', import.meta.url), 'utf8'));
let plannerIds = [];
try {
  const planner = JSON.parse(await readFile(new URL('../artifacts/exploration-planner/verification.json', import.meta.url), 'utf8'));
  plannerIds = [planner.tree_run_id, planner.replay_run_id, planner.changed_controls_run_id, ...planner.viewports.map(run => run.run_id)];
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const ids = [...new Set([fixture.source_run_id, fixture.replay_run_id, fixture.interrupted_run_id,
  ...(fixture.interaction_run_id?[fixture.interaction_run_id]:[]),
  ...(fixture.journey_run_id?[fixture.journey_run_id]:[]),
  ...plannerIds,
  ...runs.runs.slice(0, 3).map(run => run.run_id)])];
try {
  const interactions=JSON.parse(await readFile(new URL('../artifacts/browser-interactions/verification.json',import.meta.url),'utf8'));
  for(const id of [...interactions.viewports.map(run=>run.run_id),...interactions.replays.flatMap(run=>[run.source_run_id,run.replay_run_id])])if(!ids.includes(id))ids.push(id);
}catch(error){if(error.code!=='ENOENT')throw error;}
let rendered = 1;
try {
  const automatic=JSON.parse(await readFile(new URL('../artifacts/automatic-reproduction/verification.json',import.meta.url),'utf8'));
  for(const id of [...Object.values(automatic.runs),automatic.children.completed_run])if(id&&!ids.includes(id))ids.push(id);
}catch(error){if(error.code!=='ENOENT')throw error;}
try {
  const reviews=JSON.parse(await readFile(new URL('../artifacts/finding-reviews/verification.json',import.meta.url),'utf8'));
  for(const id of [reviews.source_run_id,reviews.replay_run_id])if(!ids.includes(id))ids.push(id);
}catch(error){if(error.code!=='ENOENT')throw error;}
try {
  const cancellation=JSON.parse(await readFile(new URL('../artifacts/cancellation/verification.json',import.meta.url),'utf8'));
  for(const id of Object.values(cancellation.runs))if(!ids.includes(id))ids.push(id);
}catch(error){if(error.code!=='ENOENT')throw error;}
try {
  const access=JSON.parse(await readFile(new URL('../artifacts/browser-access/verification.json',import.meta.url),'utf8'));
  for(const id of [access.source_run_id,access.replay_run_id,access.reuse_run_id,access.interrupted_run_id])if(!ids.includes(id))ids.push(id);
}catch(error){if(error.code!=='ENOENT')throw error;}
try {
  const outcomes=JSON.parse(await readFile(new URL('../artifacts/action-outcomes/verification.json',import.meta.url),'utf8'));
  for(const id of Object.values(outcomes.runs))if(!ids.includes(id))ids.push(id);
}catch(error){if(error.code!=='ENOENT')throw error;}
for (const id of ids) {
  state.runId = id;
  state.report = await get('/v1/runs/' + id);
  if(state.report.finding_reviews?.length){
    state.tab='findings';state.findingFilter='confirmed';
    assert.match(runView(),/Human confirmed/);rendered++;
    state.findingFilter='all';
    assert.match(runView(),/All candidates/);rendered++;
  }
  for (const action of state.report.actions) {
    state.actionId = action.action_id;
    const frames=state.report.events.filter(e=>e.action_id===action.action_id&&e.event_type==='action.settling_frame');
    if(frames.length){
      state.tab='actions';state.image='frame';state.frameId=frames[0].payload.frame_id;
      assert.match(runView(),/Action completion/);assert.ok(runView().includes(frames[0].payload.frame_id));rendered++;
    }
    for (const image of ['before', 'after', 'mask']) {
      state.image = image;
      state.tab = 'actions';
      assert.match(runView(), /Actions recorded/);
      rendered++;
    }
  }
  for (const tab of ['findings', 'flow']) {
    state.tab = tab;
    const view = runView();
    assert.match(view, /Coverage is bounded/);
    if (tab === 'flow' && state.report.graph?.selections?.length) {
      assert.match(view, /Discovery tree/);
      assert.match(view, /Next-action score/);
      assert.doesNotMatch(view, /NaN\/100|undefined/);
    }
    rendered++;
  }
  Object.assign(backoffice.state, { runId: id, report: state.report });
  for (const tab of ['overview', 'jobs', 'models', 'events', 'connections']) {
    backoffice.state.opsTab = tab;
    const view = backoffice.operations();
    assert.match(view, /Operations/);
    assert.doesNotMatch(view, /#\/workspace/);
    rendered++;
  }
  if (state.report.model_requests.length) {
    backoffice.state.drawer = { model: await get('/v1/model-requests/' + state.report.model_requests[0].request_id) };
    assert.match(backoffice.drawer(), /Stored request \/ response payloads/);
    rendered++;
  }
}
const result = { status: 'passed', verified_at: new Date().toISOString(), runs: ids.length,
  rendered_views: rendered, served_script_sha256: sha(source),
  method: 'pure_string_rendering_of_authenticated_API_snapshots',
  visual_browser_check: 'not_part_of_this_template_check' };
await writeFile(new URL('../artifacts/workspace/render-verification.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
