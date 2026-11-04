// Turns a failed model request already stored on a run into a sentence a person can act on.
// Kept free of browser-only asset URLs so the report exporter can import it from Node.

const PROVIDERS = {openai: 'OpenAI', anthropic: 'Anthropic', openrouter: 'OpenRouter', meta: 'Meta AI'};
const count = value => Number(value).toLocaleString('en-US');
const PURPOSES = {
  plan: 'Planning the next action',
  assessment: 'Checking the last action',
  navigation_prediction: 'Predicting a navigation',
};

function list(value) {
  return Array.isArray(value) ? value : [];
}

export function modelRequestFailure(report) {
  const stored = report?.run?.error;
  if (typeof stored !== 'string' || !/model request|incomplete_or_unsupported_output|provider_error|invalid_provider_json/i.test(stored)) return null;
  const failed = [...list(report.model_requests)].reverse().find(request => ['failed', 'interrupted', 'cancelled'].includes(request?.state) && typeof request.request_id === 'string');
  if (!failed) return null;
  const call = [...list(report.model_calls)].reverse().find(item => item?.request_id === failed.request_id);
  const event = [...list(report.events)].reverse().find(item => item?.payload?.request_id === failed.request_id && String(item.event_type || '').startsWith('model.decision_'));
  const purpose = PURPOSES[event?.payload?.kind] || 'The model request';
  const code = typeof failed.error === 'string' && failed.error ? failed.error : typeof call?.error === 'string' && call.error ? call.error : failed.state;
  const provider = PROVIDERS[failed.provider] || (typeof failed.provider === 'string' ? failed.provider : '');
  const model = provider && typeof failed.model === 'string' && failed.model ? `${provider} (${failed.model})` : provider || (typeof failed.model === 'string' ? failed.model : '');
  if(code==='demo_token_count_unavailable')return {
    title:'Exploration interrupted',
    detail:'Demo AI is temporarily unavailable. Recorded actions and findings are saved; the exploration is incomplete.',
    technicalDetail:`${purpose}${model?` with ${model}`:''} stopped before the model call was sent because its token-count check was unavailable (${code}).`,
    recoverable:true,
    requestId:failed.request_id,
  };
  const output = Number(call?.output_tokens);
  const reasoning = Number(call?.reasoning_tokens);
  const cutOff = code === 'incomplete_or_unsupported_output' && Number.isFinite(output) && output > 0 && Number.isFinite(reasoning) && reasoning > 0 && reasoning * 2 >= output;
  const title = cutOff ? 'The model answer was cut off' : failed.state === 'cancelled' ? 'The model request was cancelled' : failed.state === 'interrupted' ? 'The model request was interrupted' : 'The model request failed';
  const where = model ? `${purpose} with ${model}` : purpose;
  const cause = cutOff
    ? `stopped because the answer was incomplete (${code}). Reasoning used ${count(reasoning)} of ${count(output)} output tokens, so the visible JSON was cut off before it finished.`
    : code === 'incomplete_or_unsupported_output'
      ? `stopped because the provider returned an incomplete answer (${code}).`
      : code === 'demo_token_count_rejected'
        ? 'stopped because the demo service rejected its usage check. An administrator needs to check the provider configuration.'
        : code === 'demo_token_count_invalid'
          ? 'stopped because the demo service returned an invalid usage count. An administrator needs to check the provider response.'
          : `failed (${code}).`;
  return {
    title,
    detail: `${where} ${cause} Actions already recorded stay as they are.`,
    requestId: failed.request_id,
  };
}
