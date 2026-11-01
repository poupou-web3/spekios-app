import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateCost,knownPrice,modelPrice,priceLabel,tokenCounts,tokenSplit,tokenSum,usd} from '../src/usage.js';

test('input, output and total tokens stay apart, and a total missing counts is a lower bound',()=>{
  assert.deepEqual(tokenCounts({attempts:2,known_input_tokens:1800,known_output_tokens:240,known_total_tokens:2040,incomplete_usage_attempts:0}),{input:1800,output:240,total:2040,partial:false});
  assert.deepEqual(tokenCounts({attempts:2,known_input_tokens:1800,known_output_tokens:240}),{input:1800,output:240,total:2040,partial:false},'Older servers send no total.');
  assert.equal(tokenSplit({attempts:2,known_input_tokens:1800,known_output_tokens:240}),'1,800 in · 240 out');
  assert.equal(tokenSum({attempts:2,known_input_tokens:1800,known_output_tokens:240,incomplete_usage_attempts:1}),'≥ 2,040');
  assert.equal(tokenSplit({attempts:1,known_input_tokens:null,known_output_tokens:12}),'unknown in · 12 out');
  assert.equal(tokenSum({attempts:1,known_input_tokens:null,known_output_tokens:12}),'≥ 12');
  assert.equal(tokenSum({attempts:1,known_input_tokens:null,known_output_tokens:null}),'Unknown');
  assert.equal(tokenSum({attempts:0}),'0','No model calls is a known zero.');
});

test('known prices cover only certain cases; a saved model overrides input and output separately',()=>{
  assert.deepEqual(knownPrice('openrouter','openrouter/free'),{input:0,output:0});
  assert.deepEqual(knownPrice('openrouter','vendor/lite:free'),{input:0,output:0});
  assert.equal(knownPrice('openrouter','vendor/paid'),null);
  assert.equal(knownPrice('meta','muse-wonder-1.0'),null,'Unverified prices are not invented.');
  const saved=[{provider:'meta',model:'muse-spark-1.3',inputUsdPerMillion:0.5,outputUsdPerMillion:2},{provider:'openrouter',model:'vendor/lite:free',outputUsdPerMillion:1}];
  assert.deepEqual(modelPrice('meta','muse-spark-1.3',saved),{input:0.5,output:2,source:'yours'});
  assert.deepEqual(modelPrice('openrouter','vendor/lite:free',saved),{input:0,output:1,source:'yours'},'The other side keeps the known price.');
  assert.deepEqual(modelPrice('meta','muse-wonder-1.0',saved),{input:null,output:null,source:null});
  assert.equal(priceLabel({input:0.5,output:2}),'$0.50 in · $2.00 out per 1M tokens');
  assert.equal(priceLabel({input:null,output:null}),'No price');
});

test('estimated cost multiplies each model’s tokens by its price, falls back to reported cost, and lists unpriced models',()=>{
  const usage={attempts:4,pending_requests:0,by_model:[
    {provider:'meta',model:'muse-spark-1.3',attempts:2,known_input_tokens:1000000,known_output_tokens:250000,incomplete_usage_attempts:0,provider_reported_cost_usd:null,unpriced_attempts:2},
    {provider:'openrouter',model:'vendor/paid',attempts:1,known_input_tokens:300,known_output_tokens:40,incomplete_usage_attempts:0,provider_reported_cost_usd:'0.0021',unpriced_attempts:0},
    {provider:'meta',model:'muse-wonder-1.0',attempts:1,known_input_tokens:500,known_output_tokens:null,incomplete_usage_attempts:1,provider_reported_cost_usd:null,unpriced_attempts:1}]};
  const saved=[{provider:'meta',model:'muse-spark-1.3',inputUsdPerMillion:0.5,outputUsdPerMillion:2}];
  const estimate=estimateCost(usage,saved);
  assert.deepEqual(estimate.rows.map(r=>[r.model,r.basis,r.usd]),[['muse-spark-1.3','price',1],['vendor/paid','reported',0.0021],['muse-wonder-1.0','none',null]]);
  assert.equal(estimate.usd,1.0021);assert.equal(estimate.partial,true);assert.deepEqual(estimate.unpriced.map(r=>r.model),['muse-wonder-1.0']);
  assert.equal(usd(estimate.usd,estimate.partial),'≥ $1.00');
  const priced=estimateCost({...usage,by_model:usage.by_model.slice(0,1)},saved);
  assert.equal(priced.partial,false);assert.equal(usd(priced.usd),'$1.00');
  assert.equal(estimateCost({attempts:0,by_model:[]},saved).usd,0);
  assert.equal(estimateCost({attempts:1,by_model:[usage.by_model[2]]},saved).usd,null);
  assert.equal(usd(0.0123),'$0.0123');assert.equal(usd(0.0000081),'$0.0000081');assert.equal(usd(0),'$0.00');assert.equal(usd(null),'Unknown');
});
