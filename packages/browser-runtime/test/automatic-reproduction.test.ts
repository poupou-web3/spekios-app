import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { automaticReproductionPolicy,automaticReservation,AutomaticReproductionScheduler,transientEvidenceFailure } from '../src/automatic-reproduction.js';
import { Store } from '../src/store.js';
import { explore,reproduce } from '../src/explorer.js';
import { ModelClient } from '../src/model-client.js';
import { explorationFixture } from '../src/exploration-fixture.js';
import { workspaceId,userId } from '../src/contracts.js';

test('automatic reproduction is opt-in with separate case and total action caps',()=>{
  assert.deepEqual(automaticReproductionPolicy(),{enabled:false,max_cases:2,max_actions:12});
  for(const invalid of [{autoReproduce:'true'},{maxAutoReproductions:0},{maxAutoReproductions:4},{maxAutoReplayActions:0},{maxAutoReplayActions:25},{maxAutoReplayActions:1.5}])assert.throws(()=>automaticReproductionPolicy(invalid as any));
  const policy=automaticReproductionPolicy({autoReproduce:true,maxAutoReproductions:3,maxAutoReplayActions:7});
  assert.equal(automaticReservation(policy,0,0,4),null);
  assert.equal(automaticReservation(policy,1,4,4),'action_limit');
  assert.equal(automaticReservation(policy,1,4,3),null);
  assert.equal(automaticReservation(policy,3,6,1),'case_limit');
  assert.equal(transientEvidenceFailure(Object.assign(new Error('Temporary bucket timeout'),{name:'TimeoutError'})),true);
  assert.equal(transientEvidenceFailure(Object.assign(new Error('Missing object'),{name:'NoSuchKey'})),true);
  assert.equal(transientEvidenceFailure(new Error('Capture checksum mismatch.')),false);
  assert.equal(transientEvidenceFailure(new SyntaxError('Invalid saved JSON')),false);
});

test('automatic scheduler reserves once and defers capacity without confirming findings',{
  skip:process.env.SCOUT_EXPLORER_INTEGRATION!=='1',timeout:180000,
},async t=>{
  const store=await new Store().open(),fixture=await explorationFixture();
  const originalOrigins=process.env.SCOUT_ALLOWED_ORIGINS;process.env.SCOUT_ALLOWED_ORIGINS=fixture.url;
  const client=new ModelClient({provider:'openrouter',model:'scout-reproduction-fixture:free',freeOnly:true});
  assert.equal(await client.ready(),'protocol_fixture');
  const gateway={executionMode:'protocol_fixture' as const,configuredProviders:['openrouter']};
  const settings={...client.settings,maxActions:2,allowedOrigins:[fixture.url],viewportProfile:'desktop',autoReproduce:true,maxAutoReproductions:2,maxAutoReplayActions:12};
  const jobIds:string[]=[];
  const source=async(autoReproduce=true,maxAutoReplayActions=12)=>{
    const jobId=randomUUID();jobIds.push(jobId);
    await store.query("INSERT INTO browser_jobs(job_id,workspace_id,user_id,request,settings,execution_mode,status) VALUES($1,$2,$3,$4,$5,'protocol_fixture','running')",
      [jobId,workspaceId,userId,JSON.stringify({kind:'explore',target_url:fixture.url+'/broken-session'}),JSON.stringify({...settings,autoReproduce,maxAutoReplayActions})]);
    const run=await explore(store,fixture.url+'/broken-session',{client,allowedOrigins:[fixture.url],maxActions:2,jobId,autoReproduce,maxAutoReproductions:2,maxAutoReplayActions});
    assert.equal(run.report.run.lifecycle,'completed',run.report.run.error);assert.equal(run.report.actions[1].assessment.verdict,'suspect');
    await store.query("UPDATE browser_jobs SET status='completed',finished_at=now() WHERE job_id=$1",[jobId]);
    return {...run,jobId,actionId:run.report.actions[1].action_id};
  };
  const sweep=(status:any=gateway)=>store.exclusive(()=>new AutomaticReproductionScheduler(store).sweep(status));
  const taskFor=async(id:string)=>(await store.query('SELECT * FROM automatic_reproduction_tasks WHERE source_action_id=$1',[id])).rows[0];
  try{
    await t.test('provider and full queue defer a stable reservation and repeat no audit events',async()=>{
      const original=await source();await sweep({...gateway,configuredProviders:[]});
      let task=await taskFor(original.actionId);
      assert.equal(task.status,'pending');assert.equal(task.reason,'provider_unavailable');assert.equal(task.planned_actions,2);assert.equal(task.child_job_id,null);
      const events=async()=>Number((await store.query("SELECT count(*) FROM runtime_events WHERE run_id=$1 AND event_type LIKE 'auto_reproduction.%'",[original.run_id])).rows[0].count);
      const initial=await events();await sweep(null);assert.equal(await events(),initial);
      const fullQueue=[];
      for(let i=0;i<10;i++){const id=randomUUID();jobIds.push(id);fullQueue.push(id);await store.query("INSERT INTO browser_jobs(job_id,workspace_id,user_id,request,settings,execution_mode,status) VALUES($1,$2,$3,'{}','{}','protocol_fixture','queued')",[id,workspaceId,userId]);}
      await sweep();task=await taskFor(original.actionId);assert.equal(task.status,'pending');assert.equal(task.reason,'queue_capacity');
      const fullEvents=await events();await sweep();assert.equal(await events(),fullEvents);
      await store.query("UPDATE browser_jobs SET status='cancelled',finished_at=now() WHERE job_id=ANY($1::uuid[])",[fullQueue]);
      await sweep();task=await taskFor(original.actionId);assert.equal(task.status,'queued');assert.equal(task.reason,'scheduled');
      const child=(await store.query('SELECT * FROM browser_jobs WHERE job_id=$1',[task.child_job_id])).rows[0];
      assert.equal(child.parent_job_id,original.jobId);assert.equal(child.automatic_source_action_id,original.actionId);assert.equal(child.settings.autoReproduce,false);
      assert.equal(child.execution_mode,'protocol_fixture');assert.equal(child.request.source_action_id,original.actionId);
      const queuedEvents=await events();await sweep();assert.equal((await taskFor(original.actionId)).child_job_id,child.job_id);assert.equal(await events(),queuedEvents);
      await store.query("UPDATE browser_jobs SET status='running',started_at=now() WHERE job_id=$1",[child.job_id]);
      assert.equal(await store.exclusive(()=>new AutomaticReproductionScheduler(store).beforeDispatch(child,gateway)),true);
      const result=await reproduce(store,original.actionId,{client,allowedOrigins:[fixture.url],jobId:child.job_id,autoReproduce:false});
      await store.query("UPDATE browser_jobs SET status='completed',finished_at=now() WHERE job_id=$1",[child.job_id]);
      assert.equal(result.report.reproductions[0].result.outcome,'reproduced');assert.equal(result.report.reproductions[0].result.confirmed_bug,false);
      await sweep();assert.equal((await store.query('SELECT count(*) FROM automatic_reproduction_tasks WHERE source_run_id=$1',[result.run_id])).rows[0].count,'0');
      const report=await store.report(original.run_id);assert.equal(report.automatic_reproductions[0].child_job.run_id,result.run_id);
      assert.equal(report.automatic_reproductions[0].reproduction.result.outcome,'reproduced');assert.equal((await store.report(result.run_id)).automatic_reproductions[0].source_run_id,original.run_id);
      assert.equal(report.finding_reviews.length,0);assert.equal(report.actions[1].assessment.verdict,'suspect');
    });
    await t.test('temporary evidence readback failures preserve reservations and requeue one child with a cooldown',async()=>{
      const original=await source(),get=store.get.bind(store);
      const unavailable=async()=>{throw Object.assign(new Error('Temporary fixture bucket timeout'),{name:'TimeoutError'});};
      try{
        store.get=unavailable;await sweep();
        let task=await taskFor(original.actionId);assert.equal(task.status,'pending');assert.equal(task.reason,'evidence_unavailable');assert.equal(task.planned_actions,2);assert.equal(task.child_job_id,null);
        const eventCount=(await store.report(original.run_id)).events.length;await sweep();assert.equal((await store.report(original.run_id)).events.length,eventCount);
        store.get=get;await sweep();task=await taskFor(original.actionId);assert.equal(task.status,'queued');
        let child=(await store.query("UPDATE browser_jobs SET status='running',started_at=now() WHERE job_id=$1 RETURNING *",[task.child_job_id])).rows[0];
        store.get=unavailable;
        assert.equal(await store.exclusive(()=>new AutomaticReproductionScheduler(store).beforeDispatch(child,gateway)),false);
        child=(await store.query('SELECT *,next_attempt_at>now() AS cooling_down FROM browser_jobs WHERE job_id=$1',[child.job_id])).rows[0];
        assert.equal(child.status,'queued');assert.equal(child.run_id,null);assert.equal(child.cooling_down,true);
        assert.equal((await taskFor(original.actionId)).child_job_id,child.job_id);assert.equal((await taskFor(original.actionId)).reason,'evidence_unavailable');
        store.get=get;
        child=(await store.query("UPDATE browser_jobs SET status='running',started_at=now(),next_attempt_at=now() WHERE job_id=$1 RETURNING *",[child.job_id])).rows[0];
        assert.equal(await store.exclusive(()=>new AutomaticReproductionScheduler(store).beforeDispatch(child,gateway)),true);
        assert.equal((await taskFor(original.actionId)).reason,'scheduled');
        await store.query("UPDATE browser_jobs SET status='cancelled',finished_at=now() WHERE job_id=$1",[child.job_id]);
      }finally{store.get=get;}
    });
    await t.test('old jobs without opt-in remain untouched and paths exceeding total budget are skipped',async()=>{
      const legacy=await source(false);await sweep();assert.equal(await taskFor(legacy.actionId),undefined);assert.equal((await store.report(legacy.run_id)).run.auto_reproduction_planned_at,null);
      const limited=await source(true,1);await sweep();const task=await taskFor(limited.actionId);assert.equal(task.status,'skipped');assert.equal(task.reason,'action_limit');assert.equal(task.planned_actions,0);
    });
    await t.test('manual attempts exclude automatic allocation without adopting their job',async()=>{
      const original=await source(),manualId=randomUUID();jobIds.push(manualId);
      await store.query("INSERT INTO browser_jobs(job_id,workspace_id,user_id,request,settings,execution_mode,status) VALUES($1,$2,$3,$4,$5,'protocol_fixture','cancelled')",
        [manualId,workspaceId,userId,JSON.stringify({kind:'reproduce',source_action_id:original.actionId}),JSON.stringify({...settings,autoReproduce:false})]);
      await sweep();const task=await taskFor(original.actionId);assert.equal(task.status,'skipped');assert.equal(task.reason,'existing_attempt');assert.equal(task.child_job_id,null);assert.equal(task.planned_actions,0);
    });
    await t.test('dismissal invalidates a queued child before browser or model work',async()=>{
      const original=await source();await sweep();const task=await taskFor(original.actionId);assert.equal(task.status,'queued');
      await store.query(`INSERT INTO finding_reviews(review_id,action_id,run_id,workspace_id,user_id,reviewer_id,revision,disposition,rationale,expectation_basis,evidence_snapshot)
        VALUES($1,$2,$3,$4,$5,$5,1,'dismissed','Fixture dismissal before automatic dispatch.','','{}')`,[randomUUID(),original.actionId,original.run_id,workspaceId,userId]);
      const child=(await store.query("UPDATE browser_jobs SET status='running',started_at=now() WHERE job_id=$1 RETURNING *",[task.child_job_id])).rows[0],visits=fixture.requests.length;
      assert.equal(await store.exclusive(()=>new AutomaticReproductionScheduler(store).beforeDispatch(child,gateway)),false);
      const updated=await taskFor(original.actionId);assert.equal(updated.status,'skipped');assert.equal(updated.reason,'reviewed');assert.equal(updated.child_job_id,child.job_id);assert.equal(updated.planned_actions,2);
      const cancelled=(await store.query('SELECT status,run_id FROM browser_jobs WHERE job_id=$1',[child.job_id])).rows[0];assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.run_id,null);assert.equal(fixture.requests.length,visits);
      await sweep();assert.equal((await taskFor(original.actionId)).child_job_id,child.job_id);
    });
    await t.test('ready tasks advance past older pending tasks whose providers are unavailable',async()=>{
      const blocked=[];
      for(let i=0;i<3;i++){
        const original=await source();blocked.push(original);
        await store.query("UPDATE browser_jobs SET settings=jsonb_set(settings,'{provider}','\"anthropic\"'::jsonb) WHERE job_id=$1",[original.jobId]);
        await sweep(null);assert.equal((await taskFor(original.actionId)).status,'pending');
      }
      const ready=await source();await sweep(null);assert.equal((await taskFor(ready.actionId)).status,'pending');
      await sweep();assert.equal((await taskFor(ready.actionId)).status,'queued');
      for(const original of blocked){assert.equal((await taskFor(original.actionId)).status,'pending');
        await store.query('UPDATE runtime_runs SET auto_reproduction_cancel_id=$2,auto_reproduction_cancelled_at=now() WHERE run_id=$1',[original.run_id,randomUUID()]);}
      await store.query("UPDATE browser_jobs SET status='cancelled',finished_at=now() WHERE job_id=$1",[(await taskFor(ready.actionId)).child_job_id]);
      await sweep();
    });
    await t.test('scope revocation and source stop flags skip pending work',async()=>{
      const original=await source();await sweep({...gateway,configuredProviders:[]});process.env.SCOUT_ALLOWED_ORIGINS='http://different.invalid';
      await sweep();assert.equal((await taskFor(original.actionId)).reason,'scope_unavailable');process.env.SCOUT_ALLOWED_ORIGINS=fixture.url;
      const stopped=await source();await sweep({...gateway,configuredProviders:[]});await store.query('UPDATE runtime_runs SET auto_reproduction_cancel_id=$2,auto_reproduction_cancelled_at=now() WHERE run_id=$1',[stopped.run_id,randomUUID()]);
      await sweep();assert.equal((await taskFor(stopped.actionId)).status,'skipped');assert.equal((await taskFor(stopped.actionId)).reason,'source_unavailable');
    });
  }finally{
    await store.query("UPDATE browser_jobs SET status='cancelled',finished_at=now() WHERE (job_id=ANY($1::uuid[]) OR parent_job_id=ANY($1::uuid[])) AND status IN ('queued','running')",[jobIds]);
    if(originalOrigins===undefined)delete process.env.SCOUT_ALLOWED_ORIGINS;else process.env.SCOUT_ALLOWED_ORIGINS=originalOrigins;await fixture.close();await store.close();
  }
});
