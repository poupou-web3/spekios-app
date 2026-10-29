import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';

for(const [table,flush] of [
  ['runtime_events',(store:Store)=>store.flush(undefined,1)],
  ['identity_audit',(store:Store)=>store.flushIdentity()],
  ['issue_events',(store:Store)=>store.flushIssues()],
] as const){
  function fixture(){
    // No connections or credentials: exercise the real delivery methods with
    // a durable-row stand-in and an independently failing exporter/ack.
    const store=Object.create(Store.prototype) as Store;
    let pending=true,failExport=false,failAck=false;
    const sent:string[]=[],acknowledged:unknown[][]=[];
    const event={event_id:'11111111-1111-4111-8111-111111111111',workspace_id:'workspace',user_id:'user',run_id:'run',issue_id:'issue',seq:'7',event_type:'verification.finished',operation:'GET /v1/issues',outcome:'ok',occurred_at:new Date('2026-10-29T10:00:00Z'),payload:{message:'one\ntwo'}};
    store.query=async(sql,values=[])=>{
      assert.ok(sql.includes(table));
      if(sql.startsWith('SELECT'))return {rows:pending?[event]:[]} as any;
      if(failAck)throw new Error('Database ack unavailable');
      acknowledged.push(values);pending=false;return {rows:[],rowCount:1} as any;
    };
    store.clickhouse=async sql=>{if(failExport)throw new Error('Exporter unavailable');sent.push(sql);return '';};
    return {store,sent,acknowledged,get pending(){return pending},failExport(value:boolean){failExport=value},failAck(value:boolean){failAck=value}};
  }
  test(`${table}: delivery retains event identity, timestamp and JSON framing`,async()=>{
    const f=fixture();assert.equal(await flush(f.store),1);assert.equal(f.pending,false);assert.equal(f.acknowledged.length,1);
    const [insert,line,...extra]=f.sent[0].split('\n');assert.equal(insert,`INSERT INTO scout.${table} FORMAT JSONEachRow`);assert.equal(extra.length,0,'Payload newlines remain JSON-escaped');
    const row=JSON.parse(line);assert.equal(row.event_id,'11111111-1111-4111-8111-111111111111');assert.equal(row.occurred_at,'2026-10-29 10:00:00.000');
    if(table!=='identity_audit')assert.deepEqual(JSON.parse(row.payload),{message:'one\ntwo'});
    assert.equal(await flush(f.store),0);assert.equal(f.sent.length,1);
  });
  test(`${table}: exporter failure leaves the durable event unacknowledged`,async()=>{
    const f=fixture();f.failExport(true);await assert.rejects(flush(f.store),/Exporter unavailable/);assert.equal(f.pending,true);assert.equal(f.acknowledged.length,0);f.failExport(false);assert.equal(await flush(f.store),1);
  });
  test(`${table}: lost acknowledgement retries identical event bytes`,async()=>{
    const f=fixture();f.failAck(true);await assert.rejects(flush(f.store),/Database ack unavailable/);assert.equal(f.pending,true);f.failAck(false);assert.equal(await flush(f.store),1);assert.equal(f.sent[0],f.sent[1]);
  });
}
