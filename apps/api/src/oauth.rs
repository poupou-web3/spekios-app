//! Browser consent for public Streamable HTTP MCP clients. This deliberately
//! supports DCR, not fetching arbitrary client metadata URLs or third-party IdPs.
use crate::{
    AppState, error,
    identity::{AGENT_SCOPES, ScopedState},
};
use axum::{
    Form, Json,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Redirect, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::Url;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use tokio_postgres::Transaction;
use uuid::Uuid;

type Parameters = BTreeMap<String, String>;
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
fn failure(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({"error":code}))).into_response()
}
fn invalid(code: &str) -> Response {
    failure(StatusCode::BAD_REQUEST, code)
}
fn unavailable() -> Response {
    failure(StatusCode::SERVICE_UNAVAILABLE, "temporarily_unavailable")
}

/// Never construct an issuer or token audience from Forwarded/X-Forwarded-*.
/// A hosted issuer is pinned by configuration; unconfigured origins are loopback.
pub(crate) fn origin(state: &AppState, headers: &HeaderMap) -> Option<String> {
    if headers.get_all("host").iter().count() != 1 {
        return None;
    }
    let host = headers.get("host")?.to_str().ok()?;
    if let Some(origin) = state.public_origin.as_deref() {
        let actual = host.parse::<axum::http::uri::Authority>().ok()?;
        let expected: axum::http::Uri = origin.parse().ok()?;
        if !crate::same_authority(&actual, expected.authority()?, "https")
            || host.trim() != host
            || host.contains('@')
        {
            return None;
        }
        let suffix = host.get(actual.host().len()..)?;
        if !suffix.is_empty()
            && !suffix
                .strip_prefix(':')
                .is_some_and(|p| p.parse::<u16>().is_ok_and(|p| p > 0))
        {
            return None;
        }
        Some(origin.into())
    } else {
        crate::local_authority(host)?;
        let url = Url::parse(&format!("http://{host}")).ok()?;
        Some(url.origin().ascii_serialization())
    }
}
pub(crate) fn challenge(state: &AppState, headers: &HeaderMap, path: &str) -> HeaderValue {
    if path == "/mcp"
        && let Some(origin) = origin(state, headers)
    {
        return format!("Bearer realm=\"scout\", resource_metadata=\"{origin}/.well-known/oauth-protected-resource/mcp\", scope=\"runs:read runs:write usage:read\"").parse().unwrap();
    }
    HeaderValue::from_static("Bearer realm=\"scout\"")
}
pub async fn setup(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(origin) = origin(&state, &headers) else {
        return invalid("invalid_server_origin");
    };
    Json(json!({"mcp_url":format!("{origin}/mcp"),"authorization":"browser_oauth_pkce","cloud_reachable":state.public_origin.is_some(),"scopes":AGENT_SCOPES})).into_response()
}
pub async fn resource_metadata(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(origin) = origin(&state, &headers) else {
        return invalid("invalid_server_origin");
    };
    Json(json!({"resource":format!("{origin}/mcp"),"authorization_servers":[origin],"scopes_supported":AGENT_SCOPES,"bearer_methods_supported":["header"],"resource_name":"Spekios"})).into_response()
}
pub async fn server_metadata(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(origin) = origin(&state, &headers) else {
        return invalid("invalid_server_origin");
    };
    Json(json!({"issuer":origin,"authorization_endpoint":format!("{origin}/oauth/authorize"),"token_endpoint":format!("{origin}/oauth/token"),"registration_endpoint":format!("{origin}/oauth/register"),"revocation_endpoint":format!("{origin}/oauth/revoke"),"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"token_endpoint_auth_methods_supported":["none"],"revocation_endpoint_auth_methods_supported":["none"],"code_challenge_methods_supported":["S256"],"scopes_supported":AGENT_SCOPES,"authorization_response_iss_parameter_supported":true,"client_id_metadata_document_supported":false})).into_response()
}
fn valid_redirect(raw: &str) -> bool {
    if raw.len() > 2048 || raw.chars().any(char::is_control) {
        return false;
    }
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.port() != Some(0)
        && (url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"))))
        && !url
            .query_pairs()
            .any(|(key, _)| matches!(key.as_ref(), "code" | "state" | "error" | "iss"))
}
fn redirect_matches(registered: &str, requested: &str) -> bool {
    if !valid_redirect(requested) {
        return false;
    }
    if registered == requested {
        return true;
    }
    // RFC 8252: native clients choose an ephemeral port on the same literal
    // loopback host. Every other URI component must still match exactly.
    fn without_port(raw: &str) -> Option<String> {
        let (scheme, rest) = raw.split_once("://")?;
        if !scheme.eq_ignore_ascii_case("http") {
            return None;
        }
        let end = rest.find(['/', '?']).unwrap_or(rest.len());
        let authority = crate::local_authority(&rest[..end])?;
        Some(format!("{scheme}://{}{}", authority.host(), &rest[end..]))
    }
    without_port(registered).is_some_and(|left| Some(left) == without_port(requested))
}
fn parameters(pairs: Vec<(String, String)>) -> Result<Parameters, &'static str> {
    if pairs.len() > 20 {
        return Err("invalid_request");
    }
    let mut result = Parameters::new();
    for (key, value) in pairs {
        if key.len() > 80 || value.len() > 4096 || result.insert(key, value).is_some() {
            return Err("invalid_request");
        }
    }
    Ok(result)
}
fn scopes(raw: Option<&str>) -> Option<Vec<String>> {
    let raw = raw.unwrap_or("runs:read runs:write usage:read");
    let mut values: Vec<String> = raw.split_ascii_whitespace().map(str::to_owned).collect();
    values.sort();
    values.dedup();
    (!values.is_empty() && values.iter().all(|s| AGENT_SCOPES.contains(&s.as_str())))
        .then_some(values)
}
fn pkce(value: &str) -> bool {
    value.len() == 43 && URL_SAFE_NO_PAD.decode(value).is_ok_and(|v| v.len() == 32)
}
fn valid_verifier(value: &str) -> bool {
    (43..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
}

#[derive(Deserialize)]
pub struct Registration {
    client_name: Option<String>,
    redirect_uris: Vec<String>,
    token_endpoint_auth_method: Option<String>,
    grant_types: Option<Vec<String>>,
    response_types: Option<Vec<String>>,
}
pub async fn register(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Registration>,
) -> Response {
    if origin(&state, &headers).is_none() {
        return invalid("invalid_server_origin");
    }
    let name = input.client_name.as_deref().unwrap_or("My AI agent").trim();
    if name.is_empty()
        || name.len() > 80
        || name.chars().any(char::is_control)
        || input.redirect_uris.is_empty()
        || input.redirect_uris.len() > 10
        || !input.redirect_uris.iter().all(|uri| valid_redirect(uri))
    {
        return invalid("invalid_client_metadata");
    }
    if input
        .token_endpoint_auth_method
        .as_deref()
        .is_some_and(|v| v != "none")
        || input.grant_types.as_ref().is_some_and(|v| {
            v.is_empty()
                || !v.iter().any(|g| g == "authorization_code")
                || v.iter()
                    .any(|g| !matches!(g.as_str(), "authorization_code" | "refresh_token"))
        })
        || input
            .response_types
            .as_ref()
            .is_some_and(|v| v != &["code"])
    {
        return invalid("invalid_client_metadata");
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
    if tx
        .query_one("SELECT pg_advisory_xact_lock(736268194015)", &[])
        .await
        .is_err()
    {
        return unavailable();
    }
    let Ok(count) = tx
        .query_one(
            "SELECT count(*) FROM oauth_clients WHERE created_at>now()-interval '1 hour'",
            &[],
        )
        .await
    else {
        return unavailable();
    };
    if count.get::<_, i64>(0) >= 1000 {
        return failure(StatusCode::TOO_MANY_REQUESTS, "registration_limit_reached");
    }
    let client = format!("scout_client_{}", Uuid::new_v4().simple());
    if tx
        .execute(
            "INSERT INTO oauth_clients(client_id,name,redirect_uris) VALUES($1,$2,$3)",
            &[&client, &name, &input.redirect_uris],
        )
        .await
        .is_err()
        || tx.commit().await.is_err()
    {
        return unavailable();
    }
    (StatusCode::CREATED,Json(json!({"client_id":client,"client_name":name,"redirect_uris":input.redirect_uris,"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"]}))).into_response()
}
pub async fn authorize(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(raw): RawQuery,
) -> Response {
    let Some(origin) = origin(&state, &headers) else {
        return invalid("invalid_server_origin");
    };
    let raw = raw.unwrap_or_default();
    if raw.len() > 8192 {
        return invalid("invalid_request");
    }
    let mut url = Url::parse("https://query.invalid").unwrap();
    url.set_query(Some(&raw));
    let params = match parameters(
        url.query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect(),
    ) {
        Ok(p) => p,
        Err(code) => return invalid(code),
    };
    if params.get("response_type").map(String::as_str) != Some("code") {
        return invalid("unsupported_response_type");
    }
    let (Some(client), Some(redirect), Some(challenge)) = (
        params.get("client_id"),
        params.get("redirect_uri"),
        params.get("code_challenge"),
    ) else {
        return invalid("invalid_request");
    };
    if params.get("code_challenge_method").map(String::as_str) != Some("S256") || !pkce(challenge) {
        return invalid("invalid_request");
    }
    let resource = format!("{origin}/mcp");
    if params.get("resource") != Some(&resource) {
        return invalid("invalid_target");
    }
    let Some(scopes) = scopes(params.get("scope").map(String::as_str)) else {
        return invalid("invalid_scope");
    };
    let state_value = params.get("state");
    if state_value.is_some_and(|v| v.len() > 1024 || v.chars().any(char::is_control)) {
        return invalid("invalid_request");
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
    let Ok(client_row) = tx
        .query_opt(
            "SELECT redirect_uris FROM oauth_clients WHERE client_id=$1",
            &[client],
        )
        .await
    else {
        return unavailable();
    };
    let Some(client_row) = client_row else {
        return invalid("invalid_client");
    };
    if !client_row
        .get::<_, Vec<String>>(0)
        .iter()
        .any(|uri| redirect_matches(uri, redirect))
    {
        return invalid("invalid_redirect_uri");
    }
    if tx
        .query_one("SELECT pg_advisory_xact_lock(736268194015)", &[])
        .await
        .is_err()
    {
        return unavailable();
    }
    let Ok(count)=tx.query_one("SELECT count(*) FROM oauth_authorizations WHERE status IN ('pending','approved') AND expires_at>now()",&[]).await else{return unavailable()};
    if count.get::<_, i64>(0) >= 100 {
        return failure(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_pending_authorizations",
        );
    }
    let id = Uuid::new_v4();
    if tx.execute("INSERT INTO oauth_authorizations(authorization_id,client_id,redirect_uri,resource,challenge,state,scopes) VALUES($1,$2,$3,$4,$5,$6,$7)",&[&id,client,redirect,&resource,challenge,&state_value,&scopes]).await.is_err() || tx.commit().await.is_err(){return unavailable();}
    Redirect::to(&format!("/connect#authorization={id}")).into_response()
}
pub async fn review(ScopedState(state): ScopedState, Path(id): Path<Uuid>) -> Response {
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
    match db.query_opt("SELECT jsonb_build_object('authorization_id',a.authorization_id,'agent_name',c.name,'redirect_uri',a.redirect_uri,'scopes',a.scopes,'status',a.status,'expires_at',a.expires_at,'workspace_id',$2::uuid) FROM oauth_authorizations a JOIN oauth_clients c USING(client_id) WHERE a.authorization_id=$1 AND a.expires_at>now() AND (a.workspace_id IS NULL OR a.workspace_id=$2)",&[&id,&state.principal.workspace_id]).await {
        Ok(Some(row))=>Json(row.get::<_,Value>(0)).into_response(),Ok(None)=>error(StatusCode::NOT_FOUND,"authorization_unavailable"),Err(_)=>unavailable()
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    approve: bool,
    scopes: Option<Vec<String>>,
}
pub async fn decide(
    ScopedState(state): ScopedState,
    Path(id): Path<Uuid>,
    Json(input): Json<Decision>,
) -> Response {
    if !state.principal.is_manager() {
        return error(StatusCode::FORBIDDEN, "workspace_manager_required");
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
    let Ok(row)=tx.query_opt("SELECT redirect_uri,state,resource,scopes FROM oauth_authorizations WHERE authorization_id=$1 AND status='pending' AND expires_at>now() FOR UPDATE",&[&id]).await else{return unavailable()};
    let Some(row) = row else {
        return error(StatusCode::CONFLICT, "authorization_unavailable");
    };
    let requested: Vec<String> = row.get(3);
    let mut granted = input.scopes.unwrap_or(requested.clone());
    granted.sort();
    granted.dedup();
    if input.approve && (granted.is_empty() || !granted.iter().all(|s| requested.contains(s))) {
        return invalid("invalid_scope");
    }
    let code = secret();
    let redirect: String = row.get(0);
    let state_value: Option<String> = row.get(1);
    let resource: String = row.get(2);
    let mut url = Url::parse(&redirect).unwrap();
    {
        let mut query = url.query_pairs_mut();
        if input.approve {
            query.append_pair("code", &code);
        } else {
            query.append_pair("error", "access_denied");
        }
        if let Some(value) = state_value {
            query.append_pair("state", &value);
        }
        query.append_pair("iss", resource.strip_suffix("/mcp").unwrap());
    }
    if tx.execute("UPDATE oauth_authorizations SET status=$2,workspace_id=$3,code_sha256=$4,scopes=$5,expires_at=now()+interval '2 minutes' WHERE authorization_id=$1",&[&id,&if input.approve{"approved"}else{"denied"},&state.principal.workspace_id,&input.approve.then(||hash(&code)),&granted]).await.is_err() || tx.commit().await.is_err(){return unavailable();}
    // This browser-only result is immediately navigated to the registered
    // callback. It is never an agent tool result, log field or stored raw code.
    Json(json!({"status":if input.approve{"approved"}else{"denied"},"redirect_uri":url.as_str()}))
        .into_response()
}

async fn issue(
    tx: &Transaction<'_>,
    session: Uuid,
    workspace: Uuid,
    agent: Uuid,
    resource: &str,
    scopes: &[String],
    lifetime: i64,
) -> Result<Value, ()> {
    let access = format!("scout_oauth_{}", secret());
    let refresh = format!("scout_refresh_{}", secret());
    let credential = Uuid::new_v4();
    tx.execute("INSERT INTO workspace_credentials(credential_id,workspace_id,agent_id,token_sha256,scopes,expires_at,audience,oauth_session_id) VALUES($1,$2,$3,$4,$5,now()+make_interval(secs=>$6::double precision),$7,$8)",&[&credential,&workspace,&agent,&hash(&access),&scopes,&(lifetime as f64),&resource,&session]).await.map_err(|_|())?;
    tx.execute(
        "INSERT INTO oauth_refresh_tokens(token_sha256,session_id) VALUES($1,$2)",
        &[&hash(&refresh), &session],
    )
    .await
    .map_err(|_| ())?;
    tx.execute("INSERT INTO identity_audit(event_id,workspace_id,agent_id,credential_id,operation,outcome,request_id) VALUES($1,$2,$3,$4,'POST /oauth/token','issued',$5)",&[&Uuid::new_v4(),&workspace,&agent,&credential,&Uuid::new_v4()]).await.map_err(|_|())?;
    Ok(
        json!({"access_token":access,"token_type":"Bearer","expires_in":lifetime,"refresh_token":refresh,"scope":scopes.join(" ")}),
    )
}

async fn audit_session(
    tx: &Transaction<'_>,
    session: Uuid,
    operation: &str,
    outcome: &str,
) -> Result<(), ()> {
    tx.execute("INSERT INTO identity_audit(event_id,workspace_id,agent_id,operation,outcome,request_id) SELECT $1,workspace_id,agent_id,$2,$3,$4 FROM oauth_sessions WHERE session_id=$5",&[&Uuid::new_v4(),&operation,&outcome,&Uuid::new_v4(),&session]).await.map_err(|_|())?;
    Ok(())
}
pub async fn token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(pairs): Form<Vec<(String, String)>>,
) -> Response {
    let Some(origin) = origin(&state, &headers) else {
        return invalid("invalid_server_origin");
    };
    let p = match parameters(pairs) {
        Ok(p) => p,
        Err(code) => return invalid(code),
    };
    if headers.contains_key("authorization") || p.contains_key("client_secret") {
        return invalid("invalid_client");
    }
    let (Some(client), Some(resource)) = (p.get("client_id"), p.get("resource")) else {
        return invalid("invalid_request");
    };
    if resource != &format!("{origin}/mcp") {
        return invalid("invalid_target");
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
    let result = match p.get("grant_type").map(String::as_str) {
        Some("authorization_code") => {
            let (Some(code), Some(verifier), Some(redirect)) =
                (p.get("code"), p.get("code_verifier"), p.get("redirect_uri"))
            else {
                return invalid("invalid_request");
            };
            if code.len() != 64 || !valid_verifier(verifier) {
                return invalid("invalid_grant");
            }
            let Ok(row)=tx.query_opt("SELECT a.authorization_id,a.workspace_id,a.challenge,a.scopes,c.name FROM oauth_authorizations a JOIN oauth_clients c USING(client_id) WHERE code_sha256=$1 AND a.client_id=$2 AND a.redirect_uri=$3 AND a.resource=$4 AND a.status='approved' AND a.expires_at>now() FOR UPDATE OF a",&[&hash(code),client,redirect,resource]).await else{return unavailable()};
            let Some(row) = row else {
                return invalid("invalid_grant");
            };
            if row.get::<_, String>(2)
                != URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
            {
                return invalid("invalid_grant");
            }
            let authorization: Uuid = row.get(0);
            let workspace: Uuid = row.get(1);
            let scopes: Vec<String> = row.get(3);
            let name: String = row.get(4);
            let agent = Uuid::new_v4();
            let session = Uuid::new_v4();
            if tx.execute("INSERT INTO agent_identities(agent_id,workspace_id,name) VALUES($1,$2,$3)",&[&agent,&workspace,&name]).await.is_err()
                || tx.execute("INSERT INTO oauth_sessions(session_id,client_id,workspace_id,agent_id,resource,scopes) VALUES($1,$2,$3,$4,$5,$6)",&[&session,client,&workspace,&agent,resource,&scopes]).await.is_err()
                || tx.execute("UPDATE oauth_authorizations SET status='consumed',code_sha256=NULL WHERE authorization_id=$1",&[&authorization]).await.is_err(){return unavailable();}
            issue(&tx, session, workspace, agent, resource, &scopes, 3600).await
        }
        Some("refresh_token") => {
            let Some(refresh) = p.get("refresh_token") else {
                return invalid("invalid_request");
            };
            if refresh.len() > 128 {
                return invalid("invalid_grant");
            }
            let Ok(row)=tx.query_opt("SELECT s.session_id,s.workspace_id,s.agent_id,s.scopes,t.used_at IS NOT NULL,GREATEST(0,LEAST(3600,extract(epoch FROM s.expires_at-now())::bigint)) FROM oauth_refresh_tokens t JOIN oauth_sessions s USING(session_id) JOIN agent_identities a USING(agent_id,workspace_id) WHERE t.token_sha256=$1 AND s.client_id=$2 AND s.resource=$3 AND s.revoked_at IS NULL AND s.expires_at>now() AND a.revoked_at IS NULL FOR UPDATE OF s,t",&[&hash(refresh),client,resource]).await else{return unavailable()};
            let Some(row) = row else {
                return invalid("invalid_grant");
            };
            let session: Uuid = row.get(0);
            if row.get::<_, bool>(4) {
                if tx
                    .execute(
                        "UPDATE oauth_sessions SET revoked_at=now() WHERE session_id=$1",
                        &[&session],
                    )
                    .await
                    .is_err()
                    || audit_session(&tx, session, "POST /oauth/token", "refresh_reuse_revoked")
                        .await
                        .is_err()
                    || tx.commit().await.is_err()
                {
                    return unavailable();
                }
                return invalid("invalid_grant");
            }
            let scopes: Vec<String> = row.get(3);
            if p.get("scope")
                .is_some_and(|raw| self::scopes(Some(raw)).is_none_or(|wanted| wanted != scopes))
            {
                return invalid("invalid_scope");
            }
            let lifetime: i64 = row.get(5);
            if lifetime < 1 {
                return invalid("invalid_grant");
            }
            if tx
                .execute(
                    "UPDATE oauth_refresh_tokens SET used_at=now() WHERE token_sha256=$1",
                    &[&hash(refresh)],
                )
                .await
                .is_err()
            {
                return unavailable();
            }
            issue(
                &tx,
                session,
                row.get(1),
                row.get(2),
                resource,
                &scopes,
                lifetime,
            )
            .await
        }
        _ => return invalid("unsupported_grant_type"),
    };
    let Ok(value) = result else {
        return unavailable();
    };
    if tx.commit().await.is_err() {
        return unavailable();
    }
    let mut response = Json(value).into_response();
    response
        .headers_mut()
        .insert("pragma", HeaderValue::from_static("no-cache"));
    response
}
pub async fn revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(pairs): Form<Vec<(String, String)>>,
) -> Response {
    if origin(&state, &headers).is_none() {
        return invalid("invalid_server_origin");
    }
    let p = match parameters(pairs) {
        Ok(p) => p,
        Err(code) => return invalid(code),
    };
    let (Some(client), Some(token)) = (p.get("client_id"), p.get("token")) else {
        return invalid("invalid_request");
    };
    if token.len() > 256 {
        return invalid("invalid_request");
    }
    if headers.contains_key("authorization") || p.contains_key("client_secret") {
        return invalid("invalid_client");
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
    let Ok(row) = tx.query_opt("UPDATE oauth_sessions s SET revoked_at=now() WHERE client_id=$1 AND revoked_at IS NULL AND (EXISTS(SELECT 1 FROM oauth_refresh_tokens t WHERE t.session_id=s.session_id AND t.token_sha256=$2) OR EXISTS(SELECT 1 FROM workspace_credentials c WHERE c.oauth_session_id=s.session_id AND c.token_sha256=$2)) RETURNING session_id",&[client,&hash(token)]).await else { return unavailable(); };
    if let Some(row) = row
        && audit_session(&tx, row.get(0), "POST /oauth/revoke", "revoked")
            .await
            .is_err()
    {
        return unavailable();
    }
    if tx.commit().await.is_err() {
        return unavailable();
    }
    StatusCode::OK.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redirect_validation_is_exact_except_native_callback_port() {
        for value in [
            "javascript:alert(1)",
            "http://evil.example/callback",
            "https://user:pass@example.com/callback",
            "https://example.com/#fragment",
            "http://127.0.0.1:0/callback",
            "https://example.com/?code=old",
        ] {
            assert!(!valid_redirect(value), "{value}");
        }
        assert!(redirect_matches(
            "http://127.0.0.1/callback",
            "http://127.0.0.1:54001/callback"
        ));
        assert!(redirect_matches(
            "https://claude.ai/api/mcp/auth_callback",
            "https://claude.ai/api/mcp/auth_callback"
        ));
        for (a, b) in [
            ("https://example.com/a", "https://example.com/b"),
            ("https://example.com/cb", "https://example.com:444/cb"),
            (
                "http://127.0.0.1/callback",
                "http://localhost:9000/callback",
            ),
            (
                "http://127.0.0.1/callback",
                "http://127.0.0.1:9000/callback/other",
            ),
            ("http://127.0.0.1/callback", "https://127.0.0.1/callback"),
            (
                "http://127.0.0.1/callback",
                "http://127.0.0.1:9000/other/../callback",
            ),
        ] {
            assert!(!redirect_matches(a, b));
        }
    }
    #[test]
    fn pkce_and_scope_validation_refuse_downgrades_and_management() {
        assert!(pkce(&URL_SAFE_NO_PAD.encode([42; 32])));
        assert!(!pkce("not_a_challenge"));
        assert!(valid_verifier(&"a".repeat(43)));
        assert!(!valid_verifier(&"a".repeat(42)));
        assert!(scopes(Some("runs:read workspace:manage")).is_none());
        assert!(
            parameters(vec![
                ("client_id".into(), "a".into()),
                ("client_id".into(), "b".into())
            ])
            .is_err()
        );
    }
    #[tokio::test]
    async fn discovery_is_public_origin_pinned_and_never_anonymous_mcp() {
        use axum::{
            body::{Body, to_bytes},
            http::Request,
        };
        use tower::ServiceExt;
        let token = "oauth_discovery_fixture_token_000000000001";
        let state = AppState::new(None, token)
            .unwrap()
            .with_dev_auth_bypass(true);
        let response = crate::router(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/.well-known/oauth-authorization-server")
                    .header("host", "localhost:18080")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let data: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
        assert_eq!(data["issuer"], "http://localhost:18080");
        assert_eq!(data["code_challenge_methods_supported"], json!(["S256"]));
        let response = crate::router(state)
            .oneshot(
                Request::builder()
                    .uri("/mcp")
                    .header("host", "localhost:18080")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(
            response.headers()["www-authenticate"]
                .to_str()
                .unwrap()
                .contains("resource_metadata=")
        );
        let hosted = AppState::new(None, token)
            .unwrap()
            .with_public_origin(Some("https://scout.example"))
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("host", "scout.example".parse().unwrap());
        headers.insert("x-forwarded-host", "evil.example".parse().unwrap());
        assert_eq!(
            origin(&hosted, &headers).as_deref(),
            Some("https://scout.example")
        );
        headers.insert("host", "evil.example".parse().unwrap());
        assert!(origin(&hosted, &headers).is_none());
        assert!(origin(&AppState::new(None, token).unwrap(), &headers).is_none());
    }
}
