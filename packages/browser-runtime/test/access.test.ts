import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sealSession, openSession } from '../src/auth-session.js';
import { AccessHandoff, validateHumanInput } from '../src/access-handoff.js';
import { Store } from '../src/store.js';
import { explore, reproduce } from '../src/explorer.js';
import { ModelClient } from '../src/model-client.js';
import { explorationFixture } from '../src/exploration-fixture.js';

test('app sessions are encrypted and bound to their origin, mode and immutable ID',()=>{
  const key=randomBytes(32),scope={session_id:randomUUID(),origin:'https://app.test',execution_mode:'live'};
  const state={cookies:[],origins:[{origin:scope.origin,localStorage:[{name:'session',value:'private-marker'}]}]};
  const bytes=sealSession(state,scope,key);
  assert.ok(!bytes.includes(Buffer.from('private-marker')));
  assert.deepEqual(openSession(bytes,scope,key),state);
  for(const altered of [{...scope,origin:'https://other.test'},{...scope,session_id:randomUUID()},{...scope,execution_mode:'protocol_fixture'}])assert.throws(()=>openSession(bytes,altered,key));
  const owned={...scope,workspace_id:randomUUID(),user_id:randomUUID()};
  const ownedBytes=sealSession(state,owned,key);assert.deepEqual(openSession(ownedBytes,owned,key),state);
  for(const altered of [{...owned,workspace_id:randomUUID()},{...owned,user_id:randomUUID()}])assert.throws(()=>openSession(ownedBytes,altered,key));
  const tampered=Buffer.from(bytes);tampered[tampered.length-1]^=1;assert.throws(()=>openSession(tampered,scope,key));
});
test('human input is bounded and cannot carry scripts, URLs or arbitrary keys',()=>{
  const input={input_id:randomUUID(),type:'text',value:'private'};
  assert.equal(validateHumanInput(input).value,'private');
  for(const bad of [{...input,script:'x'},{...input,type:'navigate',url:'https://x.test'},{...input,value:'x\n'},{input_id:randomUUID(),type:'key',key:'Control+L'},{input_id:randomUUID(),type:'click',frame_id:randomUUID(),x:-1,y:1}])assert.throws(()=>validateHumanInput(bad));
});

test('private sign-in resumes exploration without recording authentication material',{
  skip:process.env.SCOUT_EXPLORER_INTEGRATION!=='1',timeout:180000,
},async t=>{
  const store=await new Store().open(),fixture=await explorationFixture(),access=new AccessHandoff(store);
  const port=await access.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${port}`;
  const client=new ModelClient({provider:'openrouter',model:'scout-explorer-fixture:free',freeOnly:true});
  assert.equal(await client.ready(),'protocol_fixture');
  const options={client,access,allowedOrigins:[fixture.url],maxActions:3,accessTimeoutMs:15000};
  const request=async(id:string,action:string,body?:unknown,lease='')=>fetch(`${base}/access/${id}/${action}`,{method:action==='screen'?'GET':'POST',headers:{Authorization:`Bearer ${process.env.SCOUT_API_TOKEN}`,'Content-Type':'application/json','X-Scout-Access-Lease':lease},body:body===undefined?undefined:JSON.stringify(body)});
  const waitRequest=async()=>{
    for(let i=0;i<200;i++){const row=(await store.pool.query("SELECT * FROM browser_access_requests WHERE origin=$1 AND status='waiting' ORDER BY created_at DESC LIMIT 1",[fixture.url])).rows[0];if(row)return row;await new Promise(r=>setTimeout(r,50));}
    throw new Error('No login request appeared.');
  };
  const login=async(remember:boolean)=>{
    const row=await waitRequest(),id=row.access_id;
    const count=await store.pool.query('SELECT count(*) FROM runtime_captures WHERE run_id=$1',[row.run_id]);
    const opened=await request(id,'start',{client_id:randomUUID()});assert.equal(opened.status,200);const {lease}=await opened.json();
    assert.equal((await request(id,'screen',undefined,'wrong')).status,409);
    assert.equal((await request(id,'start',{client_id:randomUUID()})).status,409);
    const frame=await request(id,'screen',undefined,lease);assert.equal(frame.headers.get('cache-control'),'no-store');
    assert.deepEqual(Buffer.from(await frame.arrayBuffer()).subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
    assert.equal((await request(id,'complete',{remember},lease)).status,409,'An empty login form cannot resume.');
    assert.equal((await store.pool.query('SELECT count(*) FROM runtime_captures WHERE run_id=$1',[row.run_id])).rows[0].count,count.rows[0].count,'Private frames must not create captures.');
    const send=async(payload:Record<string,unknown>)=>{const response=await request(id,'input',{input_id:randomUUID(),...payload},lease);assert.equal(response.status,200,await response.text());};
    const email={input_id:randomUUID(),type:'text',value:'qa@example.test'};
    assert.equal((await request(id,'input',email,lease)).status,200);
    assert.equal((await request(id,'input',email,lease)).status,200,'A retried input must not type twice.');
    await send({type:'key',key:'Tab'});await send({type:'text',value:'fixture-only-password'});
    await send({type:'key',key:'Tab'});await send({type:'text',value:'123456'});await send({type:'key',key:'Tab'});await send({type:'key',key:'Enter'});
    let result:any;
    for(let i=0;i<20;i++){const response=await request(id,'complete',{remember},lease);if(response.ok){result=await response.json();break;}await new Promise(r=>setTimeout(r,100));}
    assert.equal(result?.status,'completed');
    assert.equal((await request(id,'screen',undefined,lease)).status,409);
    return {...result,access_id:id};
  };
  let savedSession='';
  try{
    await t.test('private form, verification code, immutable saved session and authenticated reproduction',async()=>{
      const pending=explore(store,fixture.url+'/auth/broken',options);
      const signedIn=await login(true);savedSession=signedIn.session_id;
      const result=await pending;assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      assert.equal(result.report.actions.length,3);assert.equal(result.report.actions[0].state,'evidence_failed');
      assert.equal(result.report.actions.at(-1)!.assessment.verdict,'suspect');
      assert.equal(result.report.run.config.auth_contexts[0].session_id,savedSession);
      const manifest=await store.get(result.report.run.manifest_key);
      for(const marker of ['PRIVATE_LOGIN_ONLY','fixture-only-password','qa@example.test','123456'])assert.ok(!manifest.toString().includes(marker),marker+' leaked into evidence');
      for(let i=0;i<100;i++){
        const pending=Number((await store.pool.query('SELECT count(*) FROM model_payloads p JOIN model_calls c USING(call_id) JOIN model_requests m USING(request_id) WHERE m.run_id=$1 AND p.uploaded_at IS NULL',[result.run_id])).rows[0].count);
        if(!pending)break;if(i===99)throw new Error('Model payload export did not finish.');await new Promise(r=>setTimeout(r,100));
      }
      for(const payload of result.report.model_payloads){const body=(await store.get(payload.object_key)).toString();for(const marker of ['PRIVATE_LOGIN_ONLY','fixture-only-password','qa@example.test'])assert.ok(!body.includes(marker),'Private login leaked into a model payload.');}
      const encrypted=await readFile(join(access.vault.directory,savedSession+'.sealed'));
      assert.ok(!encrypted.includes(Buffer.from('scout_app_session')));
      const replay=await reproduce(store,result.report.actions.at(-1)!.action_id,{client,allowedOrigins:[fixture.url]});
      assert.equal(replay.report.reproductions[0].result.outcome,'reproduced');
      assert.equal(replay.report.actions.length,2,'Only the authenticated branch is replayed.');
      assert.equal(replay.report.run.config.auth_contexts[0].session_id,savedSession);
    });
    await t.test('saved session reuse starts authenticated without another handoff',async()=>{
      const result=await explore(store,fixture.url+'/auth/required',{...options,sessionId:savedSession,maxActions:2});
      assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      assert.ok(!result.report.events.some(e=>e.event_type==='access.requested'));
      assert.equal(result.report.actions.at(-1)!.assessment.verdict,'no_issue_observed');
    });
    await t.test('session expiry mid-flow creates a new context without recording the login page',async()=>{
      const pending=explore(store,fixture.url+'/auth/expire',{...options,sessionId:savedSession,maxActions:4});
      const signedIn=await login(true);const result=await pending;
      assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      assert.equal(result.report.run.config.auth_contexts.length,2);
      assert.notEqual(signedIn.session_id,savedSession);
      assert.equal(result.report.actions.at(-1)!.assessment.verdict,'no_issue_observed');
      assert.ok(result.report.actions.some(a=>a.state==='evidence_failed'));
      assert.ok(!JSON.stringify(result.report.captures).includes('PRIVATE_LOGIN_ONLY'));
      await access.vault.revoke(signedIn.session_id);
    });
    await t.test('optional login can be skipped without abandoning public coverage',async()=>{
      const pending=explore(store,fixture.url+'/auth/optional',{...options,maxActions:2});
      const row=await waitRequest();assert.equal(row.reason,'login_available');
      assert.equal((await request(row.access_id,'skip',{})).status,200);
      const result=await pending;assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      assert.equal(result.report.actions.length,2);assert.ok(result.report.events.some(e=>e.event_type==='access.skipped'));
      assert.equal(result.report.run.config.auth_mode,'public');
    });
    await t.test('explicit account creation uses private credentials and resumes authenticated exploration once',async()=>{
      const pending=explore(store,fixture.url+'/auth/required',{...options,maxActions:3}),row=await waitRequest();
      assert.equal((await request(row.access_id,'create-account',{attempt_id:randomUUID(),email:'agent@example.test',name:'Spekios QA',remember:false})).status,409,'A private lease is required.');
      const {lease}=await (await request(row.access_id,'start',{client_id:randomUUID()})).json();
      const body={attempt_id:randomUUID(),email:'agent@example.test',name:'Spekios QA',remember:true};
      const response=await request(row.access_id,'create-account',body,lease);assert.equal(response.status,200);
      const {account}=await response.json();assert.equal(account.email,body.email);assert.ok(account.password.length>=24);
      assert.equal((await request(row.access_id,'create-account',body,lease)).status,200,'An uncertain request must reuse its account attempt.');
      assert.equal((await request(row.access_id,'create-account',{...body,attempt_id:randomUUID()},lease)).status,409);
      const result=await pending;assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      assert.equal(fixture.createdAccounts.length,1);assert.equal(fixture.createdAccounts[0].password,account.password);
      assert.equal(result.report.run.config.auth_contexts[0].verification,'account_created_entry_page_sign_out_control');
      assert.ok(result.report.run.config.auth_contexts[0].session_id);
      const sealed=await readFile(join(access.vault.directory,body.attempt_id+'.account-sealed'));assert.ok(!sealed.includes(Buffer.from(account.password)));
      const manifest=(await store.get(result.report.run.manifest_key)).toString();
      for(const marker of [account.password,account.email,'PRIVATE_SIGNUP_ONLY'])assert.ok(!manifest.includes(marker),'Private signup leaked into run evidence.');
      await access.vault.revoke(result.report.run.config.auth_contexts[0].session_id);
    });
    await t.test('required login can be declined for the rest of the run while public coverage continues',async()=>{
      const pending=explore(store,fixture.url+'/recovery/public-access',{...options,maxActions:8});
      const row=await waitRequest();assert.equal(row.reason,'login_required');
      assert.equal((await request(row.access_id,'skip',{})).status,200);
      const result=await pending;
      assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      assert.equal(result.report.run.config.auth_mode,'public');
      assert.equal(result.report.events.filter(e=>e.event_type==='access.requested').length,1);
      assert.equal(result.report.events.filter(e=>e.event_type==='access.public_recovery').length,2,'A second login gate must recover without asking again.');
      assert.ok(result.report.captures.some(c=>c.observation.url===fixture.url+'/help'),'The public Help branch must still be explored.');
      assert.ok(!JSON.stringify(result.report.captures).includes('PRIVATE_LOGIN_ONLY'));
    });
    await t.test('declining a required entry login records public-only access as blocked',async()=>{
      const pending=explore(store,fixture.url+'/auth/required',options),row=await waitRequest();
      assert.equal((await request(row.access_id,'skip',{})).status,200);
      const result=await pending;
      assert.equal(result.report.run.lifecycle,'blocked');assert.equal(result.report.run.error,'login_required');
      assert.equal(result.report.run.config.auth_mode,'public');
      assert.ok(result.report.events.some(e=>e.event_type==='access.skipped'));
      assert.ok(!JSON.stringify(result.report.captures).includes('PRIVATE_LOGIN_ONLY'));
    });
    await t.test('public-only mode reports a required login as blocked',async()=>{
      const result=await explore(store,fixture.url+'/auth/required',{...options,authMode:'public'});
      assert.equal(result.report.run.lifecycle,'blocked');assert.equal(result.report.run.error,'login_required');
      assert.ok(!JSON.stringify(result.report.captures).includes('PRIVATE_LOGIN_ONLY'));
    });
    await t.test('cancel and timeout produce durable terminal access states',async()=>{
      const pending=explore(store,fixture.url+'/auth/required',options),row=await waitRequest();
      assert.equal((await request(row.access_id,'cancel',{})).status,200);
      assert.equal((await pending).report.run.lifecycle,'cancelled');
      const timed=await explore(store,fixture.url+'/auth/required',{...options,accessTimeoutMs:100});
      assert.equal(timed.report.run.lifecycle,'blocked');assert.equal(timed.report.run.error,'access_expired');
    });
    await t.test('revocation prevents future reuse and deletes the encrypted state',async()=>{
      assert.equal(await access.vault.revoke(savedSession),true);
      await assert.rejects(()=>access.vault.load(savedSession,fixture.url,'protocol_fixture'));
      await assert.rejects(()=>readFile(join(access.vault.directory,savedSession+'.sealed')));
    });
  }finally{await access.close();await fixture.close();await store.close();}
});
