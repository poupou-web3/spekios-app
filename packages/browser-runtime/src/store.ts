import pg from 'pg';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { workspaceId, userId, isUuid, type Capture, type Observation } from './contracts.js';

export const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = (data: unknown) => Buffer.from(JSON.stringify(data, null, 2) + '\n');
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };

async function durableFile(file: string, bytes: Buffer) {
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
  try { if (hash(await readFile(file)) !== hash(bytes)) throw new Error('Immutable spool collision.'); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = file + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
  const directory = await open(join(file, '..'), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export class Store {
  readonly pool = new pg.Pool({ host: process.env.PGHOST ?? 'postgres', user: 'scout', database: 'scout',
    password: required('POSTGRES_PASSWORD'), max: 4, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  readonly s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT ?? 'http://evidence:8333', region: 'us-east-1',
    forcePathStyle: true, credentials: { accessKeyId: required('S3_ACCESS_KEY_ID'), secretAccessKey: required('S3_SECRET_ACCESS_KEY') },
    maxAttempts: 2, requestHandler: { requestTimeout: 15000, connectionTimeout: 5000 } });
  readonly bucket = 'qa-evidence';
  readonly spool = process.env.RECORDER_SPOOL ?? '/data/recorder';
  client!: pg.PoolClient;

  async open() { this.client = await this.pool.connect(); return this; }
  async close() { this.client?.release(); await this.pool.end(); this.s3.destroy(); }
  query(text: string, values: unknown[] = []) { return this.client.query(text, values); }
  async exclusive<T>(body: () => Promise<T>): Promise<T> {
    const { rows } = await this.query("SELECT pg_try_advisory_lock(hashtextextended('scout-local-recorder-v1',0)) AS acquired");
    if (!rows[0].acquired) throw new Error('Another local recorder owns the execution lock.');
    try { return await body(); }
    finally { await this.query("SELECT pg_advisory_unlock(hashtextextended('scout-local-recorder-v1',0))"); }
  }
  async transaction<T>(body: () => Promise<T>): Promise<T> {
    await this.query('BEGIN');
    try { const result = await body(); await this.query('COMMIT'); return result; }
    catch (error) { await this.query('ROLLBACK'); throw error; }
  }
  async event(runId: string, type: string, payload: unknown, actionId: string | null = null) {
    const { rows } = await this.query('UPDATE runtime_runs SET event_seq=event_seq+1 WHERE run_id=$1 RETURNING event_seq', [runId]);
    await this.query('INSERT INTO runtime_events(event_id,run_id,seq,event_type,action_id,payload) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(), runId, rows[0].event_seq, type, actionId, JSON.stringify(payload)]);
  }
  async get(key: string) {
    const object = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await object.Body!.transformToByteArray());
  }
  async put(key: string, bytes: Buffer, mediaType: string) {
    try { await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: mediaType,
      IfNoneMatch: '*', Metadata: { sha256: hash(bytes) } })); }
    catch (error) { if ((error as { $metadata?: { httpStatusCode: number } }).$metadata?.httpStatusCode !== 412) throw error; }
    if (hash(await this.get(key)) !== hash(bytes)) throw new Error('Uploaded evidence failed checksum verification.');
  }
  blobKey(sha: string, extension: string) { return `workspace/${workspaceId}/blobs/sha256/${sha}.${extension}`; }
  async artifact(runId: string, kind: string, bytes: Buffer, extension: 'png' | 'json') {
    const id = randomUUID(), sha = hash(bytes), key = this.blobKey(sha, extension);
    await durableFile(join(this.spool, runId, 'blobs', sha), bytes);
    await this.query('INSERT INTO runtime_artifacts(artifact_id,run_id,kind,object_key,sha256,byte_length,status) VALUES($1,$2,$3,$4,$5,$6,\'pending_upload\') ON CONFLICT(run_id,kind,object_key) DO NOTHING',
      [id, runId, kind, key, sha, bytes.length]);
    await this.put(key, bytes, extension === 'png' ? 'image/png' : 'application/json');
    await this.query("UPDATE runtime_artifacts SET status='available' WHERE object_key=$1 AND run_id=$2 AND kind=$3", [key, runId, kind]);
    return { artifact_id: (await this.query('SELECT artifact_id FROM runtime_artifacts WHERE object_key=$1 AND run_id=$2 AND kind=$3', [key, runId, kind])).rows[0].artifact_id as string,
      object_key: key, sha256: sha, byte_length: bytes.length, kind };
  }
  async beginCapture(runId: string, actionId: string, phase: 'before' | 'after') {
    const id = randomUUID();
    await this.query("INSERT INTO runtime_captures(capture_id,run_id,action_id,phase,status) VALUES($1,$2,$3,$4,'capturing')", [id, runId, actionId, phase]);
    return id;
  }
  async saveCapture(runId: string, actionId: string, captureId: string, phase: 'before' | 'after', bytes: Buffer, observation: Observation,
    classification?: Pick<Capture, 'purpose' | 'training_status'>): Promise<Capture> {
    const sha = hash(bytes);
    const runConfig = classification ?? (await this.query('SELECT config FROM runtime_runs WHERE run_id=$1', [runId])).rows[0].config;
    const capture: Capture = { schema_version: 1, capture_id: captureId, run_id: runId, action_id: actionId, phase,
      sha256: sha, object_key: this.blobKey(sha, 'png'), metadata_key: `workspace/${workspaceId}/captures/${captureId}.json`,
      byte_length: bytes.length, observation, purpose: runConfig.purpose === 'exploration' ? 'exploration' : 'runtime_validation',
      training_status: runConfig.training_status === 'unreviewed' ? 'unreviewed' : 'excluded_fixture' };
    await durableFile(join(this.spool, runId, 'blobs', sha), bytes);
    await durableFile(join(this.spool, runId, 'captures', captureId + '.json'), jsonBytes(capture));
    await this.query("UPDATE runtime_captures SET status='pending_upload',object_key=$2,sha256=$3,byte_length=$4,observation=$5,metadata_key=$6 WHERE capture_id=$1",
      [captureId, capture.object_key, sha, bytes.length, JSON.stringify(observation), capture.metadata_key]);
    await this.put(capture.object_key, bytes, 'image/png');
    await this.put(capture.metadata_key, jsonBytes(capture), 'application/json');
    await this.transaction(async () => {
      await this.query("UPDATE runtime_captures SET status='available',error=NULL WHERE capture_id=$1", [captureId]);
      await this.event(runId, 'capture.available', { capture_id: captureId, sha256: sha, byte_length: bytes.length, object_key: capture.object_key }, actionId);
    });
    return capture;
  }
  async captureBytes(captureId: string) {
    if (!isUuid(captureId)) throw new Error('Invalid capture ID.');
    const { rows } = await this.query('SELECT c.* FROM runtime_captures c JOIN runtime_runs r USING(run_id) WHERE c.capture_id=$1 AND r.workspace_id=$2', [captureId, workspaceId]);
    const capture = rows[0];
    if (!capture || capture.status !== 'available') throw new Error('Capture is not available in this workspace.');
    const bytes = await this.get(capture.object_key);
    if (hash(bytes) !== capture.sha256 || bytes.length !== Number(capture.byte_length)) throw new Error('Capture checksum mismatch.');
    return bytes;
  }
  async report(runId: string) {
    if (!isUuid(runId)) throw new Error('Invalid run ID.');
    const run = (await this.query('SELECT * FROM runtime_runs WHERE run_id=$1 AND workspace_id=$2', [runId, workspaceId])).rows[0];
    if (!run) throw new Error('Run not found in this workspace.');
    const actions = (await this.query('SELECT * FROM runtime_actions WHERE run_id=$1 ORDER BY ordinal', [runId])).rows;
    const captures = (await this.query('SELECT * FROM runtime_captures WHERE run_id=$1 ORDER BY created_at,capture_id', [runId])).rows;
    const artifacts = (await this.query('SELECT * FROM runtime_artifacts WHERE run_id=$1 ORDER BY artifact_id', [runId])).rows;
    const events = (await this.query('SELECT event_id,seq,event_type,action_id,payload,occurred_at FROM runtime_events WHERE run_id=$1 ORDER BY seq', [runId])).rows;
    const graph = (await this.query('SELECT graph FROM exploration_graphs WHERE run_id=$1', [runId])).rows[0]?.graph ?? null;
    const modelRequests = (await this.query('SELECT request_id,provider,model,execution_mode,action_id,state,attempt_count,created_at,finished_at,error FROM model_requests WHERE run_id=$1 ORDER BY created_at,request_id', [runId])).rows;
    const modelCalls = (await this.query('SELECT c.* FROM model_calls c JOIN model_requests r USING(request_id) WHERE r.run_id=$1 ORDER BY c.started_at,c.call_id', [runId])).rows;
    const modelPayloads = (await this.query("SELECT p.payload_id,p.call_id,p.kind,p.object_key,p.sha256,p.byte_length,p.uploaded_at FROM model_payloads p JOIN model_calls c USING(call_id) JOIN model_requests r USING(request_id) WHERE r.run_id=$1 ORDER BY p.call_id,p.kind", [runId])).rows;
    const modelUsage = !run.config.model_connection && !modelRequests.length
      ? { status: 'not_connected', input_tokens: null, output_tokens: null }
      : (await this.query(`SELECT jsonb_build_object('status','connected','as_of',now(),'attempts',count(*),
        'known_input_tokens',sum(input_tokens),'known_output_tokens',sum(output_tokens),
        'incomplete_usage_attempts',count(*) FILTER (WHERE usage_status<>'reported'),
        'provider_reported_cost_usd',sum(cost_usd)::text,'unpriced_attempts',count(*) FILTER (WHERE cost_usd IS NULL),
        'pending_requests',(SELECT count(*) FROM model_requests WHERE run_id=$1 AND state IN ('queued','preparing','dispatched')),
        'complete',count(*) FILTER (WHERE usage_status<>'reported' OR c.state='dispatched')=0 AND NOT EXISTS
          (SELECT 1 FROM model_requests WHERE run_id=$1 AND state IN ('queued','preparing','dispatched')))
        AS usage FROM model_calls c JOIN model_requests r USING(request_id) WHERE r.run_id=$1`, [runId])).rows[0].usage;
    const reproductions = (await this.query('SELECT * FROM runtime_reproductions WHERE source_run_id=$1 OR replay_run_id=$1 ORDER BY created_at,reproduction_id', [runId])).rows;
    const findingReviews = (await this.query(`SELECT f.* FROM finding_reviews f WHERE f.run_id=$1
      OR f.action_id IN (SELECT source_action_id FROM runtime_reproductions WHERE replay_run_id=$1)
      ORDER BY f.created_at,f.review_id`, [runId])).rows;
    const automaticReproductions=(await this.query(`SELECT to_jsonb(t) || jsonb_build_object('child_job',
      CASE WHEN j.job_id IS NULL THEN NULL ELSE jsonb_build_object('job_id',j.job_id,'status',j.status,'run_id',j.run_id,'error',j.error,'cancel_id',j.cancel_id,'created_at',j.created_at,'started_at',j.started_at,'finished_at',j.finished_at) END,
      'reproduction',CASE WHEN v.reproduction_id IS NULL THEN NULL ELSE jsonb_build_object('reproduction_id',v.reproduction_id,'status',v.status,'replay_run_id',v.replay_run_id,'result',v.result,'created_at',v.created_at,'finished_at',v.finished_at) END) AS item
      FROM automatic_reproduction_tasks t LEFT JOIN browser_jobs j ON j.job_id=t.child_job_id
      LEFT JOIN runtime_reproductions v ON v.source_action_id=t.source_action_id
      WHERE t.source_run_id=$1 OR j.run_id=$1 ORDER BY t.created_at,t.task_id`,[runId])).rows.map(row=>row.item);
    return { schema_version: 1, run, actions, captures, artifacts, events, graph, reproductions,automatic_reproductions:automaticReproductions,
      finding_reviews:findingReviews, model_requests: modelRequests, model_calls: modelCalls, model_payloads: modelPayloads, model_usage: modelUsage };
  }
  async publish(runId: string) {
    const report = await this.report(runId);
    const snapshot = { ...report, run: { ...report.run, manifest_key: null }, artifacts: report.artifacts.filter(a => a.kind !== 'run_manifest') };
    const manifest = await this.artifact(runId, 'run_manifest', jsonBytes(snapshot), 'json');
    await this.query('UPDATE runtime_runs SET manifest_key=$2 WHERE run_id=$1', [runId, manifest.object_key]);
    return manifest;
  }
  async clickhouse(query: string) {
    const response = await fetch((process.env.CLICKHOUSE_ENDPOINT ?? 'http://clickhouse:8123') + '/?async_insert=0&wait_end_of_query=1', {
      method: 'POST', headers: { 'X-ClickHouse-User': 'scout', 'X-ClickHouse-Key': required('CLICKHOUSE_PASSWORD') },
      body: query, signal: AbortSignal.timeout(15000),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`ClickHouse export failed with HTTP ${response.status}`);
    return body;
  }
  async flush(exportBatch: (query: string) => Promise<unknown> = query => this.clickhouse(query), maxBatches=Infinity) {
    let exported = 0;
    for (let batch=0;batch<maxBatches;batch++) {
      const { rows } = await this.query('SELECT e.*,r.workspace_id,r.user_id FROM runtime_events e JOIN runtime_runs r USING(run_id) WHERE e.exported_at IS NULL ORDER BY e.occurred_at,e.seq LIMIT 100');
      if (!rows.length) return exported;
      const events = rows.map(e => ({ event_id: e.event_id, workspace_id: e.workspace_id, user_id: e.user_id, run_id: e.run_id,
        seq: e.seq, event_type: e.event_type, action_id: e.action_id, occurred_at: (e.occurred_at as Date).toISOString().replace('T', ' ').replace('Z', ''), payload: JSON.stringify(e.payload) }));
      await exportBatch('INSERT INTO scout.runtime_events FORMAT JSONEachRow\n' + events.map(e => JSON.stringify(e)).join('\n'));
      await this.query('UPDATE runtime_events SET exported_at=now() WHERE event_id=ANY($1::uuid[])', [rows.map(e => e.event_id)]);
      exported += rows.length;
    }
    return exported;
  }
  async recover(runId: string) {
    return this.exclusive(async () => {
      await this.report(runId);
      const { rows } = await this.query("SELECT * FROM runtime_captures WHERE run_id=$1 AND status<>'available'", [runId]);
      for (const row of rows) {
        try {
          const capture: Capture = JSON.parse(await readFile(join(this.spool, runId, 'captures', row.capture_id + '.json'), 'utf8'));
          if (capture.capture_id !== row.capture_id || capture.run_id !== runId || capture.action_id !== row.action_id || capture.phase !== row.phase || !/^[0-9a-f]{64}$/.test(capture.sha256)) throw new Error('Spool identity mismatch.');
          const bytes = await readFile(join(this.spool, runId, 'blobs', capture.sha256));
          if (hash(bytes) !== capture.sha256 || bytes.length !== capture.byte_length) throw new Error('Spool checksum mismatch.');
          await this.saveCapture(runId, row.action_id, row.capture_id, row.phase, bytes, capture.observation, capture);
        } catch (error) {
          await this.query("UPDATE runtime_captures SET status=CASE WHEN status='capturing' THEN 'failed' ELSE status END,error=$2 WHERE capture_id=$1", [row.capture_id, error instanceof Error ? error.message.slice(0, 500) : 'Recovery failed']);
        }
      }
      const pending = (await this.query("SELECT * FROM runtime_artifacts WHERE run_id=$1 AND status='pending_upload'", [runId])).rows;
      for (const row of pending) {
        const bytes = await readFile(join(this.spool, runId, 'blobs', row.sha256));
        if (hash(bytes) !== row.sha256) throw new Error('Artifact spool checksum mismatch.');
        await this.put(row.object_key, bytes, row.object_key.endsWith('.png') ? 'image/png' : 'application/json');
        await this.query("UPDATE runtime_artifacts SET status='available' WHERE artifact_id=$1", [row.artifact_id]);
      }
      await this.transaction(async () => {
        const cancelled=!!(await this.query('SELECT cancel_id FROM runtime_runs WHERE run_id=$1 FOR UPDATE',[runId])).rows[0].cancel_id;
        const interrupted = (await this.query("SELECT action_id,spec,state FROM runtime_actions WHERE run_id=$1 AND state IN ('prepared','dispatched')", [runId])).rows;
        for (const row of interrupted) {
          const assessment = { check_id: randomUUID(), method: row.spec.prediction.source !== 'fixture_defined' ? 'model-evidence-v1' : 'deterministic-fixture-v1', verdict: 'inconclusive', expected: row.spec.prediction.expected ?? row.spec.prediction.expected_result,
            actual: null, reason: row.state === 'dispatched' ? 'Process interrupted; action outcome is unknown. Action was not repeated.' : 'Process interrupted before dispatch.', tool_error: 'interrupted', confirmed_bug: false };
          if(cancelled)assessment.reason='Cancellation was recovered after worker interruption. No action was repeated; an in-flight outcome may be unknown.';
          await this.query("UPDATE runtime_actions SET state=$3,assessment=$2,finished_at=now() WHERE action_id=$1", [row.action_id, JSON.stringify(assessment),cancelled?'cancelled':'interrupted']);
          await this.event(runId, cancelled?'action.cancelled':'action.interrupted', assessment, row.action_id);
        }
        const decisions = (await this.query("UPDATE exploration_decisions SET status=$2,error='Recorder interrupted; gateway request may still settle. No dependent action replayed.',finished_at=now() WHERE run_id=$1 AND status='requested' RETURNING decision_id,request_id", [runId,cancelled?'cancelled':'interrupted'])).rows;
        for (const decision of decisions) await this.event(runId, cancelled?'model.decision_cancelled':'model.decision_interrupted', decision);
        const result = await this.query("UPDATE runtime_runs SET lifecycle=$2,error=$3,config=config || $4::jsonb,finished_at=now() WHERE run_id=$1 AND (lifecycle='active' OR ($5 AND lifecycle='failed'))", [runId,cancelled?'cancelled':'failed',cancelled?'User cancellation recovered without repeating actions':'Interrupted run recovered without repeating actions',JSON.stringify({stop_reason:cancelled?'user_cancelled':'worker_interrupted'}),cancelled]);
        if (result.rowCount) await this.event(runId, cancelled?'run.cancelled':'run.interrupted', { replayed_actions: 0, recovered:true });
        const reproductions = (await this.query(`UPDATE runtime_reproductions SET status='interrupted',finished_at=now(),
          result='{"outcome":"inconclusive","confirmed_bug":false,"reason":"Replay was interrupted; no browser action was repeated."}'::jsonb
          WHERE replay_run_id=$1 AND status='active' RETURNING reproduction_id`, [runId])).rows;
        for (const reproduction of reproductions) await this.event(runId, 'reproduction.interrupted', reproduction);
      });
      return this.publish(runId);
    });
  }
}
