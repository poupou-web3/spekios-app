import { Store } from './store.js';
import { record } from './recorder.js';
import { fixture, plan } from './fixture.js';
import { isUuid } from './contracts.js';
import { explore, reproduce } from './explorer.js';
import { viewportProfiles, type ViewportProfile } from './viewports.js';
import { ModelClient, modelSettings } from './model-client.js';

const [command = 'demo', id] = process.argv.slice(2);
// Live terminal explorations use app memory unless it is disabled. Simulated
// runs check contracts against fixed fixtures and never depend on earlier runs.
const memory = async () => process.env.SCOUT_EXPLORER_APP_MEMORY !== 'false' && await new ModelClient(modelSettings()).ready() === 'live';
const store = new Store();
try {
  await store.open();
  if (command === 'demo') {
    const target = await fixture();
    try {
      const results = [];
      for (const variant of ['working', 'broken', 'tiny'] as const) {
        const result = await record(store, target.url, plan(target.url, variant));
        results.push({ variant, run_id: result.run_id, lifecycle: result.report.run.lifecycle,
          manifest_key: result.report.run.manifest_key, manifest_error: result.manifest_error, export_error: result.export_error,
          actions: result.report.actions.map(action => ({ action_id: action.action_id, prediction_id: action.prediction_id,
            before_capture_id: action.before_capture_id, after_capture_id: action.after_capture_id,
            changed_pixels: action.comparison?.counts.changed_pixels, assessment: action.assessment })) });
        if (result.report.run.lifecycle !== 'completed' || result.manifest_error || result.export_error) process.exitCode = 1;
      }
      console.log(JSON.stringify({ mode: 'fixture_defined', model_connected: false, runs: results }, null, 2));
    } finally { await target.close(); }
  } else if (command === 'explore-matrix' && id) {
    const appMemory = await memory();
    const runs = await Promise.all((Object.keys(viewportProfiles) as ViewportProfile[]).map(async profile => {
      const session = await store.session();
      try {
        const result = await explore(session, id, { viewportProfile: profile, appMemory });
        if (result.report.run.lifecycle !== 'completed' || result.manifest_error || result.export_error) process.exitCode = 1;
        return { viewport_profile: profile, run_id: result.run_id, lifecycle: result.report.run.lifecycle, manifest_key: result.report.run.manifest_key,
          error: result.report.run.error, manifest_error: result.manifest_error, export_error: result.export_error };
      } catch (error) {
        process.exitCode = 1;
        return { viewport_profile: profile, error: error instanceof Error ? error.message : 'Exploration failed' };
      } finally { await session.close(); }
    }));
    console.log(JSON.stringify({ mode: 'concurrent_viewport_matrix', runs }, null, 2));
  } else if ((command === 'explore' || command === 'reproduce') && id) {
    const result = command === 'reproduce' ? await reproduce(store, id) : await explore(store, id, { appMemory: await memory() });
    console.log(JSON.stringify({ run_id: result.run_id, lifecycle: result.report.run.lifecycle,
      execution_mode: result.report.run.config.execution_mode, stop_reason: result.report.run.config.stop_reason,
      viewport_profile: result.report.run.config.viewport_profile, app_memory: result.report.run.config.app_memory,
      error: result.report.run.error, actions: result.report.actions.length, captures: result.report.captures.length,
      graph_states: result.report.graph?.states.length, graph_edges: result.report.graph?.edges.length,
      blocked_controls: result.report.graph?.frontier.filter((f: { status: string }) => f.status === 'blocked'),
      model_usage: result.report.model_usage, manifest_key: result.report.run.manifest_key,
      reproductions: result.report.reproductions, reused: result.reused,
      manifest_error: result.manifest_error, export_error: result.export_error, coverage_complete: false }, null, 2));
    if (result.report.run.lifecycle !== 'completed' || result.manifest_error || result.export_error) process.exitCode = 1;
  } else if (command === 'show' && id && isUuid(id)) {
    console.log(JSON.stringify(await store.report(id), null, 2));
  } else if (command === 'capture' && id && isUuid(id)) {
    process.stdout.write(await store.captureBytes(id));
  } else if (command === 'recover' && id && isUuid(id)) {
    console.log(JSON.stringify(await store.recover(id), null, 2));
    await store.flush();
  } else if (command === 'flush') {
    console.log(JSON.stringify({ exported_events: await store.flush() }));
  } else throw new Error('Usage: demo | explore <url> | explore-matrix <url> | reproduce <suspect-action-uuid> | show <run-uuid> | capture <capture-uuid> | recover <run-uuid> | flush');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Recorder failed');
  process.exitCode = 1;
} finally { await store.close(); }
