//! Workspace-bound principals and explicit browser approval for local agents.
//! Native pairing and browser OAuth share workspace-bound agent identities.
//! No credential enters tool results.
use crate::{AppState, WORKSPACE_ID, error, gateway::USER_ID};
use axum::{
    Json,
    extract::{FromRequestParts, Path, State},
    http::{StatusCode, request::Parts},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use uuid::Uuid;

pub const AGENT_SCOPES: &[&str] = &["runs:read", "runs:write", "usage:read"];
#[derive(Clone, Debug)]
pub struct Principal {
    pub workspace_id: Uuid,
    pub workspace_name: String,
    pub user_id: Uuid,
    pub agent_id: Option<Uuid>,
    pub credential_id: Option<Uuid>,
    pub scopes: Vec<String>,
    pub operator: bool,
    pub audience: Option<String>,
    pub request_id: Uuid,
}
impl Default for Principal {
    fn default() -> Self {
        Self {
            workspace_id: WORKSPACE_ID,
            workspace_name: "Local workspace".into(),
            user_id: USER_ID,
            agent_id: None,
            credential_id: None,
            scopes: vec![
                "workspace:manage".into(),
                "runs:read".into(),
                "runs:write".into(),
                "usage:read".into(),
            ],
            operator: true,
            audience: None,
            request_id: Uuid::new_v4(),
        }
    }
}
impl Principal {
    pub fn allows(&self, scope: &str) -> bool {
        self.scopes.iter().any(|s| s == scope)
    }
    pub fn is_manager(&self) -> bool {
        self.agent_id.is_none() && self.allows("workspace:manage")
    }
    pub fn value(&self) -> Value {
        json!({"workspace_id":self.workspace_id,"workspace_name":self.workspace_name,"agent_id":self.agent_id,"credential_id":self.credential_id,
        "principal_kind":if self.agent_id.is_some(){"agent"}else{"workspace_manager"},"scopes":self.scopes,"visibility":"team_private","request_id":self.request_id})
    }
}

/// HTTP handlers receive a per-request clone. Shared pools are never switched
/// between tenants and no task-local context can be lost across an async spawn.
pub struct ScopedState(pub AppState);
impl FromRequestParts<AppState> for ScopedState {
    type Rejection = Response;
    async fn from_request_parts(parts: &mut Parts, _: &AppState) -> Result<Self, Response> {
        parts
            .extensions
            .get::<AppState>()
            .cloned()
            .map(Self)
            .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "identity_required"))
    }
}
pub struct Identities {
    db: Arc<crate::db::Postgres>,
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
fn valid_name(name: &str, max: usize) -> bool {
    !name.trim().is_empty() && name.len() <= max && !name.chars().any(char::is_control)
}
fn validate_scopes(scopes: &[String]) -> bool {
    !scopes.is_empty()
        && scopes.len() <= AGENT_SCOPES.len()
        && scopes.iter().all(|s| AGENT_SCOPES.contains(&s.as_str()))
}
fn unavailable() -> Response {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "identity_store_unavailable",
    )
}
impl Identities {
    pub fn new(db: Arc<crate::db::Postgres>) -> Arc<Self> {
        Arc::new(Self { db })
    }
    pub(crate) async fn write(&self) -> Result<crate::db::Conn, ()> {
        self.db.write().await.map_err(|_| ())
    }
    pub async fn authenticate(&self, token: &str) -> Result<Option<Principal>, ()> {
        let db = self.write().await?;
        let row = db.query_opt("UPDATE workspace_credentials c SET last_used_at=now() FROM workspaces w WHERE c.workspace_id=w.workspace_id AND c.token_sha256=$1 AND c.revoked_at IS NULL AND c.expires_at>now() AND (c.agent_id IS NULL OR EXISTS(SELECT 1 FROM agent_identities a WHERE a.agent_id=c.agent_id AND a.workspace_id=c.workspace_id AND a.revoked_at IS NULL)) AND (c.oauth_session_id IS NULL OR EXISTS(SELECT 1 FROM oauth_sessions s WHERE s.session_id=c.oauth_session_id AND s.revoked_at IS NULL AND s.expires_at>now())) RETURNING c.workspace_id,w.owner_user_id,c.agent_id,c.credential_id,c.scopes,w.name,c.audience",&[&digest(token)]).await.map_err(|_|())?;
        Ok(row.map(|r| Principal {
            workspace_id: r.get(0),
            workspace_name: r.get(5),
            user_id: r.get(1),
            agent_id: r.get(2),
            credential_id: r.get(3),
            scopes: r.get(4),
            operator: false,
            audience: r.get(6),
            request_id: Uuid::new_v4(),
        }))
    }
    pub async fn audit(&self, p: &Principal, operation: &str, outcome: &str) -> Result<(), ()> {
        self.write().await?.execute("INSERT INTO identity_audit(event_id,workspace_id,agent_id,credential_id,operation,outcome,request_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
            &[&Uuid::new_v4(),&p.workspace_id,&p.agent_id,&p.credential_id,&operation,&outcome,&p.request_id]).await.map_err(|_|())?;
        Ok(())
    }
}

pub async fn whoami(ScopedState(state): ScopedState) -> Json<Value> {
    Json(state.principal.value())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceInput {
    name: String,
}
/// Bootstrap operator provisioning. A workspace manager key is returned once;
/// agents never receive a management scope through pairing.
pub async fn create_workspace(
    ScopedState(state): ScopedState,
    Json(input): Json<WorkspaceInput>,
) -> Response {
    if !state.principal.operator {
        return error(StatusCode::FORBIDDEN, "operator_required");
    }
    if !valid_name(&input.name, 100) {
        return error(StatusCode::BAD_REQUEST, "invalid_workspace_name");
    }
    let Some(store) = &state.identities else {
        return unavailable();
    };
    let Ok(mut db) = store.write().await else {
        return unavailable();
    };
    let Ok(tx) = db.transaction().await else {
        return unavailable();
    };
    let (workspace, user, credential) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let token = format!("scout_manager_{}", secret());
    let scopes = Principal::default().scopes;
    if tx.execute("INSERT INTO workspaces(workspace_id,owner_user_id,name) VALUES($1,$2,$3)",&[&workspace,&user,&input.name.trim()]).await.is_err()
        || tx.execute("INSERT INTO workspace_credentials(credential_id,workspace_id,token_sha256,scopes,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 days')",&[&credential,&workspace,&digest(&token),&scopes]).await.is_err()
        || tx.commit().await.is_err(){return unavailable()}
    (StatusCode::CREATED,Json(json!({"workspace_id":workspace,"name":input.name.trim(),"manager_token":token,"credential_id":credential,"visibility":"team_private","expires_in":2592000}))).into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionInput {
    agent_name: String,
    scopes: Vec<String>,
    code_challenge: String,
}
pub async fn begin(
    State(state): State<AppState>,
    Json(mut input): Json<ConnectionInput>,
) -> Response {
    if !valid_name(&input.agent_name, 80)
        || !validate_scopes(&input.scopes)
        || input.code_challenge.len() != 64
        || !input
            .code_challenge
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return error(StatusCode::BAD_REQUEST, "invalid_agent_connection");
    }
    input.scopes.sort();
    input.scopes.dedup();
    let Some(store) = &state.identities else {
        return unavailable();
    };
    let Ok(mut db) = store.write().await else {
        return unavailable();
    };
    let Ok(tx) = db.transaction().await else {
        return unavailable();
    };
    if tx
        .query_one("SELECT pg_advisory_xact_lock(736268194014)", &[])
        .await
        .is_err()
    {
        return unavailable();
    }
    let Ok(row)=tx.query_one("SELECT count(*) FROM agent_connections WHERE status IN ('pending','approved') AND expires_at>now()",&[]).await else{return unavailable()};
    if row.get::<_, i64>(0) >= 100 {
        return error(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_pending_connections",
        );
    }
    let (id, device, code) = (
        Uuid::new_v4(),
        secret(),
        Uuid::new_v4().simple().to_string()[..12].to_uppercase(),
    );
    if tx.execute("INSERT INTO agent_connections(connection_id,device_sha256,user_code,challenge,agent_name,scopes,status) VALUES($1,$2,$3,$4,$5,$6,'pending')",&[&id,&digest(&device),&code,&input.code_challenge,&input.agent_name.trim(),&input.scopes]).await.is_err() || tx.commit().await.is_err(){return unavailable()}
    Json(json!({"device_code":device,"user_code":code,"verification_uri":"/connect","expires_in":600,"interval":5})).into_response()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PollInput {
    device_code: String,
    code_verifier: String,
}
pub async fn poll(State(state): State<AppState>, Json(input): Json<PollInput>) -> Response {
    if input.device_code.len() != 64
        || input.code_verifier.len() < 32
        || input.code_verifier.len() > 256
    {
        return error(StatusCode::BAD_REQUEST, "invalid_connection_code");
    }
    let Some(store) = &state.identities else {
        return unavailable();
    };
    let Ok(mut db) = store.write().await else {
        return unavailable();
    };
    let Ok(tx) = db.transaction().await else {
        return unavailable();
    };
    let Ok(row)=tx.query_opt("SELECT connection_id,challenge,status,workspace_id,agent_name,scopes,expires_at<=now(),last_poll_at>now()-interval '5 seconds' FROM agent_connections WHERE device_sha256=$1 FOR UPDATE",&[&digest(&input.device_code)]).await else{return unavailable()};
    let Some(row) = row else {
        return error(StatusCode::BAD_REQUEST, "invalid_connection_code");
    };
    if row.get::<_, String>(1) != digest(&input.code_verifier) {
        return error(StatusCode::BAD_REQUEST, "invalid_connection_code");
    }
    if row.get::<_, bool>(6) {
        return error(StatusCode::BAD_REQUEST, "connection_expired");
    }
    let id: Uuid = row.get(0);
    let status: String = row.get(2);
    if status == "denied" {
        return error(StatusCode::FORBIDDEN, "connection_denied");
    }
    if status == "consumed" {
        return error(StatusCode::CONFLICT, "connection_already_consumed");
    }
    if row.get::<_, Option<bool>>(7) == Some(true) {
        return error(StatusCode::TOO_MANY_REQUESTS, "slow_down");
    }
    if tx
        .execute(
            "UPDATE agent_connections SET last_poll_at=now() WHERE connection_id=$1",
            &[&id],
        )
        .await
        .is_err()
    {
        return unavailable();
    }
    if status == "pending" {
        if tx.commit().await.is_err() {
            return unavailable();
        }
        return (
            StatusCode::ACCEPTED,
            Json(json!({"status":"authorization_pending","interval":5})),
        )
            .into_response();
    }
    let workspace: Uuid = row.get(3);
    let name: String = row.get(4);
    let scopes: Vec<String> = row.get(5);
    let (agent, credential) = (Uuid::new_v4(), Uuid::new_v4());
    let token = format!("scout_agent_{}", secret());
    if tx.execute("INSERT INTO agent_identities(agent_id,workspace_id,name) VALUES($1,$2,$3)",&[&agent,&workspace,&name]).await.is_err()
        || tx.execute("INSERT INTO workspace_credentials(credential_id,workspace_id,agent_id,token_sha256,scopes,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '30 days')",&[&credential,&workspace,&agent,&digest(&token),&scopes]).await.is_err()
        || tx.execute("UPDATE agent_connections SET status='consumed',agent_id=$2 WHERE connection_id=$1",&[&id,&agent]).await.is_err()
        || tx.execute("INSERT INTO identity_audit(event_id,workspace_id,agent_id,credential_id,operation,outcome) VALUES($1,$2,$3,$4,'agent.paired','approved')",&[&Uuid::new_v4(),&workspace,&agent,&credential]).await.is_err()
        || tx.commit().await.is_err(){return unavailable()}
    Json(json!({"access_token":token,"token_type":"Bearer","agent_id":agent,"workspace_id":workspace,"credential_id":credential,"expires_in":2592000,"scopes":scopes})).into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    approve: bool,
}
fn user_code(raw: &str) -> Option<String> {
    let code = raw.replace('-', "").to_ascii_uppercase();
    (code.len() == 12 && code.bytes().all(|b| b.is_ascii_hexdigit())).then_some(code)
}
pub async fn connection(ScopedState(state): ScopedState, Path(raw): Path<String>) -> Response {
    if !state.principal.is_manager() {
        return error(StatusCode::FORBIDDEN, "workspace_manager_required");
    }
    let Some(code) = user_code(&raw) else {
        return error(StatusCode::BAD_REQUEST, "invalid_user_code");
    };
    let Some(store) = &state.identities else {
        return unavailable();
    };
    let db = match store.write().await {
        Ok(db) => db,
        Err(()) => return unavailable(),
    };
    match db.query_opt("SELECT jsonb_build_object('agent_name',agent_name,'scopes',scopes,'status',status,'expires_at',expires_at,'workspace_id',$2::uuid,'credential_lifetime_days',30) FROM agent_connections WHERE user_code=$1 AND expires_at>now() AND (workspace_id IS NULL OR workspace_id=$2)",&[&code,&state.principal.workspace_id]).await {
        Ok(Some(row))=>Json(row.get::<_,Value>(0)).into_response(),Ok(None)=>error(StatusCode::NOT_FOUND,"connection_not_found"),Err(_)=>unavailable()
    }
}
pub async fn decide(
    ScopedState(state): ScopedState,
    Path(raw): Path<String>,
    Json(input): Json<Decision>,
) -> Response {
    if !state.principal.is_manager() {
        return error(StatusCode::FORBIDDEN, "workspace_manager_required");
    }
    let Some(code) = user_code(&raw) else {
        return error(StatusCode::BAD_REQUEST, "invalid_user_code");
    };
    let Some(store) = &state.identities else {
        return unavailable();
    };
    let db = match store.write().await {
        Ok(db) => db,
        Err(()) => return unavailable(),
    };
    match db.execute("UPDATE agent_connections SET status=$3,workspace_id=$2 WHERE user_code=$1 AND status='pending' AND expires_at>now()",&[&code,&state.principal.workspace_id,&if input.approve{"approved"}else{"denied"}]).await {
        Ok(1)=>Json(json!({"status":if input.approve{"approved"}else{"denied"}})).into_response(),Ok(_)=>error(StatusCode::CONFLICT,"connection_unavailable"),Err(_)=>unavailable()
    }
}
pub async fn agents(ScopedState(state): ScopedState) -> Response {
    if !state.principal.is_manager() {
        return error(StatusCode::FORBIDDEN, "workspace_manager_required");
    }
    let Some(store) = &state.identities else {
        return unavailable();
    };
    let db = match store.write().await {
        Ok(db) => db,
        Err(()) => return unavailable(),
    };
    match db.query("SELECT jsonb_build_object('agent_id',a.agent_id,'name',a.name,'created_at',a.created_at,'revoked_at',COALESCE(a.revoked_at,s.revoked_at),'scopes',c.scopes,'last_used_at',(SELECT max(k.last_used_at) FROM workspace_credentials k WHERE k.agent_id=a.agent_id AND k.workspace_id=a.workspace_id),'expires_at',COALESCE(s.expires_at,c.expires_at),'connection_kind',CASE WHEN c.oauth_session_id IS NULL THEN 'native_connector' ELSE 'browser_oauth' END) FROM agent_identities a JOIN LATERAL (SELECT * FROM workspace_credentials k WHERE k.agent_id=a.agent_id AND k.workspace_id=a.workspace_id ORDER BY k.created_at DESC,k.credential_id DESC LIMIT 1) c ON true LEFT JOIN oauth_sessions s ON s.session_id=c.oauth_session_id WHERE a.workspace_id=$1 ORDER BY a.created_at DESC LIMIT 100",&[&state.principal.workspace_id]).await {
        Ok(rows)=>Json(json!({"agents":rows.iter().map(|r|r.get::<_,Value>(0)).collect::<Vec<_>>(),"limit":100})).into_response(),Err(_)=>unavailable()
    }
}
pub async fn revoke(ScopedState(state): ScopedState, Path(id): Path<Uuid>) -> Response {
    if !state.principal.is_manager() && state.principal.agent_id != Some(id) {
        return error(StatusCode::FORBIDDEN, "agent_revocation_not_allowed");
    }
    let Some(store) = &state.identities else {
        return unavailable();
    };
    let Ok(mut db) = store.write().await else {
        return unavailable();
    };
    let Ok(tx) = db.transaction().await else {
        return unavailable();
    };
    match tx.execute("UPDATE agent_identities SET revoked_at=COALESCE(revoked_at,now()) WHERE agent_id=$1 AND workspace_id=$2",&[&id,&state.principal.workspace_id]).await {
        Ok(1)=>{},Ok(_)=>return error(StatusCode::NOT_FOUND,"agent_not_found"),Err(_)=>return unavailable()
    }
    if tx.execute("UPDATE workspace_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE agent_id=$1 AND workspace_id=$2",&[&id,&state.principal.workspace_id]).await.is_err() || tx.commit().await.is_err(){return unavailable()}
    Json(json!({"agent_id":id,"revoked":true,"existing_work_cancelled":false})).into_response()
}

/// Agents get a small explicit surface. GUI-only private login, human review,
/// settings, management and raw inference never become agent capabilities.
pub fn permitted(p: &Principal, method: &str, path: &str) -> bool {
    if p.operator {
        return true;
    }
    if path.starts_with("/v1/admin/") {
        return false;
    }
    if path == "/v1/workspaces" || (path == "/v1/model-requests" && method == "POST") {
        return false;
    }
    if p.is_manager() {
        return true;
    }
    if path.starts_with("/v1/model-requests") || path == "/v1/operations" {
        return false;
    }
    if path == "/mcp" || path == "/v1/identity" || path.starts_with("/v1/agents/") {
        return true;
    }
    if path.starts_with("/v1/agent/tools") {
        return true;
    } // Dispatcher checks each tool.
    if method == "GET"
        && (path == "/readyz" || path == "/v1/capabilities" || path == "/v1/model-providers")
    {
        return p.allows("runs:read");
    }
    if path == "/v1/usage" {
        return method == "GET" && p.allows("usage:read");
    }
    if method == "GET"
        && (path.starts_with("/v1/runs")
            || path.starts_with("/v1/captures/")
            || path.starts_with("/v1/artifacts/")
            || path.starts_with("/v1/browser-jobs")
            || path == "/v1/projects"
            || path.starts_with("/v1/projects/")
            || path == "/v1/browser-access"
            || path.starts_with("/v1/history")
            || path.starts_with("/v1/issues")
            || path.starts_with("/v1/issue-verifications")
            || path == "/v1/knowledge"
            || path.starts_with("/v1/app-memory")
            || path.starts_with("/v1/rechecks/"))
    {
        return p.allows("runs:read");
    }
    method == "POST"
        && p.allows("runs:write")
        && ((path.starts_with("/v1/issues/")
            && (path.ends_with("/verifications") || path.ends_with("/triage")))
            || path == "/v1/rechecks"
            || path == "/v1/browser-jobs"
            || ((path.starts_with("/v1/browser-jobs/") || path.starts_with("/v1/runs/"))
                && path.ends_with("/cancel"))
            || (path.starts_with("/v1/runs/") && path.ends_with("/steering")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scoped_agent_is_not_an_administrator_or_human() {
        let p = Principal {
            operator: false,
            request_id: Uuid::new_v4(),
            agent_id: Some(Uuid::new_v4()),
            scopes: vec!["runs:read".into()],
            ..Principal::default()
        };
        assert!(permitted(&p, "GET", "/v1/runs/abc/report"));
        assert!(permitted(&p, "GET", "/v1/runs/abc/steering"));
        assert!(permitted(&p, "GET", "/v1/projects"));
        assert!(permitted(&p, "GET", "/v1/projects/abc"));
        assert!(!permitted(&p, "POST", "/v1/projects"));
        assert!(!permitted(&p, "POST", "/v1/runs/abc/steering"));
        let mut writer = p.clone();
        writer.scopes.push("runs:write".into());
        assert!(permitted(&writer, "POST", "/v1/runs/abc/steering"));
        for (method, path) in [
            ("POST", "/v1/browser-jobs"),
            ("GET", "/v1/browser-access/x/screen"),
            ("GET", "/v1/browser-access/account-identity"),
            ("POST", "/v1/actions/x/reviews"),
            ("GET", "/v1/operations"),
            ("GET", "/v1/model-requests/x"),
            ("POST", "/v1/computer-use/check"),
            ("POST", "/v1/agent-connections/x/decision"),
        ] {
            assert!(!permitted(&p, method, path), "{path}");
        }
        assert!(!validate_scopes(&["workspace:manage".into()]));
    }
}
