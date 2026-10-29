import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {explore} from '../src/explorer.js';
import {explorationFixture} from '../src/exploration-fixture.js';
import {ModelClient} from '../src/model-client.js';

test('durable focus admission, boundaries, browser choice and evidence', {
  skip:process.env.SCOUT_EXPLORER_INTEGRATION!=='1', timeout:180000,
},async t=>{
  const store=await new Store().open(),fixture=await explorationFixture();
  const created:string[]=[];
  const sql=(text:string,values:unknown[]=[])=>store.pool.query(text,values);
  const snapshot=async(id:string)=>(await sql('SELECT scout_steering_snapshot($1,0,32) AS value',[id])).rows[0].value;
  const send=async(id:string,revision:number,focus:string,command=randomUUID(),workspace=store.workspaceId,agent:string|null=null)=>
    (await sql('SELECT scout_submit_steering($1,$2,$3,$4,$5,$6,$7) AS value',[id,workspace,store.userId,agent,command,revision,focus])).rows[0].value;
  const apiSend=async(id:string,revision:number,focus:string)=>{
    const response=await fetch((process.env.SCOUT_API_URL??'http://api:8080')+'/v1/runs/'+id+'/steering',{
      method:'POST',headers:{Authorization:'Bearer '+process.env.SCOUT_API_TOKEN,'Content-Type':'application/json'},
      body:JSON.stringify({steering_id:randomUUID(),expected_revision:revision,focus}),signal:AbortSignal.timeout(10000),redirect:'error',
    });
    assert.equal(response.status,200,'A real HTTP focus submission must reach the write connection');return response.json();
  };
  const seed=async(config:unknown={runtime_version:'explorer-v1',replay_of:null})=>{
    const id=randomUUID();created.push(id);
    await sql("INSERT INTO runtime_runs(run_id,workspace_id,user_id,target_url,lifecycle,config) VALUES($1,$2,$3,$4,'active',$5)",[id,store.workspaceId,store.userId,fixture.url+'/tree',config]);return id;
  };
  try{
    await t.test('concurrent writers, exact retries and owner boundaries',async()=>{
      const id=await seed(),commands=[randomUUID(),randomUUID()];
      const answers=await Promise.all(commands.map((command,i)=>send(id,0,'Focus '+i,command)));
      const winner=answers.findIndex(v=>!v.error),saved=answers[winner];
      assert.equal(answers.filter(v=>v.error==='steering_revision_conflict').length,1);
      assert.equal((await send(id,0,'Focus '+winner,commands[winner])).reused,true);
      assert.equal((await send(id,0,'Different',commands[winner])).error,'steering_id_conflict');
      assert.equal((await send(id,0,'Focus '+winner,commands[winner],store.workspaceId,randomUUID())).error,'steering_id_conflict');
      assert.equal((await send(id,0,'Hidden',randomUUID(),randomUUID())).error,'run_not_found');
      assert.equal(saved.revision,1);
      const next=await send(id,1,'Replacement');
      assert.deepEqual(next.messages.map((m:any)=>m.status),['superseded','pending']);
      await sql("UPDATE runtime_runs SET lifecycle='completed',finished_at=now() WHERE run_id=$1",[id]);
      assert.equal((await snapshot(id)).messages[1].status,'not_applied');
      const late=await send(id,2,'Too late');assert.equal(late.submission.reason,'run_ended_before_submission');
      assert.equal((await send(id,2,'Too late',late.submission.steering_id)).reused,true);
    });
    await t.test('cancellation closes pending focus and replay paths reject steering',async()=>{
      const id=await seed();await send(id,0,'Search');
      await sql('UPDATE runtime_runs SET cancel_id=$2,cancel_requested_at=now() WHERE run_id=$1',[id,randomUUID()]);
      assert.equal((await snapshot(id)).messages[0].reason,'cancelled_before_next_plan');
      assert.equal((await send(id,1,'Search again')).submission.status,'not_applied');
      const replay=await seed({runtime_version:'explorer-v1',replay_of:{source_action_id:randomUUID()}});
      assert.equal((await send(replay,0,'Change the replay')).error,'steering_requires_exploration');
    });
    await t.test('message history is bounded and can clear the focus',async()=>{
      const id=await seed();
      for(let i=0;i<32;i++)assert.equal((await send(id,i,i===31?'':'Search')).revision,i+1);
      const s=await snapshot(id);assert.equal(s.messages.at(-1).focus,'');
      assert.equal((await send(id,32,'Over budget')).error,'steering_limit_reached');
    });
    await t.test('finalization racing admission never leaves a pending instruction on an ended run',async()=>{
      const id=await seed();
      await Promise.all([send(id,0,'Search'),sql("UPDATE runtime_runs SET lifecycle='completed',finished_at=now() WHERE run_id=$1",[id])]);
      assert.equal((await snapshot(id)).messages[0].status,'not_applied');
    });
    await t.test('an empty replacement restores default planning at the next boundary',async()=>{
      class ClearClient extends ModelClient{
        seen:any[]=[];
        override async complete(...args:Parameters<ModelClient['complete']>){
          const [,id,,,,input]=args,value=input as any;this.seen.push(structuredClone(value));
          if(value.task==='assessment'&&this.seen.filter(v=>v.task==='assessment').length===1)await send(id,0,'Explore Help first');
          if(value.task==='plan'&&this.seen.filter(v=>v.task==='plan').length===1)await send(id,1,'');
          return super.complete(...args);
        }
      }
      const client=new ClearClient({provider:'openrouter',model:'scout-explorer-fixture:free',freeOnly:true});
      const result=await explore(store,fixture.url+'/tree',{client,allowedOrigins:[fixture.url],maxActions:3});created.push(result.run_id);
      assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      assert.deepEqual(result.report.actions.slice(1).map(a=>a.spec.command.control.name),['Help','Save draft']);
      const plans=client.seen.filter(v=>v.task==='plan');assert.equal(plans[1].operator_focus.focus,'');
      assert.deepEqual(result.report.steering.messages.map((m:any)=>m.status),['applied','applied']);
      assert.equal(result.report.steering.active_focus.revision,2);
    });
    await t.test('an instruction submitted during assessment changes the next real browser choice',async()=>{
      class FocusClient extends ModelClient{
        seen:any[]=[];focusId='';newerId='';runId='';
        override async complete(...args:Parameters<ModelClient['complete']>){
          const [,id,,,,input]=args,value=input as any;this.runId=id;this.seen.push(structuredClone(value));
          if(value.task==='assessment'&&this.seen.filter(v=>v.task==='assessment').length===1){
            await apiSend(id,0,'Explore catalogue');
            const latest=await apiSend(id,1,'Explore Help first');this.focusId=latest.submission.steering_id;
          }else if(value.task==='plan'){
            assert.equal(value.operator_focus.steering_id,this.focusId);
            const newer=await apiSend(id,2,'Explore catalogue instead');this.newerId=newer.submission.steering_id;
          }
          return super.complete(...args);
        }
      }
      const client=new FocusClient({provider:'openrouter',model:'scout-explorer-fixture:free',freeOnly:true});
      assert.equal(await client.ready(),'protocol_fixture');
      const result=await explore(store,fixture.url+'/tree',{client,allowedOrigins:[fixture.url],maxActions:2});
      created.push(result.run_id);
      assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      assert.equal(result.report.actions[1].spec.command.control.name,'Help','Default fixture ranking would choose Catalog');
      assert.match(result.report.captures.at(-1)!.observation.url,/\/tree\/broken$/);
      assert.equal(result.report.actions[1].spec.prediction.steering.steering_id,client.focusId);
      assert.deepEqual(result.report.steering.messages.map((m:any)=>m.status),['superseded','applied','not_applied']);
      const applied=result.report.steering.messages[1];
      assert.equal(result.report.graph.decisions.find((d:any)=>d.decision_id===applied.decision_id).kind,'plan');
      assert.equal(client.seen.filter(v=>v.task==='assessment').some(v=>v.operator_focus),false,'Assessments retain their frozen expectation');
      assert.deepEqual(result.report.events.map(e=>Number(e.seq)),result.report.events.map((_,i)=>i+1));
      const manifest=JSON.parse((await store.get(result.report.run.manifest_key)).toString());
      assert.deepEqual(manifest.steering,result.report.steering);
      assert.ok(result.report.events.some(e=>e.event_type==='steering.applied'));
      assert.equal(result.export_error,null);assert.equal(result.manifest_error,null);
    });
  }finally{
    for(const id of created)await sql("UPDATE runtime_runs SET lifecycle='completed',finished_at=COALESCE(finished_at,now()) WHERE run_id=$1 AND lifecycle='active'",[id]);
    await store.flush();await fixture.close();await store.close();
  }
});
