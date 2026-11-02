//! Named, account-scoped provider keys and an independently metered demo key.
//! Only credential references leave this module. Budget checks and reservations
//! share the dispatch transaction; uncertain usage keeps its reservation.
use crate::{
    AppState, error,
    gateway::hash,
    identity::{Principal, ScopedState},
    models::{CallResult, Provider},
};
use axum::{
    Json,
    extract::Path,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{env, sync::Arc};
use tokio_postgres::{GenericClient, Transaction};
use uuid::Uuid;

type Result<T> = std::result::Result<T, &'static str>;
pub const DEMO_MODEL: &str = "muse-spark-1.3-contributor";
// Contributor input $0.10/M, output $0.20/M, cached input $0.002/M.
// Reserve Meta's counted input plus the output cap, including images and
// reasoning. Never use user-entered model prices or image-size token guesses.
const CONTEXT_TOKENS: i64 = 1_048_576;
pub fn demo_reservation(input_tokens: i64, max_output: u32) -> i64 {
    (input_tokens * 100 + i64::from(max_output) * 200 + 999) / 1000
}
fn supported_demo(model: &str) -> bool {
    model == DEMO_MODEL
}
pub fn valid_reference(reference: &str) -> bool {
    reference == "demo" || reference.parse::<Uuid>().is_ok_and(|id| !id.is_nil())
}
fn valid_secret(value: &str) -> bool {
    (8..=4096).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_graphic())
}

pub struct Vault(aead::LessSafeKey);
impl Vault {
    pub fn from_env() -> Result<Option<Self>> {
        let key = env::var("SCOUT_PROVIDER_VAULT_KEY").unwrap_or_default();
        if key.is_empty() {
            return Ok(None);
        }
        if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid_provider_vault_key");
        }
        let bytes = (0..32)
            .map(|i| {
                u8::from_str_radix(&key[i * 2..i * 2 + 2], 16)
                    .map_err(|_| "invalid_provider_vault_key")
            })
            .collect::<Result<Vec<_>>>()?;
        Self::new(&bytes).map(Some)
    }
    fn new(bytes: &[u8]) -> Result<Self> {
        Ok(Self(aead::LessSafeKey::new(
            aead::UnboundKey::new(&aead::AES_256_GCM, bytes)
                .map_err(|_| "invalid_provider_vault_key")?,
        )))
    }
    fn seal(&self, secret: &str, binding: &str) -> Result<Vec<u8>> {
        let mut nonce = [0u8; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| "provider_vault_unavailable")?;
        let mut body = secret.as_bytes().to_vec();
        self.0
            .seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(binding.as_bytes()),
                &mut body,
            )
            .map_err(|_| "provider_vault_unavailable")?;
        Ok([nonce.as_slice(), body.as_slice()].concat())
    }
    pub fn open(&self, encrypted: &[u8], binding: &str) -> Result<String> {
        if encrypted.len() < 28 || encrypted.len() > 8192 {
            return Err("provider_key_unavailable");
        }
        let nonce: [u8; 12] = encrypted[..12]
            .try_into()
            .map_err(|_| "provider_key_unavailable")?;
        let mut body = encrypted[12..].to_vec();
        let plain = self
            .0
            .open_in_place(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(binding.as_bytes()),
                &mut body,
            )
            .map_err(|_| "provider_key_unavailable")?;
        String::from_utf8(plain.to_vec()).map_err(|_| "provider_key_unavailable")
    }
}
fn binding(
    id: Uuid,
    scope: &str,
    workspace: Option<Uuid>,
    user: Option<Uuid>,
    provider: &str,
) -> String {
    json!(["provider-key-v1", id, scope, workspace, user, provider]).to_string()
}
pub async fn key_secret<C: GenericClient + Sync>(
    db: &C,
    vault: Option<&Vault>,
    id: Uuid,
    provider: Provider,
) -> Result<String> {
    let vault = vault.ok_or("provider_vault_not_configured")?;
    let r=db.query_opt("SELECT scope,workspace_id,user_id,provider,encrypted_key FROM provider_keys WHERE key_id=$1 AND revoked_at IS NULL",&[&id]).await.map_err(|_| "database_unavailable")?.ok_or("provider_key_unavailable")?;
    let p: String = r.get(3);
    if p != provider.name() {
        return Err("provider_key_provider_mismatch");
    }
    vault.open(
        &r.get::<_, Vec<u8>>(4),
        &binding(id, &r.get::<_, String>(0), r.get(1), r.get(2), &p),
    )
}

pub async fn demo_status<C: GenericClient + Sync>(db: &C, user: Uuid) -> Result<Value> {
    let r=db.query_one("SELECT enabled,allowance_microusd,model,EXISTS(SELECT 1 FROM provider_keys k WHERE k.key_id=s.key_id AND k.revoked_at IS NULL),revision,updated_at::text FROM demo_settings s WHERE singleton",&[]).await.map_err(|_| "database_unavailable")?;
    let spent=db.query_one("SELECT COALESCE(sum(charged_microusd) FILTER(WHERE state='settled'),0)::bigint,COALESCE(sum(reserved_microusd) FILTER(WHERE state IN ('reserved','held')),0)::bigint,count(*) FILTER(WHERE state='held') FROM demo_reservations WHERE user_id=$1",&[&user]).await.map_err(|_| "database_unavailable")?;
    let limit: i64 = r.get(1);
    let used: i64 = spent.get(0);
    let held: i64 = spent.get(1);
    Ok(
        json!({"enabled":r.get::<_,bool>(0),"configured":r.get::<_,bool>(3),"model":r.get::<_,String>(2),"provider":"meta","label":"Spekios demo key","allowance_usd":limit as f64/1e6,"spent_usd":used as f64/1e6,"reserved_usd":held as f64/1e6,"remaining_usd":(limit-used-held).max(0) as f64/1e6,"minimum_call_reserve_usd":demo_reservation(0,4096) as f64/1e6,"uncertain_calls":spent.get::<_,i64>(2),"revision":r.get::<_,i64>(4),"updated_at":r.get::<_,String>(5),"period":"lifetime","contributor_mode":true}),
    )
}
pub async fn personal_keys<C: GenericClient + Sync>(db: &C, p: &Principal) -> Result<Value> {
    Ok(db.query_one("SELECT COALESCE(jsonb_agg(jsonb_build_object('key_id',key_id,'provider',provider,'name',name,'is_default',is_default,'created_at',created_at) ORDER BY provider,created_at,key_id),'[]'::jsonb) FROM provider_keys WHERE scope='personal' AND workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL",&[&p.workspace_id,&p.user_id]).await.map_err(|_| "database_unavailable")?.get(0))
}
pub async fn account_defaults<C: GenericClient + Sync>(
    db: &C,
    p: &Principal,
    settings: &mut Value,
) -> Result<()> {
    if p.operator {
        return Ok(());
    }
    let model: String = db
        .query_one("SELECT model FROM demo_settings WHERE singleton", &[])
        .await
        .map_err(|_| "database_unavailable")?
        .get(0);
    settings["provider"] = json!("meta");
    settings["model"] = json!(model);
    settings["freeOnly"] = json!(false);
    settings["providerKeyId"] = json!("demo");
    Ok(())
}

#[derive(Clone)]
pub struct Funding {
    pub source: &'static str,
    pub key_id: Option<Uuid>,
}
pub async fn resolve<C: GenericClient + Sync>(
    db: &C,
    p: &Principal,
    provider: Provider,
    model: &str,
    reference: Option<&str>,
    check_balance: bool,
) -> Result<Funding> {
    if reference == Some("demo") {
        let r = db
            .query_one(
                "SELECT enabled,model,key_id FROM demo_settings WHERE singleton",
                &[],
            )
            .await
            .map_err(|_| "database_unavailable")?;
        if provider != Provider::Meta || model != r.get::<_, String>(1) || !supported_demo(model) {
            return Err("demo_model_only");
        }
        if !r.get::<_, bool>(0) {
            return Err("demo_unavailable");
        }
        let id: Option<Uuid> = r.get(2);
        let id = id.ok_or("demo_unavailable")?;
        if db.query_opt("SELECT 1 FROM provider_keys WHERE key_id=$1 AND scope='demo' AND revoked_at IS NULL",&[&id]).await.map_err(|_| "database_unavailable")?.is_none() { return Err("demo_unavailable"); }
        if check_balance {
            let status = demo_status(db, p.user_id).await?;
            if status["remaining_usd"].as_f64().unwrap_or(0.) * 1e6
                < demo_reservation(0, 4096) as f64
            {
                return Err("demo_credits_insufficient");
            }
        }
        return Ok(Funding {
            source: "demo",
            key_id: Some(id),
        });
    }
    let id = reference
        .map(|s| {
            s.parse::<Uuid>()
                .map_err(|_| "invalid_provider_key_reference")
        })
        .transpose()?;
    if let Some(r)=db.query_opt("SELECT key_id FROM provider_keys WHERE scope='personal' AND workspace_id=$1 AND user_id=$2 AND provider=$3 AND revoked_at IS NULL AND (($4::uuid IS NOT NULL AND key_id=$4) OR ($4::uuid IS NULL AND is_default))",&[&p.workspace_id,&p.user_id,&provider.name(),&id]).await.map_err(|_| "database_unavailable")? {
        return Ok(Funding {source:"personal",key_id:Some(r.get(0))});
    }
    if id.is_some() {
        return Err("provider_key_unavailable");
    }
    if p.operator {
        Ok(Funding {
            source: "operator",
            key_id: None,
        })
    } else {
        Err("provider_key_required")
    }
}
pub async fn bind_settings(
    tx: &Transaction<'_>,
    p: &Principal,
    settings: &mut Value,
) -> Result<()> {
    for navigation in [false, true] {
        let mut choice = if navigation {
            settings["navigationModel"].clone()
        } else {
            settings.clone()
        };
        if navigation && choice.is_null() {
            continue;
        }
        let provider: Provider = serde_json::from_value(choice["provider"].clone())
            .map_err(|_| "invalid_settings_provider")?;
        let model = choice["model"].as_str().ok_or("invalid_settings_model")?;
        let reference = choice["providerKeyId"].as_str();
        // Navigation using the same provider can inherit the explicit key.
        let reference = reference.or_else(|| {
            (navigation && choice["provider"] == settings["provider"])
                .then(|| settings["providerKeyId"].as_str())
                .flatten()
        });
        let funding = resolve(tx, p, provider, model, reference, true).await?;
        if funding.source == "demo" {
            choice["providerKeyId"] = json!("demo");
        } else if let Some(id) = funding.key_id {
            choice["providerKeyId"] = json!(id);
        }
        if navigation {
            settings["navigationModel"] = choice;
        } else {
            settings["providerKeyId"] = choice["providerKeyId"].clone();
        }
    }
    Ok(())
}
pub async fn reserve(
    tx: &Transaction<'_>,
    user: Uuid,
    call: Uuid,
    input: i64,
    output: u32,
    model: &str,
) -> Result<()> {
    // Global configuration is read-locked through reservation commit.
    let config = tx
        .query_one(
            "SELECT enabled,allowance_microusd,model FROM demo_settings WHERE singleton FOR SHARE",
            &[],
        )
        .await
        .map_err(|_| "database_unavailable")?;
    if !config.get::<_, bool>(0) {
        return Err("demo_unavailable");
    }
    if config.get::<_, String>(2) != model || !(0..=CONTEXT_TOKENS).contains(&input) {
        return Err("demo_model_only");
    }
    tx.execute(
        "INSERT INTO demo_accounts(user_id) VALUES($1) ON CONFLICT DO NOTHING",
        &[&user],
    )
    .await
    .map_err(|_| "database_unavailable")?;
    tx.query_one(
        "SELECT user_id FROM demo_accounts WHERE user_id=$1 FOR UPDATE",
        &[&user],
    )
    .await
    .map_err(|_| "database_unavailable")?;
    let used:i64=tx.query_one("SELECT COALESCE(sum(CASE WHEN state='settled' THEN charged_microusd ELSE reserved_microusd END),0)::bigint FROM demo_reservations WHERE user_id=$1",&[&user]).await.map_err(|_| "database_unavailable")?.get(0);
    let amount = demo_reservation(input, output);
    if used
        .checked_add(amount)
        .is_none_or(|sum| sum > config.get::<_, i64>(1))
    {
        return Err("demo_credits_insufficient");
    }
    tx.execute(
        "INSERT INTO demo_reservations(call_id,user_id,reserved_microusd) VALUES($1,$2,$3)",
        &[&call, &user, &amount],
    )
    .await
    .map_err(|_| "database_unavailable")?;
    Ok(())
}
fn reported_micros(value: &str) -> Option<i64> {
    let (whole, frac) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !frac.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let base = whole.parse::<i64>().ok()?.checked_mul(1_000_000)?;
    let digits = format!("{frac:0<6}");
    let micros = digits[..6].parse::<i64>().ok()?;
    base.checked_add(micros)?.checked_add(i64::from(
        frac.as_bytes().iter().skip(6).any(|b| *b != b'0'),
    ))
}
fn settlement_charge(result: &CallResult) -> Option<i64> {
    if !result.response_complete {
        return None;
    }
    let u = &result.usage;
    let known = u.cost_usd.as_deref().and_then(reported_micros).or_else(|| {
        if u.usage_status != "reported" {
            return None;
        }
        let (input, output) = (u.input_tokens?, u.output_tokens?);
        let cached = u.cached_input_tokens.unwrap_or(0);
        if input < 0 || output < 0 || cached < 0 || cached > input {
            return None;
        }
        (input - cached)
            .checked_mul(100)?
            .checked_add(cached.checked_mul(2)?)?
            .checked_add(output.checked_mul(200)?)?
            .checked_add(999)
            .map(|n| n / 1000)
    });
    // Respect explicitly reported charges even if a provider returns an error.
    known.or_else(|| {
        matches!(result.http_status, Some(400 | 401 | 403 | 404 | 422 | 429)).then_some(0)
    })
}
pub async fn settle(tx: &Transaction<'_>, result: &CallResult) -> Result<()> {
    let Some(account) = tx
        .query_opt(
            "SELECT user_id FROM demo_reservations WHERE call_id=$1",
            &[&result.call_id],
        )
        .await
        .map_err(|_| "database_settlement_failed")?
    else {
        return Ok(());
    };
    tx.query_one(
        "SELECT user_id FROM demo_accounts WHERE user_id=$1 FOR UPDATE",
        &[&account.get::<_, Uuid>(0)],
    )
    .await
    .map_err(|_| "database_settlement_failed")?;
    let cost = settlement_charge(result);
    tx.execute("UPDATE demo_reservations SET charged_microusd=$2,state=CASE WHEN $2::bigint IS NULL THEN 'held' ELSE 'settled' END,settled_at=now() WHERE call_id=$1 AND state='reserved'",&[&result.call_id,&cost]).await.map_err(|_| "database_settlement_failed")?;
    Ok(())
}

fn failure(code: &'static str) -> Response {
    error(
        match code {
            "provider_key_not_found" => StatusCode::NOT_FOUND,
            "provider_key_id_conflict" | "revision_conflict" => StatusCode::CONFLICT,
            "provider_vault_not_configured" | "database_unavailable" => {
                StatusCode::SERVICE_UNAVAILABLE
            }
            _ => StatusCode::BAD_REQUEST,
        },
        code,
    )
}
fn gateway(state: &AppState) -> Result<&Arc<crate::gateway::Gateway>> {
    state
        .gateway
        .as_ref()
        .ok_or("provider_vault_not_configured")
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewKey {
    key_id: Uuid,
    provider: Provider,
    name: String,
    api_key: String,
    #[serde(default)]
    make_default: bool,
}
pub async fn create_key(
    ScopedState(state): ScopedState,
    body: std::result::Result<Json<NewKey>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if !state.principal.is_manager() && !state.principal.operator {
        return error(StatusCode::FORBIDDEN, "workspace_manager_required");
    }
    let Ok(Json(input)) = body else {
        return failure("invalid_provider_key");
    };
    let name = input.name.trim();
    if input.key_id.is_nil()
        || name.is_empty()
        || name.chars().count() > 60
        || name.chars().any(char::is_control)
        || !valid_secret(&input.api_key)
        || name.contains(&input.api_key)
    {
        return failure("invalid_provider_key");
    }
    let result=async {
        let g=gateway(&state)?;let vault=g.vault.as_ref().ok_or("provider_vault_not_configured")?;
        let db=state.database.as_ref().ok_or("database_unavailable")?;let mut db=db.write().await?;let tx=db.transaction().await.map_err(|_| "database_unavailable")?;
        let p=&state.principal; let fingerprint=hash(input.api_key.as_bytes());
        tx.query_one("SELECT pg_advisory_xact_lock(hashtextextended($1,9128))",&[&p.user_id.to_string()]).await.map_err(|_| "database_unavailable")?;
        if let Some(r)=tx.query_opt("SELECT workspace_id,user_id,provider,name,secret_sha256,revoked_at IS NULL FROM provider_keys WHERE key_id=$1",&[&input.key_id]).await.map_err(|_| "database_unavailable")? {
            if r.get::<_,Option<Uuid>>(0)!=Some(p.workspace_id)||r.get::<_,Option<Uuid>>(1)!=Some(p.user_id)||r.get::<_,String>(2)!=input.provider.name()||r.get::<_,String>(3)!=name||r.get::<_,String>(4)!=fingerprint||!r.get::<_,bool>(5) {return Err("provider_key_id_conflict");}
            return Ok(json!({"key_id":input.key_id,"created":false}));
        }
        let n:i64=tx.query_one("SELECT count(*) FROM provider_keys WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL",&[&p.workspace_id,&p.user_id]).await.map_err(|_| "database_unavailable")?.get(0);
        if n>=50 {return Err("provider_key_limit");}
        let first:bool=tx.query_one("SELECT NOT EXISTS(SELECT 1 FROM provider_keys WHERE workspace_id=$1 AND user_id=$2 AND provider=$3 AND is_default AND revoked_at IS NULL)",&[&p.workspace_id,&p.user_id,&input.provider.name()]).await.map_err(|_| "database_unavailable")?.get(0);
        if input.make_default || first { tx.execute("UPDATE provider_keys SET is_default=false WHERE workspace_id=$1 AND user_id=$2 AND provider=$3",&[&p.workspace_id,&p.user_id,&input.provider.name()]).await.map_err(|_| "database_unavailable")?; }
        let encrypted=vault.seal(&input.api_key,&binding(input.key_id,"personal",Some(p.workspace_id),Some(p.user_id),input.provider.name()))?;
        tx.execute("INSERT INTO provider_keys(key_id,scope,workspace_id,user_id,provider,name,encrypted_key,secret_sha256,is_default) VALUES($1,'personal',$2,$3,$4,$5,$6,$7,$8)",&[&input.key_id,&p.workspace_id,&p.user_id,&input.provider.name(),&name,&encrypted,&fingerprint,&(input.make_default||first)]).await.map_err(|_| "database_unavailable")?;
        tx.commit().await.map_err(|_| "database_unavailable")?;
        Ok(json!({"key_id":input.key_id,"created":true}))
    }.await;
    match result {
        Ok(v) => (
            if v["created"] == true {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            },
            Json(v),
        )
            .into_response(),
        Err(e) => failure(e),
    }
}
pub async fn revoke_key(ScopedState(state): ScopedState, Path(id): Path<Uuid>) -> Response {
    change_key(&state, id, false).await
}
pub async fn default_key(ScopedState(state): ScopedState, Path(id): Path<Uuid>) -> Response {
    change_key(&state, id, true).await
}
async fn change_key(state: &AppState, id: Uuid, make_default: bool) -> Response {
    if !state.principal.is_manager() && !state.principal.operator {
        return error(StatusCode::FORBIDDEN, "workspace_manager_required");
    }
    let result=async {
        let mut db=state.database.as_ref().ok_or("database_unavailable")?.write().await?;let tx=db.transaction().await.map_err(|_| "database_unavailable")?;let p=&state.principal;
        tx.query_one("SELECT pg_advisory_xact_lock(hashtextextended($1,9128))",&[&p.user_id.to_string()]).await.map_err(|_| "database_unavailable")?;
        let r=tx.query_opt("SELECT provider FROM provider_keys WHERE key_id=$1 AND scope='personal' AND workspace_id=$2 AND user_id=$3 AND revoked_at IS NULL FOR UPDATE",&[&id,&p.workspace_id,&p.user_id]).await.map_err(|_| "database_unavailable")?.ok_or("provider_key_not_found")?;
        if make_default {tx.execute("UPDATE provider_keys SET is_default=false WHERE workspace_id=$1 AND user_id=$2 AND provider=$3",&[&p.workspace_id,&p.user_id,&r.get::<_,String>(0)]).await.map_err(|_| "database_unavailable")?;}
        tx.execute("UPDATE provider_keys SET is_default=$2,revoked_at=CASE WHEN $2 THEN NULL ELSE now() END WHERE key_id=$1",&[&id,&make_default]).await.map_err(|_| "database_unavailable")?;
        tx.commit().await.map_err(|_| "database_unavailable")?;Ok(json!({"key_id":id,"revoked":!make_default,"is_default":make_default}))
    }.await;
    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => failure(e),
    }
}
pub async fn admin_get(ScopedState(state): ScopedState) -> Response {
    if !state.principal.operator {
        return error(StatusCode::FORBIDDEN, "operator_required");
    }
    let result = async {
        let db = state
            .database
            .as_ref()
            .ok_or("database_unavailable")?
            .write()
            .await?;
        let mut v = demo_status(&**db, state.principal.user_id).await?;
        v["vault_ready"] = json!(state.gateway.as_ref().is_some_and(|g| g.vault.is_some()));
        Ok(v)
    }
    .await;
    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => failure(e),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DemoUpdate {
    expected_revision: i64,
    enabled: bool,
    allowance_usd: f64,
    model: String,
    #[serde(default)]
    api_key: Option<String>,
}
pub async fn admin_update(
    ScopedState(state): ScopedState,
    body: std::result::Result<Json<DemoUpdate>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if !state.principal.operator {
        return error(StatusCode::FORBIDDEN, "operator_required");
    }
    let Ok(Json(input)) = body else {
        return failure("invalid_demo_settings");
    };
    if input.expected_revision < 0
        || !input.allowance_usd.is_finite()
        || !(0.0..=1000.0).contains(&input.allowance_usd)
        || !supported_demo(&input.model)
        || input.api_key.as_ref().is_some_and(|s| !valid_secret(s))
    {
        return failure("invalid_demo_settings");
    }
    let result=async {
        let mut db=state.database.as_ref().ok_or("database_unavailable")?.write().await?;let tx=db.transaction().await.map_err(|_| "database_unavailable")?;
        let r=tx.query_one("SELECT revision,key_id FROM demo_settings WHERE singleton FOR UPDATE",&[]).await.map_err(|_| "database_unavailable")?;
        if r.get::<_,i64>(0)!=input.expected_revision {return Err("revision_conflict");}
        let mut id:Option<Uuid>=r.get(1);
        if let Some(secret)=&input.api_key {
            let vault=gateway(&state)?.vault.as_ref().ok_or("provider_vault_not_configured")?;
            let next=Uuid::new_v4();let encrypted=vault.seal(secret,&binding(next,"demo",None,None,"meta"))?;
            tx.execute("INSERT INTO provider_keys(key_id,scope,provider,name,encrypted_key,secret_sha256) VALUES($1,'demo','meta','Spekios demo key',$2,$3)",&[&next,&encrypted,&hash(secret.as_bytes())]).await.map_err(|_| "database_unavailable")?;
            if let Some(old)=id {tx.execute("UPDATE provider_keys SET revoked_at=now() WHERE key_id=$1",&[&old]).await.map_err(|_| "database_unavailable")?;}
            id=Some(next);
        }
        if input.enabled && id.is_none() {return Err("demo_key_required");}
        if input.enabled && gateway(&state)?.vault.is_none() {return Err("provider_vault_not_configured");}
        let limit=(input.allowance_usd*1e6).round() as i64;
        tx.execute("UPDATE demo_settings SET enabled=$1,allowance_microusd=$2,model=$3,key_id=$4,revision=revision+1,updated_at=now() WHERE singleton",&[&input.enabled,&limit,&input.model,&id]).await.map_err(|_| "database_unavailable")?;
        tx.commit().await.map_err(|_| "database_unavailable")?;Ok(json!({"saved":true,"revision":input.expected_revision+1}))
    }.await;
    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => failure(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vault_binds_ciphertext_to_account_provider_and_key() {
        let vault = Vault::new(&[27; 32]).unwrap();
        let id = Uuid::new_v4();
        let owner = Uuid::new_v4();
        let aad = binding(id, "personal", Some(owner), Some(owner), "meta");
        let sealed = vault.seal("test-secret-never-returned", &aad).unwrap();
        assert!(!sealed.windows(11).any(|s| s == b"test-secret"));
        assert_eq!(
            vault.open(&sealed, &aad).unwrap(),
            "test-secret-never-returned"
        );
        assert!(
            vault
                .open(
                    &sealed,
                    &binding(id, "personal", Some(owner), Some(Uuid::new_v4()), "meta")
                )
                .is_err()
        );
        assert!(
            vault
                .open(
                    &sealed,
                    &binding(id, "personal", Some(owner), Some(owner), "openai")
                )
                .is_err()
        );
        let mut tampered = sealed.clone();
        tampered[13] ^= 1;
        assert!(vault.open(&tampered, &aad).is_err());
        assert!(Vault::new(&[28; 32]).unwrap().open(&sealed, &aad).is_err());
        assert!(vault.open(&[0; 12], &aad).is_err());
    }
    #[test]
    fn prices_round_up_and_keys_never_become_agent_capabilities() {
        assert_eq!(reported_micros("0.0000001"), Some(1));
        assert_eq!(reported_micros("1.0000010"), Some(1_000_001));
        assert_eq!(reported_micros("-1"), None);
        assert_eq!(demo_reservation(5000, 2000), 900);
        assert_eq!(demo_reservation(0, 4096), 820);
        let mut reported = CallResult::unknown(Uuid::new_v4(), "test");
        assert_eq!(settlement_charge(&reported), None);
        reported.response_complete = true;
        reported.http_status = Some(429);
        assert_eq!(settlement_charge(&reported), Some(0));
        reported.usage.cost_usd = Some("0.001".into());
        assert_eq!(settlement_charge(&reported), Some(1000));
        assert!(!valid_reference("sk-this-is-not-a-key-id"));
        let manager = Principal {
            operator: false,
            ..Principal::default()
        };
        assert!(!crate::identity::permitted(
            &manager,
            "POST",
            "/v1/admin/demo"
        ));
        assert!(crate::identity::permitted(
            &manager,
            "POST",
            "/v1/provider-keys"
        ));
        let agent = Principal {
            agent_id: Some(Uuid::new_v4()),
            scopes: vec!["runs:read".into(), "runs:write".into()],
            ..manager
        };
        for path in [
            "/v1/admin/demo",
            "/v1/provider-keys",
            "/v1/provider-keys/x/revoke",
        ] {
            assert!(!crate::identity::permitted(&agent, "POST", path));
        }
    }

    #[tokio::test]
    #[ignore = "requires disposable PostgreSQL; SPEKIOS_KEYS_TEST_DB=1"]
    async fn postgres_keys_isolate_accounts_and_demo_reservations_cap_concurrent_spend() {
        assert_eq!(
            std::env::var("SPEKIOS_KEYS_TEST_DB").as_deref(),
            Ok("1"),
            "Never run against the application database"
        );
        let pool = Arc::new(crate::db::Postgres::connect().await.unwrap());
        let db = pool.write().await.unwrap();
        db.batch_execute("CREATE TABLE IF NOT EXISTS workspaces(workspace_id uuid PRIMARY KEY);CREATE TABLE IF NOT EXISTS model_requests(request_id uuid PRIMARY KEY);CREATE TABLE IF NOT EXISTS model_calls(call_id uuid PRIMARY KEY);").await.unwrap();
        db.batch_execute(include_str!(
            "../../../infra/postgres/025-provider-access.sql"
        ))
        .await
        .unwrap();
        let a = Principal {
            workspace_id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            operator: false,
            ..Principal::default()
        };
        let b = Principal {
            workspace_id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            operator: false,
            ..Principal::default()
        };
        for p in [&a, &b] {
            db.execute(
                "INSERT INTO workspaces(workspace_id) VALUES($1)",
                &[&p.workspace_id],
            )
            .await
            .unwrap();
        }
        let vault = Vault::new(&[31; 32]).unwrap();
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let foreign = Uuid::new_v4();
        let shared = Uuid::new_v4();
        for (id, p, name, default) in [
            (first, &a, "My Meta", true),
            (second, &a, "Another Meta", false),
            (foreign, &b, "Other account", true),
        ] {
            let encrypted = vault
                .seal(
                    "personal-test-provider-secret",
                    &binding(
                        id,
                        "personal",
                        Some(p.workspace_id),
                        Some(p.user_id),
                        "meta",
                    ),
                )
                .unwrap();
            db.execute("INSERT INTO provider_keys(key_id,scope,workspace_id,user_id,provider,name,encrypted_key,secret_sha256,is_default) VALUES($1,'personal',$2,$3,'meta',$4,$5,'test',$6)",&[&id,&p.workspace_id,&p.user_id,&name,&encrypted,&default]).await.unwrap();
        }
        let encrypted = vault
            .seal(
                "shared-demo-test-provider-secret",
                &binding(shared, "demo", None, None, "meta"),
            )
            .unwrap();
        db.execute("INSERT INTO provider_keys(key_id,scope,provider,name,encrypted_key,secret_sha256) VALUES($1,'demo','meta','Spekios demo key',$2,'test')",&[&shared,&encrypted]).await.unwrap();
        db.execute(
            "UPDATE demo_settings SET enabled=true,key_id=$1,allowance_microusd=1000",
            &[&shared],
        )
        .await
        .unwrap();
        let keys = personal_keys(&**db, &a).await.unwrap();
        assert_eq!(keys.as_array().unwrap().len(), 2);
        assert!(!keys.to_string().contains("secret"));
        assert!(!keys.to_string().contains("encrypted"));
        assert_eq!(
            personal_keys(&**db, &b)
                .await
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            resolve(&**db, &a, Provider::Meta, "any-model", None, false)
                .await
                .unwrap()
                .key_id,
            Some(first)
        );
        assert_eq!(
            resolve(
                &**db,
                &a,
                Provider::Meta,
                "any-model",
                Some(&second.to_string()),
                false
            )
            .await
            .unwrap()
            .key_id,
            Some(second)
        );
        assert!(matches!(
            resolve(
                &**db,
                &a,
                Provider::Meta,
                DEMO_MODEL,
                Some(&foreign.to_string()),
                false
            )
            .await,
            Err("provider_key_unavailable")
        ));
        assert!(matches!(
            resolve(
                &**db,
                &a,
                Provider::Meta,
                "muse-wonder-1.0",
                Some("demo"),
                true
            )
            .await,
            Err("demo_model_only")
        ));
        assert_eq!(
            key_secret(&**db, Some(&vault), second, Provider::Meta)
                .await
                .unwrap(),
            "personal-test-provider-secret"
        );
        drop(db);
        // Two dispatchers reserve for the same account concurrently. Only one
        // $0.0009 call fits this $0.001 allowance, even across connections.
        let mut tasks = Vec::new();
        for _ in 0..2 {
            let pool = pool.clone();
            let user = a.user_id;
            tasks.push(tokio::spawn(async move {
                let mut db = pool.write().await.unwrap();
                let tx = db.transaction().await.unwrap();
                let id = Uuid::new_v4();
                tx.execute("INSERT INTO model_calls(call_id) VALUES($1)", &[&id])
                    .await
                    .unwrap();
                match reserve(&tx, user, id, 5000, 2000, DEMO_MODEL).await {
                    Ok(()) => {
                        tx.commit().await.unwrap();
                        Some(id)
                    }
                    Err("demo_credits_insufficient") => {
                        tx.rollback().await.unwrap();
                        None
                    }
                    Err(e) => panic!("{e}"),
                }
            }));
        }
        let mut accepted = Vec::new();
        for task in tasks {
            if let Some(id) = task.await.unwrap() {
                accepted.push(id);
            }
        }
        assert_eq!(accepted.len(), 1);
        let mut db = pool.write().await.unwrap();
        let mut result = CallResult::unknown(accepted[0], "pending");
        result.state = "completed".into();
        result.response_complete = true;
        result.http_status = Some(200);
        result.usage.input_tokens = Some(500);
        result.usage.output_tokens = Some(100);
        result.usage.usage_status = "reported".into();
        let tx = db.transaction().await.unwrap();
        settle(&tx, &result).await.unwrap();
        settle(&tx, &result).await.unwrap();
        tx.commit().await.unwrap();
        let charged: i64 = db
            .query_one(
                "SELECT charged_microusd FROM demo_reservations WHERE call_id=$1",
                &[&accepted[0]],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(charged, 70);
        let tx = db.transaction().await.unwrap();
        let unknown = Uuid::new_v4();
        tx.execute("INSERT INTO model_calls(call_id) VALUES($1)", &[&unknown])
            .await
            .unwrap();
        reserve(&tx, a.user_id, unknown, 5000, 2000, DEMO_MODEL)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let tx = db.transaction().await.unwrap();
        settle(&tx, &CallResult::unknown(unknown, "network_unknown"))
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let status = demo_status(&**db, a.user_id).await.unwrap();
        assert_eq!(status["uncertain_calls"], 1);
        let used:i64=db.query_one("SELECT sum(COALESCE(charged_microusd,reserved_microusd))::bigint FROM demo_reservations WHERE user_id=$1",&[&a.user_id]).await.unwrap().get(0);
        assert_eq!(used, 970);
        assert!(
            resolve(&**db, &a, Provider::Meta, DEMO_MODEL, Some("demo"), true)
                .await
                .is_err()
        );
        // Exhausted demo credit never prevents using an independently owned key.
        assert_eq!(
            resolve(
                &**db,
                &a,
                Provider::Meta,
                "muse-wonder-1.0",
                Some(&second.to_string()),
                true
            )
            .await
            .unwrap()
            .source,
            "personal"
        );
        assert_eq!(
            demo_status(&**db, b.user_id).await.unwrap()["spent_usd"].as_f64(),
            Some(0.0)
        );
        db.execute(
            "UPDATE provider_keys SET revoked_at=now() WHERE key_id=$1",
            &[&second],
        )
        .await
        .unwrap();
        assert!(
            resolve(
                &**db,
                &a,
                Provider::Meta,
                "any-model",
                Some(&second.to_string()),
                false
            )
            .await
            .is_err()
        );
        assert!(
            key_secret(&**db, Some(&vault), second, Provider::Meta)
                .await
                .is_err()
        );
    }
}
