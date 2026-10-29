---
{
  "title": "Connect a model provider",
  "description": "Configure OpenAI, Anthropic or OpenRouter API access, understand free-only routing, saved defaults and nullable token/cost accounting.",
  "reviewed": "2026-10-28",
  "sidebar": {
    "order": 3
  }
}
---
Scout’s model gateway supports OpenAI, Anthropic and OpenRouter using provider API keys. The key stays in the private service configuration; it is not entered in these docs or embedded in a client bundle.

## Configure provider access

Add the relevant key to your checkout’s private **.env**:

~~~dotenv
# Set only the providers you intend to use.
OPENAI_API_KEY=your-private-key
ANTHROPIC_API_KEY=your-private-key
OPENROUTER_API_KEY=your-private-key
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

In **Back office → Connections**, choose a provider, model, viewport and action budget. Defaults are append-only revisions. A newly admitted job freezes its effective settings; retries preserve the original admission.

Provider keys and allowed origins remain environment-level configuration. Saving a GUI preference does not alter either.

## OpenRouter free-only mode

When enabled, the model ID must be **openrouter/free** or end in **:free**. The gateway checks that the returned routing/pricing metadata satisfies its zero-price constraints and does not accept a paid fallback list or paid plugins.

Free-only mode applies to OpenRouter. It is normalized off for direct OpenAI/Anthropic connections.

## Usage accounting

Scout records each model request and attempt, including failed/retried attempts and late usage after cancellation. Tokens and costs come from provider-reported metadata. An absent value stays unknown rather than becoming zero.

Inspect **Back office**, the [usage API](../../api/models-usage/) or **scout_usage**. Calls may incur charges when using a paid provider; reading existing reports and progress does not request new inference.

## Subscription authentication

ChatGPT, Claude and coding-agent subscription allowances are not connected by this implementation. Use API keys. External-agent connections operate Scout with its configured provider; they do not transfer the caller’s model allowance.
