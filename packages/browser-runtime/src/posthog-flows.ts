// Imported recordings are untrusted observations. They never become code.
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';

export type FlowStep = { action: 'navigate'|'click'|'fill'|'select'|'check'|'observe'; path?: string; selector?: string; value?: string; checked?: boolean; label: string };
export type RecordedEvent = { uuid?: string; event: string; timestamp: string; properties: Record<string, any> };
export type Snapshot = { type: number; timestamp: number; windowId: string; data: any };
export type InferredFlow = { fingerprint: string; title: string; steps: FlowStep[]; issues: string[]; executable: boolean; synthetic: boolean };
const short = (v: unknown, max=160): string => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,max) : '';
const sensitive = /password|passcode|secret|token|email|credit|card|payment|wallet|billing|phone|address|username|sign.?in|log.?in/i;
export const safeSelector = (v: unknown): v is string => typeof v==='string' && /^(?:#[a-zA-Z][\w-]{0,79}|\[data-testid="[\w-]{1,80}"\])$/.test(v);
const selectorFor = (attributes: Record<string, any> = {}): string | null => {
  const testid=attributes['data-testid'],id=attributes.id;
  if (typeof testid==='string'&&safeSelector(`[data-testid="${testid}"]`)) return `[data-testid="${testid}"]`;
  return typeof id==='string'&&safeSelector('#'+id)?'#'+id:null;
};
function pagePath(raw: unknown, origin: string): string | null {
  try {
    const url=new URL(String(raw),origin);
    // Query values may contain secrets and are not silently dropped from a test.
    return url.origin===origin&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname.length<=500 ? url.pathname : null;
  } catch { return null; }
}

// Supports PostHog blob_v2 JSONL, window envelopes and SDK gzip-compressed fields.
// Unknown encodings are surfaced rather than interpreted as an empty recording.
export function parseSnapshots(text: string): Snapshot[] {
  if (Buffer.byteLength(text)>8*1024*1024) throw new Error('snapshot_limit');
  let items: any[];
  try { const all=JSON.parse(text); items=Array.isArray(all)&&!(all.length===2&&typeof all[0]==='string')?all:[all]; }
  catch { items=text.split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line)); }
  const result:Snapshot[]=[];
  let expanded=Buffer.byteLength(text);
  const unzip=(raw:any)=>{
    if(typeof raw!=='string')return raw;
    const bytes=Buffer.from(raw,'latin1');
    const decoded=bytes[0]===0x1f&&bytes[1]===0x8b?zlib.gunzipSync(bytes,{maxOutputLength:8*1024*1024}):bytes[0]===0x28&&bytes[1]===0xb5&&typeof zlib.zstdDecompressSync==='function'?zlib.zstdDecompressSync(bytes,{maxOutputLength:8*1024*1024}):null;
    if(!decoded)throw new Error('snapshot_encoding_unsupported');
    expanded+=decoded.length;if(expanded>16*1024*1024)throw new Error('snapshot_limit');
    return JSON.parse(decoded.toString());
  };
  for (let item of items) {
    if(typeof item==='string')item=JSON.parse(item);
    if(Array.isArray(item))item={windowId:item[0],data:[item[1]]};
    if(!item||typeof item!=='object')throw new Error('snapshot_encoding_unsupported');
    const windowId=String(item.windowId??item.window_id??'default');
    for (let event of 'type' in item?[item]:item.data??[]) {
      if(!event||!Number.isFinite(event.timestamp)||!Number.isInteger(event.type))throw new Error('snapshot_encoding_unsupported');
      if(event.cv&&event.cv!=='2024-10')throw new Error('snapshot_encoding_unsupported');
      event={...event,data:event.cv&&event.type===2?unzip(event.data):event.data};
      if(event.cv&&event.type===3&&event.data?.source===0){
        event.data={...event.data};
        for(const field of ['adds','removes','texts','attributes'])event.data[field]=unzip(event.data[field])??[];
      }
      result.push({...event,windowId});
      if(result.length>30000)throw new Error('snapshot_limit');
    }
  }
  const seen=new Set<string>();
  return result.sort((a,b)=>a.timestamp-b.timestamp).filter(s=>{const key=JSON.stringify(s);if(seen.has(key))return false;seen.add(key);return true;});
}

export function inferFlow(events: RecordedEvent[], snapshots: Snapshot[], origin: string): InferredFlow {
  const steps:FlowStep[]=[],issues=new Set<string>();
  const ordered=[...events].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
  const synthetic=events.some(e=>e.properties?.spekios_synthetic===true);
  const append=(step:FlowStep)=>{
    const last=steps.at(-1);
    if(JSON.stringify(last)===JSON.stringify(step))return;
    // Input activity represents the final field value, not a series of keystrokes.
    if(last&&last.action===step.action&&last.selector===step.selector&&['fill','select','check'].includes(step.action))steps.pop();
    steps.push(step);
  };
  const navigate=(raw:unknown)=>{const path=pagePath(raw,origin);if(path!==null)append({action:'navigate',path,label:`Open ${path}`});else issues.add('Navigation needs a same-origin URL without query parameters or fragments.');};
  const action=(raw:any)=>{
    if(!raw||!['click','fill','select','check','observe'].includes(raw.action)||!safeSelector(raw.selector)){issues.add('An interaction has no supported stable selector.');return;}
    const label=short(raw.label)||raw.action;
    if(sensitive.test(raw.selector+' '+label)){issues.add('A sensitive interaction needs test data and authentication.');return;}
    const step:FlowStep={action:raw.action,selector:raw.selector,label};
    if(['fill','select','observe'].includes(raw.action)){
      if(typeof raw.value!=='string'||raw.value.length>300||/\*{3}|•{3}/.test(raw.value)){issues.add('An input or observation is masked or unavailable.');return;}
      step.value=raw.value;
    }
    if(raw.action==='check'){
      if(typeof raw.checked!=='boolean'){issues.add('Checkbox state is unavailable.');return;}
      step.checked=raw.checked;
    }
    append(step);
  };
  const custom=ordered.filter(e=>['spekios_action','spekios_checkpoint'].includes(e.event));
  if(custom.length){
    for(const event of ordered){
      if(event.event==='$pageview')navigate(event.properties.$current_url);
      if(event.event==='spekios_action')action(event.properties);
      if(event.event==='spekios_checkpoint')action({...event.properties,action:'observe'});
    }
  } else if(snapshots.some(s=>s.type===2)) {
    const windows=new Set(snapshots.map(s=>s.windowId));
    if(windows.size>1)issues.add('Multiple browser tabs need separate workflows.');
    type Node = {id:number;tagName?:string;attributes?:Record<string,any>;childNodes?:Node[];parent?:number};
    const mirror=new Map<number,Node>();
    const sourceWindows=new Map<string,boolean>();
    const add=(node:Node,parent?:number,depth=0)=>{if(depth>100||mirror.size>30000){issues.add('The recorded document exceeds the import limit.');return;}mirror.set(node.id,{...node,parent});for(const child of node.childNodes??[])add(child,node.id,depth+1);};
    const resolve=(id:number)=>{let node=mirror.get(id);for(let i=0;node&&i<12;i++,node=mirror.get(node.parent!)){if(selectorFor(node.attributes))return node;}return null;};
    for(const s of snapshots){
      const d=s.data;
      if(s.type===4){
        let sameOrigin=false;try{sameOrigin=new URL(d?.href).origin===origin;}catch{}
        sourceWindows.set(s.windowId,sameOrigin);mirror.clear();navigate(d?.href);
      }
      // Project recordings may span sibling websites. Do not retain their DOM,
      // labels or input values, even in a workflow already blocked for navigation.
      if(!sourceWindows.get(s.windowId))continue;
      if(s.type===2){mirror.clear();add(d.node);}
      if(s.type!==3||!d)continue;
      if(d.source===0){
        for(const r of d.removes??[])mirror.delete(r.id);
        for(const a of d.adds??[])add(a.node,a.parentId);
        for(const a of d.attributes??[]){const n=mirror.get(a.id);if(n)n.attributes={...n.attributes,...a.attributes};}
      }
      if(d.source===2&&d.type===2){const n=resolve(d.id);if(!n){issues.add('A recorded click has no supported stable selector.');continue;}
        action({action:'click',selector:selectorFor(n.attributes),label:short(n.attributes?.['aria-label'])||n.tagName});}
      if(d.source===5){const n=mirror.get(d.id),attrs=n?.attributes??{};
        if(!n||sensitive.test([attrs.type,attrs.name,attrs.id,attrs.autocomplete].join(' '))){issues.add('A sensitive or unknown input needs test data.');continue;}
        action({action:attrs.type==='checkbox'||attrs.type==='radio'?'check':n.tagName==='select'?'select':'fill',selector:selectorFor(attrs),value:d.text,checked:d.isChecked,label:attrs['aria-label']||attrs.name||n.tagName});}
      // Dragging, touch, custom widgets and scroll-container state are not guessed.
      if([6,7,9,12,14].includes(d.source))issues.add('This recording includes an unsupported browser interaction.');
    }
  } else {
    for(const e of ordered){
      if(e.event==='$pageview')navigate(e.properties.$current_url);
      if(e.event==='$autocapture'){
        const elements=e.properties.$elements;
        const target=Array.isArray(elements)?elements.find(n=>selectorFor(n)):null;
        if(e.properties.$event_type==='click'&&target)action({action:'click',selector:selectorFor(target),label:short(e.properties.$el_text)||'Click'});
        else issues.add('Event data describes a journey but lacks a complete interaction recording.');
      }
    }
    issues.add('Raw recording data is required to validate this inferred journey.');
  }
  if(!steps.length||steps[0].action!=='navigate')issues.add('The initial page is unavailable.');
  if(!steps.some(s=>!['navigate','observe'].includes(s.action)))issues.add('No replayable interactions were recorded.');
  if(steps.length>40)issues.add('The workflow exceeds the 40-step replay limit.');
  if(!steps.some(s=>s.action==='observe'))issues.add('No explicit outcome was captured; execution only checks that the steps can run.');
  const blockers=[...issues].filter(s=>!s.startsWith('No explicit outcome'));
  const stable=steps.map(({label,...step})=>step);
  const fingerprint=createHash('sha256').update(JSON.stringify(['posthog-flow-v1',origin,stable,[...blockers].sort()])).digest('hex');
  const names=steps.filter(s=>s.action!=='observe').slice(0,4).map(s=>s.label);
  return {fingerprint,title:short(names.join(' → '),200)||'Recorded journey',steps:steps.slice(0,40),issues:[...issues],executable:!synthetic&&!blockers.length,synthetic};
}
