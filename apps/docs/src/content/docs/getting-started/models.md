---
{
  "title": "Connect a model provider",
  "description": "Configure OpenAI, Anthropic, OpenRouter or Meta AI API access, understand free-only routing, saved defaults and nullable token/cost accounting.",
  "reviewed": "2026-11-02",
  "sidebar": {
    "order": 3
  }
}
---
Spekios supports OpenAI, Anthropic, OpenRouter and Meta AI. Use the sponsored demo connection or add your own named API keys in **Settings → Models**.

## Demo credits

The **Spekios demo key** runs only **Muse Spark 1.3 Contributor**. Each account has a lifetime allowance set by the operator (default $1), with spent, reserved and remaining credit shown separately. Demo calls stop when there is not enough credit for the next call. You can add personal models and keys before or after that point; personal-key calls do not use demo credit.

Meta Contributor mode permits Meta to use submitted prompts and screenshots for training. The launch page and demo card disclose this. See [Meta’s Contributor documentation](https://dev.meta.ai/docs/pricing-rate-limits).

## Add a personal API key

1. Open **Settings → Models → Your API keys** and select **Add API key**.
2. Choose its provider, give it a name and enter the key. You can save several keys for the same provider.
3. Select the key for your account defaults, project or individual test. The first key becomes that provider’s default; you can choose another default later.

You may add a model first: if it needs a key, the named-key form opens automatically. Cancelling that form keeps the model in your draft. Keys are saved securely and never shown again, included in prompts or placed in browser storage. Removing a key stops future calls through it; it never silently switches to another paid connection.

Self-hosted operators can still configure environment keys for local/operator work. Those credentials are not a fallback for hosted users. The separate provider-vault encryption key is generated once during setup/deployment and must be preserved across releases.

## Save nonsecret defaults

In the workspace, open **Settings → Models**. Under **Your models**, pick a listed model or type another model ID. Listed models already have a name and a standard price: Meta AI (including Muse Spark), Claude and ChatGPT on their own providers, and those same models plus DeepSeek, Mistral and GLM on OpenRouter. Then choose the **Exploration model** and an optional cheaper **Navigation model** from that list and select **Save defaults**. Choose an **API key** independently of each model. A missing or removed key prevents new tests until you select a usable connection. Viewport, strategy and limits are under **Settings → Exploration** and **Settings → Limits**.

Defaults are append-only revisions. A newly admitted job freezes its effective settings; retries preserve the original admission. Your model list is saved with the defaults, but jobs do not freeze it.

## Choose a model per project or per run

A run uses, in order of precedence:

1. **The model chosen for that run.** In the workspace, open the options under the URL field and pick a **Model**. Agents and the API send `model` with the job: `{"provider": "anthropic", "model": "claude-sonnet-5-5"}`, optionally with `free_only` and `navigation_model`. Run again and Continue keep a run's own choice.
2. **Its project's model.** Under **Settings → Models → Project models**, create a named project and choose its model and API key. Its ID is generated automatically and is available under **Agent project ID** when connecting an agent. A test started in the workspace can pick that project under its options.
3. **The exploration model** in **Models in use**.

The job records where its model came from in `settings.modelSource` (`run`, `project` or `default`), and the run page says so next to the model. Limit overrides for a model match the model the run ends up using. **GET /v1/projects**, **scout_list_projects** and **scout_get_project** show the model and limits a new run in each project would use, so agents can look up project IDs before starting work.

Free-only stays on for a project or run choice unless it picks a paid OpenRouter model, and when **Restrict OpenRouter to free model IDs** is on the workspace only offers free OpenRouter models there. A free-only choice never inherits a paid OpenRouter navigation model; the run uses one model instead.

Preferences select saved keys by opaque reference. Key values are managed separately; allowed origins remain operator configuration.

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
