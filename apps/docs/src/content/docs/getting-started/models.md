---
{
  "title": "Connect a model provider",
  "description": "Configure OpenAI, Anthropic, OpenRouter or Meta AI API access, understand free-only routing, saved defaults and nullable token/cost accounting.",
  "reviewed": "2026-10-28",
  "sidebar": {
    "order": 3
  }
}
---
Scout’s model gateway supports OpenAI, Anthropic, OpenRouter and Meta AI using provider API keys. The key stays in the private service configuration; it is not entered in these docs or embedded in a client bundle.

## Configure provider access

Add the relevant key to your checkout’s private **.env**:

~~~dotenv
# Set only the providers you intend to use.
OPENAI_API_KEY=your-private-key
ANTHROPIC_API_KEY=your-private-key
OPENROUTER_API_KEY=your-private-key
META_API_KEY=your-private-key
~~~

These are placeholders. Do not commit real values. Restart the stack after adding or changing keys.

Set the initial explorer provider and a current model ID available to that account:

~~~dotenv
SCOUT_EXPLORER_PROVIDER=openrouter
SCOUT_EXPLORER_MODEL=openrouter/free
SCOUT_EXPLORER_FREE_ONLY=true
SCOUT_EXPLORER_MAX_ACTIONS=6
~~~

Provider model availability, rate limits and pricing can change. Scout checks free-only eligibility, but it cannot guarantee a provider’s free capacity or quota.

## Save nonsecret defaults

In the workspace under **Settings → Exploration defaults**, choose a provider, model, viewport and action budget. Defaults are append-only revisions. A newly admitted job freezes its effective settings; retries preserve the original admission.

Provider keys and allowed origins remain environment-level configuration. Saving a GUI preference does not alter either.

## OpenRouter free-only mode

When enabled, the model ID must be **openrouter/free** or end in **:free**. The gateway checks that the returned routing/pricing metadata satisfies its zero-price constraints and does not accept a paid fallback list or paid plugins.

Free-only mode applies to OpenRouter. It is normalized off for direct OpenAI, Anthropic and Meta AI connections.

## Meta AI

Set the explorer provider to **meta** and the model to **muse-wonder-1.0**, or another current Meta model ID. The gateway sends non-streaming [Responses API](https://dev.meta.ai/docs/protocols/responses) requests to `https://api.meta.ai/v1/responses` with bearer authentication. `META_API_KEY` is the token Meta’s docs call `MODEL_API_KEY`; an empty `META_API_KEY` falls back to `MODEL_API_KEY`. Requests set `store` to false, so prompts and screenshots are not retained by Meta. Token totals come from the response. Meta does not report a dollar price in that usage object, so cost stays unknown. Meta calls use Meta’s own API billing.

## Usage accounting

Scout records each model request and attempt, including failed/retried attempts and late usage after cancellation. Tokens and costs come from provider-reported metadata. An absent value stays unknown rather than becoming zero.

Inspect a run's model token total, the [usage API](../../api/models-usage/) or **scout_usage**. Operators can review individual attempts in the back office. Calls may incur charges when using a paid provider; reading existing reports and progress does not request new inference.

## Subscription authentication

ChatGPT, Claude and coding-agent subscription allowances are not connected by this implementation. Use API keys. External-agent connections operate Scout with its configured provider; they do not transfer the caller’s model allowance.
