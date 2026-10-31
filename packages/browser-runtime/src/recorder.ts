import { chromium, type BrowserContext, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { comparePng } from '../../image-diff/index.mjs';
import { Store, jsonBytes } from './store.js';
import { permitBrowserRequest } from './exploration-policy.js';
import { validatePlan, type ActionSpec, type Expectation, type Assessment, type Capture, type Observation } from './contracts.js';

const message = (error: unknown) => error instanceof Error ? error.message.slice(0, 1000) : 'Unknown runtime failure';
export type Hooks = {
  beforeCapture?: (page: Page) => Promise<void>;
  observationContext?: () => { auth_context_id?: string };
  screenshot?: (page: Page, phase: 'before' | 'after', ordinal: number) => Promise<Buffer>;
  afterDispatch?: (ordinal: number) => Promise<void>;
  observe?: (page: Page) => Promise<Pick<Observation, 'controls' | 'controls_truncated'>>;
};

export const CAPTURE_POLICY = {
  screenshot_caret: 'hide',
  screenshot_animations: 'disabled',
  reduced_motion: 'reduce',
  capture_clock: 'paused_during_capture',
} as const;

// CSS animations are held on the initial frame for the PNG only. The bytes
// stored afterwards are still the exact device pixels of that frame.
export async function image(page: Page, timeout = 5000) {
  return page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', caret: 'hide', scale: 'device', timeout });
}

// Installed before navigation, then left running. Capture pauses it so a clock
// or timer-driven frame cannot move between the screenshot and the DOM read.
export async function prepareCaptureContext(context: BrowserContext) {
  await context.clock.install({ time: Date.now() });
  await context.clock.resume();
}

// The page clock keeps running between reading it and pausing, and Playwright
// refuses to pause in its past, so pause slightly ahead and retry once.
export async function withFrozenClock<T>(page: Page, body: () => Promise<T>): Promise<T> {
  const ahead = async () => {
    let now = Date.now();
    try { now = await page.evaluate(() => Date.now()); } catch { /* Navigation can replace the page world before the read. */ }
    return now + 50;
  };
  try { await page.clock.pauseAt(await ahead()); }
  catch (error) {
    if (!/fast-forward to the past/.test(String(error))) throw error;
    await page.clock.pauseAt(await ahead() + 1000);
  }
  try { return await body(); }
  finally { await page.clock.resume().catch(() => {}); }
}

export async function installNetworkGate(context: BrowserContext, pageOrigin: string, allowedOrigins: readonly string[] = []) {
  await context.route('**/*', async route => {
    try {
      const request = route.request();
      const main = request.isNavigationRequest() && !request.frame()?.parentFrame();
      const allowed = permitBrowserRequest(pageOrigin, request.url(), main ? 'main' : 'subresource', allowedOrigins);
      if (allowed) await route.continue();
      else await route.abort('blockedbyclient');
    } catch {
      try { await route.abort('blockedbyclient'); } catch { /* The browser already finished this request. */ }
    }
  });
  await context.routeWebSocket('**/*', async socket => {
    try {
      if (permitBrowserRequest(pageOrigin, socket.url(), 'subresource', allowedOrigins)) socket.connectToServer();
      else await socket.close();
    } catch {
      try { await socket.close(); } catch { /* The socket is already closed. */ }
    }
  });
}
async function expectedValue(page: Page, expected: Expectation): Promise<string | null> {
  if (expected.kind === 'url_equals') return page.url();
  const locator = page.getByTestId(expected.testId);
  if (await locator.count() !== 1) return null;
  return expected.kind === 'text_equals' ? (await locator.textContent({ timeout: 1000 }))?.trim() ?? null
    : locator.getAttribute(expected.attribute, { timeout: 1000 });
}
export async function capture(store: Store, page: Page, runId: string, actionId: string, phase: 'before' | 'after', ordinal: number, expected: Expectation | null, hooks: Hooks) {
  await hooks.beforeCapture?.(page);
  const id = await store.beginCapture(runId, actionId, phase);
  try {
    const shot = await withFrozenClock(page, async () => {
      const started = new Date().toISOString();
      const bytes = await (hooks.screenshot ? hooks.screenshot(page, phase, ordinal) : image(page));
      await hooks.beforeCapture?.(page);
      const finished = new Date().toISOString();
      let state: Pick<Observation, 'title' | 'text' | 'text_truncated' | 'scroll' | 'device_scale'> = { title: null, text: null, text_truncated: null, scroll: null, device_scale: null };
      let value: string | null = null;
      let observationError: string | null = null;
      let controls: Pick<Observation, 'controls' | 'controls_truncated'> = {};
      try {
        state = await page.evaluate(() => {
          const text = document.body?.innerText ?? '';
          return { title: document.title, text: text.slice(0, 8000), text_truncated: text.length > 8000,
            scroll: { x: window.scrollX, y: window.scrollY }, device_scale: window.devicePixelRatio };
        });
        value = expected ? await expectedValue(page, expected) : null;
        controls = await hooks.observe?.(page) ?? {};
      } catch (error) { observationError = message(error); }
      // A failed DOM read must not discard a screenshot that was already taken.
      const observation: Observation = { ...state, ...controls, ...hooks.observationContext?.(), url: page.url(), viewport: page.viewportSize()!,
        observed_value: value, observation_error: observationError, observed_at: new Date().toISOString(),
        screenshot_started_at: started, screenshot_finished_at: finished };
      return { bytes, observation };
    });
    return { capture: await store.saveCapture(runId, actionId, id, phase, shot.bytes, shot.observation), bytes: shot.bytes };
  } catch (error) {
    // Keep pending_upload when a durable capture can be recovered from the spool.
    await store.query("UPDATE runtime_captures SET status=CASE WHEN status='capturing' THEN 'failed' ELSE status END,error=$2 WHERE capture_id=$1", [id, message(error)]);
    throw error;
  }
}

export async function record(store: Store, targetUrl: string, input: ActionSpec[], hooks: Hooks = {}) {
  const specs = validatePlan(targetUrl, input);
  const runId = randomUUID();
  // The run lock keeps recovery off this recording until the connection drops.
  return store.locked('run:' + runId, async () => {
    await store.transaction(async () => {
      await store.query("INSERT INTO runtime_runs(run_id,workspace_id,user_id,target_url,lifecycle,config) VALUES($1,$2,$3,$4,'active',$5)",
        [runId, store.workspaceId, store.userId, targetUrl, JSON.stringify({ runtime_version: 'recorder-v1', expectation_source: 'fixture_defined',
          viewport: { width: 800, height: 600 }, device_scale: 1, video: false, ...CAPTURE_POLICY, service_workers: 'block', model_connection: null,
          scope: 'controlled-local-fixture', purpose: 'runtime_validation', training_status: 'excluded_fixture' })]);
      await store.event(runId, 'run.started', { target_url: targetUrl, planned_actions: specs.length });
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      // The browser receives no database, bucket, model, or target credentials.
      // validatePlan confines this recorder to the in-process fixture, so it runs
      // Chromium locally; target sites run in the browser sandbox instead.
      browser = await chromium.launch({ headless: true, chromiumSandbox: false,
        env: { PATH: process.env.PATH ?? '', HOME: '/tmp', LANG: 'C.UTF-8' } });
      const browserVersion = browser.version();
      await store.transaction(async () => {
        await store.query("UPDATE runtime_runs SET config=config || $2::jsonb WHERE run_id=$1", [runId, JSON.stringify({ browser: 'chromium', browser_version: browserVersion, playwright_version: '1.64.0' })]);
        await store.event(runId, 'browser.ready', { browser_version: browserVersion });
      });
      const context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1,
        serviceWorkers: 'block', acceptDownloads: false, locale: 'en-US', reducedMotion: CAPTURE_POLICY.reduced_motion });
      await prepareCaptureContext(context);
      const origin = new URL(targetUrl).origin;
      const allowedOrigins = (process.env.SCOUT_ALLOWED_ORIGINS ?? 'http://exploration-fixture:8082').split(',').map(s => s.trim());
      await installNetworkGate(context, origin, allowedOrigins);
      const page = await context.newPage();
      page.setDefaultTimeout(2000);
      page.on('dialog', dialog => void dialog.dismiss());
      context.on('page', popup => { if (popup !== page) void popup.close(); });
      let ordinal = 0;
      for (const spec of specs) {
        ordinal++;
        const actionId = randomUUID(), predictionId = randomUUID();
        await store.transaction(async () => {
          await store.query("INSERT INTO runtime_actions(action_id,run_id,ordinal,prediction_id,spec,state) VALUES($1,$2,$3,$4,$5,'prepared')",
            [actionId, runId, ordinal, predictionId, JSON.stringify(spec)]);
          await store.event(runId, 'action.prepared', { prediction_id: predictionId, ordinal, spec }, actionId);
        });
        let before: { capture: Capture; bytes: Buffer } | undefined;
        let after: { capture: Capture; bytes: Buffer } | undefined;
        let toolError: string | null = null;
        try {
          before = await capture(store, page, runId, actionId, 'before', ordinal, spec.prediction.expected, hooks);
          if (before.capture.observation.observation_error) throw new Error('Incomplete before observation: ' + before.capture.observation.observation_error);
          await store.transaction(async () => {
            await store.query("UPDATE runtime_actions SET state='dispatched',before_capture_id=$2,dispatched_at=now() WHERE action_id=$1", [actionId, before!.capture.capture_id]);
            await store.event(runId, 'action.dispatched', { before_capture_id: before!.capture.capture_id }, actionId);
          });
          await hooks.afterDispatch?.(ordinal);
          try {
            if (spec.command.type === 'navigate') {
              const response = await page.goto(spec.command.url, { waitUntil: 'load', timeout: 10000 });
              if (response && response.status() >= 400) toolError = `Navigation returned HTTP ${response.status()}`;
            } else await page.getByRole('button', { name: spec.command.button, exact: true }).click({ timeout: 2000 });
          } catch (error) { toolError = message(error); }
          after = await capture(store, page, runId, actionId, 'after', ordinal, spec.prediction.expected, hooks);
          const diff = comparePng(before.bytes, after.bytes, { beforeCaptureId: before.capture.capture_id, afterCaptureId: after.capture.capture_id });
          const raw = await store.artifact(runId, 'raw_mask', diff.rawMaskPng, 'png');
          const delta = await store.artifact(runId, 'absolute_delta', diff.absoluteDeltaPng, 'png');
          const geometry = diff.geometryMaskPng ? await store.artifact(runId, 'geometry_mask', diff.geometryMaskPng, 'png') : null;
          const comparison = { ...diff.metadata, raw_mask_artifact: raw, absolute_delta_artifact: delta, geometry_mask_artifact: geometry };
          const comparisonArtifact = await store.artifact(runId, 'comparison', jsonBytes(comparison), 'json');
          const expected = spec.prediction.expected, actual = after.capture.observation.observed_value;
          const checkError = toolError ?? after.capture.observation.observation_error;
          const assessment: Assessment = { check_id: randomUUID(), method: 'deterministic-fixture-v1',
            verdict: checkError ? 'inconclusive' : actual === expected.value ? 'no_issue_observed' : 'suspect',
            expected, actual, tool_error: toolError, confirmed_bug: false,
            reason: checkError ? 'Tool or observation failure; inspect the recorded result before classifying a product bug.'
              : actual === expected.value ? 'Observed value matches the frozen fixture expectation.' : 'Observed value does not match the frozen fixture expectation; reproduction is required.' };
          await store.transaction(async () => {
            await store.query("UPDATE runtime_actions SET state='completed',after_capture_id=$2,comparison=$3,assessment=$4,tool_error=$5,finished_at=now() WHERE action_id=$1",
              [actionId, after!.capture.capture_id, JSON.stringify({ ...comparison, metadata_artifact: comparisonArtifact }), JSON.stringify(assessment), toolError]);
            await store.event(runId, 'action.assessed', { assessment, before_capture_id: before!.capture.capture_id,
              after_capture_id: after!.capture.capture_id, comparison_id: diff.metadata.difference_id, changed_pixels: diff.metadata.counts.changed_pixels }, actionId);
          });
          if (checkError) throw new Error('Stopped after an inconclusive tool or observation failure.');
        } catch (error) {
          await store.transaction(async () => {
            const updated = await store.query("UPDATE runtime_actions SET state='evidence_failed',before_capture_id=COALESCE(before_capture_id,$2),after_capture_id=COALESCE(after_capture_id,$3),assessment=$4,finished_at=now() WHERE action_id=$1 AND state<>'completed'",
              [actionId, before?.capture.capture_id ?? null, after?.capture.capture_id ?? null, JSON.stringify({ check_id: randomUUID(), method: 'deterministic-fixture-v1', verdict: 'inconclusive',
                expected: spec.prediction.expected, actual: null, reason: 'Incomplete evidence: ' + message(error), tool_error: toolError, confirmed_bug: false })]);
            if (updated.rowCount) await store.event(runId, 'action.evidence_failed', { error: message(error) }, actionId);
          });
          throw error;
        }
      }
      await store.transaction(async () => {
        await store.query("UPDATE runtime_runs SET lifecycle='completed',finished_at=now() WHERE run_id=$1", [runId]);
        await store.event(runId, 'run.completed', { executed_actions: specs.length });
      });
    } catch (error) {
      await store.transaction(async () => {
        await store.query("UPDATE runtime_runs SET lifecycle='failed',error=$2,finished_at=now() WHERE run_id=$1", [runId, message(error)]);
        await store.event(runId, 'run.failed', { error: message(error) });
      });
    } finally { await browser?.close(); }
    let manifestError: string | null = null;
    try { await store.publish(runId); } catch (error) { manifestError = message(error); }
    // Durable outbox remains pending if ClickHouse is unavailable.
    let exportError: string | null = null;
    try { await store.flush(); } catch (error) { exportError = message(error); }
    return { run_id: runId, report: await store.report(runId), manifest_error: manifestError, export_error: exportError };
  });
}
