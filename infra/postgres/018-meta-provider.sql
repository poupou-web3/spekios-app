-- Existing volumes keep the original provider check. Meta uses the Responses API.
ALTER TABLE model_requests DROP CONSTRAINT IF EXISTS model_requests_provider_check;
ALTER TABLE model_requests ADD CONSTRAINT model_requests_provider_check CHECK (provider IN ('openai','anthropic','openrouter','meta'));
