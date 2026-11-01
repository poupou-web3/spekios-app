---
{
  "title": "Connect a model provider",
  "description": "Configure OpenAI, Anthropic, OpenRouter or Meta AI API access, understand free-only routing, saved defaults and nullable token/cost accounting.",
  "reviewed": "2026-11-01",
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

In the workspace, open **Settings → Models**. Under **Your models**, pick a listed model or type another model ID. Listed models already have a name and a standard price: Meta AI (including Muse Spark), Claude and ChatGPT on their own providers, and those same models plus DeepSeek, Mistral and GLM on OpenRouter. Then choose the **Exploration model** and an optional cheaper **Navigation model** from that list and select **Save defaults**. Models whose provider has no key on this server are marked **Not configured**. Viewport, strategy and limits are under **Settings → Exploration** and **Settings → Limits**.

Defaults are append-only revisions. A newly admitted job freezes its effective settings; retries preserve the original admission. Your model list is saved with the defaults, but jobs do not freeze it.

## Choose a model per project or per run

A run uses, in order of precedence:

1. **The model chosen for that run.** In the workspace, open the options under the URL field and pick a **Model**. Agents and the API send `model` with the job: `{"provider": "anthropic", "model": "claude-sonnet-5-5"}`, optionally with `free_only` and `navigation_model`. Run again and Continue keep a run's own choice.
2. **Its project's model.** Under **Settings → Models → Project models**, give a project ID (the UUID agents send as `project_id`) a name, an exploration model and a navigation model from your list. A test started in the workspace can pick that project under its options.
3. **The exploration model** in **Models in use**.

The job records where its model came from in `settings.modelSource` (`run`, `project` or `default`), and the run page says so next to the model. Limit overrides for a model match the model the run ends up using. **GET /v1/projects**, **scout_list_projects** and **scout_get_project** show the model and limits a new run in each project would use, so agents can look up project IDs before starting work.

Free-only stays on for a project or run choice unless it picks a paid OpenRouter model, and when **Restrict OpenRouter to free model IDs** is on the workspace only offers free OpenRouter models there. A free-only choice never inherits a paid OpenRouter navigation model; the run uses one model instead.

Provider keys and allowed origins remain environment-level configuration. Saving a GUI preference does not alter either.

## OpenRouter free-only mode

When enabled, the model ID must be **openrouter/free** or end in **:free**. The gateway checks that the returned routing/pricing metadata satisfies its zero-price constraints and does not accept a paid fallback list or paid plugins.

Free-only mode applies to OpenRouter. It is normalized off for direct OpenAI, Anthropic and Meta AI connections.

## Meta AI

Set the explorer provider to **meta** and the model to **muse-wonder-1.0**, or another current Meta model ID. The gateway sends non-streaming [Responses API](https://dev.meta.ai/docs/protocols/responses) requests to `https://api.meta.ai/v1/responses` with bearer authentication. `META_API_KEY` is the token Meta’s docs call `MODEL_API_KEY`; an empty `META_API_KEY` falls back to `MODEL_API_KEY`. Requests set `store` to false, so prompts and screenshots are not retained by Meta. They also set `reasoning.effort` to `low`: Muse Wonder's reasoning tokens come out of the same `max_output_tokens` budget as the JSON answer, and a deeper pass can truncate that answer. Token totals come from the response. Meta does not report a dollar price in that usage object. A listed Meta model still has a standard price in Settings, which the workspace uses to estimate cost. Meta calls use Meta’s own API billing.

## Usage accounting

Scout records each model request and attempt, including failed/retried attempts and late usage after cancellation. Tokens and costs come from provider-reported metadata. An absent value stays unknown rather than becoming zero.

Each run shows input, output and total tokens, overall and for each model it used. Inspect them on the run page, in the run list, the [usage API](../../api/models-usage/) or **scout_usage**.

## Estimate cost

Under **Settings → Models → Your models**, each model has an input and an output price in US dollars per million tokens. Listed models and OpenRouter's free routes (`openrouter/free` and IDs ending in `:free`) have a known price: the vendor's standard list rate for a direct connection, or the prompt and completion rate OpenRouter publishes for that model ID. Any other model starts without a price until you enter one. A price you enter replaces the known one for that model. Some models charge more for a very long prompt, and DeepSeek's published rate is higher at peak hours; the known price is the standard rate.

The run page and run list estimate cost as each model's input tokens times its input price plus its output tokens times its output price. A model with no price uses the cost the provider reported, if any (OpenRouter reports one); otherwise the run page names it as having no price. Select **Estimated cost**, or **Add a price** in the run's **Model usage** table, to open that model's price in Settings; a model that is not in your list yet opens the add form filled in with it. Estimates use your current prices, so changing a price updates earlier runs too. They are estimates, not a bill.
 Operators can review individual attempts in the back office. Calls may incur charges when using a paid provider; reading existing reports and progress does not request new inference.

## Subscription authentication

ChatGPT, Claude and coding-agent subscription allowances are not connected by this implementation. Use API keys. External-agent connections operate Scout with its configured provider; they do not transfer the caller’s model allowance.
