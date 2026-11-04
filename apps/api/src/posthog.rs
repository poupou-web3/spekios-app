//! Scoped Cloud connector control plane. Keys are checked before encrypted storage.
use crate::{error, identity::ScopedState, provider_access::Vault};
use axum::{
    Json,
    extract::Path,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

type Result<T> = std::result::Result<T, &'static str>;

fn origin(raw: &str) -> Result<String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "invalid_posthog_origin")?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port() == Some(0)
    {
        return Err("invalid_posthog_origin");
    }
    Ok(url.origin().ascii_serialization())
}
fn allowed(name: &str) -> Vec<String> {
    std::env::var(name)
        .unwrap_or_else(|_| {
            if name == "SCOUT_POSTHOG_HOSTS" {
                "https://eu.posthog.com,https://us.posthog.com".into()
            } else {
                String::new()
            }
        })
        .split(',')
        .filter_map(|s| origin(s.trim()).ok())
        .collect()
}
fn response(result: Result<Value>) -> Response {
    match result {
        Ok(v) => Json(v).into_response(),
        Err(code) => error(
            match code {
                "posthog_connection_not_found" | "posthog_workflow_not_found" => {
                    StatusCode::NOT_FOUND
                }
                "database_unavailable" | "posthog_vault_not_configured" => {
                    StatusCode::SERVICE_UNAVAILABLE
                }
                "workspace_manager_required" => StatusCode::FORBIDDEN,
                "posthog_connection_exists" | "posthog_replay_already_queued" => {
                    StatusCode::CONFLICT
                }
                _ => StatusCode::BAD_REQUEST,
            },
            code,
        ),
    }
}
fn manager(state: &crate::AppState) -> Result<()> {
    if !state.principal.is_manager() {
        return Err("workspace_manager_required");
    }
    Ok(())
}

pub async fn list(ScopedState(state): ScopedState, Path(source): Path<String>) -> Response {
    response(async {
        manager(&state)?;
        let source=origin(&source)?;
        let db = state.database.as_ref().ok_or("database_unavailable")?.read().await?;
        let p = &state.principal;
        let rows = db.query("SELECT jsonb_build_object('connection_id',c.connection_id,'name',name,'host',host,'project_id',project_id,'source_origin',source_origin,'replay_origin',replay_origin,'enabled',enabled,'auto_replay',auto_replay,'last_synced_at',last_synced_at,'syncing',scan IS NOT NULL,'error',error,'sessions',(SELECT count(*) FROM posthog_sessions s WHERE s.connection_id=c.connection_id),'workflows',(SELECT count(*) FROM posthog_workflows f WHERE f.connection_id=c.connection_id)) FROM posthog_connections c WHERE workspace_id=$1 AND user_id=$2 AND source_origin=$3 ORDER BY created_at DESC LIMIT 20", &[&p.workspace_id,&p.user_id,&source]).await.map_err(|_| "database_unavailable")?;
        Ok(json!({"connections":rows.iter().map(|r|r.get::<_,Value>(0)).collect::<Vec<_>>(),
            "source_origin":source,"allowed_hosts":allowed("SCOUT_POSTHOG_HOSTS"),"replay_origins":allowed("SCOUT_POSTHOG_REPLAY_ORIGINS"),
            "worker_ready":db.query_one("SELECT EXISTS(SELECT 1 FROM posthog_worker_status WHERE heartbeat_at>now()-interval '90 seconds')", &[]).await.map_err(|_| "database_unavailable")?.get::<_,bool>(0),
            "vault_ready":Vault::from_env().ok().flatten().is_some()}))
    }.await)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewConnection {
    name: String,
    host: String,
    project_id: String,
    source_origin: String,
    replay_origin: Option<String>,
    api_key: String,
    #[serde(default)]
    auto_replay: bool,
}
impl NewConnection {
    fn validate(&self, hosts: &[String], replays: &[String]) -> Result<(String, String)> {
        if self.api_key.starts_with("phc_") {
            return Err("posthog_private_key_required");
        }
        let host = origin(&self.host)?;
        let source = origin(&self.source_origin)?;
        if !hosts.contains(&host) {
            return Err("posthog_host_not_allowed");
        }
        let replay = self
            .replay_origin
            .as_deref()
            .map(origin)
            .transpose()?
            .unwrap_or_else(|| source.clone());
        if self.auto_replay && !replays.contains(&replay) {
            return Err("posthog_replay_origin_not_allowed");
        }
        if self.name.trim().is_empty()
            || self.name.len() > 60
            || self.name.chars().any(char::is_control)
            || self.project_id.len() > 20
            || self.project_id.is_empty()
            || !self.project_id.bytes().all(|b| b.is_ascii_digit())
            || !(8..=4096).contains(&self.api_key.len())
            || !self.api_key.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err("invalid_posthog_connection");
        }
        Ok((host, source))
    }
}
pub async fn create(
    ScopedState(state): ScopedState,
    Path(source): Path<String>,
    Json(input): Json<NewConnection>,
) -> Response {
    response(
        async {
            manager(&state)?;
            if origin(&source)? != origin(&input.source_origin)? {
                return Err("posthog_project_origin_mismatch");
            }
            let (host, _) = input.validate(
                &allowed("SCOUT_POSTHOG_HOSTS"),
                &allowed("SCOUT_POSTHOG_REPLAY_ORIGINS"),
            )?;
            // Fail before any network request when secure storage is unavailable.
            Vault::from_env()?.ok_or("posthog_vault_not_configured")?;
            verify_credentials(&host, &input.project_id, &input.api_key).await?;
            save_connection(&state, input).await
        }
        .await,
    )
}

async fn verify_credentials(host: &str, project: &str, key: &str) -> Result<()> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "posthog_request_failed")?;
    async fn read(request: reqwest::RequestBuilder) -> Result<Value> {
        let mut response = request.send().await.map_err(|_| "posthog_request_failed")?;
        if !response.status().is_success() {
            return Err(match response.status().as_u16() {
                401 | 403 => "posthog_access_denied",
                404 => "posthog_endpoint_unavailable",
                429 => "posthog_rate_limited",
                _ => "posthog_request_failed",
            });
        }
        let mut data = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "posthog_request_failed")?
        {
            if data.len() + chunk.len() > 1024 * 1024 {
                return Err("posthog_response_limit");
            }
            data.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&data).map_err(|_| "posthog_response_invalid")
    }
    // These probes require only the same two read scopes used by background imports.
    let query = read(
        client
            .post(format!("{host}/api/projects/{project}/query/"))
            .bearer_auth(key)
            .json(&json!({"query":{"kind":"HogQLQuery","query":"SELECT 1 FROM events LIMIT 1"}})),
    );
    let recordings = read(
        client
            .get(format!(
                "{host}/api/projects/{project}/session_recordings/?limit=1"
            ))
            .bearer_auth(key),
    );
    let (query, recordings) = tokio::try_join!(query, recordings)?;
    if !query["results"].is_array() || !recordings["results"].is_array() {
        return Err("posthog_response_invalid");
    }
    Ok(())
}

async fn save_connection(state: &crate::AppState, input: NewConnection) -> Result<Value> {
    manager(&state)?;
    let (host, source) = input.validate(
        &allowed("SCOUT_POSTHOG_HOSTS"),
        &allowed("SCOUT_POSTHOG_REPLAY_ORIGINS"),
    )?;
    let replay_origin = input
        .replay_origin
        .as_deref()
        .map(origin)
        .transpose()?
        .unwrap_or_else(|| source.clone());
    let vault = Vault::from_env()?.ok_or("posthog_vault_not_configured")?;
    let db = state
        .database
        .as_ref()
        .ok_or("database_unavailable")?
        .write()
        .await?;
    let p = &state.principal;
    let id = Uuid::new_v4();
    let binding = json!(["posthog-v1", id, p.workspace_id, p.user_id]).to_string();
    let encrypted = vault.seal(&input.api_key, &binding)?;
    // Serialize admission per owner, bounding connection count under concurrent requests.
    let mut db = db;
    let tx = db.transaction().await.map_err(|_| "database_unavailable")?;
    tx.query_one(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        &[&format!("posthog-owner:{}:{}", p.workspace_id, p.user_id)],
    )
    .await
    .map_err(|_| "database_unavailable")?;
    let count: i64 = tx
        .query_one(
            "SELECT count(*) FROM posthog_connections WHERE workspace_id=$1 AND user_id=$2",
            &[&p.workspace_id, &p.user_id],
        )
        .await
        .map_err(|_| "database_unavailable")?
        .get(0);
    if count >= 20 {
        return Err("posthog_connection_limit");
    }
    let inserted=tx.execute("INSERT INTO posthog_connections(connection_id,workspace_id,user_id,name,host,project_id,source_origin,replay_origin,encrypted_key,auto_replay) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(workspace_id,user_id,host,project_id,source_origin) DO NOTHING",&[&id,&p.workspace_id,&p.user_id,&input.name.trim(),&host,&input.project_id,&source,&replay_origin,&encrypted,&input.auto_replay]).await.map_err(|_| "database_unavailable")?;
    if inserted == 0 {
        return Err("posthog_connection_exists");
    }
    tx.commit().await.map_err(|_| "database_unavailable")?;
    Ok(json!({"connection_id":id,"status":"queued"}))
}

pub async fn detail(
    ScopedState(state): ScopedState,
    Path((source, id)): Path<(String, Uuid)>,
) -> Response {
    response(async {
        manager(&state)?;
        let source=origin(&source)?;
        let db=state.database.as_ref().ok_or("database_unavailable")?.read().await?;
        let p=&state.principal;
        let r=db.query_opt("SELECT jsonb_build_object('workflows',COALESCE((SELECT jsonb_agg(item) FROM (SELECT jsonb_build_object('workflow_id',f.workflow_id,'title',title,'steps',steps,'issues',issues,'executable',executable,'sessions',(SELECT count(*) FROM posthog_sessions s WHERE s.workflow_id=f.workflow_id),'closed_sessions',(SELECT count(*) FROM posthog_sessions s WHERE s.workflow_id=f.workflow_id AND NOT ongoing),'updated_at',updated_at) item FROM posthog_workflows f WHERE connection_id=c.connection_id ORDER BY updated_at DESC LIMIT 30) fs),'[]'::jsonb),'sessions',COALESCE((SELECT jsonb_agg(item) FROM (SELECT to_jsonb(s)-'connection_id' item FROM posthog_sessions s WHERE connection_id=c.connection_id ORDER BY started_at DESC LIMIT 30) ss),'[]'::jsonb),'replays',COALESCE((SELECT jsonb_agg(item) FROM (SELECT to_jsonb(r)-'steps'-'connection_id' item FROM posthog_replays r WHERE connection_id=c.connection_id ORDER BY created_at DESC LIMIT 20) rs),'[]'::jsonb),'analysis',analysis,'analysis_updated_at',analysis_updated_at,'analysis_error',analysis_error,'limit',30) FROM posthog_connections c WHERE connection_id=$1 AND workspace_id=$2 AND user_id=$3 AND source_origin=$4",&[&id,&p.workspace_id,&p.user_id,&source]).await.map_err(|_| "database_unavailable")?.ok_or("posthog_connection_not_found")?;
        Ok(r.get(0))
    }.await)
}

pub async fn action(
    ScopedState(state): ScopedState,
    Path((source, id, action)): Path<(String, Uuid, String)>,
) -> Response {
    response(async {
        manager(&state)?;
        let source=origin(&source)?;
        let db=state.database.as_ref().ok_or("database_unavailable")?.write().await?;
        let p=&state.principal;
        let sql=match action.as_str() {
            "sync"=>"UPDATE posthog_connections SET enabled=true,next_sync_at=now(),next_analysis_at=now(),error=NULL WHERE connection_id=$1 AND workspace_id=$2 AND user_id=$3 AND source_origin=$4",
            "pause"=>"UPDATE posthog_connections SET enabled=false WHERE connection_id=$1 AND workspace_id=$2 AND user_id=$3 AND source_origin=$4",
            "remove"=>"DELETE FROM posthog_connections WHERE connection_id=$1 AND workspace_id=$2 AND user_id=$3 AND source_origin=$4",
            _=>return Err("invalid_posthog_action"),
        };
        if db.execute(sql,&[&id,&p.workspace_id,&p.user_id,&source]).await.map_err(|_| "database_unavailable")?==0 { return Err("posthog_connection_not_found"); }
        Ok(json!({"status":action}))
    }.await)
}

pub async fn replay(
    ScopedState(state): ScopedState,
    Path((source, connection, id)): Path<(String, Uuid, Uuid)>,
) -> Response {
    response(async {
        manager(&state)?;
        let source=origin(&source)?;
        let db=state.database.as_ref().ok_or("database_unavailable")?.write().await?;
        let p=&state.principal;
        let r=db.query_opt("SELECT f.steps,f.executable,c.replay_origin,c.enabled FROM posthog_workflows f JOIN posthog_connections c USING(connection_id) WHERE f.workflow_id=$1 AND c.connection_id=$2 AND workspace_id=$3 AND user_id=$4 AND source_origin=$5",&[&id,&connection,&p.workspace_id,&p.user_id,&source]).await.map_err(|_| "database_unavailable")?.ok_or("posthog_workflow_not_found")?;
        if !r.get::<_,bool>(1) || !r.get::<_,bool>(3) { return Err("posthog_workflow_not_executable"); }
        if !allowed("SCOUT_POSTHOG_REPLAY_ORIGINS").contains(&r.get::<_,String>(2)) { return Err("posthog_replay_origin_not_allowed"); }
        let replay=Uuid::new_v4();
        let count=db.execute("INSERT INTO posthog_replays(replay_id,connection_id,workflow_id,steps) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",&[&replay,&connection,&id,&r.get::<_,Value>(0)]).await.map_err(|_| "database_unavailable")?;
        if count==0 {return Err("posthog_replay_already_queued");}
        Ok(json!({"replay_id":replay,"status":"queued"}))
    }.await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn credentials_require_both_read_apis_and_never_return_upstream_errors() {
        use axum::{
            Router,
            routing::{get, post},
        };
        let app = Router::new()
            .route(
                "/api/projects/1/query/",
                post(|| async { Json(json!({"results":[]})) }),
            )
            .route(
                "/api/projects/1/session_recordings/",
                get(|| async { Json(json!({"results":[]})) }),
            )
            .route(
                "/api/projects/2/query/",
                post(|| async { Json(json!({"results":[]})) }),
            )
            .route(
                "/api/projects/2/session_recordings/",
                get(|| async {
                    (
                        StatusCode::FORBIDDEN,
                        "private upstream error with phx-secret",
                    )
                }),
            )
            .route(
                "/api/projects/3/query/",
                post(|| async { Json(json!({"error":"not a query result"})) }),
            )
            .route(
                "/api/projects/3/session_recordings/",
                get(|| async { Json(json!({"results":[]})) }),
            )
            .route(
                "/api/projects/4/query/",
                post(|| async { axum::response::Redirect::temporary("/api/projects/1/query/") }),
            )
            .route(
                "/api/projects/4/session_recordings/",
                get(|| async { Json(json!({"results":[]})) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        assert_eq!(verify_credentials(&host, "1", "phx-fixture").await, Ok(()));
        assert_eq!(
            verify_credentials(&host, "2", "phx-fixture").await,
            Err("posthog_access_denied")
        );
        assert_eq!(
            verify_credentials(&host, "3", "phx-fixture").await,
            Err("posthog_response_invalid")
        );
        assert_eq!(
            verify_credentials(&host, "4", "phx-fixture").await,
            Err("posthog_request_failed")
        );
        server.abort();
    }

    #[tokio::test]
    async fn connector_routes_require_authentication_and_manager_scope() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let state = crate::AppState::new(None, &"x".repeat(40)).unwrap();
        for (method, path) in [
            (
                "GET",
                "/v1/websites/http%3A%2F%2Frecorded.invalid/posthog/connections",
            ),
            (
                "POST",
                "/v1/websites/http%3A%2F%2Frecorded.invalid/posthog/connections",
            ),
            (
                "GET",
                "/v1/websites/http%3A%2F%2Frecorded.invalid/posthog/connections/11111111-1111-4111-8111-111111111111",
            ),
            (
                "POST",
                "/v1/websites/http%3A%2F%2Frecorded.invalid/posthog/connections/11111111-1111-4111-8111-111111111111/sync",
            ),
        ] {
            let response = crate::router(state.clone())
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        let mut agent = state;
        agent.principal.agent_id = Some(Uuid::new_v4());
        agent.principal.operator = false;
        assert!(manager(&agent).is_err());
        for method in ["GET", "POST"] {
            assert!(!crate::identity::permitted(
                &agent.principal,
                method,
                "/v1/websites/http%3A%2F%2Frecorded.invalid/posthog/connections"
            ));
        }
    }

    #[tokio::test]
    #[ignore = "requires disposable PostgreSQL; SPEKIOS_POSTHOG_TEST_DB=1"]
    async fn postgres_connections_are_scoped_encrypted_and_replays_are_durable() {
        use std::sync::Arc;
        assert_eq!(std::env::var("SPEKIOS_POSTHOG_TEST_DB").as_deref(), Ok("1"));
        let pool = Arc::new(crate::db::Postgres::connect().await.unwrap());
        let db = pool.write().await.unwrap();
        db.batch_execute("CREATE TABLE IF NOT EXISTS workspaces(workspace_id uuid PRIMARY KEY,owner_user_id uuid NOT NULL,name text NOT NULL)").await.unwrap();
        for _ in 0..2 {
            db.batch_execute(include_str!("../../../infra/postgres/031-posthog.sql"))
                .await
                .unwrap();
        }
        let a = crate::identity::Principal {
            workspace_id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            ..Default::default()
        };
        let b = crate::identity::Principal {
            workspace_id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            ..Default::default()
        };
        for p in [&a, &b] {
            db.execute("INSERT INTO workspaces(workspace_id,owner_user_id,name) VALUES($1,$2,'PostHog integration test')",&[&p.workspace_id,&p.user_id]).await.unwrap();
        }
        let state = crate::AppState::new(Some(pool.clone()), &"x".repeat(40)).unwrap();
        let owner = state.scoped(a.clone());
        let other = state.scoped(b);
        let input = NewConnection {
            name: "Demo".into(),
            host: "http://posthog.invalid".into(),
            project_id: "1".into(),
            source_origin: "http://recorded.invalid".into(),
            replay_origin: Some("http://demo.invalid".into()),
            api_key: "phx-private-test-only".into(),
            auto_replay: true,
        };
        async fn body(response: Response) -> Value {
            serde_json::from_slice(
                &axum::body::to_bytes(response.into_body(), 1024 * 1024)
                    .await
                    .unwrap(),
            )
            .unwrap()
        }
        let created = response(save_connection(&owner, input).await);
        assert_eq!(created.status(), StatusCode::OK);
        let id = body(created).await["connection_id"]
            .as_str()
            .unwrap()
            .parse::<Uuid>()
            .unwrap();
        let row = db
            .query_one(
                "SELECT encrypted_key FROM posthog_connections WHERE connection_id=$1",
                &[&id],
            )
            .await
            .unwrap();
        let vault = Vault::from_env().unwrap().unwrap();
        let binding = json!(["posthog-v1", id, a.workspace_id, a.user_id]).to_string();
        assert_eq!(
            vault.open(&row.get::<_, Vec<u8>>(0), &binding).unwrap(),
            "phx-private-test-only"
        );
        let listed = body(
            list(
                ScopedState(owner.clone()),
                Path("http://recorded.invalid".into()),
            )
            .await,
        )
        .await;
        assert_eq!(listed["connections"].as_array().unwrap().len(), 1);
        assert!(!listed.to_string().contains("phx-private"));
        assert!(!listed.to_string().contains("encrypted_key"));
        // Even the same owner cannot use a connection through a sibling project's route.
        assert_eq!(
            body(
                list(
                    ScopedState(owner.clone()),
                    Path("http://sibling.invalid".into())
                )
                .await
            )
            .await["connections"],
            json!([])
        );
        assert_eq!(
            detail(
                ScopedState(owner.clone()),
                Path(("http://sibling.invalid".into(), id))
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            action(
                ScopedState(owner.clone()),
                Path(("http://sibling.invalid".into(), id, "pause".into()))
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        let mismatch = NewConnection {
            name: "Wrong project".into(),
            host: "http://posthog.invalid".into(),
            project_id: "1".into(),
            source_origin: "http://recorded.invalid".into(),
            replay_origin: None,
            api_key: "phx-fixture".into(),
            auto_replay: false,
        };
        let rejected = body(
            create(
                ScopedState(owner.clone()),
                Path("http://sibling.invalid".into()),
                Json(mismatch),
            )
            .await,
        )
        .await;
        assert_eq!(rejected["error"], "posthog_project_origin_mismatch");
        assert_eq!(
            body(
                list(
                    ScopedState(other.clone()),
                    Path("http://recorded.invalid".into())
                )
                .await
            )
            .await["connections"],
            json!([])
        );
        assert_eq!(
            detail(
                ScopedState(other.clone()),
                Path(("http://recorded.invalid".into(), id))
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        let flow = Uuid::new_v4();
        db.execute("INSERT INTO posthog_workflows(workflow_id,connection_id,fingerprint,title,steps,issues,executable) VALUES($1,$2,'fixture','Fixture','[]','[]',true)",&[&flow,&id]).await.unwrap();
        assert_eq!(
            replay(
                ScopedState(owner.clone()),
                Path(("http://sibling.invalid".into(), id, flow))
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            replay(
                ScopedState(other.clone()),
                Path(("http://recorded.invalid".into(), id, flow))
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            replay(
                ScopedState(owner.clone()),
                Path(("http://recorded.invalid".into(), id, flow))
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            replay(
                ScopedState(owner.clone()),
                Path(("http://recorded.invalid".into(), id, flow))
            )
            .await
            .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            action(
                ScopedState(other),
                Path(("http://recorded.invalid".into(), id, "remove".into()))
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            action(
                ScopedState(owner.clone()),
                Path(("http://recorded.invalid".into(), id, "pause".into()))
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            replay(
                ScopedState(owner.clone()),
                Path(("http://recorded.invalid".into(), id, flow))
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            action(
                ScopedState(owner),
                Path(("http://recorded.invalid".into(), id, "remove".into()))
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            db.query_one(
                "SELECT count(*) FROM posthog_replays WHERE connection_id=$1",
                &[&id]
            )
            .await
            .unwrap()
            .get::<_, i64>(0),
            0
        );
    }
    #[test]
    fn origins_are_exact_and_never_accept_credentials_or_paths() {
        for raw in [
            "https://a.test/path",
            "https://user:secret@a.test",
            "https://a.test?x=y",
            "file:///tmp",
            "https://a.test/#x",
        ] {
            assert!(origin(raw).is_err(), "{raw}");
        }
        assert_eq!(
            origin("http://localhost:18190/").unwrap(),
            "http://localhost:18190"
        );
        let mut c = NewConnection {
            name: "Demo".into(),
            host: "https://ph.test".into(),
            project_id: "1".into(),
            source_origin: "https://demo.test".into(),
            replay_origin: None,
            api_key: "phx-test-key".into(),
            auto_replay: false,
        };
        assert!(c.validate(&[], &[]).is_err());
        let hosts = vec!["https://ph.test".into()];
        assert!(c.validate(&hosts, &[]).is_ok());
        c.api_key = "phc_public_capture_token".into();
        assert_eq!(c.validate(&hosts, &[]), Err("posthog_private_key_required"));
        c.api_key = "phx-fixture-key".into();
        c.auto_replay = true;
        assert!(c.validate(&hosts, &[]).is_err());
        assert!(c.validate(&hosts, &["https://demo.test".into()]).is_ok());
        c.project_id = "1/../../users".into();
        assert!(c.validate(&hosts, &[]).is_err());
    }
}
