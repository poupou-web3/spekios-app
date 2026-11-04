import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createCipheriv,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {chromium} from 'playwright';
import {demoServer} from '../../../apps/posthog-demo/server.mjs';

test('durable worker imports cursor pages, groups sessions and automatically validates only once', {skip:process.env.SPEKIOS_POSTHOG_WORKER_TEST_DB!=='1',timeout:60000},async()=>{
  const db=new pg.Client({host:process.env.PGHOST,port:Number(process.env.PGPORT),user:'scout',database:'scout',password:process.env.POSTGRES_PASSWORD});
  await db.connect();
  const demo=demoServer({token:'',host:'',enabled:false});await new Promise<void>(resolve=>demo.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(demo.address() as AddressInfo).port}`;
  const timestamp=new Date(Date.now()-120000).toISOString();
  const raw=[['$pageview',{$current_url:origin+'/'}],['spekios_action',{action:'click',selector:'[data-testid="browse"]',label:'Browse'}],['$pageview',{$current_url:origin+'/catalogue'}],['spekios_action',{action:'click',selector:'[data-testid="open-bottle"]',label:'Bottle'}],['$pageview',{$current_url:origin+'/product'}],['spekios_action',{action:'select',selector:'[data-testid="size"]',value:'large',label:'Size'}],['spekios_action',{action:'click',selector:'[data-testid="add-to-bag"]',label:'Add'}],['spekios_action',{action:'click',selector:'[data-testid="bag"]',label:'Bag'}],['$pageview',{$current_url:origin+'/bag'}],['spekios_action',{action:'click',selector:'[data-testid="place-demo-order"]',label:'Demo order'}],['$pageview',{$current_url:origin+'/complete'}],['spekios_checkpoint',{selector:'[data-testid="order-confirmation"]',value:'Your demo order is confirmed.',label:'Order confirmation'}],['spekios_session_complete',{}]];
  const rows=raw.map(([event,properties],index)=>[randomUUID(),event,new Date(Date.parse(timestamp)+index).toISOString(),{$current_url:origin+'/',...properties as object}]);
  let cursorSeen=false,snapshotsRead=0,queryFailed=false,retryForced=false,recordingsUnavailable=false;
  const posthog=createServer(async(req,res)=>{
    const url=new URL(req.url!,'http://fixture');
    assert.equal(req.headers.authorization,'Bearer phx-disposable-read-key');
    let body='';for await(const chunk of req)body+=chunk;
    res.setHeader('Content-Type','application/json');
    if(url.pathname.endsWith('/session_recordings/')){
      if(recordingsUnavailable){res.writeHead(404);res.end('{}');return;}
      const second=url.searchParams.get('after')==='page-two';cursorSeen||=second;
      res.end(JSON.stringify({results:[{id:second?'session-two':'session-one',start_time:timestamp,ongoing:false}],has_next:!second,...(!second?{next_cursor:'page-two'}:{})}));
    }else if(url.pathname.endsWith('/query/')){
      const sql=JSON.parse(body).query.query;
      if(!sql.includes('SELECT uuid')){assert.match(sql,/spekios_synthetic/);assert.ok(sql.includes(origin));const results=sql.includes('uniqExactIf')?[[42,4,2,12,1,0,0]]:sql.includes('toString(toDate')?[[timestamp.slice(0,10),42,4]]:sql.includes('properties.$pathname')?[['/',12]]:[['$pageview',12]];res.end(JSON.stringify({results}));return;}
      if(!queryFailed){queryFailed=true;res.writeHead(503);res.end('{}');return;}
      assert.match(JSON.parse(body).query.query,/properties\.\$session_id/);res.end(JSON.stringify({columns:['uuid','event','timestamp','properties'],results:rows}));
    }else if(url.pathname.endsWith('/snapshots')){
      if(url.searchParams.get('source')){assert.equal(url.searchParams.get('start_blob_key'),'0');assert.equal(url.searchParams.get('end_blob_key'),'0');snapshotsRead++;res.end(JSON.stringify(['tab',{type:4,timestamp:Date.parse(timestamp),data:{href:origin+'/'}}]));}
      else res.end(JSON.stringify({sources:[{source:'blob_v2',blob_key:'0'}]}));
    }else{res.writeHead(404);res.end('{}');}
  });
  await new Promise<void>(resolve=>posthog.listen(0,'127.0.0.1',resolve));
  const host=`http://127.0.0.1:${(posthog.address() as AddressInfo).port}`;
  const browser=await chromium.launchServer({headless:true,host:'127.0.0.1'});
  const id=randomUUID(),workspace=randomUUID(),user=randomUUID(),key='1f'.repeat(32),iv=Buffer.alloc(12,3);
  const cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);cipher.setAAD(Buffer.from(JSON.stringify(['posthog-v1',id,workspace,user])));
  const encrypted=Buffer.concat([iv,cipher.update('phx-disposable-read-key'),cipher.final(),cipher.getAuthTag()]);
  await db.query('INSERT INTO workspaces(workspace_id,owner_user_id,name) VALUES($1,$2,\'PostHog disposable integration\')',[workspace,user]);
  await db.query('INSERT INTO posthog_connections(connection_id,workspace_id,user_id,name,host,project_id,source_origin,replay_origin,encrypted_key,auto_replay) VALUES($1,$2,$3,\'Demo fixture\',$4,\'1\',$5,$5,$6,true)',[id,workspace,user,host,origin,encrypted]);
  const child=spawn(process.execPath,['--import','tsx','src/posthog-worker.ts'],{cwd:new URL('..',import.meta.url),env:{...process.env,SCOUT_PROVIDER_VAULT_KEY:key,SCOUT_POSTHOG_HOSTS:host,SCOUT_POSTHOG_REPLAY_ORIGINS:origin,SCOUT_BROWSER_ENDPOINT:browser.wsEndpoint(),SCOUT_BROWSER_SLOTS:'1',S3_ACCESS_KEY_ID:'fixture',S3_SECRET_ACCESS_KEY:'fixture',S3_ENDPOINT:'http://127.0.0.1:1'},stdio:['ignore','pipe','pipe']});
  let logs='';child.stderr?.on('data',b=>logs+=b.toString());
  try{
    const deadline=Date.now()+45000;let result:any;
    while(Date.now()<deadline){
      assert.equal(child.exitCode,null,'Worker exited: '+logs);
      const replay=(await db.query('SELECT status,result FROM posthog_replays WHERE connection_id=$1',[id])).rows[0];
      const sessions=(await db.query('SELECT count(*)::int n FROM posthog_sessions WHERE connection_id=$1',[id])).rows[0].n;
      const connection=(await db.query('SELECT error,scan FROM posthog_connections WHERE connection_id=$1',[id])).rows[0];
      if(connection?.error==='posthog_request_failed'&&!retryForced){assert.equal(connection.scan.offset,0);retryForced=true;await db.query('UPDATE posthog_connections SET next_sync_at=now() WHERE connection_id=$1',[id]);}
      if(replay&&['failed','blocked','interrupted'].includes(replay.status))assert.fail(JSON.stringify(replay));
      if(sessions===2&&replay?.status==='completed'){result=replay;break;}
      await delay(300);
    }
    const diagnostic=(await db.query('SELECT error,scan,last_synced_at,(SELECT count(*) FROM posthog_sessions s WHERE s.connection_id=c.connection_id) sessions,(SELECT count(*) FROM posthog_workflows f WHERE f.connection_id=c.connection_id) workflows FROM posthog_connections c WHERE connection_id=$1',[id])).rows;
    assert.ok(result,'Background import and browser validation did not finish: '+JSON.stringify(diagnostic)+' '+logs);
    const analysis=(await db.query('SELECT analysis,analysis_error,analysis_updated_at FROM posthog_connections WHERE connection_id=$1',[id])).rows[0];assert.equal(analysis.analysis.totals.events,42);assert.equal(analysis.analysis.totals.visitors,4);assert.equal(analysis.analysis_error,null);assert.ok(analysis.analysis_updated_at);assert.equal((await db.query('SELECT count(*)::int n FROM posthog_worker_status')).rows[0].n,1);
    assert.equal(result.result.outcome,'matched_observations');assert.equal(cursorSeen,true);assert.equal(snapshotsRead,2);assert.equal(retryForced,true);
    assert.equal((await db.query('SELECT count(*)::int n FROM posthog_workflows WHERE connection_id=$1',[id])).rows[0].n,1);
    await db.query('UPDATE posthog_connections SET next_sync_at=now() WHERE connection_id=$1',[id]);await delay(2500);
    assert.equal((await db.query('SELECT count(*)::int n FROM posthog_replays WHERE connection_id=$1',[id])).rows[0].n,1);
    recordingsUnavailable=true;await db.query('UPDATE posthog_connections SET analysis=NULL,next_analysis_at=now(),next_sync_at=now() WHERE connection_id=$1',[id]);
    let independent=false;const analyticsDeadline=Date.now()+10000;
    while(Date.now()<analyticsDeadline){const row=(await db.query('SELECT analysis,error FROM posthog_connections WHERE connection_id=$1',[id])).rows[0];if(row.analysis?.totals.events===42&&row.error==='posthog_endpoint_unavailable'){independent=true;break;}await delay(200);}
    assert.equal(independent,true,'Event analysis continues when recordings are unavailable.');
    assert.doesNotMatch(logs,/phx-disposable-read-key/);
    await db.query('DELETE FROM posthog_connections WHERE connection_id=$1',[id]);
    assert.equal((await db.query('SELECT count(*)::int n FROM posthog_sessions WHERE connection_id=$1',[id])).rows[0].n,0);
  }finally{
    child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(3000)]);if(child.exitCode===null)child.kill('SIGKILL');
    await browser.close();await new Promise<void>(resolve=>posthog.close(()=>resolve()));await new Promise<void>(resolve=>demo.close(()=>resolve()));await db.end();
  }
});
