#!/usr/bin/env bash
# Exercise fresh initialization and populated-volume replay without the app stack.
set -euo pipefail
cd "$(dirname "$0")/.."

container="scout-schema-test-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --rm --name "$container" --network none \
  --tmpfs /var/lib/postgresql/data --tmpfs /docker-entrypoint-initdb.d \
  -e POSTGRES_USER=scout -e POSTGRES_DB=scout -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e 'PGOPTIONS=-c client_min_messages=warning' \
  "${SCOUT_SCHEMA_TEST_IMAGE:-scout-qa-postgres:local}" >/dev/null

ready=false
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U scout -d scout >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  docker logs "$container"
  exit 1
fi

psql_test() { docker exec -i "$container" psql -X -qAt -U scout -d scout -v ON_ERROR_STOP=1 -f -; }
apply_schemas() {
  for file in infra/postgres/*.sql; do
    echo "PostgreSQL $(basename "$file")"
    psql_test <"$file"
  done
}

apply_schemas
psql_test <<'SQL'
INSERT INTO runtime_runs(run_id,workspace_id,user_id,target_url,lifecycle,config)
VALUES ('00000000-0000-4000-8000-000000000001',gen_random_uuid(),gen_random_uuid(),'https://example.test','cancelled','{}');
INSERT INTO exploration_decisions(decision_id,run_id,request_id,kind,status,input_capture_ids)
SELECT gen_random_uuid(),run_id,gen_random_uuid(),'plan',status,'{}'::uuid[]
FROM runtime_runs CROSS JOIN unnest(ARRAY['requested','accepted','rejected','failed','interrupted','cancelled','reused']) AS status;
INSERT INTO runtime_actions(action_id,run_id,ordinal,prediction_id,spec,state)
SELECT gen_random_uuid(),run_id,1,gen_random_uuid(),'{}','cancelled' FROM runtime_runs;
INSERT INTO model_requests(request_id,workspace_id,user_id,run_id,provider,model,spec,spec_sha256,state)
SELECT gen_random_uuid(),workspace_id,user_id,run_id,'meta','fixture','{}',repeat('0',64),'cancelled' FROM runtime_runs;
INSERT INTO browser_jobs(job_id,workspace_id,user_id,request,settings,execution_mode,status,run_id)
SELECT gen_random_uuid(),workspace_id,user_id,'{}','{}','protocol_fixture','cancelled',run_id FROM runtime_runs;
SQL

snapshot() {
  psql_test <<'SQL'
SELECT jsonb_build_object(
  'runs',(SELECT jsonb_agg(r ORDER BY run_id) FROM runtime_runs r),
  'actions',(SELECT jsonb_agg(a ORDER BY action_id) FROM runtime_actions a),
  'decisions',(SELECT jsonb_agg(d ORDER BY decision_id) FROM exploration_decisions d),
  'requests',(SELECT jsonb_agg(m ORDER BY request_id) FROM model_requests m),
  'jobs',(SELECT jsonb_agg(j ORDER BY job_id) FROM browser_jobs j));
SQL
}
before=$(snapshot)
for ((pass=1; pass<=2; pass++)); do
  apply_schemas
  if [[ "$(snapshot)" != "$before" ]]; then
    echo "Schema replay changed existing evidence on pass $pass." >&2
    exit 1
  fi
done

psql_test <<'SQL'
DO $$ BEGIN
  BEGIN
    UPDATE exploration_decisions SET status='invalid';
    RAISE EXCEPTION 'Invalid decision status was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
SQL
echo "Fresh schemas and repeated bootstrap preserve reused decisions and cancelled work."
