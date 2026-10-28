import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { explore, reproduce } from '../src/explorer.js';
import { ModelClient } from '../src/model-client.js';
import { image } from '../src/recorder.js';
import { explorationFixture } from '../src/exploration-fixture.js';
import { workspaceId, userId } from '../src/contracts.js';

test('cancellation at CLI and reproduction dispatch boundaries',{
  skip:process.env.SCOUT_EXPLORER_INTEGRATION!=='1',timeout:120000,
},async t=>{
  const store=await new Store().open(),fixture=await explorationFixture();
  const client=new ModelClient({provider:'openrouter',model:'scout-cancellation-fixture:free',freeOnly:true});
  const options={client,allowedOrigins:[fixture.url],maxActions:2};
  assert.equal(await client.ready(),'protocol_fixture');
  const cancel=async(path:string)=>{
    const response=await fetch(client.endpoint+path,{method:'POST',headers:{Authorization:'Bearer '+process.env.SCOUT_API_TOKEN,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,202,await response.clone().text());return response.json();
  };
  const beforeSecondAction={screenshot:async(page:Parameters<typeof image>[0],phase:'before'|'after',ordinal:number)=>{
    const bytes=await image(page);
    if(phase==='before'&&ordinal===2){
      const row=(await store.query("SELECT run_id FROM runtime_actions WHERE state='prepared' ORDER BY created_at DESC LIMIT 1")).rows[0];
      await cancel('/v1/runs/'+row.run_id+'/cancel');
    }
    return bytes;
  }};
  try{
    await t.test('a cancellation before the job is linked prevents the first model decision and browser launch',async()=>{
      const jobId=randomUUID();
      await store.query("INSERT INTO browser_jobs(job_id,workspace_id,user_id,request,settings,execution_mode,status) VALUES($1,$2,$3,$4,'{}','protocol_fixture','running')",[jobId,workspaceId,userId,JSON.stringify({kind:'explore',target_url:fixture.url+'/working'})]);
      try{
        const operation=await cancel('/v1/browser-jobs/'+jobId+'/cancel');
        const result=await explore(store,fixture.url+'/working',{...options,jobId});
        assert.equal(result.report.run.lifecycle,'cancelled');
        assert.equal(result.report.run.cancel_id,operation.cancellation_id);
        assert.equal(result.report.actions.length,0);assert.equal(result.report.model_requests.length,0);
        assert.ok(!result.report.events.some(e=>e.event_type==='browser.ready'));
        assert.equal(fixture.requests.length,0);
      }finally{await store.query("UPDATE browser_jobs SET status='cancelled',finished_at=now() WHERE job_id=$1",[jobId]);}
    });
    await t.test('cancelling a CLI run after preparation never dispatches the planned click',async()=>{
      const result=await explore(store,fixture.url+'/working',{...options,hooks:beforeSecondAction});
      assert.equal(result.report.run.lifecycle,'cancelled');
      assert.equal(result.report.actions.length,2);
      const action=result.report.actions[1];
      assert.equal(action.state,'cancelled');assert.equal(action.dispatched_at,null);
      assert.equal(action.assessment.verdict,'inconclusive');
      assert.ok(!result.report.events.some(e=>e.event_type==='action.dispatched'&&e.action_id===action.action_id));
      assert.equal(result.report.graph.edges.length,1);
    });
    await t.test('cancelled reproduction remains inconclusive and cannot silently retry its click',async()=>{
      const source=await explore(store,fixture.url+'/broken-session',options);
      assert.equal(source.report.actions[1].assessment.verdict,'suspect');
      const result=await reproduce(store,source.report.actions[1].action_id,{...options,hooks:beforeSecondAction});
      assert.equal(result.report.run.lifecycle,'cancelled');
      assert.equal(result.report.actions[1].dispatched_at,null);
      assert.equal(result.report.reproductions[0].result.outcome,'inconclusive');
      assert.equal(result.report.reproductions[0].result.confirmed_bug,false);
      const visits=fixture.requests.length;
      const again=await reproduce(store,source.report.actions[1].action_id,options);
      assert.equal(again.reused,true);assert.equal(again.run_id,result.run_id);
      assert.equal(fixture.requests.length,visits);
      assert.equal(again.report.model_requests.length,result.report.model_requests.length);
      assert.equal((await store.report(source.run_id)).actions[1].assessment.verdict,'suspect');
    });
  }finally{await fixture.close();await store.close();}
});
