const ref = (name) => ({ $ref: '#/components/schemas/' + name });
const uuid = { type: 'string', format: 'uuid', not: { const: '00000000-0000-0000-0000-000000000000' } };
// Exploration limits are optional: absent or null means no limit.
const limitFields = {
  max_actions: { type: ['integer','null'], minimum: 1, maximum: 10000, description: 'Executed actions per exploration, including navigation and returns. null: no limit.' },
  max_minutes: { type: ['integer','null'], minimum: 1, maximum: 10080, description: 'Wall-clock minutes per exploration attempt. null: no limit.' },
  max_tokens: { type: ['integer','null'], minimum: 1000, maximum: 1000000000, description: 'Provider-reported input plus output tokens per run, checked before each new action. null: no limit.' },
  max_cost_usd: { type: ['number','null'], minimum: 0.01, maximum: 100000, description: 'Provider-reported cost per run, checked before each new action; unpriced calls do not count. null: no limit.' },
};
const string = { type: 'string' };
const bool = { type: 'boolean' };
const object = { type: 'object', additionalProperties: true };
const nullableObject = { type: ['object', 'null'], additionalProperties: true };
const bounded = (min, max, value) => ({ type: 'integer', minimum: min, maximum: max, ...(value === undefined ? {} : { default: value }) });
const choice = (...values) => ({ type: 'string', enum: values });
const strict = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const response = (description, schema = object, mime = 'application/json') => ({ description, content: { [mime]: { schema } } });
const pathParameter = (name, schema = uuid) => ({ name, in: 'path', required: true, schema });
const query = (name, schema, description) => ({ name, in: 'query', required: false, schema, description });
const body = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const errors = Object.fromEntries([400, 401, 403, 404, 409, 413, 503].map((code) => [code, response('Request rejected; inspect the error. Framework parsing errors can differ.', ref('Error'))]));
const operation = (id, tag, summary, extra = {}) => ({
  operationId: id, tags: [tag], summary,
  responses: { '200': response('Current recorded state. No inference is triggered by reads.'), ...errors },
  ...extra,
});

export function openapi(catalog) {
  const tools = catalog.tools;
  const paths = {};
  function add(path, method, id, tag, summary, extra = {}) {
    paths[path] ??= {};
    paths[path][method] = operation(id, tag, summary, extra);
  }
  add('/healthz', 'get', 'health', 'Status', 'Read API process health', { security: [], responses: { '200': response('Process health; not provider or worker readiness.') } });
  add('/v1/auth-mode', 'get', 'authMode', 'Status', 'Read the GUI authentication mode', { security: [] });
  add('/v1/agent-setup','get','agentSetup','Identity','Read the nonsecret user connection URL and configured hosting mode',{security:[]});
  for (const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']) {
    add(path,'get',path.endsWith('/mcp')?'mcpResourceMetadata':'rootResourceMetadata','OAuth','Discover the canonical MCP resource and authorization server',{security:[]});
  }
  add('/.well-known/oauth-authorization-server','get','oauthServerMetadata','OAuth','Discover public-client DCR, PKCE authorization, token and revocation endpoints',{security:[]});
  add('/oauth/register','post','registerOAuthClient','OAuth','Register a public MCP client; no client secret is issued',{
    security:[],requestBody:body({type:'object',required:['redirect_uris'],properties:{client_name:{type:'string',maxLength:80},redirect_uris:{type:'array',minItems:1,maxItems:10,items:{type:'string',format:'uri',maxLength:2048}},token_endpoint_auth_method:{const:'none'},grant_types:{type:'array',items:choice('authorization_code','refresh_token')},response_types:{type:'array',items:{const:'code'}}}}),
    responses:{'201':response('Registered public client ID and metadata.'),...errors,'429':response('Global registration admission limit reached.')},
  });
  add('/oauth/authorize','get','authorizeOAuthClient','OAuth','Validate a client request and open explicit browser consent',{
    security:[],parameters:[...['response_type','client_id','redirect_uri','resource','code_challenge','code_challenge_method'].map(name=>({...query(name,string,'Required OAuth parameter; only code / S256 and the canonical /mcp resource are supported.'),required:true})),query('scope',string,'Space-separated runs:read, runs:write and usage:read.'),query('state',string,'Client correlation value, echoed unchanged.')],
    responses:{'303':{description:'Navigate to Spekios browser approval. No access token is issued.',headers:{Location:{schema:string}}},...errors,'429':response('Too many pending authorizations.')},
  });
  add('/v1/oauth/authorizations/{id}','get','reviewOAuthAuthorization','OAuth','Manager-only pending authorization details',{parameters:[pathParameter('id')]});
  add('/v1/oauth/authorizations/{id}/decision','post','decideOAuthAuthorization','OAuth','Explicitly approve or deny and return the validated browser callback',{
    parameters:[pathParameter('id')],requestBody:body(strict({approve:bool,scopes:{type:'array',minItems:1,items:choice('runs:read','runs:write','usage:read')}},['approve'])),
  });
  add('/oauth/token','post','exchangeOAuthToken','OAuth','Exchange a single-use PKCE code or rotate a refresh token',{
    security:[],requestBody:{required:true,content:{'application/x-www-form-urlencoded':{schema:{type:'object',required:['grant_type','client_id','resource'],properties:{grant_type:choice('authorization_code','refresh_token'),client_id:string,resource:{type:'string',format:'uri'},code:string,code_verifier:{type:'string',minLength:43,maxLength:128},redirect_uri:{type:'string',format:'uri'},refresh_token:string,scope:string}}}}},
    responses:{'200':response('Sensitive tokens for the client credential store only. One-hour access maximum; rotating refresh within a fixed thirty-day connection.'),...errors},
  });
  add('/oauth/revoke','post','revokeOAuthToken','OAuth','Revoke an OAuth connection with its token; unknown tokens are a successful no-op',{
    security:[],requestBody:{required:true,content:{'application/x-www-form-urlencoded':{schema:{type:'object',required:['client_id','token'],properties:{client_id:string,token:string,token_type_hint:string}}}}},responses:{'200':{description:'Connection revoked or token unknown. Empty body.'},...errors},
  });
  add('/readyz', 'get', 'readiness', 'Status', 'Check protected readiness');
  add('/v1/identity', 'get', 'whoami', 'Identity', 'Read authenticated workspace, agent and scopes without a secret');
  add('/v1/workspaces', 'post', 'createWorkspace', 'Identity', 'Operator-only private workspace provisioning', {
    requestBody: body(strict({name:{type:'string',minLength:1,maxLength:100}},['name'])),
    responses: {'201':response('New private workspace; manager_token returned once. Store privately.'),...errors},
  });
  add('/v1/agents', 'get', 'listAgents', 'Identity', 'Manager-only recent agent credentials metadata');
  add('/v1/agents/{id}/revoke', 'post', 'revokeAgent', 'Identity', 'Manager or same-agent revocation; existing jobs continue', {parameters:[pathParameter('id')]});
  add('/v1/agent-connections', 'post', 'startAgentConnection', 'Identity', 'Begin verifier-bound browser approval without granting access', {
    security:[], requestBody:body(strict({agent_name:{type:'string',minLength:1,maxLength:80},scopes:{type:'array',minItems:1,maxItems:3,items:choice('runs:read','runs:write','usage:read')},code_challenge:{type:'string',pattern:'^[a-f0-9]{64}$'}},['agent_name','scopes','code_challenge'])),
    responses:{'200':response('Ten-minute device code, public approval code, browser path and polling interval.'),...errors,'429':response('Too many outstanding connections.')},
  });
  add('/v1/agent-connections/token', 'post', 'exchangeAgentConnection', 'Identity', 'Exchange an approved one-time device code and verifier', {
    security:[], requestBody:body(strict({device_code:{type:'string',minLength:64,maxLength:64},code_verifier:{type:'string',minLength:32,maxLength:256}},['device_code','code_verifier'])),
    responses:{'200':response('Agent token returned once. Save in private local secret storage.'),'202':response('Authorization pending; wait at least five seconds.'),...errors,'429':response('Polling too quickly.')},
  });
  add('/v1/agent-connections/{code}', 'get', 'reviewAgentConnection', 'Identity', 'Manager-only review of a pending agent connection', {parameters:[pathParameter('code',{type:'string',description:'Twelve hexadecimal characters; optional dashes accepted.'})]});
  add('/v1/agent-connections/{code}/decision', 'post', 'decideAgentConnection', 'Identity', 'Manager-only explicit approval or denial', {parameters:[pathParameter('code',{type:'string'})],requestBody:body(strict({approve:bool},['approve']))});
  const historyParameters=[query('domain',{type:'string',maxLength:253},'Exact hostname; never grants access to another workspace.'),query('url',{type:'string',maxLength:2048},'Exact normalized HTTP(S) URL.'),...['agent_id','project_id','task_id'].map(name=>query(name,uuid,'Caller-scoped attribution or correlation filter.')),query('offset',bounded(0,100000,0),'Offset in matching history; not snapshot frozen.'),query('limit',bounded(1,50,20),'Maximum runs per page.')];
  add('/v1/history/sessions','get','listSessions','History','Search private complete run history with filters and offset pagination',{parameters:historyParameters});
  add('/v1/history/domain','get','domainSummary','History','Read latest twenty historical runs and matching total for an exact domain',{parameters:historyParameters.map(p=>p.name==='domain'?{...p,required:true}:p)});

  add('/v1/capabilities', 'get', 'capabilities', 'Status', 'Read implemented capabilities');
  add('/v1/operations', 'get', 'operations', 'Status', 'Read delivery and queue snapshots');
  add('/v1/browser-jobs', 'get', 'listJobs', 'Jobs', 'List recent owned jobs and worker state');
  add('/v1/browser-jobs', 'post', 'submitJob', 'Jobs', 'Admit durable URL exploration or reproduction', {
    description: 'At most ten active jobs. The address must be http or https without embedded credentials, and the provider must be available. Save job_id before sending. Identical ID/input retries reuse the original settings snapshot; changed input conflicts. Can change target data and consume model usage.',
    requestBody: body(ref('JobSubmission')),
    responses: { '202': response('New job admitted.', ref('JobAdmission')), '200': response('Original admission reused.', ref('JobAdmission')), ...errors },
  });
  add('/v1/browser-jobs/{job_id}', 'get', 'getJob', 'Jobs', 'Read one job independently of the recent list', { parameters: [pathParameter('job_id')] });
  const reportParameters = [
    query('offset', bounded(0, 100000, 0), 'Index in the filtered ordered report.'),
    query('limit', bounded(1, 10, 4), 'Maximum requested items; the response adapts to the byte bound.'),
    query('include_changes', { ...bool, default: true }, 'Include ordinary observed changes.'),
    query('expected_snapshot', { type: 'string', pattern: '^[a-fA-F0-9]{64}$' }, 'Use the continuation hash. On conflict restart from offset zero.'),
  ];
  for (const [path, parameter, label] of [
    ['/v1/browser-jobs/{job_id}', 'job_id', 'Job'],
    ['/v1/runs/{run_id}', 'run_id', 'Run'],
  ]) {
    add(path + '/progress', 'get', 'get' + label + 'Progress', 'Reports', 'Read lightweight ' + label.toLowerCase() + ' progress', {
      parameters: [pathParameter(parameter)], responses: { '200': response('Recorded progress; no invented percent/ETA.', ref('Progress')), ...errors },
    });
    add(path + '/report', 'get', 'get' + label + 'Report', 'Reports', 'Read paged coding-agent feedback by ' + label.toLowerCase(), {
      parameters: [pathParameter(parameter), ...reportParameters],
      responses: { '200': response('Partial, finished, queued or pre-launch outcome.', ref('Report')), ...errors },
    });
    add(path + '/cancel', 'post', 'cancel' + label, 'Jobs', 'Request durable ' + label.toLowerCase() + ' cancellation', {
      parameters: [pathParameter(parameter)],
      responses: { '202': response('Cancellation requested; inspect acknowledgement.'), '200': response('Recorded terminal/cancellation state.'), ...errors },
    });
  }
  add('/v1/runs', 'get', 'listRuns', 'Runs', 'Read a page of tests and the complete website catalog',{
    parameters:[query('origin',{type:'string',maxLength:2048},'Exact website origin; paths share a website, staging hosts and ports stay separate.'),query('offset',bounded(0,100000,0),'Page offset. Returns up to 50 tests, total and next_offset.')],
    description:'The websites array groups all owned runs by origin, including websites outside the current page. Without origin, runs remains the latest workspace run page. Reads never start inference.',
  });
  add('/v1/issues','get','listPersistentIssues','Issues','Find permanent issues in the authenticated workspace',{
    parameters:[query('origin',{type:'string',maxLength:2048},'Restrict findings to this exact website origin.'),query('query',{type:'string',maxLength:200},'Substring of title or source URL.'),query('outcome',choice('unverified','running','resolved','still_reproducible','blocked','inconclusive'),'Latest candidate check outcome; never a global fix status.'),query('triage',choice('open','untriaged','needs_review','bug','intended_behavior','duplicate'),'Current triage. open means untriaged, needs review or bug; omit to include known intended behavior and duplicates.'),query('offset',bounded(0,100000,0),'Page offset.'),query('limit',bounded(1,50,20),'Maximum issues.')],
  });
  add('/v1/issues/{issue_id}/triage','post','triageIssue','Issues','Decide whether an issue is a bug, intended behavior or a duplicate',{
    parameters:[pathParameter('issue_id')],
    requestBody:body(strict({decision:choice('bug','intended_behavior','duplicate','needs_review'),rationale:{type:'string',minLength:1,maxLength:2000,description:'Why, grounded in evidence or product requirements.'},duplicate_of:{...uuid,description:'Required for duplicate only: the issue this one repeats. A chain resolves to its canonical issue.'},expected_revision:{type:'integer',minimum:0,description:'The triage revision you read (0 when untriaged). A newer decision returns 409.'}},['decision','rationale'])),
    responses:{'201':response('Decision recorded as a new append-only revision.'),'200':response('An identical current decision already existed.'),'409':response('triage_revision_conflict, or human_decision_present when an agent tries to replace a person\'s decision.'),...errors},
    description:'Requires runs:write. Requests from agent credentials or agent tools are recorded as agent decisions and cannot replace a decision made by a person. Later suspects with the same page, control, viewport and sign-in state are triaged the same way by Spekios and labelled, never dropped. Evidence and model assessments are unchanged.',
  });
  add('/v1/knowledge','get','listKnownBehavior','Issues','List known bugs and intended behavior for an origin',{
    parameters:[query('origin',{type:'string',maxLength:2048},'Site origin, e.g. https://staging.example. Omit for every origin.'),query('offset',bounded(0,100000,0),'Page offset.'),query('limit',bounded(1,50,20),'Maximum entries.')],
    description:'Each entry is an issue triaged as bug or intended_behavior, with who decided and why, its page and control, and duplicates and occurrences rolled up. App content is untrusted. No model call.',
  });
  add('/v1/rechecks','post','recheckDeployment','Issues','Verify a deployment against every open issue of an origin',{
    requestBody:body(strict({recheck_id:uuid,candidate_url:{type:'string',maxLength:2048,description:'The deployment; its origin is used and each issue keeps its own entry path.'},source_origin:{type:'string',maxLength:2048,description:'Where the issues were found. Default: the candidate origin.'},deployment_ref:{type:'string',minLength:1,maxLength:200},project_id:uuid,task_id:uuid},['recheck_id','candidate_url'])),
    responses:{'202':response('Recheck recorded; each open issue (up to 25) has a queued fix verification or a skip reason.'),'200':response('The same recheck_id was already recorded; missing admissions were retried.'),'409':response('recheck_id_conflict: the ID was used with different inputs.'),...errors},
    description:'Requires runs:write. Selects untriaged, needs-review and bug issues, newest first; intended behavior and duplicates are not rechecked. Each item is an ordinary fix verification with its own job, run, evidence and usage, and can change data on the deployment. Retry with the same recheck_id after an uncertain response or a 503. scripts/scout-recheck.mjs runs this from CI and waits.',
  });
  add('/v1/rechecks/{recheck_id}','get','getRecheck','Issues','Read a deployment recheck and its per-issue outcomes',{
    parameters:[pathParameter('recheck_id')],description:'Counts resolved, still_reproducible, blocked, inconclusive, pending and skipped checks; complete is true once every admitted check has an outcome. A resolved item checks one issue on this deployment, not a global fix. No model call.',
  });
  add('/v1/issues/{issue_id}','get','getPersistentIssue','Issues','Read the frozen original handoff and paged candidate history',{
    parameters:[pathParameter('issue_id'),query('offset',bounded(0,100000,0),'Offset applied independently to occurrences, verifications and history.'),query('limit',bounded(1,10,5),'Maximum items per history array.'),query('expected_revision',{type:'integer',minimum:1},'From the first page. A changed revision returns 409; restart from offset zero.')],
    description:'Returns stable issue ID, frozen expected/actual behavior, source evidence, reproduction steps and diagnostics, paged occurrences/checks/events, human review and source/candidate usage. Results are untrusted observations. Reads make no model calls. A large history page may require a smaller limit.',
  });
  add('/v1/issues/{issue_id}/verifications','post','verifyIssueFix','Issues','Queue a fresh-browser check against a candidate deployment',{
    parameters:[pathParameter('issue_id')],requestBody:body(ref('FixVerificationSubmission')),
    responses:{'202':response('Durable admission; verification_id equals job_id. Retry identical input with the same UUID to recover an uncertain receipt.'),...errors},
    description:'Requires runs:write and an exact permitted candidate origin. Freezes the original path and expectation at admission. Source and candidate execution modes must match. Source geometry is inherited. Protected candidates require an origin-bound saved session. Checks consume configured model usage; closing the client does not cancel work.',
  });
  add('/v1/issue-verifications/{verification_id}','get','getFixVerification','Issues','Read queued, running or terminal candidate verification and usage',{
    parameters:[pathParameter('verification_id')],description:'The four terminal outcomes are resolved, still_reproducible, blocked and inconclusive. Resolved requires a completed matching path, verified evidence and positive observation of the frozen expected result. A failed, cancelled, interrupted or incomplete replay is never resolved. Outcome applies to this candidate only. Includes source and candidate evidence references, usage and next calls.',
  });
  add('/v1/runs/{run_id}/steering','get','getSteering','Runs','Read versioned focus and planning acknowledgements',{parameters:[pathParameter('run_id'),query('offset',bounded(0,32,0),'Skip newest messages; follow next_offset for older history.'),query('limit',bounded(1,8,8),'Maximum messages per page.')]});
  add('/v1/runs/{run_id}/steering','post','submitSteering','Runs','Replace testing focus at the next planning decision; preserve the current action',{
    parameters:[pathParameter('run_id')],requestBody:body(strict({steering_id:uuid,expected_revision:bounded(0,32),focus:{type:'string',maxLength:2000,description:'Replacement focus; empty clears it. No credentials.'}},['steering_id','expected_revision','focus'])),
    responses:{'200':response('Versioned history and submission. Status pending, applied, superseded or not_applied. Applied acknowledges planner input, not coverage.'),...errors,'422':response('Invalid UUID, revision, focus length or control characters.',ref('Error'))},
  });
  add('/v1/runs/{run_id}', 'get' , 'getRun', 'Runs', 'Read the raw stored run projection', { parameters: [pathParameter('run_id')] });
  add('/v1/runs/{run_id}/issues/{action_id}', 'get', 'getIssue', 'Reports', 'Read one detailed coding-agent handoff', {
    parameters: [pathParameter('run_id'), pathParameter('action_id')],
    responses: { '200': response('Recorded issue with expectation, location, observed result, evidence and uncertainty.', ref('Issue')), ...errors },
  });
  add('/v1/runs/{run_id}/graph', 'get', 'getGraph', 'Runs', 'Read the raw stored graph', {
    description: 'The REST projection is not the bounded agent graph tool. Use scout_get_graph for per-array paging.',
    parameters: [pathParameter('run_id')],
  });
  add('/v1/runs/{run_id}/events', 'get', 'getEvents', 'Runs', 'Read durable events after a sequence cursor', {
    parameters: [pathParameter('run_id'), query('after_seq', { type: 'integer', minimum: 0, default: 0 }, 'Last observed sequence.'), query('limit', bounded(1, 100, 10), 'Maximum events.')],
  });
  add('/v1/runs/{run_id}/automatic-reproductions/cancel', 'post', 'cancelAutomaticChecks', 'Jobs', 'Stop a source run’s automatic rechecks', {
    parameters: [pathParameter('run_id')],
    responses: { '202': response('Cancellation requested.'), '200': response('Recorded cancellation state.'), ...errors },
  });
  add('/v1/captures/{capture_id}', 'get', 'getCapture', 'Evidence', 'Read capture metadata', { parameters: [pathParameter('capture_id')] });
  add('/v1/captures/{capture_id}/image', 'get', 'getCaptureImage', 'Evidence', 'Download a hash-verified PNG', {
    parameters: [pathParameter('capture_id')],
    responses: { '200': response('Private, uncached PNG verified against recorded hash/length.', { type: 'string', format: 'binary' }, 'image/png'), ...errors, '502': response('Object retrieval/integrity failed.', ref('Error')) },
  });
  add('/v1/artifacts/{artifact_id}/content', 'get', 'getArtifact', 'Evidence', 'Download verified PNG or JSON artifact content', {
    parameters: [pathParameter('artifact_id')],
    responses: { '200': { description: 'Verified private artifact bytes.', content: { 'image/png': { schema: { type: 'string', format: 'binary' } }, 'application/json': { schema: {} } } }, ...errors, '502': response('Object retrieval/integrity failed.', ref('Error')) },
  });
  add('/v1/agent/tools', 'get', 'listAgentTools', 'Agent tools', 'Read the shared MCP/HTTP tool catalog and instructions');
  add('/v1/agent/tools/{name}', 'post', 'callAgentTool', 'Agent tools', 'Call a shared tool with its direct argument object', {
    description: 'Select arguments using mcp-tools.json or the live catalog. Cross-field constraints are validated by the dispatcher. Success is HTTP 200, including asynchronous admission. Domain errors preserve HTTP status and use the tool envelope.',
    parameters: [pathParameter('name', { type: 'string', enum: tools.map((t) => t.name) })],
    requestBody: body({ type: 'object', description: 'Exact inputSchema depends on name. See x-scout-tool-input-schemas and the generated reference.', additionalProperties: true }),
    'x-scout-tool-input-schemas': Object.fromEntries(tools.map((t) => [t.name, t.inputSchema])),
    responses: { '200': response('MCP tool-result envelope.', ref('ToolResult')), ...Object.fromEntries(Object.keys(errors).map((code) => [code, response('Tool/domain failure. Invalid routes or framework errors can use the ordinary error body.', { oneOf: [ref('ToolResult'), ref('Error')] })])) },
  });
  add('/v1/exploration-settings', 'get', 'getSettings', 'Settings', 'Read effective defaults and append-only revision');
  add('/v1/exploration-settings', 'post', 'saveSettings', 'Settings', 'Save nonsecret defaults using optimistic revision', {
    requestBody: body(ref('SettingsSubmission')),
    responses: { '201': response('New defaults revision saved.'), '200': response('Original save reused.'), ...errors },
  });
  add('/v1/projects', 'get', 'listProjects', 'Settings', 'List known projects with the model and limits a new run in each would use', {
    description: 'Projects this user has started jobs in (up to 200, most recently used first) followed by projects only named in settings. Each entry has the label, job and run counts, last_job_at, the resolved model with model.source (project or default), resolved limits and the overrides applied. A project is any UUID sent as project_id. No model call.',
  });
  add('/v1/projects/{project_id}', 'get', 'getProject', 'Settings', 'Read the model and limits a new run in one project would use', {
    parameters: [pathParameter('project_id')],
    description: 'Works for a project with no jobs yet: it resolves to the defaults until settings name it. No model call.',
  });
  add('/v1/model-providers', 'get', 'getProviders', 'Models', 'Read provider availability without keys');
  add('/v1/computer-use/check','post','checkComputerUse','Models','Check a Meta connection for native computer-tool support',{
    description:'Manager/operator only. One metered request through the selected saved key, with no app screenshots and no action execution. Poll /v1/model-requests/{request_id}; completed confirms the native protocol. Proof is account, key and execution-mode scoped and expires after 30 days. Read successful checks in /v1/model-providers computer_use. Does not enable recovery by itself.',
    requestBody:body(strict({request_id:uuid,provider:{const:'meta'},model:{type:'string',minLength:1,maxLength:200},provider_key_id:{type:['string','null'],description:'Saved key UUID or demo; absent uses the provider default.'}},['request_id','provider','model'])),
    responses:{'202':response('Compatibility check admitted. Poll using the supplied request ID.'),...errors,'402':response('Insufficient demo credit.')},
  });
  add('/v1/usage', 'get', 'getUsage', 'Models', 'Read nullable provider-reported token/cost totals', {
    description: 'known_input_tokens, known_output_tokens and known_total_tokens count only what providers reported; null means unknown, not zero. by_model has the same counts and reported cost for each provider and model, and by_agent for each agent. Run reports (model_usage) and the run list use the same fields for one run.',
  });
  add('/v1/model-requests', 'post', 'submitModelRequest', 'Models', 'Admit a bounded nonstreaming model request', {
    requestBody: body(ref('ModelRequest')),
    responses: { '202': response('Request admitted.', ref('ModelAdmission')), '200': response('Original admission reused.', ref('ModelAdmission')), ...errors },
  });
  add('/v1/model-requests/{request_id}', 'get', 'getModelRequest', 'Models', 'Read recorded model request and attempts', { parameters: [pathParameter('request_id')] });
  add('/v1/app-memory', 'get', 'listAppMemory', 'Settings', 'List remembered app scopes from earlier explorations', {
    description: 'One scope per origin, viewport profile and size, sign-in state and execution mode, newest first (at most 100). Counts pages, tried/untried controls, map states, transitions and depth. Memory is derived from runs; it never contains screenshots or field values.',
  });
  add('/v1/app-memory/{scope_id}/map', 'get', 'getAppMap', 'Settings', 'Read the app map carried between runs for one scope', {
    parameters: [pathParameter('scope_id'), query('offset', bounded(0,100000,0), 'States to skip, ordered by depth then page template.'), query('limit', bounded(1,100,20), 'Maximum states.')],
    description: 'States by depth from the entry page with where each control led (up to 40 transitions per state), verdict counts and up to 12 controls no run has tried there. The summary reports coverage at each depth (by_depth): control entries any run acted on out of those the screens offer. A state is a page template (identifiers become :n or :id) plus the controls it offers, with repeated list items collapsed. Written by explorations that use app memory. No model call.',
  });
  add('/v1/runs/{run_id}/map-diff', 'get', 'compareRunMap', 'Runs', 'Compare a run with earlier runs of the same app scope', {
    parameters: [pathParameter('run_id')],
    description: 'New states and transitions, states the previous run reached but this run did not, controls that now lead to a different state, and verdict changes on the same transition (regression: no_issue_observed before, suspect now). Lists are capped at 50 with full counts. A run without app memory has no scope to compare. No model call.',
  });
  add('/v1/app-memory/{scope_id}/forget', 'post', 'forgetAppMemory', 'Settings', 'Forget one remembered app scope; run evidence is kept', {
    parameters: [pathParameter('scope_id')],
    description: 'Deletes the derived pages, controls and app map for this scope. Recorded runs, captures and model requests are unchanged. A scope that an active run is still using returns 409 memory_scope_in_use.',
    responses: { '200': response('Scope forgotten.'), ...errors },
  });
  add('/v1/browser-access', 'get', 'getAccessRequests', 'Access', 'Read human access requests and nonsecret session metadata', {
    description: 'Private frames, leases, input controls, saved-session material and human review mutations are outside this contract. Agent tools expose only handoff metadata.',
  });

  const providerChoice = choice('openai','anthropic','openrouter','meta');
  const modelId = { type: 'string', minLength: 1, maxLength: 200, description: 'Trimmed model ID with ASCII letters, digits and / : . _ - only.' };
  const navigationChoice = { ...strict({ provider: providerChoice, model: modelId }, ['provider','model']), type: ['object','null'] };
  const modelChoiceFields = {
    provider: providerChoice, model: modelId,
    free_only: { type: 'boolean', default: true, description: 'Keep OpenRouter on openrouter/free or :free model IDs, for this model and its navigation model. Ignored by other providers.' },
    navigation_model: { ...navigationChoice, description: 'Omitted: inherit the navigation model. null: one model for everything.' },
  };
  const runModel = { ...strict(modelChoiceFields, ['provider','model']),
    description: 'This run\'s model instead of its project\'s model or the saved default. The provider must be configured. Part of the retry identity. The job records settings.modelSource: run, project or default.' };
  const projectIdField = { ...uuid, description: 'Opaque project UUID. Selects the project\'s model and limit overrides from settings; list known projects with GET /v1/projects. A new UUID starts a new project.' };
  const jobExplore = strict({
    project_id:projectIdField,task_id:uuid,job_id: uuid, kind: { const: 'explore', type: 'string' }, model: runModel,
    target_url: { type: 'string', maxLength: 2048, description: 'At most 2048 UTF-8 bytes. HTTP(S), no embedded credentials.' },
    viewport_profile: choice('desktop', 'tablet', 'mobile'),
    auth_mode: choice('auto', 'sign_in', 'public'), session_id: uuid, auto_reproduce: bool,
    app_memory: { type: 'boolean', description: 'Override the saved memory default for this run. False explores without reading or recording cross-run memory.' },
    continue_from_run_id: { ...uuid, description: 'Resume this failed, interrupted or cancelled exploration. The new job uses current settings, plans from the pages that run recorded, and does not repeat a dispatched action. The target URL and viewport must match the run.' },
  }, ['job_id', 'kind', 'target_url']);
  const jobReproduce = strict({ project_id:projectIdField,task_id:uuid,job_id: uuid, kind: { const: 'reproduce', type: 'string' }, source_action_id: uuid, model: runModel }, ['job_id', 'kind', 'source_action_id']);
  const verificationFields={candidate_url:{type:'string',maxLength:2048,format:'uri'},deployment_ref:{type:'string',minLength:1,maxLength:200},auth_mode:choice('auto','public'),session_id:uuid,project_id:uuid,task_id:uuid};
  const jobVerify=strict({job_id:uuid,kind:{type:'string',const:'verify_fix'},issue_id:uuid,model:runModel,target_url:verificationFields.candidate_url,...Object.fromEntries(Object.entries(verificationFields).filter(([key])=>key!=='candidate_url'))},['job_id','kind','issue_id','target_url']);
  return {
    openapi: '3.1.0',
    info: {
      title: 'Spekios local integration API', version: '0.2.0',
      summary: 'Durable URL-first QA jobs and evidence-backed feedback for people and coding agents.',
      description: 'Source-reviewed local developer preview. This document covers the integration routes listed here; private human-login control, human review mutation and MCP JSON-RPC transport are documented separately. Extensible stored projections are intentionally not exhaustive generated-client models. Request bodies are capped at 64 KiB. Commands can change data on the target site and consume provider usage. API-key model access only; no subscription allowance transfer.',
    },
    servers: [{ url: 'http://127.0.0.1:18080', description: 'Default private local API. Replace with your trusted deployment origin.' }],
    security: [{ bearerAuth: [] }],
    tags: ['Status','Jobs','Runs','Reports','Evidence','Agent tools','Settings','Models','Access','Identity','History','Issues'].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Workspace-bound agent or manager credential. SCOUT_API_TOKEN remains privileged operator/worker access. Always required for MCP; ordinary local routes can use explicit development bypass.' } },
      schemas: {
        Error: { type: 'object', properties: { error: string }, required: ['error'], additionalProperties: true },
        JobSubmission: { oneOf: [jobExplore, jobReproduce,jobVerify], description: 'Unknown fields rejected. Public auth mode cannot load a session. A new job requires a new non-nil UUID.' },
        FixVerificationSubmission:strict({verification_id:uuid,...verificationFields},['verification_id','candidate_url']),
        JobAdmission: { type: 'object', properties: { job: object, reused: bool }, required: ['job','reused'], additionalProperties: true },
        Progress: {
          type: 'object', additionalProperties: true,
          required: ['schema_version','phase','execution_finished','counts','needs_user_input','poll_after_ms','coverage_complete'],
          properties: {
            schema_version: { const: 1, type: 'integer' }, job: nullableObject, run: nullableObject,
            phase: string, execution_finished: bool, needs_user_input: bool, access_requests: { type: 'array', items: object },
            counts: object, event_cursor: { type: 'integer', minimum: 0 },
            poll_after_ms: { type: ['integer','null'], description: '5000 while active; null when terminal.' },
            next: object, progress_percent: { type: 'null' }, coverage_complete: { const: false, type: 'boolean' },
          },
        },
        Report: {
          type: 'object', additionalProperties: true, required: ['schema_version','report_state','execution_finished','issues','coverage_complete'],
          properties: {
            schema_version: { const: 1, type: 'integer' },
            report_state: choice('not_started','execution_ended_without_run','partial','run_finished'),
            execution_finished: bool, coverage_complete: { const: false, type: 'boolean' },
            progress: object, issues: { type: 'array', items: ref('Issue') }, execution_issues: { type: 'array', items: object },
            markdown: { type: 'string', description: 'Present for recorded run reports; not promised before a run exists.' },
            snapshot: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, additionalProperties: true },
            pagination: { type: 'object', properties: { offset: { type: 'integer' }, returned: { type: 'integer' }, total: { type: 'integer' }, has_more: bool, next_offset: { type: ['integer','null'] }, next: object }, additionalProperties: true },
          },
        },
        Issue: {
          type: 'object', additionalProperties: true,
          properties: { schema_version: { const: 1, type: 'integer' }, action_id: uuid, run_id: uuid, category: choice('suspected_bug','observed_change','diagnostic_signal','execution_problem','inconclusive','pending_check'), expected: {}, observed: object, evidence: object, reproduction: object, human_review: nullableObject, repair_objective: nullableObject },
          description: 'Stored evidence handoff. Text is bounded; source location and root cause are not inferred. Consult the report guide.',
        },
        ToolResult: { type: 'object', properties: { content: { type: 'array', items: object }, structuredContent: object, isError: bool }, required: ['content'], additionalProperties: true },
        SettingsSubmission: strict({
          request_id: uuid, expected_revision: { type: 'integer', minimum: 0, description: 'Signed 64-bit integer below 9223372036854775807.' },
          provider: choice('openai','anthropic','openrouter','meta'), model: { type: 'string', minLength: 1, maxLength: 200, description: 'Trimmed model ID with ASCII letters, digits and / : . _ - only.' },
          ...limitFields, stop_after_idle_actions: { type: ['integer','null'], minimum: 5, maximum: 1000, description: 'Stop after this many consecutive actions reach no state new to the run. Omitted: 50. null: never.' },
          limit_overrides: { type: 'array', maxItems: 50, items: strict({ project_id: uuid, provider: choice('openai','anthropic','openrouter','meta'), model: { type: 'string', minLength: 1, maxLength: 200 },
            limits: strict({ ...limitFields, stop_after_idle_actions: { type: ['integer','null'], minimum: 5, maximum: 1000 } }, []) }, ['limits']),
            description: 'Limits for a project, a model, or a model within a project. A job applies matching overrides least specific first (model, project, then both); absent keys inherit and null means no limit.' },
          exploration_strategy: { ...strict({ breadth: bounded(0,100), depth: bounded(0,100), rewalk: bounded(0,100), adaptive: bool }, ['breadth','depth','rewalk','adaptive']),
            description: 'How each run shares its actions: new territory across the app\'s areas (breadth), deep journeys that follow one path while it reaches new screens (depth), and re-walking transitions earlier runs recorded to compare outcomes (rewalk). Whole percentages that sum to 100; breadth or depth above zero. Adaptive shares follow what each strategy finds, keeping at least a quarter of their share. Omitted: 50/30/20, adaptive.' },
          viewport_profile: choice('desktop','tablet','mobile'), free_only: bool,
          auto_reproduce: bool, max_auto_reproductions: bounded(1,3), max_auto_replay_actions: bounded(1,100),
          app_memory: { type: 'boolean', default: true, description: 'Remember explored pages and controls across runs of the same app, viewport and sign-in state.' },
          reuse_rankings: { type: 'boolean', default: true, description: 'Reuse what the model ranked on a screen in an earlier run when its address pattern, title, text (numbers and times normalized) and control states are unchanged and the model is the same. Needs app memory. Skips the planning request; recorded as a plan decision with status reused. A ranking is reused at most 10 times; rankings that type text and runs with a testing focus are always ranked afresh.' },
          project_models: { type: 'array', maxItems: 50, default: [], items: strict({ project_id: uuid, label: { type: 'string', maxLength: 60, description: 'Optional project name, trimmed; no control characters.' }, ...modelChoiceFields }, ['project_id','provider','model']),
            description: 'The model for each project, one entry per project UUID. A job with that project_id uses it unless the job sets its own model; limit overrides then match the resolved model. Jobs keep the resolved model, not this list. Omitted: every project uses the default.' },
          navigation_model: { ...strict({ provider: choice('openai','anthropic','openrouter','meta'), model: { type: 'string', minLength: 1, maxLength: 200 } }, ['provider','model']), type: ['object','null'],
            description: 'A cheaper model that predicts and assesses navigation actions: opening a URL, following a link and scrolling. Any result other than a clean no_issue_observed, or one with browser errors or failed requests, is reassessed by the exploration model. Free-only applies to an OpenRouter navigation model. Omitted or null: one model for everything.' },
          saved_models: { type: 'array', maxItems: 30, default: [], items: strict({ provider: choice('openai','anthropic','openrouter','meta'), model: { type: 'string', minLength: 1, maxLength: 200 }, label: { type: 'string', maxLength: 60, description: 'Optional display name, trimmed; no control characters.' },
            computer_use:{type:'boolean',description:'Allow bounded computer-use recovery for this exact direct Meta model. Absent defaults on only for muse-spark-1.3 and muse-wonder-1.0. Other Meta models additionally need a successful compatibility check on the selected key. Explicit false persists an opt-out. Other providers cannot enable this integration.'},
            input_usd_per_million: { type: ['number','null'], minimum: 0, maximum: 10000, description: 'Optional price in US dollars per million input tokens, used to estimate cost. Absent or null keeps the known price, if any.' },
            output_usd_per_million: { type: ['number','null'], minimum: 0, maximum: 10000, description: 'Optional price in US dollars per million output tokens. Absent or null keeps the known price, if any.' } }, ['provider','model']),
            description: 'The models the settings page offers for exploration and navigation, such as several Meta models. Each provider and trimmed model ID appears once; different providers can share an ID. Only names and IDs are saved, never credentials. Listed models can be paid while free_only is on; only the exploration and navigation models must be free. Jobs do not freeze this list. Omitted: an empty list.' },
        }, ['request_id','expected_revision','provider','model','viewport_profile','free_only','auto_reproduce','max_auto_reproductions','max_auto_replay_actions']),
        ModelRequest: strict({
          request_id: uuid, provider: choice('openai','anthropic','openrouter','meta'), model: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9/:._-]+$' },
          prompt: { type: 'string', minLength: 1, maxLength: 65536, description: 'Nonblank, no NUL, at most 65536 UTF-8 bytes. This route accepts request bodies up to 192 KiB.' },
          system: { type: 'string', maxLength: 16384, default: '', description: 'No NUL; at most 16384 UTF-8 bytes.' },
          run_id: uuid, action_id: uuid, capture_ids: { type: 'array', maxItems: 2, uniqueItems: true, items: uuid, default: [] },
          assessment_image_ids: { type: 'array', maxItems: 2, items: uuid, description: 'Optional recorded before/after overview-and-crop artifacts linked to this action and original capture pair. Originals remain authoritative. Omit for full screenshots.' },
          max_output_tokens: bounded(1,4096,1024), max_attempts: bounded(1,3,2), free_only: { type: 'boolean', default: true },
          computer_use:{type:'boolean',default:false,description:'Trusted worker/operator native Meta computer request. Requires an enabled run and exactly one linked screenshot, or computer_use_probe.'},
          computer_use_probe:{type:'boolean',default:false,description:'Non-executing Meta compatibility probe. Requires computer_use; cannot attach a run or screenshots. Prefer the manager check endpoint.'},
        }, ['request_id','provider','model','prompt']),
        ModelAdmission: { type: 'object', properties: { request_id: uuid, created: bool, status_url: string }, required: ['request_id','created','status_url'], additionalProperties: true },
      },
    },
  };
}
