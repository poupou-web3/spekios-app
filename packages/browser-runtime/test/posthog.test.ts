import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {inferFlow,parseSnapshots,safeSelector,type RecordedEvent} from '../src/posthog-flows.js';
import {PostHogClient,openPostHogKey,type PostHogConnection} from '../src/posthog-client.js';

const origin='https://demo.test';
let time=0;
const event=(event:string,properties:Record<string,any>):RecordedEvent=>({uuid:String(++time),event,timestamp:new Date(1800000000000+time).toISOString(),properties:{$current_url:origin+'/',...properties}});
function journey(){return [event('$pageview',{}),event('spekios_action',{action:'click',selector:'[data-testid="browse"]',label:'Browse'}),event('$pageview',{$current_url:origin+'/catalogue'}),event('spekios_action',{action:'select',selector:'#size',value:'large',label:'Size'}),event('spekios_checkpoint',{selector:'#result',value:'Added.',label:'Bag'})];}
test('session events become grouped, ordered workflows; labels do not change identity',()=>{
  const events=journey(),flow=inferFlow([...events].reverse(),[],origin);
  assert.equal(flow.executable,true);assert.equal(flow.steps.length,5);assert.equal(flow.steps[3].value,'large');
  const renamed=events.map(e=>({...e,properties:{...e.properties,label:'Another label'}}));
  assert.equal(inferFlow(renamed,[],origin).fingerprint,flow.fingerprint);
  assert.notEqual(inferFlow([...events,event('spekios_action',{action:'click',selector:'#next'})],[],origin).fingerprint,flow.fingerprint);
});
test('masked fields, missing steps, queries, cross-origin navigation and synthetic traffic fail closed',()=>{
  for(const extra of [event('spekios_action',{action:'fill',selector:'#search',value:'*****'}),event('spekios_action',{action:'fill',selector:'#password',value:'never-store'}),event('spekios_action',{action:'execute',selector:'#next'}),event('$pageview',{$current_url:origin+'/?secret=x'}),event('$pageview',{$current_url:'https://other.test/'})]){
    const flow=inferFlow([...journey(),extra],[],origin);assert.equal(flow.executable,false);assert.ok(flow.issues.length);assert.doesNotMatch(JSON.stringify(flow),/never-store|secret=x/);
  }
  assert.equal(inferFlow([event('$pageview',{})],[],origin).executable,false);
  assert.equal(inferFlow([...journey(),event('anything',{spekios_synthetic:true})],[],origin).synthetic,true);
  assert.equal(safeSelector('button;script'),false);assert.equal(safeSelector('[data-testid="safe"]'),true);
});
test('blob_v2 JSONL and compressed rrweb fields are decoded, ordered and deduplicated',()=>{
  const node={id:1,type:0,childNodes:[{id:2,type:2,tagName:'button',attributes:{id:'next'}}]};
  const data=gzipSync(JSON.stringify({node})).toString('latin1');
  const lines=[['tab',{type:4,timestamp:1,data:{href:origin+'/'}}],['tab',{type:2,timestamp:2,cv:'2024-10',data}],['tab',{type:3,timestamp:3,data:{source:2,type:2,id:2}}]];
  const snapshots=parseSnapshots([...lines,lines[2]].map(l=>JSON.stringify(l)).join('\n'));
  assert.equal(snapshots.length,3);assert.equal(snapshots[1].data.node.id,1);
  const flow=inferFlow([],snapshots,origin);assert.equal(flow.executable,true);assert.equal(flow.steps[1].selector,'#next');assert.match(flow.issues[0],/No explicit outcome/);
  assert.throws(()=>parseSnapshots(JSON.stringify([['tab',{type:2,timestamp:1,cv:'future',data:'unknown'}]])));
  assert.throws(()=>parseSnapshots('not-json'));
});
test('rrweb node IDs are resolved through mutations and masked input cannot become a runnable flow',()=>{
  const items=[['tab',{type:4,timestamp:1,data:{href:origin+'/'}}],['tab',{type:2,timestamp:2,data:{node:{id:1,childNodes:[]}}}],['tab',{type:3,timestamp:3,data:{source:0,adds:[{parentId:1,node:{id:2,tagName:'input',attributes:{id:'search',type:'search'}}}]}}],['tab',{type:3,timestamp:4,data:{source:5,id:2,text:'****'}}]];
  const flow=inferFlow([],parseSnapshots(JSON.stringify(items)),origin);assert.equal(flow.executable,false);assert.ok(flow.issues.some(i=>i.includes('masked')));
});
test('a cross-subdomain recording never imports the sibling website’s controls or input values',()=>{
  const items=[['tab',{type:4,timestamp:1,data:{href:origin+'/'}}],['tab',{type:2,timestamp:2,data:{node:{id:1,tagName:'button',attributes:{id:'next'}}}}],['tab',{type:3,timestamp:3,data:{source:2,type:2,id:1}}],['tab',{type:4,timestamp:4,data:{href:'https://sibling.demo.test/'}}],['tab',{type:2,timestamp:5,data:{node:{id:2,tagName:'input',attributes:{id:'sibling-only-control'}}}}],['tab',{type:3,timestamp:6,data:{source:5,id:2,text:'sibling-only-value'}}]];
  const flow=inferFlow([],parseSnapshots(JSON.stringify(items)),origin);
  assert.equal(flow.executable,false);assert.ok(flow.steps.some(s=>s.selector==='#next'));
  assert.doesNotMatch(JSON.stringify(flow),/sibling-only/);
});

const connection:PostHogConnection={connection_id:'11111111-1111-4111-8111-111111111111',workspace_id:'22222222-2222-4222-8222-222222222222',user_id:'33333333-3333-4333-8333-333333333333',host:'https://posthog.test',project_id:'1',source_origin:origin,replay_origin:origin,encrypted_key:Buffer.alloc(0),auto_replay:false,scan:null,last_synced_at:null};
test('connector ciphertext is compatible with the product vault and bound to its owner',()=>{
  const key='1f'.repeat(32),iv=Buffer.alloc(12,4),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);
  cipher.setAAD(Buffer.from(JSON.stringify(['posthog-v1',connection.connection_id,connection.workspace_id,connection.user_id])));
  const bytes=Buffer.concat([iv,cipher.update('phx-private-read-key'),cipher.final(),cipher.getAuthTag()]);
  assert.equal(openPostHogKey({...connection,encrypted_key:bytes},key),'phx-private-read-key');
  assert.throws(()=>openPostHogKey({...connection,workspace_id:connection.user_id,encrypted_key:bytes},key));
});
test('API client checks host, rejects redirects, bounds payloads and does not follow upstream next URLs',async()=>{
  process.env.SCOUT_POSTHOG_HOSTS=connection.host;
  let called:any;
  const transport:typeof fetch=async(input,init)=>{called={url:String(input),init};return new Response(JSON.stringify({results:[],has_next:true,next:'https://evil.test/steal'}));};
  const client=new PostHogClient(connection,'phx-private-read-key',transport);
  const page=await client.recordings({from:'2026-01-01',to:'2026-01-02',offset:5});
  assert.equal(page.has_next,true);assert.equal(called.init.redirect,'error');assert.equal(new URL(called.url).origin,connection.host);
  await assert.rejects(()=>client.request('https://evil.test/api/x'),/host_not_allowed/);
  await assert.rejects(()=>client.events("bad' OR true"),/session_id_invalid/);
  assert.throws(()=>new PostHogClient({...connection,host:'https://evil.test'},'key'),/host_not_allowed/);
  const denied=new PostHogClient(connection,'secret',async()=>new Response('body with secret',{status:403}));
  await assert.rejects(()=>denied.recordings({from:'a',to:'b',offset:0}),e=>e instanceof Error&&e.message==='posthog_access_denied');
});
test('event queries are source-scoped and unsupported snapshot sources are explicit',async()=>{
  process.env.SCOUT_POSTHOG_HOSTS=connection.host;
  let body='';
  const client=new PostHogClient(connection,'key',async(input,init)=>{
    if(String(input).includes('/query/')){body=String(init?.body);return new Response(JSON.stringify({columns:['uuid','event','timestamp','properties'],results:[['a','$pageview','2026-01-01T00:00:00Z',{$current_url:origin+'/'}]]}));}
    return new Response(JSON.stringify({sources:[{source:'unknown',url:'https://evil.test'}]}));
  });
  assert.equal((await client.events('session-a')).length,1);assert.match(body,/startsWith/);assert.match(body,/demo.test/);
  await assert.rejects(()=>client.snapshots('session-a'),/snapshot_source_unsupported/);
});
test('analysis queries isolate subdomains and synthetic visits, validate counts and return bounded aggregates',async()=>{
  process.env.SCOUT_POSTHOG_HOSTS=connection.host;
  const queries:string[]=[];
  const client=new PostHogClient(connection,'key',async(input,init)=>{
    const sql=JSON.parse(String(init?.body)).query.query;queries.push(sql);
    const results=sql.includes('uniqExactIf')?[[100,12,9,30,2,1,3]]:sql.includes('toString(toDate')?[['2026-11-04',100,12]]:sql.includes('properties.$pathname')?[['/product',20],['/?private=secret',2]]:[['$pageview',30]];
    return new Response(JSON.stringify({results}));
  });
  const data=await client.analysis(new Date('2026-11-04T12:00:00Z'));
  assert.equal(data.from,'2026-10-29T00:00:00.000Z');assert.equal(data.totals.events,100);assert.equal(data.totals.visitors,12);assert.deepEqual(data.top_pages,[{label:'/product',count:20}]);
  assert.equal(queries.length,4);
  for(const query of queries){assert.ok(query.includes(`properties.$current_url = '${origin}' OR startsWith(properties.$current_url, '${origin}/')`));assert.match(query,/properties.spekios_synthetic IS NULL OR properties.spekios_synthetic != true/);assert.match(query,/timestamp >= toDateTime/);}
  const malformed=new PostHogClient(connection,'key',async()=>new Response(JSON.stringify({results:[[null,0,0,0,0,0,0]]})));
  await assert.rejects(()=>malformed.analysis(),/posthog_analysis_format_unsupported/);
});
