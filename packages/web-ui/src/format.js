// Formatting and labels shared by the customer workspace and the operator back office.
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const text = value => typeof value === 'object' ? JSON.stringify(value) : String(value ?? 'Not recorded');
export const number = value => value == null ? '—' : Number(value).toLocaleString();
export function tokenTotal(usage){
  const values=[usage.known_input_tokens,usage.known_output_tokens];
  if(values.every(value=>value==null))return 'Unknown';
  const incomplete=values.some(value=>value==null)||Number(usage.incomplete_usage_attempts)>0||usage.complete===false;
  return (incomplete?'≥ ':'')+number(values.reduce((sum,value)=>sum+Number(value??0),0));
}
export function costTotal(usage){
  if(usage.provider_reported_cost_usd==null)return 'Unknown';
  return (Number(usage.unpriced_attempts)>0?'≥ ':'')+'$'+Number(usage.provider_reported_cost_usd).toFixed(4);
}
export const short = id => id ? id.slice(0,8) : '—';
export const date = value => value ? new Date(value).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
export const elapsed = (start,end) => { if(!start)return '—'; const s=Math.max(0,Math.round(((end?new Date(end):new Date())-new Date(start))/1000)); return s<60?`${s}s`:`${Math.floor(s/60)}m ${s%60}s`; };
export const name = run => { try {const u=new URL(run.target_url); return u.hostname+(u.pathname==='/'?'':u.pathname);}catch{return run.target_url||'Untitled run';} };
export const fixture = run => run.config?.training_status==='excluded_fixture';
export const MODEL_PROVIDERS=['openrouter','openai','anthropic','meta'];
export function providerName(id){return {openai:'OpenAI',anthropic:'Anthropic',openrouter:'OpenRouter',meta:'Meta AI'}[id]||id||'No provider';}
export function runStatus(run){return run.lifecycle==='active'&&run.cancel_requested_at?'cancelling':run.lifecycle;}
export function opsMode(mode){return mode==='protocol_fixture'?'Simulated':mode==='live'?'Live':'Unknown mode';}
