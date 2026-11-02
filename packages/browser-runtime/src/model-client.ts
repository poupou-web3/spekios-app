import { setTimeout as delay } from 'node:timers/promises';
import { PROMPT_LIMIT_BYTES } from './model-context.js';

// Reasoning models spend part of this budget before any visible JSON. 4096 is
// the gateway maximum, so a light reasoning pass can still finish a plan.
export const MAX_OUTPUT_TOKENS = 4096;
export type ModelSettings = { provider: 'openai' | 'anthropic' | 'openrouter' | 'meta'; model: string; freeOnly: boolean; providerKeyId?:string|null };
export function modelSettings(): ModelSettings {
  const provider = process.env.SCOUT_EXPLORER_PROVIDER ?? 'openrouter';
  if (!['openai', 'anthropic', 'openrouter', 'meta'].includes(provider)) throw new Error('Unsupported explorer provider.');
  const model = process.env.SCOUT_EXPLORER_MODEL || (provider === 'openrouter' ? 'openrouter/free' : provider === 'meta' ? 'muse-wonder-1.0' : '');
  if (!model || model.length > 200 || !/^[a-zA-Z0-9._:/-]+$/.test(model)) throw new Error('Configure SCOUT_EXPLORER_MODEL for the selected provider.');
  return { provider: provider as ModelSettings['provider'], model, freeOnly: process.env.SCOUT_EXPLORER_FREE_ONLY !== 'false' };
}
export class ModelClient {
  constructor(readonly settings: ModelSettings, readonly endpoint = process.env.SCOUT_API_URL ?? 'http://api:8080',
    private readonly token = process.env.SCOUT_API_TOKEN ?? '', readonly waitMs = 90000) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || token.length < 32) throw new Error('Invalid local model gateway configuration.');
    this.endpoint = url.origin;
  }
  private async request(path: string, body?: unknown, signal?:AbortSignal) {
    const response = await fetch(this.endpoint + path, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000) });
    if (!response.ok) {
      const code=await response.json().then(body=>body?.error).catch(()=>null);
      if(code==='demo_credits_insufficient')throw new Error('Not enough demo credit for this call. Add a personal API key and choose it in Settings.');
      if(code==='provider_key_required'||code==='provider_key_unavailable')throw new Error('Choose an available personal API key in Settings.');
      throw new Error(`Model gateway returned HTTP ${response.status}.`);
    }
    return response.json();
  }
  async ready() {
    const status = await this.request('/v1/model-providers');
    if (!status.gateway_ready || !status.providers?.some((p: { provider: string; configured: boolean }) => p.provider === this.settings.provider && p.configured)) {
      throw new Error(`Configure ${this.settings.provider} on the Rust model gateway before exploring.`);
    }
    return status.test_mode ? 'protocol_fixture' as const : 'live' as const;
  }
  async complete(requestId: string, runId: string, actionId: string | null, captureIds: string[], system: string, input: unknown, signal?:AbortSignal) {
    signal?.throwIfAborted();
    const prompt = JSON.stringify(input);
    if (Buffer.byteLength(prompt) > PROMPT_LIMIT_BYTES) throw new Error('Model context exceeds the bounded prompt size.');
    const body = { request_id: requestId, run_id: runId, action_id: actionId, capture_ids: captureIds,
      provider: this.settings.provider, model: this.settings.model, free_only: this.settings.freeOnly,
      ...(this.settings.providerKeyId?{provider_key_id:this.settings.providerKeyId}:{}),
      prompt, system, max_output_tokens: MAX_OUTPUT_TOKENS, max_attempts: 1 };
    // Re-submit only the identical logical request. A lost HTTP acknowledgement
    // cannot turn into a second charge or a second model-generated action.
    try { await this.request('/v1/model-requests', body,signal); }
    catch { signal?.throwIfAborted(); await this.request('/v1/model-requests', body,signal); }
    const deadline = Date.now() + this.waitMs;
    while (Date.now() < deadline) {
      let report;
      signal?.throwIfAborted();
      try { report = await this.request('/v1/model-requests/' + requestId,undefined,signal); }
      catch { signal?.throwIfAborted();await delay(250); continue; }
      if (report.request.state === 'completed') {
        const call = report.calls.at(-1);
        if (!call || typeof call.output_text !== 'string' || call.output_text.length > 16000) throw new Error('Missing or oversized model output.');
        // No fence stripping, eval, repair prompt, or arbitrary tool execution.
        return { value: JSON.parse(call.output_text) as unknown, call_id: call.call_id as string };
      }
      if (['failed', 'interrupted','cancelled'].includes(report.request.state)) {
        const detail = typeof report.request.error === 'string' && report.request.error ? report.request.error : report.request.state;
        throw new Error(`Model request ${requestId} did not complete (${detail}).`);
      }
      await delay(200);
    }
    throw new Error('Model wait expired. The recorded request may still settle; no dependent action will execute.');
  }
}
