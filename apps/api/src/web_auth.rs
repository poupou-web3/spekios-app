//! Spekios human login: opaque PKCE handoff, then a host-only server-side session.
//! The remote identity response is trusted only over the configured HTTPS channel.
use crate::{AppState, error, identity::Principal};
use axum::{
    extract::{RawQuery, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::{Html, IntoResponse, Redirect, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::Url;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use subtle::ConstantTimeEq;
use uuid::Uuid;

const SESSION_SECONDS: u64 = 43_200;
#[derive(Clone)]
pub struct Config {
    auth_origin: String,
    issuer: String,
    client_id: String,
    client_secret: String,
    redirect_uri: String,
    app_origin: String,
    secure: bool,
    http: reqwest::Client,
}
impl Config {
    pub fn from_env() -> Result<Option<Self>, &'static str> {
        let names = [
            "SPEKIOS_AUTH_ORIGIN",
            "SPEKIOS_ISSUER",
            "SPEKIOS_CLIENT_ID",
            "SPEKIOS_CLIENT_SECRET",
            "SPEKIOS_REDIRECT_URI",
        ];
        let values: Vec<String> = names
            .iter()
            .map(|n| std::env::var(n).unwrap_or_default())
            .collect();
        if values.iter().all(String::is_empty) {
            return Ok(None);
        }
        if values.iter().any(String::is_empty) {
            return Err("All five SPEKIOS auth settings are required");
        }
        Self::new(&values[0], &values[1], &values[2], &values[3], &values[4]).map(Some)
    }
    pub fn new(
        auth: &str,
        issuer: &str,
        id: &str,
        secret: &str,
        callback: &str,
    ) -> Result<Self, &'static str> {
        let auth = Url::parse(auth).map_err(|_| "Invalid SPEKIOS_AUTH_ORIGIN")?;
        let issuer_url = Url::parse(issuer).map_err(|_| "Invalid SPEKIOS_ISSUER")?;
        let redirect = Url::parse(callback).map_err(|_| "Invalid SPEKIOS_REDIRECT_URI")?;
        let clean = |u: &Url| {
            u.host_str().is_some()
                && u.username().is_empty()
                && u.password().is_none()
                && u.query().is_none()
                && u.fragment().is_none()
                && u.port() != Some(0)
        };
        if !clean(&auth) || auth.scheme() != "https" || auth.path() != "/" {
            return Err("SPEKIOS_AUTH_ORIGIN must be a clean HTTPS origin");
        }
        if !clean(&issuer_url) || issuer_url.scheme() != "https" {
            return Err("SPEKIOS_ISSUER must be an HTTPS URL");
        }
        let loopback = matches!(redirect.host_str(), Some("localhost" | "127.0.0.1"));
        if !clean(&redirect)
            || redirect.path() != "/auth/callback"
            || !(redirect.scheme() == "https" || (redirect.scheme() == "http" && loopback))
        {
            return Err("Callback must be HTTPS or literal localhost HTTP, at /auth/callback");
        }
        if !(3..=64).contains(&id.len())
            || !id.as_bytes()[0].is_ascii_lowercase() && !id.as_bytes()[0].is_ascii_digit()
            || !id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
        {
            return Err("Invalid SPEKIOS_CLIENT_ID");
        }
        if !(32..=512).contains(&secret.len()) || !secret.bytes().all(|b| b.is_ascii_graphic()) {
            return Err("SPEKIOS_CLIENT_SECRET must be 32-512 printable ASCII characters");
        }
        Ok(Self {
            auth_origin: auth.origin().ascii_serialization(),
            issuer: issuer.into(),
            client_id: id.into(),
            client_secret: secret.into(),
            app_origin: redirect.origin().ascii_serialization(),
            secure: redirect.scheme() == "https",
            redirect_uri: callback.into(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "Auth HTTP client unavailable")?,
        })
    }
    fn cookie_name(&self, login: bool) -> &'static str {
        match (self.secure, login) {
            (true, true) => "__Host-spekios_login",
            (true, false) => "__Host-spekios_session",
            (false, true) => "spekios_login",
            (false, false) => "spekios_session",
        }
    }
    fn cookie(&self, login: bool, value: &str, seconds: u64) -> String {
        format!(
            "{}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={seconds}{}",
            self.cookie_name(login),
            if self.secure { "; Secure" } else { "" }
        )
    }
    pub(crate) fn browser_request(&self, headers: &HeaderMap, mutation: bool) -> bool {
        // Never infer the app origin from proxy headers or a request's callback.
        let Some(host) = single_header(headers, "host") else {
            return false;
        };
        let Ok(authority) = host.parse::<axum::http::uri::Authority>() else {
            return false;
        };
        let Ok(expected) = self.app_origin.parse::<axum::http::Uri>() else {
            return false;
        };
        if host.contains('@')
            || host.trim() != host
            || !crate::same_authority(
                &authority,
                expected.authority().unwrap(),
                if self.secure { "https" } else { "http" },
            )
        {
            return false;
        }
        let suffix = host.get(authority.host().len()..).unwrap_or(":invalid");
        if !suffix.is_empty()
            && !suffix
                .strip_prefix(':')
                .is_some_and(|p| p.parse::<u16>().is_ok_and(|p| p > 0))
        {
            return false;
        }
        if headers.get_all("origin").iter().count() > 1
            || headers.get_all("sec-fetch-site").iter().count() > 1
        {
            return false;
        }
        let origin = headers.get("origin").and_then(|v| v.to_str().ok());
        if (mutation && origin != Some(self.app_origin.as_str()))
            || (origin.is_some() && origin != Some(self.app_origin.as_str()))
        {
            return false;
        }
        if let Some(site) = headers.get("sec-fetch-site") {
            return matches!(site.to_str(), Ok("same-origin" | "none"));
        }
        true
    }
    fn authorize_url(&self, state: &str, verifier: &str) -> String {
        let mut url = Url::parse(&format!("{}/bridge/authorize", self.auth_origin)).unwrap();
        url.query_pairs_mut().extend_pairs([
            ("response_type", "code"),
            ("client_id", &self.client_id),
            ("redirect_uri", &self.redirect_uri),
            ("state", state),
            ("code_challenge", &challenge(verifier)),
            ("code_challenge_method", "S256"),
        ]);
        url.into()
    }
}
impl AppState {
    pub fn with_web_auth(mut self, config: Option<Config>) -> Result<Self, &'static str> {
        if let Some(config) = config {
            if self
                .public_origin
                .as_deref()
                .is_some_and(|origin| origin != config.app_origin)
            {
                return Err("SPEKIOS_REDIRECT_URI must match SCOUT_PUBLIC_ORIGIN");
            }
            // The callback's HTTPS origin is explicit configuration, never a
            // forwarded header. Reuse it for existing agent-approval fences.
            if config.secure && self.public_origin.is_none() {
                self.public_origin = Some(Arc::from(config.app_origin.as_str()));
            }
            self.dev_auth_bypass = false;
            self.web_auth = Some(Arc::new(config));
        }
        Ok(self)
    }
}
fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    if headers.get_all(name).iter().count() != 1 {
        return None;
    }
    headers.get(name)?.to_str().ok()
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn random() -> String {
    let mut bytes = Vec::with_capacity(32);
    bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}
fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
fn opaque(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let mut found = None;
    for header in headers.get_all(header::COOKIE) {
        for part in header.to_str().ok()?.split(';') {
            let Some((key, value)) = part.trim().split_once('=') else {
                continue;
            };
            if key == name {
                if found.is_some() || !opaque(value) {
                    return None;
                }
                found = Some(value.to_string());
            }
        }
    }
    found
}
fn params(raw: Option<String>) -> Option<BTreeMap<String, String>> {
    let raw = raw.unwrap_or_default();
    if raw.len() > 4096 {
        return None;
    }
    let url = Url::parse(&format!("https://invalid.test/?{raw}")).ok()?;
    let mut values = BTreeMap::new();
    for (k, v) in url.query_pairs() {
        if values.insert(k.into_owned(), v.into_owned()).is_some() {
            return None;
        }
    }
    Some(values)
}
fn return_path(value: &str) -> Option<&str> {
    if value.len() > 1024 || value.bytes().any(|b| b <= 32 || b == 127 || b == b'\\') {
        return None;
    }
    let page = value.split('#').next()?;
    ["/", "/connect", "/issues"]
        .contains(&page)
        .then_some(value)
}
fn unavailable() -> Response {
    error(StatusCode::SERVICE_UNAVAILABLE, "sign_in_unavailable")
}
fn add_cookie(response: &mut Response, cookie: String) {
    response
        .headers_mut()
        .append(header::SET_COOKIE, cookie.parse().unwrap());
}

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(raw): RawQuery,
) -> Response {
    let Some(config) = &state.web_auth else {
        return unavailable();
    };
    // A landing-page link can legitimately start a cross-site top-level login.
    // Unlike cookie-authenticated API calls, entry/return navigations only need
    // the pinned authority; the login attempt itself supplies state and PKCE.
    let mut navigation_headers = headers.clone();
    navigation_headers.remove("origin");
    navigation_headers.remove("sec-fetch-site");
    if !config.browser_request(&navigation_headers, false) {
        return error(StatusCode::FORBIDDEN, "request_origin_not_allowed");
    }
    let Some(p) = params(raw) else {
        return error(StatusCode::BAD_REQUEST, "invalid_login_request");
    };
    let Some(next) = return_path(p.get("next").map(String::as_str).unwrap_or("/")) else {
        return error(StatusCode::BAD_REQUEST, "invalid_return_path");
    };
    let Some(db) = &state.database else {
        return unavailable();
    };
    let Ok(mut db) = db.write().await else {
        return unavailable();
    };
    let Ok(tx) = db.transaction().await else {
        return unavailable();
    };
    let (login_cookie, login_state, verifier) = (random(), random(), random());
    if tx
        .query_one("SELECT pg_advisory_xact_lock(736268194023)", &[])
        .await
        .is_err()
        || tx
            .execute(
                "DELETE FROM web_login_attempts WHERE expires_at<=now()",
                &[],
            )
            .await
            .is_err()
    {
        return unavailable();
    }
    if let Some(previous) = cookie_value(&headers, config.cookie_name(true)) {
        if tx
            .execute(
                "DELETE FROM web_login_attempts WHERE cookie_sha256=$1",
                &[&hash(&previous)],
            )
            .await
            .is_err()
        {
            return unavailable();
        }
    }
    let Ok(count) = tx
        .query_one("SELECT count(*) FROM web_login_attempts", &[])
        .await
    else {
        return unavailable();
    };
    if count.get::<_, i64>(0) >= 500 {
        return error(StatusCode::TOO_MANY_REQUESTS, "too_many_sign_in_attempts");
    }
    if tx.execute("INSERT INTO web_login_attempts(cookie_sha256,state_sha256,verifier,return_path) VALUES($1,$2,$3,$4)", &[&hash(&login_cookie), &hash(&login_state), &verifier, &next]).await.is_err() || tx.commit().await.is_err() { return unavailable(); }
    let mut response = Redirect::to(&config.authorize_url(&login_state, &verifier)).into_response();
    add_cookie(&mut response, config.cookie(true, &login_cookie, 600));
    response
}

#[derive(Deserialize)]
struct Identity {
    iss: String,
    sub: String,
    aud: String,
    email: Option<String>,
    email_verified: bool,
    handoff_id: Uuid,
    issued_at: i64,
}
impl Identity {
    fn valid(&self, config: &Config) -> bool {
        let now = chrono::Utc::now().timestamp();
        self.iss == config.issuer
            && self.aud == config.client_id
            && !self.sub.is_empty()
            && self.sub.len() <= 256
            && !self.sub.chars().any(char::is_control)
            && !self.handoff_id.is_nil()
            && self.issued_at <= now + 30
            && self.issued_at >= now - 120
            && self
                .email
                .as_ref()
                .is_none_or(|e| e.len() <= 320 && !e.chars().any(char::is_control))
    }
}
pub async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(raw): RawQuery,
) -> Response {
    let Some(config) = &state.web_auth else {
        return unavailable();
    };
    // Cross-site top-level return from Lovable is expected here. Check only the
    // configured authority; state and the host-only cookie protect the callback.
    let mut callback_headers = headers.clone();
    callback_headers.remove("origin");
    callback_headers.remove("sec-fetch-site");
    if !config.browser_request(&callback_headers, false) {
        return error(StatusCode::FORBIDDEN, "request_origin_not_allowed");
    }
    let mut response = finish_login(&state, &headers, raw).await;
    add_cookie(&mut response, config.cookie(true, "", 0));
    response
}
async fn finish_login(state: &AppState, headers: &HeaderMap, raw: Option<String>) -> Response {
    let config = state.web_auth.as_ref().unwrap();
    let Some(cookie) = cookie_value(headers, config.cookie_name(true)) else {
        return error(StatusCode::BAD_REQUEST, "sign_in_expired");
    };
    let Some(db) = &state.database else {
        return unavailable();
    };
    let Ok(mut db) = db.write().await else {
        return unavailable();
    };
    // Consume before validating or contacting Lovable: callback replay fails closed.
    let Ok(Some(attempt)) = db.query_opt("DELETE FROM web_login_attempts WHERE cookie_sha256=$1 RETURNING state_sha256,verifier,return_path,expires_at>now()", &[&hash(&cookie)]).await else { return error(StatusCode::BAD_REQUEST, "sign_in_expired"); };
    let Some(p) = params(raw) else {
        return error(StatusCode::BAD_REQUEST, "invalid_login_callback");
    };
    let expected: String = attempt.get(0);
    let returned = p.get("state").map(|s| hash(s)).unwrap_or_default();
    if !attempt.get::<_, bool>(3) || !bool::from(expected.as_bytes().ct_eq(returned.as_bytes())) {
        return error(StatusCode::BAD_REQUEST, "invalid_login_state");
    }
    let Some(code) = p.get("code").filter(|c| opaque(c)) else {
        return error(StatusCode::BAD_REQUEST, "sign_in_cancelled");
    };
    let verifier: String = attempt.get(1);
    let Ok(response) = config.http.post(format!("{}/api/public/bridge/token", config.auth_origin)).json(&serde_json::json!({
        "grant_type":"authorization_code", "client_id":config.client_id, "client_secret":config.client_secret,
        "redirect_uri":config.redirect_uri, "code":code, "code_verifier":verifier,
    })).send().await else { return error(StatusCode::BAD_GATEWAY, "sign_in_exchange_failed"); };
    if response.status() != StatusCode::OK || response.content_length().is_some_and(|n| n > 16_384)
    {
        return error(StatusCode::BAD_GATEWAY, "sign_in_exchange_failed");
    }
    let mut response = response;
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if body.len() + chunk.len() <= 16_384 => body.extend_from_slice(&chunk),
            Ok(None) => break,
            _ => return error(StatusCode::BAD_GATEWAY, "sign_in_exchange_failed"),
        }
    }
    let Ok(identity) = serde_json::from_slice::<Identity>(&body) else {
        return error(StatusCode::BAD_GATEWAY, "invalid_login_identity");
    };
    if !identity.valid(config) {
        return error(StatusCode::BAD_GATEWAY, "invalid_login_identity");
    }
    let Ok(tx) = db.transaction().await else {
        return unavailable();
    };
    // Serialize first login for a single immutable identity across API replicas.
    let identity_key = serde_json::to_string(&(&identity.iss, &identity.sub)).unwrap();
    if tx
        .query_one(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            &[&identity_key],
        )
        .await
        .is_err()
    {
        return unavailable();
    }
    let Ok(existing) = tx
        .query_opt(
            "SELECT user_id,workspace_id FROM web_identities WHERE issuer=$1 AND subject=$2",
            &[&identity.iss, &identity.sub],
        )
        .await
    else {
        return unavailable();
    };
    let (user, workspace) = if let Some(row) = existing {
        (row.get::<_, Uuid>(0), row.get::<_, Uuid>(1))
    } else {
        let (user, workspace) = (Uuid::new_v4(), Uuid::new_v4());
        if tx.execute("INSERT INTO workspaces(workspace_id,owner_user_id,name) VALUES($1,$2,'My workspace')", &[&workspace,&user]).await.is_err()
            || tx.execute("INSERT INTO web_identities(issuer,subject,user_id,workspace_id) VALUES($1,$2,$3,$4)", &[&identity.iss,&identity.sub,&user,&workspace]).await.is_err() { return unavailable(); }
        (user, workspace)
    };
    let session = random();
    if let Some(old) = cookie_value(headers, config.cookie_name(false)) {
        if tx
            .execute(
                "DELETE FROM web_sessions WHERE token_sha256=$1",
                &[&hash(&old)],
            )
            .await
            .is_err()
        {
            return unavailable();
        }
    }
    if tx
        .execute(
            "UPDATE web_identities SET email=$3,email_verified=$4 WHERE issuer=$1 AND subject=$2",
            &[
                &identity.iss,
                &identity.sub,
                &identity.email,
                &identity.email_verified,
            ],
        )
        .await
        .is_err()
        || tx
            .execute("DELETE FROM web_sessions WHERE expires_at<=now()", &[])
            .await
            .is_err()
        || tx
            .execute(
                "INSERT INTO web_sessions(token_sha256,user_id,workspace_id) VALUES($1,$2,$3)",
                &[&hash(&session), &user, &workspace],
            )
            .await
            .is_err()
        || tx.commit().await.is_err()
    {
        return unavailable();
    }
    let next: String = attempt.get(2);
    let mut response = Redirect::to(return_path(&next).unwrap_or("/")).into_response();
    add_cookie(
        &mut response,
        config.cookie(false, &session, SESSION_SECONDS),
    );
    response
}

pub(crate) async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    method: &Method,
) -> Result<Option<Principal>, Response> {
    let Some(config) = &state.web_auth else {
        return Ok(None);
    };
    let Some(token) = cookie_value(headers, config.cookie_name(false)) else {
        return Ok(None);
    };
    if !config.browser_request(
        headers,
        !matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS),
    ) {
        return Err(error(StatusCode::FORBIDDEN, "request_origin_not_allowed"));
    }
    let Some(db) = &state.database else {
        return Err(unavailable());
    };
    let db = db.read().await.map_err(|_| unavailable())?;
    let row = db.query_opt("SELECT s.user_id,s.workspace_id,w.name FROM web_sessions s JOIN workspaces w ON w.workspace_id=s.workspace_id AND w.owner_user_id=s.user_id WHERE s.token_sha256=$1 AND s.expires_at>now()", &[&hash(&token)]).await.map_err(|_| unavailable())?;
    Ok(row.map(|row| Principal {
        user_id: row.get(0),
        workspace_id: row.get(1),
        workspace_name: row.get(2),
        operator: false,
        ..Principal::default()
    }))
}
pub(crate) async fn account_email(state: &AppState) -> Result<Option<String>, Response> {
    let Some(config) = &state.web_auth else {
        return Ok(None);
    };
    if !state.principal.is_manager() {
        return Err(error(StatusCode::FORBIDDEN, "workspace_manager_required"));
    }
    let db = state.database.as_ref().ok_or_else(unavailable)?;
    let conn = db.read().await.map_err(|_| unavailable())?;
    let row = conn
        .query_opt(
            "SELECT email FROM web_identities WHERE issuer=$1 AND user_id=$2 AND workspace_id=$3 AND email_verified=true",
            &[&config.issuer, &state.principal.user_id, &state.principal.workspace_id],
        )
        .await
        .map_err(|_| unavailable())?;
    Ok(row
        .and_then(|row| row.get::<_, Option<String>>(0))
        .filter(|email| {
            email.len() <= 254
                && email.contains('@')
                && !email.chars().any(|c| c.is_control() || c.is_whitespace())
        }))
}
pub async fn logout_page(State(state): State<AppState>) -> Response {
    let mut r = Html("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Sign out · Spekios</title><h1>Sign out of Spekios</h1><form action=\"/logout\" method=\"post\"><button type=\"submit\">Sign out</button></form><p><a href=\"/\">Back to app</a></p></html>").into_response();
    // A navigation POST under no-referrer serializes Origin as null. Preserve
    // the origin for this same-origin form without sending referrers off-site;
    // the POST handler still requires the exact configured application origin.
    r.headers_mut()
        .insert(header::REFERRER_POLICY, "same-origin".parse().unwrap());
    // Browsers apply form-action to the POST's redirects too. Allow only the
    // configured identity provider's logout destination so both sessions end.
    let form_action = state
        .web_auth
        .as_ref()
        .map(|config| format!("'self' {}/logout", config.auth_origin))
        .unwrap_or_else(|| "'self'".into());
    r.headers_mut().insert(
        "content-security-policy",
        format!(
            "default-src 'none'; form-action {form_action}; frame-ancestors 'none'; base-uri 'none'"
        )
        .parse()
        .unwrap(),
    );
    r
}
pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(config) = &state.web_auth else {
        return unavailable();
    };
    if !config.browser_request(&headers, true) {
        return error(StatusCode::FORBIDDEN, "request_origin_not_allowed");
    }
    let Some(db) = &state.database else {
        return unavailable();
    };
    let Ok(db) = db.write().await else {
        return unavailable();
    };
    for (name, table, column) in [
        (config.cookie_name(false), "web_sessions", "token_sha256"),
        (
            config.cookie_name(true),
            "web_login_attempts",
            "cookie_sha256",
        ),
    ] {
        if let Some(token) = cookie_value(&headers, name) {
            if db
                .execute(
                    &format!("DELETE FROM {table} WHERE {column}=$1"),
                    &[&hash(&token)],
                )
                .await
                .is_err()
            {
                return unavailable();
            }
        }
    }
    let mut response = Redirect::to(&format!("{}/logout", config.auth_origin)).into_response();
    add_cookie(&mut response, config.cookie(false, "", 0));
    add_cookie(&mut response, config.cookie(true, "", 0));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        body::{Body, to_bytes},
        http::Request,
        routing::post,
    };
    use serde_json::{Value, json};
    use tower::ServiceExt;
    const TOKEN: &str = "test_operator_token_01234567890123456789";
    fn config() -> Config {
        Config::new(
            "https://login.example.test",
            "https://identity.example.test/auth/v1",
            "spekios-local",
            "test_client_secret_01234567890123456789",
            "http://localhost:18080/auth/callback",
        )
        .unwrap()
    }
    fn headers() -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("host", "localhost:18080".parse().unwrap());
        h
    }
    #[test]
    fn configuration_and_browser_fences() {
        let c = config();
        assert!(c.browser_request(&headers(), false));
        assert!(!c.browser_request(&headers(), true));
        let mut h = headers();
        h.insert("origin", "http://localhost:18080".parse().unwrap());
        assert!(c.browser_request(&h, true));
        h.insert("sec-fetch-site", "cross-site".parse().unwrap());
        assert!(!c.browser_request(&h, true));
        for host in [
            "evil.test",
            "localhost:18080/",
            "localhost:18080?x",
            "localhost:18080:",
            "user@localhost:18080",
        ] {
            let mut h = headers();
            h.insert("host", host.parse().unwrap());
            assert!(!c.browser_request(&h, false), "{host}");
        }
        for callback in [
            "http://app.test/auth/callback",
            "https://app.test/wrong",
            "https://a:b@app.test/auth/callback",
            "http://localhost:18080/auth/callback?next=evil",
        ] {
            assert!(
                Config::new(
                    "https://login.test",
                    "https://issuer.test",
                    "spekios-local",
                    &"s".repeat(40),
                    callback
                )
                .is_err()
            );
        }
        let s = AppState::new(None, TOKEN)
            .unwrap()
            .with_dev_auth_bypass(true)
            .with_web_auth(Some(c))
            .unwrap()
            .with_dev_auth_bypass(true);
        assert!(!s.dev_auth_bypass);
    }
    #[test]
    fn pkce_and_return_paths_and_cookies() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert!(opaque(&random()));
        for path in [
            "//evil.test",
            "/\\evil.test",
            "https://evil.test",
            "/login",
            "/%2fevil.test",
            "/connect?next=evil",
            "/\n",
        ] {
            assert!(return_path(path).is_none());
        }
        assert_eq!(
            return_path("/connect#authorization=abc"),
            Some("/connect#authorization=abc")
        );
        let c = config();
        let mut h = headers();
        let value = random();
        h.insert("cookie", format!("spekios_login={value}").parse().unwrap());
        assert_eq!(cookie_value(&h, c.cookie_name(true)), Some(value.clone()));
        h.append("cookie", format!("spekios_login={value}").parse().unwrap());
        assert!(cookie_value(&h, c.cookie_name(true)).is_none());
        assert!(!c.cookie(false, &value, 10).contains("Secure"));
        let prod = Config::new(
            "https://login.test",
            "https://issuer.test",
            "spekios",
            &"s".repeat(40),
            "https://app.test/auth/callback",
        )
        .unwrap();
        assert!(
            prod.cookie(false, &value, 10)
                .starts_with("__Host-spekios_session=")
        );
        assert!(prod.cookie(false, &value, 10).contains("; Secure"));
        let url = Url::parse(&c.authorize_url(&random(), &value)).unwrap();
        let p: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(p["code_challenge"], challenge(&value));
        assert_eq!(p["code_challenge_method"], "S256");
        assert!(!url.as_str().contains(&c.client_secret));
        assert!(params(Some("state=a&state=b".into())).is_none());
    }
    #[test]
    fn identity_must_match_trusted_issuer_audience_and_time() {
        let c = config();
        let mut i = Identity {
            iss: c.issuer.clone(),
            sub: Uuid::new_v4().to_string(),
            aud: c.client_id.clone(),
            email: None,
            email_verified: false,
            handoff_id: Uuid::new_v4(),
            issued_at: chrono::Utc::now().timestamp(),
        };
        assert!(i.valid(&c));
        i.iss = "https://evil.test".into();
        assert!(!i.valid(&c));
        i.iss = c.issuer.clone();
        i.aud = "other-app".into();
        assert!(!i.valid(&c));
        i.aud = c.client_id.clone();
        i.issued_at -= 1000;
        assert!(!i.valid(&c));
    }
    async fn call(
        app: &Router,
        method: &str,
        uri: &str,
        cookie: Option<&str>,
        origin: Option<&str>,
    ) -> Response {
        let mut b = Request::builder()
            .method(method)
            .uri(uri)
            .header("host", "localhost:18080");
        if let Some(c) = cookie {
            b = b.header("cookie", c);
        }
        if let Some(o) = origin {
            b = b.header("origin", o);
        }
        app.clone()
            .oneshot(b.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }
    fn response_cookie(r: &Response, name: &str) -> String {
        r.headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|h| h.to_str().ok())
            .find(|v| v.starts_with(&format!("{name}=")))
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .into()
    }
    async fn body(r: Response) -> Value {
        serde_json::from_slice(&to_bytes(r.into_body(), 65_536).await.unwrap()).unwrap()
    }
    async fn begin(app: &Router, old_cookie: Option<&str>) -> (String, String, String) {
        let mut request = Request::builder()
            .uri("/login?next=%2Fconnect")
            .header("host", "localhost:18080")
            .header("sec-fetch-site", "cross-site");
        if let Some(cookie) = old_cookie {
            request = request.header("cookie", cookie);
        }
        let r = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::SEE_OTHER);
        let cookie = response_cookie(&r, "spekios_login");
        let url = Url::parse(r.headers()["location"].to_str().unwrap()).unwrap();
        let p: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        (cookie, p["state"].clone(), p["code_challenge"].clone())
    }
    #[tokio::test]
    async fn unconfigured_login_fails_closed() {
        let app = crate::router(AppState::new(None, TOKEN).unwrap());
        assert_eq!(call(&app, "GET", "/login", None, None).await.status(), 503);
        assert_eq!(
            call(&app, "GET", "/auth/callback?code=x&state=y", None, None)
                .await
                .status(),
            503
        );
    }
    #[tokio::test]
    async fn logout_form_preserves_origin_without_relaxing_csrf() {
        let app = crate::router(
            AppState::new(None, TOKEN)
                .unwrap()
                .with_web_auth(Some(config()))
                .unwrap(),
        );
        let page = call(&app, "GET", "/logout", None, None).await;
        assert_eq!(page.status(), 200);
        assert_eq!(page.headers()[header::REFERRER_POLICY], "same-origin");
        assert_eq!(page.headers()[header::CACHE_CONTROL], "no-store");
        assert!(
            page.headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .contains("form-action 'self' https://login.example.test/logout;")
        );
        let unconfigured = crate::router(AppState::new(None, TOKEN).unwrap());
        let unconfigured = call(&unconfigured, "GET", "/logout", None, None).await;
        assert!(
            unconfigured.headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .contains("form-action 'self';")
        );
        for path in ["/login", "/auth/callback", "/"] {
            let response = call(&app, "GET", path, None, None).await;
            assert_eq!(response.headers()[header::REFERRER_POLICY], "no-referrer");
        }
        for origin in [None, Some("null"), Some("http://evil.test")] {
            assert_eq!(
                call(&app, "POST", "/logout", None, origin).await.status(),
                403
            );
        }
        let null_origin = Request::builder()
            .method("POST")
            .uri("/logout")
            .header("host", "localhost:18080")
            .header("origin", "null")
            .header("sec-fetch-site", "same-origin")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(null_origin).await.unwrap().status(),
            403
        );
        assert_eq!(
            call(
                &app,
                "POST",
                "/logout",
                None,
                Some("http://localhost:18080")
            )
            .await
            .status(),
            503,
            "valid same-origin form reaches the handler; this test has no database"
        );
    }
    #[tokio::test]
    #[ignore = "requires a disposable PostgreSQL database; see SPEKIOS_AUTH.md"]
    async fn postgres_login_lifecycle_and_isolation() {
        assert_eq!(
            std::env::var("SPEKIOS_AUTH_TEST_DB").as_deref(),
            Ok("1"),
            "Use only an isolated disposable database"
        );
        let db = Arc::new(crate::db::Postgres::connect().await.unwrap());
        // Never point this test at the application database.
        let conn = db.write().await.unwrap();
        conn.batch_execute("CREATE TABLE IF NOT EXISTS workspaces(workspace_id uuid PRIMARY KEY,owner_user_id uuid NOT NULL,name text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());").await.unwrap();
        conn.batch_execute(include_str!("../../../infra/postgres/024-web-auth.sql"))
            .await
            .unwrap();
        conn.batch_execute(
            "TRUNCATE web_sessions,web_login_attempts,web_identities,workspaces CASCADE",
        )
        .await
        .unwrap();
        drop(conn);
        let c = config();
        let expected_secret = c.client_secret.clone();
        let issuer = c.issuer.clone();
        let audience = c.client_id.clone();
        let subject = Arc::new(std::sync::atomic::AtomicUsize::new(1));
        let mock_subject = subject.clone();
        let mock=Router::new().route("/api/public/bridge/token",post(move |Json(p):Json<Value>| {
            let expected_secret=expected_secret.clone();let issuer=issuer.clone();let audience=audience.clone();let subject=mock_subject.clone();
            async move {
                assert_eq!(p["client_secret"],expected_secret);assert_eq!(p["redirect_uri"],"http://localhost:18080/auth/callback");
                let code=p["code"].as_str().unwrap();
                assert_eq!(challenge(p["code_verifier"].as_str().unwrap()),code);
                Json(json!({"iss":issuer,"aud":audience,"sub":format!("user-{}",subject.load(std::sync::atomic::Ordering::SeqCst)),"email":"same@example.test","email_verified":true,"handoff_id":Uuid::new_v4(),"issued_at":chrono::Utc::now().timestamp()}))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });
        let mut c = c;
        c.auth_origin = format!("http://{address}"); // Only tests may use HTTP for the exchange.
        let mut s = AppState::new(Some(db.clone()), TOKEN)
            .unwrap()
            .with_web_auth(Some(c))
            .unwrap();
        s.dev_auth_bypass = false;
        let app = crate::router(s);
        let (cookie, st, code) = begin(&app, None).await;
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("/auth/callback?code={code}&state={st}"),
                None,
                None
            )
            .await
            .status(),
            400
        );
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("/auth/callback?code={code}&state=wrong"),
                Some(&cookie),
                None
            )
            .await
            .status(),
            400
        );
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("/auth/callback?code={code}&state={st}"),
                Some(&cookie),
                None
            )
            .await
            .status(),
            400,
            "bad state consumed the attempt"
        );
        let (cookie, st, code) = begin(&app, None).await;
        let r = call(
            &app,
            "GET",
            &format!("/auth/callback?code={code}&state={st}"),
            Some(&cookie),
            None,
        )
        .await;
        assert_eq!(r.status(), 303);
        assert_eq!(r.headers()["location"], "/connect");
        let session = response_cookie(&r, "spekios_session");
        let first = body(call(&app, "GET", "/v1/identity", Some(&session), None).await).await;
        assert_ne!(first["workspace_id"], crate::WORKSPACE_ID.to_string());
        let signup = body(
            call(
                &app,
                "GET",
                "/v1/browser-access/account-identity",
                Some(&session),
                None,
            )
            .await,
        )
        .await;
        assert_eq!(
            signup,
            json!({"source":"lovable","email":"same@example.test"})
        );
        let conn = db.write().await.unwrap();
        // Identity JSON deliberately omits user/email details. Find this exact
        // cookie's identity to verify that unverified contact data is not reused.
        let token = session.split_once('=').unwrap().1;
        let user = conn
            .query_one(
                "SELECT user_id FROM web_sessions WHERE token_sha256=$1",
                &[&hash(token)],
            )
            .await
            .unwrap()
            .get::<_, Uuid>(0);
        conn.execute(
            "UPDATE web_identities SET email_verified=false WHERE user_id=$1",
            &[&user],
        )
        .await
        .unwrap();
        drop(conn);
        let unverified = body(
            call(
                &app,
                "GET",
                "/v1/browser-access/account-identity",
                Some(&session),
                None,
            )
            .await,
        )
        .await;
        assert_eq!(unverified, json!({"source":null,"email":null}));
        db.write()
            .await
            .unwrap()
            .execute(
                "UPDATE web_identities SET email_verified=true WHERE user_id=$1",
                &[&user],
            )
            .await
            .unwrap();
        assert_eq!(
            call(
                &app,
                "POST",
                "/v1/exploration-settings",
                Some(&session),
                Some("http://evil.test")
            )
            .await
            .status(),
            403
        );
        assert_eq!(
            call(
                &app,
                "POST",
                "/v1/exploration-settings",
                Some(&session),
                None
            )
            .await
            .status(),
            403
        );
        assert_eq!(
            call(
                &app,
                "POST",
                "/v1/exploration-settings",
                Some(&session),
                Some("http://localhost:18080")
            )
            .await
            .status(),
            503,
            "same-origin cookie reaches the handler (queue is absent in this test)"
        );
        assert_eq!(
            call(&app, "POST", "/mcp", Some(&session), None)
                .await
                .status(),
            401,
            "MCP never accepts a human cookie"
        );
        let (login, st, code) = begin(&app, Some(&session)).await;
        let both = format!("{login}; {session}");
        let r = call(
            &app,
            "GET",
            &format!("/auth/callback?code={code}&state={st}"),
            Some(&both),
            None,
        )
        .await;
        assert_eq!(r.status(), 303);
        let new_session = response_cookie(&r, "spekios_session");
        let again = body(call(&app, "GET", "/v1/identity", Some(&new_session), None).await).await;
        assert_eq!(first["workspace_id"], again["workspace_id"]);
        subject.store(2, std::sync::atomic::Ordering::SeqCst);
        let (second_login, second_state, second_code) = begin(&app, None).await;
        let second_response = call(
            &app,
            "GET",
            &format!("/auth/callback?code={second_code}&state={second_state}"),
            Some(&second_login),
            None,
        )
        .await;
        assert_eq!(second_response.status(), 303);
        let second_session = response_cookie(&second_response, "spekios_session");
        let second =
            body(call(&app, "GET", "/v1/identity", Some(&second_session), None).await).await;
        let second_workspace = Uuid::parse_str(second["workspace_id"].as_str().unwrap()).unwrap();
        db.write()
            .await
            .unwrap()
            .execute(
                "UPDATE web_identities SET email='other@example.test' WHERE workspace_id=$1",
                &[&second_workspace],
            )
            .await
            .unwrap();
        let first_signup = body(
            call(
                &app,
                "GET",
                "/v1/browser-access/account-identity",
                Some(&new_session),
                None,
            )
            .await,
        )
        .await;
        let second_signup = body(
            call(
                &app,
                "GET",
                "/v1/browser-access/account-identity",
                Some(&second_session),
                None,
            )
            .await,
        )
        .await;
        assert_eq!(first_signup["email"], "same@example.test");
        assert_eq!(second_signup["email"], "other@example.test");
        assert_ne!(
            first["workspace_id"], second["workspace_id"],
            "same email never merges identities"
        );
        assert_eq!(
            db.read()
                .await
                .unwrap()
                .query_one("SELECT count(*) FROM web_identities", &[])
                .await
                .unwrap()
                .get::<_, i64>(0),
            2
        );
        db.write().await.unwrap().execute("UPDATE web_sessions SET expires_at=now()-interval '1 second' WHERE token_sha256=$1",&[&hash(second_session.split_once('=').unwrap().1)]).await.unwrap();
        assert_eq!(
            call(&app, "GET", "/v1/identity", Some(&second_session), None)
                .await
                .status(),
            401
        );
        assert_eq!(
            call(&app, "GET", "/v1/identity", Some(&session), None)
                .await
                .status(),
            401,
            "old session rotated"
        );
        assert_eq!(
            call(
                &app,
                "POST",
                "/logout",
                Some(&new_session),
                Some("http://evil.test")
            )
            .await
            .status(),
            403
        );
        assert_eq!(
            call(
                &app,
                "POST",
                "/logout",
                Some(&new_session),
                Some("http://localhost:18080")
            )
            .await
            .status(),
            303
        );
        assert_eq!(
            call(&app, "GET", "/v1/identity", Some(&new_session), None)
                .await
                .status(),
            401
        );
        let (cookie, st, code) = begin(&app, None).await;
        db.write()
            .await
            .unwrap()
            .execute(
                "UPDATE web_login_attempts SET expires_at=now()-interval '1 second'",
                &[],
            )
            .await
            .unwrap();
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("/auth/callback?code={code}&state={st}"),
                Some(&cookie),
                None
            )
            .await
            .status(),
            400
        );
        server.abort();
    }
}
