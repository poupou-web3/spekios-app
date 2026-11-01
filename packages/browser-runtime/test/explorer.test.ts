import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, hash } from '../src/store.js';
import { explore } from '../src/explorer.js';
import { image } from '../src/recorder.js';
import { ModelClient, modelSettings } from '../src/model-client.js';
import { explorationFixture } from '../src/exploration-fixture.js';
import { blockedReason, isLayoutOverlap, parseAssessment, parsePlan, permitBrowserRequest, validateTarget } from '../src/exploration-policy.js';
import type { ObservedControl } from '../src/contracts.js';

const control: ObservedControl = { control_id: 'a'.repeat(24), role: 'button', name: 'Preview', href: null, disabled: false, submits_form: false, ambiguous: false };
test('provider selection cannot accidentally reuse the default OpenRouter model', () => {
  const savedProvider = process.env.SCOUT_EXPLORER_PROVIDER, savedModel = process.env.SCOUT_EXPLORER_MODEL;
  try {
    process.env.SCOUT_EXPLORER_MODEL = '';
    process.env.SCOUT_EXPLORER_PROVIDER = 'openrouter';
    assert.equal(modelSettings().model, 'openrouter/free');
    process.env.SCOUT_EXPLORER_PROVIDER = 'anthropic';
    assert.throws(() => modelSettings(), /Configure SCOUT_EXPLORER_MODEL/);
    process.env.SCOUT_EXPLORER_PROVIDER = 'openai';
    assert.throws(() => modelSettings(), /Configure SCOUT_EXPLORER_MODEL/);
    process.env.SCOUT_EXPLORER_PROVIDER = 'meta';
    assert.equal(modelSettings().model, 'muse-wonder-1.0');
    assert.equal(modelSettings().provider, 'meta');
  } finally {
    if (savedProvider === undefined) delete process.env.SCOUT_EXPLORER_PROVIDER; else process.env.SCOUT_EXPLORER_PROVIDER = savedProvider;
    if (savedModel === undefined) delete process.env.SCOUT_EXPLORER_MODEL; else process.env.SCOUT_EXPLORER_MODEL = savedModel;
  }
});
test('only a reported collision asks for a longer layout wait', () => {
  assert.equal(isLayoutOverlap('The hero tagline visually overlaps the introductory paragraph.', 'The homepage is visible.'), true);
  assert.equal(isLayoutOverlap('A banner sits on top of the introduction.', 'Page loaded.'), true);
  assert.equal(isLayoutOverlap('The sections do not overlap.', 'Readable page.'), false);
  assert.equal(isLayoutOverlap('The draft did not reach Saved.', 'Service unavailable'), false);
});
test('model output cannot add tools, invent controls or forge evidence', () => {
  const candidate = {control_id: control.control_id,goal:'Preview item',expected_result:'A preview opens.',likelihood:0.8};
  assert.equal(parsePlan({candidates:[candidate],stop_reason:null},[control]).candidates[0].control_id, control.control_id);
  assert.throws(() => parsePlan({candidates:[candidate],stop_reason:null,execute_shell:'printenv'},[control]), /unsupported fields/);
  assert.throws(() => parsePlan({candidates:[{...candidate,control_id:'0'.repeat(24)}],stop_reason:null},[control]), /unobserved/);
  assert.throws(() => parsePlan({candidates:[candidate,candidate],stop_reason:null},[control]), /unobserved/);
  assert.throws(() => parsePlan({candidates:[candidate],stop_reason:null},[]), /unobserved/);
  assert.throws(() => parseAssessment({verdict:'suspect',reason:'x',observed_result:'y',evidence_capture_ids:['invented','invented'],expectation_uncertain:false}, ['before','after']), /exactly the two/);
  assert.equal(blockedReason({...control,name:'Upgrade'},'http://fixture'), 'payment_or_transaction_requires_handoff');
  assert.equal(blockedReason({...control,name:'Sign in'},'http://fixture'), 'credentials_required');
  assert.equal(blockedReason({...control,name:'Delete all'},'http://fixture'), 'potentially_destructive_or_external_action');
  assert.equal(blockedReason({...control,submits_form:true},'http://fixture'), 'form_submission_requires_handoff');
  assert.equal(blockedReason({...control,role:'link',href:'http://postgres:5432/'},'http://fixture'), 'outside_allowed_origin');
  assert.equal(blockedReason({...control,role:'link',href:'https://v2.bubblemaps.io/'},'https://bubblemaps.io'), null);
  assert.equal(blockedReason({...control,role:'link',href:'https://intel.bubblemaps.io/'},'https://bubblemaps.io'), null);
  assert.equal(blockedReason({...control,role:'link',href:'https://notbubblemaps.io/'},'https://bubblemaps.io'), 'outside_allowed_origin');
  assert.equal(blockedReason({...control,role:'link',href:'https://bubblemaps.io.evil.com/'},'https://bubblemaps.io'), 'outside_allowed_origin');
  assert.equal(blockedReason({...control,role:'link',href:'https://b.github.io/'},'https://a.github.io'), 'outside_allowed_origin');
  assert.throws(() => validateTarget('http://name:secret@fixture/', ['http://fixture']), /explicitly allowed origin/);
  assert.throws(() => validateTarget('http://unconfigured/', ['http://fixture']), /explicitly allowed origin/);
  assert.equal(validateTarget('https://bubblemaps.io/map', ['http://fixture']), 'https://bubblemaps.io/map');
  assert.throws(() => validateTarget('http://bubblemaps.io/', ['http://fixture']), /explicitly allowed origin/);
  assert.throws(() => validateTarget('https://127.0.0.1/', ['http://fixture']), /explicitly allowed origin/);
  assert.throws(() => validateTarget('https://app.internal/', ['http://fixture']), /explicitly allowed origin/);
});
test('public pages load public subresources and stay on the entry site', () => {
  const page = 'https://v2.bubblemaps.io';
  const allow = ['http://exploration-fixture:8082', 'http://127.0.0.1:3000', page];
  for (const url of [page + '/assets/app.js', 'https://api.bubblemaps.io/screener/tokens', 'https://shop.bubblemaps.io/token-ads',
    'https://fonts.googleapis.com/css2?family=Inter', 'https://www.googletagmanager.com/gtm.js',
    'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel', 'https://eu-assets.i.posthog.com/static/array.js',
    'wss://firestore.googleapis.com/ws', 'wss://v2.bubblemaps.io/live', 'data:image/png;base64,aaaa', 'blob:https://v2.bubblemaps.io/8c1d', 'about:blank', 'about:srcdoc'])
    assert.equal(permitBrowserRequest(page, url, 'subresource', allow), true, url);
  for (const url of ['http://api.bubblemaps.io/tokens', 'http://169.254.169.254/latest/meta-data', 'http://127.0.0.1/', 'https://127.0.0.1/',
    'http://localhost/admin', 'https://metadata.google.internal/computeMetadata/v1/', 'https://app.internal/', 'https://printer.local/',
    'https://user:pass@api.bubblemaps.io/tokens', 'https://api.bubblemaps.io:8443/tokens', 'ws://api.bubblemaps.io/socket', 'javascript:alert(1)',
    'file:///etc/passwd', 'http://exploration-fixture:8082/secret', 'http://127.0.0.1:3000/', 'https://2130706433/'])
    assert.equal(permitBrowserRequest(page, url, 'subresource', allow), false, url);
  assert.equal(permitBrowserRequest(page, page + '/map', 'main', allow), true);
  assert.equal(permitBrowserRequest(page, 'about:blank', 'main', allow), true);
  for (const url of ['https://api.bubblemaps.io/', 'https://intel.bubblemaps.io/', 'https://bubblemaps.io/'])
    assert.equal(permitBrowserRequest(page, url, 'main', allow), true, url);
  assert.equal(permitBrowserRequest('https://www.example.co.uk', 'https://shop.example.co.uk/', 'main', allow), true);
  for (const url of ['https://accounts.google.com/o/oauth2/auth', 'https://notbubblemaps.io/', 'https://bubblemaps.io.evil.com/',
    'https://b.github.io/', 'https://evil.co.uk/', 'http://intel.bubblemaps.io/', 'https://intel.bubblemaps.io:8443/',
    'data:text/html,hi', 'http://exploration-fixture:8082/'])
    assert.equal(permitBrowserRequest(page, url, 'main', allow), false, url);
  const fixture = 'http://exploration-fixture:8082';
  assert.equal(permitBrowserRequest(fixture, fixture + '/journeys/result', 'subresource', allow), true);
  assert.equal(permitBrowserRequest(fixture, 'ws://exploration-fixture:8082/ws', 'subresource', allow), true);
  assert.equal(permitBrowserRequest(fixture, 'https://fonts.googleapis.com/css', 'subresource', allow), true);
  assert.equal(permitBrowserRequest(fixture, 'http://127.0.0.1:3000/api', 'subresource', allow), true);
  assert.equal(permitBrowserRequest(fixture, 'http://postgres:5432/', 'subresource', allow), false);
  assert.equal(permitBrowserRequest(fixture, 'http://169.254.169.254/', 'subresource', allow), false);
  assert.equal(permitBrowserRequest(fixture, fixture + '/journeys/search', 'main', allow), true);
  assert.equal(permitBrowserRequest(fixture, 'https://fonts.googleapis.com/', 'main', allow), false);
  assert.equal(permitBrowserRequest(fixture, 'http://127.0.0.1:3000/', 'main', allow), false);
  assert.equal(permitBrowserRequest(page, 'not a url', 'subresource', allow), false);
});

test('model-driven browser loop preserves evidence, graph and uncertainty', {
  skip: process.env.SCOUT_EXPLORER_INTEGRATION !== '1', timeout: 300000,
}, async t => {
  const store = await new Store().open();
  const fixture = await explorationFixture();
  const client = new ModelClient({provider:'openrouter',model:'scout-explorer-fixture:free',freeOnly:true});
  assert.equal(await client.ready(), 'protocol_fixture', 'This test must never use live paid providers.');
  let workingId = '';
  const run = (path: string, options: Parameters<typeof explore>[2] = {}) => explore(store, fixture.url + path,
    {client,allowedOrigins:[fixture.url],maxActions:2,...options});
  try {
    await t.test('URL alone drives prediction, action, assessment and immutable model lineage', async () => {
      const result = await run('/working', { client: new ModelClient({provider:'openai',model:'scout-explorer-fixture',freeOnly:true}) });
      workingId = result.run_id;
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      assert.equal(result.manifest_error, null);
      assert.equal(result.export_error, null);
      assert.equal(result.report.actions.length, 2);
      assert.equal(result.report.captures.length, 4);
      assert.equal(result.report.model_requests.length, 4);
      assert.equal(result.report.model_usage.known_input_tokens, 64);
      assert.equal(result.report.model_usage.known_output_tokens, 20);
      assert.equal(result.report.model_usage.complete, true);
      assert.equal(result.report.graph.edges.length, 2);
      assert.equal(result.report.graph.coverage_complete, false);
      for (const action of result.report.actions) {
        assert.equal(action.spec.prediction.source, 'model');
        assert.equal(action.assessment.method, 'model-evidence-v1');
        assert.equal(action.assessment.verdict, 'no_issue_observed');
        assert.equal(action.assessment.confirmed_bug, false);
        const prediction = result.report.model_requests.find(r => r.request_id === action.spec.prediction.request_id)!;
        assert.ok(prediction.finished_at <= action.dispatched_at);
        assert.ok(result.report.graph.decisions.some((d: { request_id: string }) => d.request_id === action.assessment.request_id));
        assert.deepEqual(action.assessment.evidence_capture_ids, [action.before_capture_id, action.after_capture_id]);
      }
      for (const capture of result.report.captures) {
        assert.equal(hash(await store.captureBytes(capture.capture_id)), capture.sha256);
        const metadata = JSON.parse((await store.get(capture.metadata_key)).toString());
        assert.equal(metadata.action_id, capture.action_id);
        assert.equal(metadata.training_status, 'excluded_fixture');
      }
      const manifest = JSON.parse((await store.get(result.report.run.manifest_key)).toString());
      assert.equal(manifest.graph.edges.length, 2);
      assert.equal(manifest.model_calls.length, 4);
      assert.equal(manifest.model_payloads.length, 8);
      const events = result.report.events.map(e => Number(e.seq));
      assert.deepEqual(events, events.map((_, i) => i+1));
    });
    await t.test('broken no-op is checked with both images despite an empty pixel mask', async () => {
      const result = await run('/broken');
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      const action = result.report.actions[1];
      assert.equal(action.comparison.counts.changed_pixels, 0);
      assert.equal(action.assessment.verdict, 'suspect');
      assert.equal(action.assessment.confirmed_bug, false);
      assert.ok(action.assessment.request_id);
      const request = (await store.query('SELECT spec FROM model_requests WHERE request_id=$1', [action.assessment.request_id])).rows[0];
      assert.deepEqual(request.spec.capture_ids, [action.before_capture_id, action.after_capture_id]);
    });
    await t.test('one-channel one-pixel change stays in the evidence mask without splitting the state', async () => {
      const result = await run('/tiny', {client:new ModelClient({provider:'anthropic',model:'scout-explorer-fixture',freeOnly:true})});
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      assert.equal(result.report.actions[1].comparison.counts.changed_pixels, 1);
      assert.equal(result.report.actions[1].comparison.max_overlap_channel_delta, 1);
      assert.equal(result.report.actions[1].assessment.verdict, 'no_issue_observed');
      const edge = result.report.graph.edges[1];
      assert.equal(edge.from_state_id, edge.to_state_id);
      assert.notEqual(result.report.captures.find((c: { capture_id: string }) => c.capture_id === result.report.actions[1].before_capture_id).sha256,
        result.report.captures.find((c: { capture_id: string }) => c.capture_id === result.report.actions[1].after_capture_id).sha256);
      assert.equal(result.report.model_usage.known_input_tokens, 240);
    });
    await t.test('branch traversal returns to a prior state and does not replay its attempted controls', async () => {
      const result = await run('/branches', {maxActions:8});
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      assert.equal(result.report.run.config.stop_reason, 'no_reachable_unexplored_controls');
      assert.deepEqual(result.report.actions.slice(1).map(a => a.spec.command.control.name), ['Help','Home','Settings','Home']);
      assert.equal(result.report.graph.states.length, 4); // blank + root + two branches
      assert.equal(result.report.graph.edges.length, 5);
      assert.equal(result.report.model_requests.length, 10);
      assert.ok(result.report.graph.frontier.every((f: { status: string }) => f.status === 'attempted'));
    });
    await t.test('credential, payment and destructive controls remain blocked while public branches run', async () => {
      const result = await run('/access', {maxActions:8});
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      const blocked = result.report.graph.frontier.filter((f: { status: string }) => f.status === 'blocked');
      assert.equal(blocked.length, 3);
      assert.deepEqual(new Set(blocked.map((f: { reason: string }) => f.reason)), new Set(['credentials_required','payment_or_transaction_requires_handoff','potentially_destructive_or_external_action']));
      assert.ok(!fixture.requests.some(path => path.startsWith('/forbidden')));
      assert.ok(result.report.actions.some(a => a.spec.command.control?.name === 'Help'));
    });
    await t.test('unchanged successful controls cannot create an unbounded cycle', async () => {
      const result = await run('/loop', {maxActions:8});
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      assert.equal(result.report.actions.length, 2);
      assert.equal(result.report.actions[1].comparison.counts.changed_pixels, 0);
      assert.equal(result.report.actions[1].assessment.verdict, 'no_issue_observed');
      assert.equal(result.report.graph.edges[1].from_state_id, result.report.graph.edges[1].to_state_id);
    });
    await t.test('untrusted page instructions cannot authorize invented model actions', async () => {
      const result = await run('/malicious');
      assert.equal(result.report.run.lifecycle, 'failed');
      assert.match(result.report.run.error, /unobserved/);
      assert.equal(result.report.actions.length, 1);
      assert.equal(result.report.graph.decisions.at(-1).status, 'rejected');
      assert.equal(result.report.model_requests.length, 3);
    });
    await t.test('a model assessment failure retains executed action evidence and blocks further actions', async () => {
      for (const path of ['/invalid-assessment', '/provider-outage']) {
        const result = await run(path);
        assert.equal(result.report.run.lifecycle, 'failed');
        assert.equal(result.report.actions.length, 1);
        const action = result.report.actions[0];
        assert.equal(action.assessment.verdict, 'inconclusive');
        assert.ok(action.before_capture_id && action.after_capture_id && action.comparison);
        assert.equal(result.report.graph.edges.length, 1);
        assert.equal(result.report.captures.length, 2);
        assert.equal(result.report.model_requests.length, 2);
        if (path === '/provider-outage') assert.equal(result.report.model_usage.incomplete_usage_attempts, 1);
      }
    });
    await t.test('unsupported expectations override model bug guesses to inconclusive', async () => {
      const result = await run('/uncertain');
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      assert.ok(result.report.actions.every(a => a.assessment.verdict === 'inconclusive' && a.assessment.confirmed_bug === false));
    });
    await t.test('a screen change skips the stale prediction and replans from retained fresh evidence', async () => {
      let dispatched = 0;
      const result = await run('/working', {hooks:{
        screenshot:async (page,phase,ordinal) => {
          if (phase === 'before' && ordinal === 2) await page.evaluate(() => { document.querySelector('#status')!.textContent = 'Changed asynchronously'; });
          return image(page);
        }, afterDispatch:async () => { dispatched++; },
      }});
      assert.equal(dispatched, 2);
      assert.equal(result.report.run.lifecycle, 'completed',result.report.run.error);
      assert.equal(result.report.actions.length,3);
      assert.equal(result.report.actions[1].state,'skipped');
      assert.equal(result.report.actions[1].dispatched_at, null);
      assert.ok(result.report.actions[1].before_capture_id);
      assert.equal(result.report.actions[1].after_capture_id, null);
      assert.equal(result.report.actions[2].spec.prediction.context_capture_id,result.report.actions[1].before_capture_id);
      assert.equal(result.report.run.config.replans,1);
      assert.ok(result.report.events.some(e=>e.event_type==='exploration.replanned'));
    });
    await t.test('persistent page drift defers the unstable branch after three retained replans without dispatching stale controls',async()=>{
      const result=await run('/working',{hooks:{screenshot:async(page,phase,ordinal)=>{
        if(phase==='before'&&ordinal>1)await page.evaluate(value=>{document.querySelector('#status')!.textContent=`Update ${value}`;},ordinal);
        return image(page);
      }}});
      assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      assert.equal(result.report.run.config.stop_reason,'no_reachable_unexplored_controls');
      assert.ok(result.report.events.some(e=>e.event_type==='exploration.branch_deferred'));
      assert.equal(result.report.actions.filter(a=>a.dispatched_at).length,1);
      assert.equal(result.report.actions.filter(a=>a.state==='skipped').length,3);
      assert.equal(result.report.graph.edges.length,1);
    });
    await t.test('a leaf without a Home link returns to the root and explores the next probable branch',async()=>{
      const result=await run('/tree',{maxActions:5});
      assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      assert.deepEqual(result.report.actions.map(a=>a.spec.command.type==='navigate'?'navigate':a.spec.command.control.name),['navigate','Catalog','navigate','Help','Save draft']);
      const back=result.report.actions[2];
      assert.equal(back.spec.exploration.purpose,'return');
      assert.equal(back.assessment.verdict,'no_issue_observed');
      assert.ok(back.before_capture_id&&back.after_capture_id&&back.comparison);
      assert.equal(result.report.actions[4].assessment.verdict,'suspect');
      assert.ok(result.report.graph.selections.some((s:any)=>s.purpose==='return'&&s.selected.name==='Help'));
      assert.ok(result.report.graph.states.some((s:any)=>s.planning.depth===1));
    });
    await t.test('new clickable content inside the changed region gets priority over an unchanged link',async()=>{
      const result=await run('/changing-controls',{maxActions:3});
      assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      assert.deepEqual(result.report.actions.slice(1).map(a=>a.spec.command.control.name),['Open menu','Menu item']);
      const choice=result.report.graph.selections.at(-1);
      assert.equal(choice.selected.name,'Menu item');
      assert.equal(choice.selected.likelihood,.65);
      assert.ok(choice.selected.components.newly_exposed>0&&choice.selected.components.changed_control>0);
      const old=choice.ranked_paths.find((p:any)=>p.name==='Help'&&p.travel_steps===0);
      assert.ok(old.likelihood>choice.selected.likelihood);
      assert.ok(old.priority<choice.selected.priority);
    });
    await t.test('desktop tablet and mobile each observe their own responsive controls and capture geometry',async()=>{
      for(const [profile,label,width,height] of [['desktop','Desktop navigation',1920,1080],['tablet','Tablet navigation',768,1024],['mobile','Mobile navigation',390,844]] as const){
        const result=await run('/responsive',{viewportProfile:profile});
        assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
        assert.equal(result.report.run.config.viewport_profile,profile);
        assert.equal(result.report.actions[1].spec.command.control.name,label);
        assert.deepEqual(result.report.run.config.viewport,{width,height});
        assert.ok(result.report.captures.every(c=>c.observation.viewport.width===width&&c.observation.viewport.height===height));
      }
    });
    await t.test('a visible control under an overlay is recorded as blocked and never clicked',async()=>{
      const result=await run('/covered');
      assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      const covered=result.report.graph.frontier.find((f:any)=>f.control.name==='Hidden action');
      assert.equal(covered.status,'blocked');
      assert.equal(covered.reason,'covered_or_unclickable_control');
      assert.ok(!fixture.requests.includes('/forbidden-covered'));
    });
    await t.test('an exhausted time budget stops before dispatching another action', async () => {
      let dispatched = 0;
      const result = await run('/working', {maxActions:8, maxDurationMs:1, hooks:{afterDispatch:async () => { dispatched++; }}});
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      assert.equal(result.report.run.config.stop_reason, 'time_budget_reached');
      assert.equal(result.report.run.config.limits.max_duration_ms, 1);
      assert.equal(dispatched, 0);
    });
    await t.test('missing before evidence prevents even initial navigation', async () => {
      let dispatched = 0;
      const result = await run('/working', {hooks:{ screenshot:async () => {throw new Error('injected image failure');}, afterDispatch:async () => {dispatched++;} }});
      assert.equal(dispatched, 0);
      assert.equal(result.report.run.lifecycle, 'failed');
      assert.equal(result.report.actions[0].dispatched_at, null);
      assert.equal(result.report.actions[0].assessment.verdict, 'inconclusive');
    });
    await t.test('interrupted model decisions are marked without replaying actions or model charges', async () => {
      const decisionId = randomUUID();
      await store.query("INSERT INTO exploration_decisions(decision_id,run_id,request_id,kind,status,input_capture_ids) VALUES($1,$2,$3,'plan','requested','{}')", [decisionId,workingId,randomUUID()]);
      const before = await store.report(workingId);
      await store.recover(workingId);
      const after = await store.report(workingId);
      assert.equal(after.graph.decisions.find((d: { decision_id: string }) => d.decision_id === decisionId).status, 'interrupted');
      assert.equal(after.actions.length, before.actions.length);
      assert.equal(after.model_calls.length, before.model_calls.length);
    });
    await store.flush();
  } finally { await fixture.close(); await store.close(); }
});
