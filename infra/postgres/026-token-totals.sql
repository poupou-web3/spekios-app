-- Usage keeps input and output tokens apart and adds their total, overall and
-- per provider and model, so cost can be estimated from per-model prices.
-- Unknown counts stay null: a total covers only the tokens providers reported.
CREATE OR REPLACE FUNCTION scout_run_usage(id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('run_id',id,'attempts',count(*),'known_input_tokens',sum(c.input_tokens),'known_output_tokens',sum(c.output_tokens),
 'known_total_tokens',CASE WHEN count(c.input_tokens)+count(c.output_tokens)>0 THEN coalesce(sum(c.input_tokens),0)+coalesce(sum(c.output_tokens),0) END,
 'incomplete_usage_attempts',count(*) FILTER(WHERE c.usage_status<>'reported'),'provider_reported_cost_usd',sum(c.cost_usd)::text,
 'unpriced_attempts',count(*) FILTER(WHERE c.cost_usd IS NULL),'pending_requests',(SELECT count(*) FROM model_requests WHERE run_id=id AND state IN ('queued','preparing','dispatched')),
 'by_model',COALESCE((SELECT jsonb_agg(to_jsonb(u) ORDER BY u.provider,u.model) FROM (SELECT m.provider,m.model,count(*) AS attempts,sum(c.input_tokens) AS known_input_tokens,sum(c.output_tokens) AS known_output_tokens,CASE WHEN count(c.input_tokens)+count(c.output_tokens)>0 THEN coalesce(sum(c.input_tokens),0)+coalesce(sum(c.output_tokens),0) END AS known_total_tokens,count(*) FILTER (WHERE c.usage_status<>'reported') AS incomplete_usage_attempts,sum(c.cost_usd)::text AS provider_reported_cost_usd,count(*) FILTER (WHERE c.cost_usd IS NULL) AS unpriced_attempts FROM model_calls c JOIN model_requests m USING(request_id) WHERE m.run_id=id GROUP BY m.provider,m.model) u),'[]'::jsonb))
 FROM model_calls c JOIN model_requests m USING(request_id) WHERE m.run_id=id
$$;
