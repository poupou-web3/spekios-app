import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configuration,demoServer} from '../server.mjs';

test('only a dedicated public project token and clean PostHog origin are accepted',()=>{
  assert.deepEqual(configuration({}),{token:'',host:'',uiHost:'',toolbarEnabled:false,enabled:false});
  for(const host of ['https://secret:pass@ph.test','https://ph.test/path','https://ph.test?key=x','file:///tmp'])assert.throws(()=>configuration({POSTHOG_DEMO_HOST:host,POSTHOG_DEMO_PROJECT_TOKEN:'phc_demoToken123'}));
  assert.throws(()=>configuration({POSTHOG_DEMO_HOST:'https://ph.test',POSTHOG_DEMO_PROJECT_TOKEN:'phx_private-read-key'}));
  assert.deepEqual(configuration({POSTHOG_DEMO_HOST:'https://ph.test/',POSTHOG_DEMO_PROJECT_TOKEN:'phc_demoToken123',SCOUT_API_TOKEN:'never-read'}),{host:'https://ph.test',uiHost:'https://ph.test',toolbarEnabled:false,token:'phc_demoToken123',enabled:true});
});
test('standalone demo serves its SDK, routes and public config with a scoped CSP',async()=>{
  const server=demoServer(configuration({POSTHOG_DEMO_HOST:'https://ph.test',POSTHOG_DEMO_PROJECT_TOKEN:'phc_demoToken123'}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    for(const path of ['/','/product','/bag','/complete','/vendor/posthog.js','/app.js']){
      const response=await fetch(base+path);assert.equal(response.status,200,path);
      assert.match(response.headers.get('content-security-policy'),/connect-src 'self' https:\/\/ph.test;/);
      assert.doesNotMatch(response.headers.get('content-security-policy'),/unsafe-inline|\*\.posthog/);
    }
    const config=await fetch(base+'/config.json').then(r=>r.json());assert.equal(config.token,'phc_demoToken123');assert.deepEqual(Object.keys(config).sort(),['enabled','host','token','toolbarEnabled','uiHost']);
    assert.equal((await fetch(base+'/../../.env')).status,404);
    assert.equal((await fetch(base+'/v1/runs')).status,404);
    assert.equal((await fetch(base+'/',{method:'POST'})).status,405);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('EU Cloud separates ingestion and UI hosts and allows toolbar assets only for the standalone demo',async()=>{
  const config=configuration({POSTHOG_DEMO_HOST:'https://eu.i.posthog.com',POSTHOG_DEMO_PROJECT_TOKEN:'phc_demoToken123',POSTHOG_DEMO_TOOLBAR:'true'});
  assert.equal(config.uiHost,'https://eu.posthog.com');assert.equal(config.toolbarEnabled,true);
  assert.throws(()=>configuration({POSTHOG_DEMO_UI_HOST:'https://secret:pass@eu.posthog.com'}));
  assert.throws(()=>configuration({POSTHOG_DEMO_TOOLBAR:'yes'}));
  const server=demoServer(config);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base=`http://127.0.0.1:${server.address().port}`,response=await fetch(base+'/');
    const csp=response.headers.get('content-security-policy');
    for(const directive of ['script-src','connect-src','style-src','font-src','img-src','media-src'])assert.match(csp,new RegExp(directive+"[^;]*https://\\*\\.posthog\\.com"));
    assert.doesNotMatch(csp,/unsafe-inline|unsafe-eval/);
    const sdk=await fetch(base+'/vendor/posthog.js');assert.equal(sdk.status,200);
    assert.match(await sdk.text(),/loadExternalDependency/,'This bundle can actually load the authorized toolbar.');
    assert.equal((await fetch(base+'/config.json').then(r=>r.json())).uiHost,'https://eu.posthog.com');
  }finally{await new Promise(resolve=>server.close(resolve));}
});
