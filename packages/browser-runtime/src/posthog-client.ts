import { createDecipheriv } from 'node:crypto';
import { parseSnapshots, type RecordedEvent } from './posthog-flows.js';

export type PostHogScan = {from:string;to:string;offset:number;cursor?:string};
export type PostHogConnection = { connection_id:string; workspace_id:string; user_id:string; host:string; project_id:string; source_origin:string; replay_origin:string; encrypted_key:Buffer; auto_replay:boolean; scan:PostHogScan|null; last_synced_at:Date|null };
export const configuredOrigins=(name:string)=>new Set((process.env[name]??(name==='SCOUT_POSTHOG_HOSTS'?'https://eu.posthog.com,https://us.posthog.com':'')).split(',').map(s=>s.trim()).filter(Boolean).map(s=>new URL(s).origin));
export function openPostHogKey(c:PostHogConnection,key=process.env.SCOUT_PROVIDER_VAULT_KEY??''):string {
  if(!/^[a-f\d]{64}$/i.test(key)||c.encrypted_key.length<28)throw new Error('posthog_vault_unavailable');
  const bytes=c.encrypted_key,decipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),bytes.subarray(0,12));
  decipher.setAAD(Buffer.from(JSON.stringify(['posthog-v1',c.connection_id,c.workspace_id,c.user_id])));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString();
}
export class PostHogClient {
  constructor(private connection:PostHogConnection,private key:string,private transport:typeof fetch=fetch) {
    if(!configuredOrigins('SCOUT_POSTHOG_HOSTS').has(connection.host)||!/^[\d]{1,20}$/.test(connection.project_id))throw new Error('posthog_host_not_allowed');
  }
  async request(path:string,body?:unknown):Promise<string> {
    const url=new URL(path,this.connection.host);
    if(url.origin!==this.connection.host||!url.pathname.startsWith('/api/'))throw new Error('posthog_host_not_allowed');
    const response=await this.transport(url,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${this.key}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok){await response.body?.cancel();throw new Error(response.status===429?'posthog_rate_limited':response.status===401||response.status===403?'posthog_access_denied':response.status===404?'posthog_endpoint_unavailable':'posthog_request_failed');}
    const reader=response.body?.getReader();if(!reader)throw new Error('posthog_empty_response');
    const buffers:Uint8Array[]=[];let count=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>8*1024*1024)throw new Error('posthog_response_limit');buffers.push(value);}}
    finally{await reader.cancel();}
    return Buffer.concat(buffers).toString('utf8');
  }
  async recordings(scan:PostHogScan) {
    const q=new URLSearchParams({limit:'5',offset:String(scan.offset),date_from:scan.from,date_to:scan.to});
    if(scan.cursor)q.set('after',scan.cursor);
    const result=JSON.parse(await this.request(`/api/projects/${this.connection.project_id}/session_recordings/?${q}`));
    if(!Array.isArray(result.results)||result.results.length>5)throw new Error('posthog_recording_format_unsupported');
    if(result.next_cursor&&(typeof result.next_cursor!=='string'||result.next_cursor.length>4096))throw new Error('posthog_recording_format_unsupported');
    return result as {results:any[];has_next?:boolean;next?:string|null;next_cursor?:string};
  }
  async events(sessionId:string):Promise<RecordedEvent[]> {
    if(!/^[\w-]{1,100}$/.test(sessionId))throw new Error('posthog_session_id_invalid');
    const origin=this.connection.source_origin.replaceAll("'","''");
    const query=`SELECT uuid, event, timestamp, properties FROM events WHERE properties.$session_id = '${sessionId}' AND (properties.$current_url = '${origin}' OR startsWith(properties.$current_url, '${origin}/')) ORDER BY timestamp, uuid LIMIT 501`;
    const data=JSON.parse(await this.request(`/api/projects/${this.connection.project_id}/query/`,{query:{kind:'HogQLQuery',query}}));
    if(!Array.isArray(data.results)||data.results.length>500)throw new Error('posthog_event_limit');
    const columns=['uuid','event','timestamp','properties'];
    if(data.columns&&JSON.stringify(data.columns)!==JSON.stringify(columns))throw new Error('posthog_event_format_unsupported');
    return data.results.map((row:any)=>{
      if(!Array.isArray(row)||row.length!==4)throw new Error('posthog_event_format_unsupported');
      const properties=typeof row[3]==='string'?JSON.parse(row[3]):row[3];
      if(!properties||typeof properties!=='object'||typeof row[1]!=='string'||!Number.isFinite(Date.parse(row[2])))throw new Error('posthog_event_format_unsupported');
      return {uuid:row[0],event:row[1],timestamp:row[2],properties};
    });
  }
  async analysis(now=new Date()) {
    const from=new Date(now);from.setUTCHours(0,0,0,0);from.setUTCDate(from.getUTCDate()-6);
    const literal=(value:string)=>value.replaceAll('\\','\\\\').replaceAll("'","\\'");
    const origin=literal(this.connection.source_origin);
    const date=(value:Date)=>value.toISOString().slice(0,19).replace('T',' ');
    // Every query uses the exact website origin, including in projects shared by subdomains.
    const where=`FROM events WHERE timestamp >= toDateTime('${date(from)}', 'UTC') AND timestamp < toDateTime('${date(now)}', 'UTC') AND (properties.$current_url = '${origin}' OR startsWith(properties.$current_url, '${origin}/')) AND (properties.spekios_synthetic IS NULL OR properties.spekios_synthetic != true)`;
    const query=async(sql:string,width:number,limit:number)=>{
      const data=JSON.parse(await this.request(`/api/projects/${this.connection.project_id}/query/`,{query:{kind:'HogQLQuery',query:sql}}));
      if(!Array.isArray(data.results)||data.results.length>limit||data.results.some((r:unknown)=>!Array.isArray(r)||r.length!==width))throw new Error('posthog_analysis_format_unsupported');
      return data.results as unknown[][];
    };
    const number=(value:unknown)=>{const n=Number(value);if(value===null||!Number.isSafeInteger(n)||n<0)throw new Error('posthog_analysis_format_unsupported');return n;};
    const totals=await query(`SELECT count(), uniqExact(distinct_id), uniqExactIf(properties.$session_id, properties.$session_id IS NOT NULL AND properties.$session_id != ''), countIf(event = '$pageview'), countIf(event = '$exception'), countIf(event = '$rageclick'), countIf(event = '$dead_click') ${where}`,7,1);
    if(totals.length!==1)throw new Error('posthog_analysis_format_unsupported');
    const values=totals[0].map(number);
    const daily=await query(`SELECT toString(toDate(timestamp, 'UTC')), count(), uniqExact(distinct_id) ${where} GROUP BY toDate(timestamp, 'UTC') ORDER BY toDate(timestamp, 'UTC') LIMIT 7`,3,7);
    const top=async(expression:string,filter='')=>{
      const rows=await query(`SELECT ${expression}, count() ${where} ${filter} GROUP BY ${expression} ORDER BY count() DESC, ${expression} LIMIT 10`,2,10);
      return rows.map(row=>{if(typeof row[0]!=='string'||row[0].length>2048)throw new Error('posthog_analysis_format_unsupported');return {label:row[0],count:number(row[1])};});
    };
    const events=await top('event');
    const pages=(await top('properties.$pathname',"AND event = '$pageview' AND properties.$pathname IS NOT NULL AND properties.$pathname != ''")).filter(p=>p.label.startsWith('/')&&!/[?#\r\n]/.test(p.label));
    return {from:from.toISOString(),to:now.toISOString(),totals:Object.fromEntries(['events','visitors','sessions','pageviews','exceptions','rageclicks','deadclicks'].map((k,i)=>[k,values[i]])),daily:daily.map(row=>{if(typeof row[0]!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(row[0]))throw new Error('posthog_analysis_format_unsupported');return {date:row[0],events:number(row[1]),visitors:number(row[2])};}),top_events:events,top_pages:pages};
  }
  async snapshots(sessionId:string) {
    if(!/^[\w-]{1,100}$/.test(sessionId))throw new Error('posthog_session_id_invalid');
    const base=`/api/environments/${this.connection.project_id}/session_recordings/${sessionId}/snapshots`;
    const data=JSON.parse(await this.request(base+'?blob_v2=true'));
    if(!Array.isArray(data.sources)||data.sources.length>20)throw new Error('snapshot_source_limit');
    if(!data.sources.length)throw new Error('snapshot_not_ready');
    const snapshots=[];let size=0;
    for(const source of data.sources){
      if(source.source!=='blob_v2'||!/^\d+$/.test(String(source.blob_key)))throw new Error('snapshot_source_unsupported');
      const key=String(source.blob_key);
      const text=await this.request(base+'?'+new URLSearchParams({source:'blob_v2',blob_key:key,start_blob_key:key,end_blob_key:key,decompress:'true'}));
      size+=Buffer.byteLength(text);if(size>8*1024*1024)throw new Error('snapshot_limit');
      snapshots.push(...parseSnapshots(text));
      if(snapshots.length>30000)throw new Error('snapshot_limit');
    }
    return snapshots;
  }
}
