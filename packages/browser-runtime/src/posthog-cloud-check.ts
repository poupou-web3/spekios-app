// Explicit, one-visit setup check against the configured PostHog Cloud project.
// The visit is marked synthetic and excluded from connector workflow discovery.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import type {AddressInfo} from 'node:net';
import {chromium} from 'playwright';
import {configuration,demoServer} from '../../../apps/posthog-demo/server.mjs';

const root=new URL('../../../',import.meta.url);
const env=parseEnv(await readFile(new URL('apps/posthog-demo/.env',root),'utf8'));
const config=configuration(env);
if(!config.enabled||!['https://eu.i.posthog.com','https://us.i.posthog.com'].includes(config.host))throw new Error('Configure the standalone demo with a PostHog Cloud ingestion host first.');
const demo=demoServer(config);
await new Promise<void>(resolve=>demo.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
const deliveries:Promise<{path:string;status:number;quotaLimited:unknown}>[]=[];
try{
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errors:string[]=[];
  page.on('pageerror',()=>errors.push('browser_script_error'));
  page.on('response',response=>{
    const url=new URL(response.url());
    if(url.origin!==config.host||response.request().method()!=='POST')return;
    deliveries.push((async()=>{
      let quotaLimited:unknown=null;
      try{const data=await response.json();quotaLimited=data.quota_limited??null;}catch{}
      return {path:url.pathname,status:response.status(),quotaLimited};
    })());
  });
  const origin=`http://127.0.0.1:${(demo.address() as AddressInfo).port}`;
  await page.goto(origin);
  await page.waitForFunction(()=>document.getElementById('monitoring-status')?.textContent?.startsWith('Ready.'));
  // Override bot filtering for this explicitly requested setup check only;
  // the real demo retains ordinary SDK bot filtering and anonymous identities.
  await page.evaluate('window.posthog.set_config({opt_out_useragent_filter:true,before_send:function(event){event.properties.spekios_setup_check=true;event.properties.spekios_synthetic=true;event.properties.source_environment="local_preview";return event;}})');
  await page.getByTestId('start-recording').click();
  const recordingStarted=await page.waitForFunction(()=>(window as any).posthog.sessionRecordingStarted(),{},{timeout:15000}).then(()=>true,()=>false);
  await page.getByTestId('browse').click();
  await page.getByTestId('open-bottle').click();
  await page.getByTestId('size').selectOption('large');
  await page.getByTestId('add-to-bag').click();
  await page.getByTestId('bag').click();
  await page.getByTestId('place-demo-order').click();
  await page.getByTestId('order-confirmation').waitFor();
  await page.getByTestId('finish-recording').click();
  await page.waitForTimeout(6000);
  const responses=await Promise.all(deliveries);
  const result={timestamp:new Date().toISOString(),source_environment:'local_preview',synthetic:true,ingestionHost:config.host,uiHost:config.uiHost,toolbarEnabled:config.toolbarEnabled,recordingStarted,responses,scriptErrors:errors,acceptedRequests:responses.filter(r=>r.status>=200&&r.status<300).length,ingestionPersistenceVerified:false,note:'HTTP acceptance is checked; dashboard/session queries still require a private read credential.'};
  await mkdir(new URL('artifacts/posthog/',root),{recursive:true});
  await writeFile(new URL('artifacts/posthog/cloud-check.json',root),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
  if(!result.acceptedRequests||responses.some(r=>r.status>=400||Array.isArray(r.quotaLimited)&&r.quotaLimited.length))process.exitCode=1;
}finally{await browser.close();await new Promise<void>(resolve=>demo.close(()=>resolve()));}
