// Deterministic provider protocol fixture. No real credentials or model network calls.
import http from 'node:http';
import { explorerInput, explorerReply } from './explorer.mjs';
const credential = 'scout_fixture_credential_not_a_real_key';
const calls = [];
const counts = new Map();
const server = http.createServer(async (req, res) => {
  const send = (status, value, headers = {}) => { res.writeHead(status, { 'content-type':'application/json', ...headers }); res.end(JSON.stringify(value)); };
  if (req.url === '/health') return send(200, { ok:true });
  if (req.url === '/stats') return send(200, { calls });
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const provider = req.url.slice(1);
    const authOK = provider === 'anthropic'
      ? req.headers['x-api-key'] === credential && req.headers['anthropic-version'] === '2023-06-01'
      : req.headers.authorization === `Bearer ${credential}`;
    if (!authOK) return send(401, { error:{message:'fixture_authentication_failed'} });
    const raw = JSON.stringify(body);
    const scenario = raw.match(/case:([a-z_]+)/)?.[1] ?? 'success';
    const count = (counts.get(body.model) ?? 0) + 1;
    counts.set(body.model, count);
    calls.push({ provider, model:body.model, count, scenario, at:Date.now(), images:raw.includes('image/png'), store:body.store, stream:body.stream, max_tokens:body.max_tokens ?? body.max_output_tokens, routing:body.provider });
    if (scenario === 'hang') return; // The gateway must bound this and retain unknown usage.
    if (scenario === 'rate_limit' && count === 1) return send(429, { error:{message:'fixture rate limit'} }, {'retry-after':'1'});
    if (scenario === 'bad_retry') return send(429, { error:{message:'invalid retry header'} }, {'retry-after':'99999999'});
    if (scenario === 'payment') return send(402, { error:{message:'payment required'} });
    if (scenario === 'unavailable') return send(503, { error:{message:'provider unavailable'} });
    if (scenario === 'invalid') { res.writeHead(200); return res.end('{invalid-json'); }
    if (scenario === 'oversize') { res.writeHead(200); return res.end('x'.repeat(2 * 1024 * 1024 + 10)); }
    if (scenario === 'redirect') { res.writeHead(307, {location:'/openai'}); return res.end(); }
    if (scenario === 'partial_response') {
      res.writeHead(200, {'content-type':'application/json','content-length':10000});
      res.write('{"id":"partial-id","output":');
      return setTimeout(() => res.destroy(), 150);
    }
    const exploration = explorerInput(body, provider);
    if (exploration?.task === 'assessment' && exploration.after.url.includes('/provider-outage')) return send(503, {error:{message:'fixture assessment unavailable'}});
    const text = exploration ? JSON.stringify(explorerReply(exploration)) : scenario === 'redact' ? `Do not leak ${credential}` : 'The page is ready.';
    let value;
    if (provider === 'openai') value = { id:`response-${body.model}`, model:'fixture-openai', status:'completed', output:[{type:'message',content:[{type:'output_text',text}]}], usage:{input_tokens:16,output_tokens:5,input_tokens_details:{cached_tokens:6},output_tokens_details:{reasoning_tokens:2}} };
    if (provider === 'anthropic') value = { id:`message-${body.model}`, model:'fixture-claude', type:'message', stop_reason:'end_turn', content:[{type:'text',text}], usage:{input_tokens:10,cache_creation_input_tokens:30,cache_read_input_tokens:20,output_tokens:4} };
    if (provider === 'openrouter') value = { id:`generation-${body.model}`, model:'fixture-returned-model', provider:'fixture-provider', choices:[{message:{role:'assistant',content:text},finish_reason:'stop'}], usage:{prompt_tokens:3,completion_tokens:2,cost:0} };
    if (!value) return send(404, { error:{message:'unknown provider fixture'} });
    if (scenario === 'missing_usage') delete value.usage;
    if (scenario === 'partial_usage') value.usage = {prompt_tokens:3};
    if (scenario === 'truncated') value.status = 'incomplete';
    if (scenario === 'delayed') return setTimeout(() => send(200,value),1500);
    send(200,value);
  } catch { send(400,{error:{message:'invalid fixture request'}}); }
});
server.listen(8081,'0.0.0.0');
