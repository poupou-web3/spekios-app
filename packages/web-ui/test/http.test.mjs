import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceRequest,requireOk} from '../src/http.js';

test('workspace transport keeps credentials in headers and refuses foreign or ambiguous destinations',()=>{
  let called=false;
  for(const path of ['https://other.example/v1/runs','//other.example/v1/runs','/\\other.example/v1/runs','/\n/other.example/v1/runs','v1/runs']){
    assert.throws(()=>workspaceRequest(path,{token:'private-fixture'},()=>{called=true}),/local absolute path/);
  }
  assert.equal(called,false,'A rejected path must never send its credential');
});

test('shared transport preserves JSON bodies, private access headers and redirect fencing',async()=>{
  const requests=[],fetcher=async(path,options)=>{requests.push({path,options});return {ok:true};};
  await workspaceRequest('/v1/browser-access/id/start',{token:'fixture',body:{client_id:'id'},headers:{'X-Scout-Access-Lease':'lease'}},fetcher);
  assert.equal(requests[0].options.headers.Authorization,'Bearer fixture');assert.equal(requests[0].options.headers['X-Scout-Access-Lease'],'lease');assert.equal(requests[0].options.headers['Content-Type'],'application/json');assert.equal(requests[0].options.redirect,'error');assert.deepEqual(JSON.parse(requests[0].options.body),{client_id:'id'});
  await workspaceRequest('/readyz',{},fetcher);assert.equal(requests[1].options.method,'GET');assert.equal(requests[1].options.headers.Authorization,undefined);assert.equal(requests[1].options.body,undefined);
  await workspaceRequest('/v1/example',{body:false},fetcher);assert.equal(requests[2].options.method,'POST');assert.equal(requests[2].options.body,'false');
});

test('caller cancellation is retained alongside the request timeout',async()=>{
  const controller=new AbortController();controller.abort();
  await workspaceRequest('/v1/runs',{signal:controller.signal},async(_path,options)=>{assert.equal(options.signal.aborted,true);});
});

test('error responses retain their status and machine code without trusting malformed JSON',async()=>{
  await assert.rejects(requireOk({ok:false,status:409,json:async()=>({error:'job_id_conflict'})}),e=>e.status===409&&e.code==='job_id_conflict'&&e.message==='job id conflict');
  for(const json of [async()=>({error:42}),async()=>{throw new Error('Invalid JSON')}]){
    await assert.rejects(requireOk({ok:false,status:502,json}),e=>e.status===502&&e.code==='Request failed');
  }
  const response={ok:true};assert.equal(await requireOk(response),response);
});
