import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir} from 'node:fs/promises';
import type {AddressInfo} from 'node:net';
import {chromium} from 'playwright';
import {demoServer} from '../../../apps/posthog-demo/server.mjs';
import {inferFlow,type RecordedEvent} from '../src/posthog-flows.js';
import {replayFlow} from '../src/posthog-replay.js';

test('real demo SDK captures a journey, which is inferred and executed in a fresh browser',async()=>{
  // Protocol fixture, not a claim that a live PostHog Cloud account was tested.
  const posthog=createServer((req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    req.resume();res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(req.url?.includes('config')?{hasFeatureFlags:false,sessionRecording:{endpoint:'/s/',sampleRate:1,minimumDurationMilliseconds:0}}:{status:1,featureFlags:{}}));
  });
  await new Promise<void>(resolve=>posthog.listen(0,'127.0.0.1',resolve));
  const phOrigin=`http://127.0.0.1:${(posthog.address() as AddressInfo).port}`;
  const demo=demoServer({token:'phc_demoProtocolFixture123',host:phOrigin,enabled:true});
  await new Promise<void>(resolve=>demo.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(demo.address() as AddressInfo).port}`;
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900},userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'});
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);
    await page.waitForFunction(()=>document.getElementById('monitoring-status')?.textContent?.startsWith('Ready.'));
    const artifacts=new URL('../../../artifacts/posthog/',import.meta.url);
    await mkdir(artifacts,{recursive:true});
    await page.screenshot({path:new URL('demo-desktop.png',artifacts).pathname,fullPage:true});
    // SDK bot filtering correctly excludes Playwright. Disable it only in this
    // protocol test to exercise capture through the real SDK.
    await page.evaluate('window.__captured=[];window.posthog.set_config({opt_out_useragent_filter:true,before_send:function(event){window.__captured.push(JSON.parse(JSON.stringify({...event,timestamp:new Date().toISOString()})));return event;}})');
    await page.getByTestId('start-recording').click();
    await page.waitForFunction(()=>(window as any).posthog.sessionRecordingStarted());
    await page.getByTestId('browse').click();
    await page.getByTestId('open-bottle').click();
    await page.getByTestId('size').selectOption('large');
    await page.getByTestId('add-to-bag').click();
    await page.waitForFunction(()=>document.getElementById('added')?.textContent==='Added to your bag.');
    await page.getByTestId('bag').click();
    assert.match(await page.locator('#view').innerText(),/Trail Bottle/);
    await page.getByTestId('place-demo-order').click();
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate('window.__captured.some(e=>e.event==="spekios_checkpoint"&&e.properties.selector===\'[data-testid="order-confirmation"]\')'),true,JSON.stringify(await page.evaluate('({captured:window.__captured.map(e=>({event:e.event,selector:e.properties&&e.properties.selector})),status:document.getElementById("monitoring-status").textContent})')));
    await page.getByTestId('finish-recording').click();
    const captured=await page.evaluate(()=>(window as any).__captured);
    const events:RecordedEvent[]=captured.map((e:any)=>({uuid:e.uuid,event:e.event,timestamp:e.timestamp,properties:e.properties}));
    assert.ok(events.some(e=>e.event==='spekios_session_complete'));
    assert.ok(events.filter(e=>e.event==='$pageview'||e.event.startsWith('spekios_')).every(e=>e.properties.spekios_demo===true));
    assert.ok(events.some(e=>e.event==='$snapshot'),'The real SDK also emits session recording snapshots.');
    assert.ok(events.some(e=>e.properties.$session_id),'SDK attaches real session IDs.');
    const flow=inferFlow(events,[],origin);assert.equal(flow.executable,true,JSON.stringify(flow.issues));
    const validation=await replayFlow(browser,origin,flow.steps);
    assert.equal(validation.status,'completed',JSON.stringify(validation));assert.equal(validation.outcome,'matched_observations');
    assert.equal(validation.steps.length,flow.steps.length);assert.deepEqual(errors,[]);
    const broken=flow.steps.map(s=>s.action==='observe'&&s.value?.includes('confirmed')?{...s,value:'Something else happened.'}:s);
    const failed=await replayFlow(browser,origin,broken);assert.equal(failed.status,'failed');assert.equal(failed.error,'recorded_observation_mismatch');
    const interrupted=await replayFlow(browser,origin,flow.steps,async()=>false);assert.equal(interrupted.status,'interrupted');
    await page.setViewportSize({width:390,height:844});await page.goto(origin);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Demo fits a mobile screen.');
    await page.screenshot({path:new URL('demo-mobile.png',artifacts).pathname,fullPage:true});
  }finally{await browser.close();await new Promise<void>(resolve=>demo.close(()=>resolve()));await new Promise<void>(resolve=>posthog.close(()=>resolve()));}
});

test('toolbar-enabled demo exposes window.posthog and loads toolbar assets with the separate UI host',async()=>{
  const token='phc_toolbarFixture123';
  const remote=createServer((req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');
    if(req.url?.includes('toolbar.js')){
      res.setHeader('Content-Type','text/javascript');
      res.end('window.ph_load_toolbar=function(params){window.__toolbarFixture={apiURL:params.apiURL,action:params.action};};');
    }else if(req.url?.includes('config.js')){
      res.setHeader('Content-Type','text/javascript');
      res.end(`window._POSTHOG_REMOTE_CONFIG={${JSON.stringify(token)}:{config:{hasFeatureFlags:false,sessionRecording:false}}};`);
    }else{req.resume();res.setHeader('Content-Type','application/json');res.end('{"status":1,"featureFlags":{}}');}
  });
  await new Promise<void>(resolve=>remote.listen(0,'127.0.0.1',resolve));
  const host=`http://127.0.0.1:${(remote.address() as AddressInfo).port}`;
  const demo=demoServer({token,host,uiHost:'https://eu.posthog.com',toolbarEnabled:true,enabled:true});
  await new Promise<void>(resolve=>demo.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${(demo.address() as AddressInfo).port}`);
    await page.waitForFunction(()=>document.getElementById('monitoring-status')?.textContent?.startsWith('Ready.'));
    assert.equal(await page.getByTestId('browse').getAttribute('data-attr'),'browse');
    assert.equal(await page.evaluate('window.posthog.config.ui_host'),'https://eu.posthog.com');
    await page.evaluate('window.posthog.loadToolbar({action:"ph_authorize",userIntent:"add-action"})');
    await page.waitForFunction(()=>(window as any).__toolbarFixture);
    const toolbar=await page.evaluate(()=>(window as any).__toolbarFixture);
    assert.equal(new URL(toolbar.apiURL).origin,'https://eu.posthog.com');
    assert.equal(toolbar.action,'ph_authorize');assert.deepEqual(errors,[]);
  }finally{await browser.close();await new Promise<void>(resolve=>demo.close(()=>resolve()));await new Promise<void>(resolve=>remote.close(()=>resolve()));}
});
