import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {ModelClient} from '../src/model-client.js';

test('model requests preserve the selected key reference and keep authentication in headers',async()=>{
  const requests:{headers:Record<string,unknown>;body:Record<string,unknown>}[]=[];
  const server=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/v1/model-providers'){res.end(JSON.stringify({gateway_ready:true,providers:[{provider:'meta',configured:true}]}));return;}
    if(req.method==='POST'){
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      requests.push({headers:req.headers,body:JSON.parse(Buffer.concat(chunks).toString())});res.writeHead(202);res.end('{}');return;
    }
    res.end(JSON.stringify({request:{state:'completed'},calls:[{call_id:randomUUID(),output_text:'{"ok":true}'}]}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const address=server.address();assert(address&&typeof address!=='string');
  const token='disposable-test-operator-credential-0123456789',keys=[randomUUID(),randomUUID()];
  try{
    for(const key of keys){
      const client=new ModelClient({provider:'meta',model:'muse-spark-1.3-contributor',freeOnly:false,providerKeyId:key},`http://127.0.0.1:${address.port}`,token);
      assert.equal(await client.ready(),'live');
      assert.deepEqual((await client.complete(randomUUID(),randomUUID(),null,[],'System',{task:'Test'})).value,{ok:true});
    }
    assert.deepEqual(requests.map(r=>r.body.provider_key_id),keys);
    for(const r of requests){assert.equal(r.headers.authorization,`Bearer ${token}`);assert(!('api_key' in r.body));assert(!JSON.stringify(r.body).includes(token));}
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});

test('demo exhaustion explains personal key setup and never changes the funding reference',async()=>{
  const requests:Record<string,unknown>[]=[];
  const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));requests.push(JSON.parse(Buffer.concat(chunks).toString()));res.writeHead(402,{'content-type':'application/json'});res.end('{"error":"demo_credits_insufficient"}');});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert(address&&typeof address!=='string');
  try{
    const client=new ModelClient({provider:'meta',model:'muse-spark-1.3-contributor',freeOnly:false,providerKeyId:'demo'},`http://127.0.0.1:${address.port}`,'disposable-test-operator-credential-0123456789');
    await assert.rejects(client.complete(randomUUID(),randomUUID(),null,[],'System',{}),/Not enough demo credit.*personal API key/);
    assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1],'A lost/failed acknowledgement retries only the same logical request.');
    assert(requests.every(r=>r.provider_key_id==='demo'&&r.model==='muse-spark-1.3-contributor'));
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
