// Model usage shared by the workspace and the back office. Input and output tokens are counted
// apart and added up; cost is estimated from per-model prices in USD per million tokens.
import {number} from './format.js';

// Usage objects carry known_input_tokens, known_output_tokens and (newer servers) known_total_tokens.
// A count the provider did not report stays unknown, so a total missing some is a lower bound.
export function tokenCounts(usage={}){
  if(Number(usage.attempts)===0)return {input:0,output:0,total:0,partial:Number(usage.pending_requests)>0};
  const input=usage.known_input_tokens??null,output=usage.known_output_tokens??null;
  const total=usage.known_total_tokens??(input==null&&output==null?null:Number(input??0)+Number(output??0));
  const partial=input==null||output==null||Number(usage.incomplete_usage_attempts)>0||Number(usage.pending_requests)>0||usage.complete===false;
  return {input,output,total,partial};
}
const tokenCount=value=>value==null?'unknown':number(value);
// "1,800 in · 240 out" and "2,040" (or "≥ 2,040" while some counts are missing).
export function tokenSplit(usage){const t=tokenCounts(usage);return `${tokenCount(t.input)} in · ${tokenCount(t.output)} out`;}
export function tokenSum(usage){const t=tokenCounts(usage);return t.total==null?'Unknown':(t.partial?'≥ ':'')+number(t.total);}

// Prices are only listed when they are certain: OpenRouter's free routes cost nothing. Add a model
// here as 'provider|model': {input, output} in USD per million tokens; a saved model's own price wins.
const KNOWN_PRICES={};
export function knownPrice(provider,model){
  const id=String(model??'');
  if(provider==='openrouter'&&(id==='openrouter/free'||id.endsWith(':free')))return {input:0,output:0};
  return KNOWN_PRICES[`${provider}|${id}`]||null;
}
// The price used for a model: each of input and output from the saved model when set, else known.
export function modelPrice(provider,model,saved=[]){
  const own=(Array.isArray(saved)?saved:[]).find(m=>m?.provider===provider&&m?.model===model),known=knownPrice(provider,model);
  const side=(key,ownKey)=>Number.isFinite(own?.[ownKey])?{value:own[ownKey],source:'yours'}:known?{value:known[key],source:'known'}:{value:null,source:null};
  const input=side('input','inputUsdPerMillion'),output=side('output','outputUsdPerMillion');
  return {input:input.value,output:output.value,source:[input.source,output.source].includes('yours')?'yours':input.source&&output.source?'known':null};
}
// Estimated cost of usage.by_model: tokens times each model's price, or the cost the provider
// reported when the model has no price. Models with neither are returned as unpriced.
export function estimateCost(usage,saved){
  const rows=(usage?.by_model||[]).map(m=>{
    const price=modelPrice(m.provider,m.model,saved),tokens=tokenCounts(m);
    if(price.input!=null&&price.output!=null)return {...m,price,tokens,usd:(Number(tokens.input??0)*price.input+Number(tokens.output??0)*price.output)/1e6,basis:'price',partial:tokens.partial};
    if(m.provider_reported_cost_usd!=null&&Number.isFinite(Number(m.provider_reported_cost_usd)))return {...m,price,tokens,usd:Number(m.provider_reported_cost_usd),basis:'reported',partial:Number(m.unpriced_attempts)>0};
    return {...m,price,tokens,usd:null,basis:'none',partial:true};
  });
  const priced=rows.filter(r=>r.usd!=null);
  return {rows,usd:priced.length?priced.reduce((sum,r)=>sum+r.usd,0):rows.length?null:0,partial:rows.some(r=>r.partial)||Number(usage?.pending_requests)>0,unpriced:rows.filter(r=>r.basis==='none')};
}
// "$0.0123", "$4.20", "$0.0000080"; "≥" when some usage could not be priced or counted.
export function usd(value,partial=false){
  if(value==null)return 'Unknown';
  const amount=value===0?'0.00':value<0.0001?value.toPrecision(2):value<1?value.toFixed(4):value.toFixed(2);
  return `${partial?'≥ ':''}$${amount}`;
}
// "$0.50 in · $2.00 out per 1M tokens"
export function priceLabel(price){
  const side=value=>value==null?'no price':`$${value<0.01&&value>0?value.toPrecision(2):value.toFixed(2)}`;
  return price.input==null&&price.output==null?'No price':`${side(price.input)} in · ${side(price.output)} out per 1M tokens`;
}
