import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';

test('connector settings render real browser modules at desktop and mobile and submit a private key once',async()=>{
  const root=new URL('../../../',import.meta.url),id='11111111-1111-4111-8111-111111111111',source='http://demo.test',base='/v1/websites/'+encodeURIComponent(source)+'/posthog/connections';
  const connection={connection_id:id,name:'PostHog demo',host:'http://posthog.test',source_origin:'http://demo.test',replay_origin:'http://test.test',project_id:'1',enabled:true,auto_replay:true,sessions:2,workflows:1};
  const detail={analysis:{from:'2026-10-29T00:00:00Z',to:'2026-11-04T12:00:00Z',totals:{events:42,visitors:4,sessions:2,pageviews:12,exceptions:1,rageclicks:0,deadclicks:0},daily:[{date:'2026-11-03',events:42,visitors:4}],top_events:[{label:'$pageview',count:12}],top_pages:[{label:'/',count:12}]},analysis_updated_at:'2026-11-04T12:00:00Z',workflows:[{workflow_id:id,title:'Browse → Choose a size → Place demo order',executable:true,sessions:2,steps:[{action:'navigate',path:'/',label:'Open the shop'},{action:'click',selector:'#browse',label:'Browse the collection'},{action:'observe',selector:'#result',value:'Demo order confirmed.',label:'Order confirmation'}],issues:[]}],sessions:[{session_id:'recording-one',started_at:'2026-11-03T12:00:00Z',ongoing:false,event_count:12,snapshot_status:'available',issues:[]}],replays:[{replay_id:id,workflow_id:id,status:'completed',created_at:'2026-11-03T12:01:00Z',automatic:true,result:{outcome:'matched_observations',steps:[{},{},{}]}}]};
  let saved:any;
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url!,'http://fixture');
    const api:Record<string,unknown>={'/v1/auth-mode':{mode:'local_development'},'/v1/runs':{runs:[],websites:[]},'/v1/browser-jobs':{jobs:[],workers:[],settings:{provider:'openrouter',model:'openrouter/free',viewportProfile:'desktop',freeOnly:true,allowedOrigins:[]}},'/v1/model-providers':{providers:[]},'/v1/browser-access':{requests:[],sessions:[]},'/v1/identity':{workspace_name:'Test workspace'},[base]:{connections:[connection],vault_ready:true,allowed_hosts:['http://posthog.test'],replay_origins:['http://test.test']},[base+'/'+id]:detail};
    if(req.method==='POST'&&url.pathname===base){let text='';for await(const b of req)text+=b;saved=JSON.parse(text);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({connection_id:id}));return;}
    if(url.pathname in api){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(api[url.pathname]));return;}
    let path=url.pathname.startsWith('/assets/app/')?'apps/web/src/'+url.pathname.slice(12):url.pathname.startsWith('/assets/ui/')?'packages/web-ui/src/'+url.pathname.slice(11):'apps/web/index.html';
    if(path.includes('..')){res.writeHead(404);res.end();return;}
    try{const file=await readFile(new URL(path,root));res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.ttf')?'font/ttf':'text/html');res.end(file);}catch{res.writeHead(404);res.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/website/${encodeURIComponent(source)}/settings/posthog`);
    await page.getByText('Matched the recorded observations',{exact:false}).waitFor();await page.getByRole('heading',{name:'Website analytics'}).waitFor();await page.getByRole('navigation',{name:'Website navigation'}).getByRole('link',{name:'Project settings',exact:true}).waitFor();assert.match(await page.locator('.breadcrumb').textContent()||'',/Project settings/);assert.equal(await page.locator('.posthog-metrics dd').first().textContent(),'42');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await mkdir(new URL('artifacts/posthog/',root),{recursive:true});
    await page.screenshot({path:new URL('artifacts/posthog/connector-desktop.png',root).pathname,fullPage:true});
    await page.getByRole('button',{name:'Connect PostHog',exact:true}).click();
    await page.locator('[name="name"]').fill('Demo connection');await page.locator('[name="project_id"]').fill('http://posthog.test/project/1/dashboard');
    assert.equal(await page.locator('[name="source_origin"]').inputValue(),source);assert.equal(await page.locator('[name="source_origin"]').getAttribute('readonly'),'');await page.locator('[name="replay_origin"]').fill('http://test.test');
    await page.locator('[name="api_key"]').fill('phc_public_token');await page.getByRole('button',{name:'Verify and connect'}).click();await page.getByRole('alert').filter({hasText:'private personal API key'}).waitFor();assert.equal(Boolean(saved),false);
    await page.locator('[name="api_key"]').fill('phx-test-not-a-real-key');await page.locator('[name="auto_replay"]').check();
    await page.getByRole('button',{name:'Verify and connect'}).click();await page.locator('#posthog-dialog').waitFor({state:'detached'});
    assert.equal(saved.project_id,'1');assert.equal(saved.api_key,'phx-test-not-a-real-key');assert.equal(saved.auto_replay,true);assert.equal(saved.replay_origin,'http://test.test');
    assert.doesNotMatch(await page.content(),/phx-test-not-a-real-key/);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Settings fit a mobile screen.');
    await page.screenshot({path:new URL('artifacts/posthog/connector-mobile.png',root).pathname,fullPage:true});
    assert.deepEqual(errors,[]);
  }finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
