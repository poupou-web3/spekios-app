//! One API replica owns the PostgreSQL advisory lock on a dedicated connection.
//! The others stay ready and admit work. Admission, dispatch, usage settlement
//! and outbox creation commit before their external effects. A dropped database
//! connection releases leadership and is retried; it does not exit the process.
use crate::identity::ScopedState;
use crate::{
    error,
    logs::emit as log,
    models::{CallResult, ModelRequest, Provider, interpret, wire_request},
    query,
};
use axum::{
    Json,
    extract::Path,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use object_store::{
    ObjectStore, PutMode, PutOptions, RetryConfig,
    aws::{AmazonS3Builder, S3ConditionalPut},
    path::Path as ObjectPath,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    env,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Notify};
use tokio_postgres::Transaction;
use uuid::Uuid;

pub const USER_ID: Uuid = Uuid::from_u128(0x00000000000040008000000000000002);
type GResult<T> = Result<T, &'static str>;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const MAX_IMAGE: u64 = 4 * 1024 * 1024;
const LOCK_ID: i64 = 736_268_194_001;
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum Role {
    Starting = 0,
    Leader = 1,
    Standby = 2,
    Halted = 3,
}

pub struct Gateway {
    db: Arc<crate::db::Postgres>,
    http: reqwest::Client,
    store: Arc<dyn ObjectStore>,
    keys: Vec<(Provider, String)>,
    secrets: Vec<String>,
    pub(crate) vault: Option<crate::provider_access::Vault>,
    fixture_url: Option<String>,
    clickhouse_url: String,
    clickhouse_password: String,
    spool: PathBuf,
    notify: Notify,
    leader: Mutex<Option<crate::db::Dedicated>>,
    role: AtomicU8,
}

impl Gateway {
    pub fn from_env(db: Arc<crate::db::Postgres>) -> GResult<Arc<Self>> {
        let fixture_url = if env::var("SCOUT_MODEL_TEST_MODE").as_deref() == Ok("1") {
            let value = env::var("SCOUT_MODEL_FIXTURE_URL").map_err(|_| "missing_fixture_url")?;
            let url = reqwest::Url::parse(&value).map_err(|_| "invalid_fixture_url")?;
            if url.scheme() != "http"
                || !matches!(url.host_str(), Some("model-fixture" | "127.0.0.1"))
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("invalid_fixture_url");
            }
            Some(value.trim_end_matches('/').to_owned())
        } else {
            None
        };
        let mut keys = Vec::new();
        for p in Provider::ALL {
            let key = if fixture_url.is_some() {
                "scout_fixture_credential_not_a_real_key".into()
            } else {
                let configured = env::var(p.key_env()).unwrap_or_default();
                // Meta's own examples name the bearer token MODEL_API_KEY.
                if configured.is_empty() && p == Provider::Meta {
                    env::var("MODEL_API_KEY").unwrap_or_default()
                } else {
                    configured
                }
            };
            if !key.is_empty() {
                if key.len() < 8 || key.len() > 4096 || !key.bytes().all(|b| b.is_ascii_graphic()) {
                    return Err("invalid_provider_key_format");
                }
                keys.push((p, key));
            }
        }
        let mut secrets: Vec<String> = keys.iter().map(|(_, v)| v.clone()).collect();
        for key in [
            "SCOUT_API_TOKEN",
            "MODEL_API_KEY",
            "POSTGRES_PASSWORD",
            "S3_ACCESS_KEY_ID",
            "S3_SECRET_ACCESS_KEY",
            "CLICKHOUSE_PASSWORD",
            "SCOUT_PROVIDER_VAULT_KEY",
        ] {
            if let Ok(value) = env::var(key)
                && value.len() >= 8
            {
                secrets.push(value);
            }
        }
        let store = AmazonS3Builder::new()
            .with_bucket_name("qa-evidence")
            .with_region("us-east-1")
            .with_endpoint(
                env::var("S3_ENDPOINT").unwrap_or_else(|_| "http://evidence:8333".into()),
            )
            .with_access_key_id(env::var("S3_ACCESS_KEY_ID").map_err(|_| "missing_s3_credentials")?)
            .with_secret_access_key(
                env::var("S3_SECRET_ACCESS_KEY").map_err(|_| "missing_s3_credentials")?,
            )
            .with_allow_http(true)
            .with_virtual_hosted_style_request(false)
            .with_conditional_put(S3ConditionalPut::ETagMatch)
            .with_retry(RetryConfig {
                max_retries: 1,
                retry_timeout: Duration::from_secs(15),
                ..RetryConfig::default()
            })
            .build()
            .map_err(|_| "invalid_s3_configuration")?;
        let seconds = if fixture_url.is_some() { 2 } else { 60 };
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(seconds))
            .build()
            .map_err(|_| "http_configuration_failed")?;
        Ok(Arc::new(Self {
            db,
            http,
            store: Arc::new(store),
            keys,
            secrets,
            vault: crate::provider_access::Vault::from_env()?,
            fixture_url,
            clickhouse_url: env::var("CLICKHOUSE_URL")
                .unwrap_or_else(|_| "http://clickhouse:8123".into()),
            clickhouse_password: env::var("CLICKHOUSE_PASSWORD")
                .map_err(|_| "missing_clickhouse_credentials")?,
            spool: env::var("MODEL_SPOOL")
                .unwrap_or_else(|_| "/data/gateway".into())
                .into(),
            notify: Notify::new(),
            leader: Mutex::new(None),
            role: AtomicU8::new(Role::Starting as u8),
        }))
    }

    fn role(&self) -> Role {
        match self.role.load(Ordering::SeqCst) {
            1 => Role::Leader,
            2 => Role::Standby,
            3 => Role::Halted,
            _ => Role::Starting,
        }
    }

    fn set_role(&self, role: Role) {
        self.role.store(role as u8, Ordering::SeqCst);
    }

    /// True when this process or another replica is dispatching model calls.
    /// Followers stay ready so a Service can send them ordinary API traffic.
    pub fn is_ready(&self) -> bool {
        matches!(self.role(), Role::Leader | Role::Standby)
    }

    fn is_leader(&self) -> bool {
        self.role() == Role::Leader
    }

    async fn conn(&self) -> GResult<crate::db::Conn> {
        self.db.write().await
    }
    pub async fn evidence_bytes(&self, key: &str, sha: &str, length: u64) -> GResult<bytes::Bytes> {
        if length == 0 || length > 32 * 1024 * 1024 {
            return Err("evidence_too_large");
        }
        tokio::time::timeout(Duration::from_secs(12), async {
            let object = self
                .store
                .get(&ObjectPath::from(key))
                .await
                .map_err(|_| "evidence_unavailable")?;
            if object.meta.size != length {
                return Err("evidence_checksum_mismatch");
            }
            let bytes = object.bytes().await.map_err(|_| "evidence_unavailable")?;
            if bytes.len() as u64 != length || hash(&bytes) != sha {
                return Err("evidence_checksum_mismatch");
            }
            Ok(bytes)
        })
        .await
        .map_err(|_| "evidence_timeout")?
    }
    /// Capture metadata is addressed by its immutable capture UUID, while its
    /// PNG is content addressed. Review compares this bounded document with
    /// the durable capture record and verifies the PNG separately.
    pub(crate) async fn evidence_metadata(&self, key: &str) -> GResult<Value> {
        tokio::time::timeout(Duration::from_secs(12), async {
            let object = self
                .store
                .get(&ObjectPath::from(key))
                .await
                .map_err(|_| "evidence_unavailable")?;
            if object.meta.size == 0 || object.meta.size > 2 * 1024 * 1024 {
                return Err("evidence_invalid_metadata");
            }
            let bytes = object.bytes().await.map_err(|_| "evidence_unavailable")?;
            serde_json::from_slice(&bytes).map_err(|_| "evidence_invalid_metadata")
        })
        .await
        .map_err(|_| "evidence_timeout")?
    }
    fn execution_mode(&self) -> &'static str {
        if self.fixture_url.is_some() {
            "protocol_fixture"
        } else {
            "live"
        }
    }
    pub fn providers(&self) -> Value {
        let providers = Provider::ALL
            .iter()
            .map(|p| {
                json!({
                    "provider":p,"configured":self.keys.iter().any(|(key,_)| key==p),
                    "authentication":if self.fixture_url.is_some(){"test_fixture"}else{"api_key"},
                    "subscription_auth":false,"images_by_capture_id":true
                })
            })
            .collect::<Vec<_>>();
        json!({"providers":providers,"gateway_ready":self.is_ready(),"test_mode":self.fixture_url.is_some()})
    }
    pub async fn providers_for(&self, principal: &crate::identity::Principal) -> GResult<Value> {
        let db = self.conn().await?;
        let keys = crate::provider_access::personal_keys(&**db, principal).await?;
        let demo = crate::provider_access::demo_status(&**db, principal.user_id).await?;
        let mut status = self.providers();
        if let Some(list) = status["providers"].as_array_mut() {
            for p in list {
                let personal = keys
                    .as_array()
                    .is_some_and(|keys| keys.iter().any(|k| k["provider"] == p["provider"]));
                let global = if principal.operator {
                    db.query_one("SELECT EXISTS(SELECT 1 FROM provider_keys WHERE provider=$1 AND revoked_at IS NULL)",&[&p["provider"].as_str().unwrap_or("")]).await.map_err(|_| "database_unavailable")?.get::<_,bool>(0)
                } else {
                    false
                };
                let demo_ready = p["provider"] == "meta"
                    && demo["enabled"] == true
                    && demo["configured"] == true
                    && demo["remaining_usd"].as_f64().unwrap_or(0.)
                        >= demo["minimum_call_reserve_usd"]
                            .as_f64()
                            .unwrap_or(f64::MAX);
                p["configured"] = json!(
                    (principal.operator && p["configured"] == true)
                        || (self.vault.is_some() && (personal || global || demo_ready))
                );
            }
        }
        status["keys"] = keys;
        status["demo"] = demo;
        status["vault_ready"] = json!(self.vault.is_some());
        status["operator_access"] = json!(principal.operator);
        if principal.is_manager() || principal.operator {
            let rows = db.query("SELECT DISTINCT r.model,r.provider_key_id,r.funding_source FROM model_requests r JOIN model_calls c USING(request_id) WHERE r.workspace_id=$1 AND r.user_id=$2 AND r.execution_mode=$3 AND r.provider='meta' AND r.spec->>'computer_use_probe'='true' AND r.state='completed' AND c.state='completed' AND r.created_at>now()-interval '30 days' AND (r.funding_source<>'demo' OR r.provider_key_id=(SELECT key_id FROM demo_settings WHERE singleton)) AND (r.funding_source<>'personal' OR EXISTS(SELECT 1 FROM provider_keys k WHERE k.key_id=r.provider_key_id AND k.revoked_at IS NULL))",&[&principal.workspace_id,&principal.user_id,&self.execution_mode()]).await.map_err(|_|"database_unavailable")?;
            status["computer_use"] = json!({"documented_models":["muse-spark-1.3","muse-wonder-1.0"],"verified_connections":rows.iter().map(|r|json!({"model":r.get::<_,String>(0),"provider_key_id":r.get::<_,Option<Uuid>>(1),"funding_source":r.get::<_,String>(2)})).collect::<Vec<_>>()});
        }
        if !principal.is_manager() && !principal.operator {
            // Provider readiness is an agent capability; private key names and
            // account balances are not part of that discovery surface.
            status.as_object_mut().unwrap().remove("keys");
            status.as_object_mut().unwrap().remove("demo");
        }
        Ok(status)
    }
    fn redact(&self, text: &str) -> String {
        self.secrets.iter().fold(text.to_owned(), |text, secret| {
            text.replace(secret, "[REDACTED_CREDENTIAL]")
        })
    }
    fn response_bytes(&self, bytes: &[u8], key: &str) -> Vec<u8> {
        fn scrub(g: &Gateway, value: &mut Value, key: &str) {
            match value {
                Value::String(text) => {
                    *text = g
                        .redact(text)
                        .replace(key, "[REDACTED_CREDENTIAL]")
                        .replace('\0', "[NUL]")
                }
                Value::Array(values) => values.iter_mut().for_each(|v| scrub(g, v, key)),
                Value::Object(map) => {
                    let old = std::mem::take(map);
                    for (field, mut value) in old {
                        scrub(g, &mut value, key);
                        map.insert(
                            g.redact(&field)
                                .replace(key, "[REDACTED_CREDENTIAL]")
                                .replace('\0', "[NUL]"),
                            value,
                        );
                    }
                }
                _ => {}
            }
        }
        if let Ok(original) = serde_json::from_slice::<Value>(bytes) {
            let mut cleaned = original.clone();
            scrub(self, &mut cleaned, key);
            if cleaned != original {
                return serde_json::to_vec(&cleaned).expect("JSON value");
            }
        }
        self.redact(&String::from_utf8_lossy(bytes))
            .replace(key, "[REDACTED_CREDENTIAL]")
            .into_bytes()
    }

    pub fn start(self: &Arc<Self>) {
        let worker = self.clone();
        tokio::spawn(async move {
            loop {
                match worker.try_lead().await {
                    Ok(true) => {
                        if let Err(code) = worker.recover().await {
                            worker.release_leader().await;
                            worker.set_role(Role::Starting);
                            log(
                                "warning",
                                "model_gateway_initializing",
                                json!({"error":code}),
                            );
                            tokio::time::sleep(Duration::from_secs(2)).await;
                            continue;
                        }
                        worker.set_role(Role::Leader);
                        loop {
                            if !worker.leader_alive().await {
                                worker.release_leader().await;
                                worker.set_role(Role::Starting);
                                log("warning", "model_gateway_leader_connection_lost", json!({}));
                                break;
                            }
                            match worker.process_next().await {
                                Ok(true) => continue,
                                Ok(false) => {}
                                Err("database_unavailable") => {
                                    log("warning", "model_gateway_database_unavailable", json!({}));
                                    if !worker.leader_alive().await {
                                        worker.release_leader().await;
                                        worker.set_role(Role::Starting);
                                        break;
                                    }
                                }
                                Err(code) => {
                                    // A failed local journal/settlement must stop new spending.
                                    // Keep the lock so another replica does not dispatch it.
                                    worker.set_role(Role::Halted);
                                    log(
                                        "error",
                                        "model_gateway_halted",
                                        json!({"error":code,"action":"restart after restoring storage"}),
                                    );
                                    return;
                                }
                            }
                            tokio::select! { _=worker.notify.notified()=>{}, _=tokio::time::sleep(Duration::from_secs(1))=>{} }
                        }
                    }
                    Ok(false) => {
                        worker.set_role(Role::Standby);
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                    Err(code) => {
                        worker.set_role(Role::Starting);
                        log(
                            "warning",
                            "model_gateway_initializing",
                            json!({"error":code}),
                        );
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                }
            }
        });
        let exporter = self.clone();
        tokio::spawn(async move {
            loop {
                if exporter.is_leader() {
                    match exporter.export_once().await {
                        Ok(true) => {
                            // Keep draining bounded batches while work exists;
                            // sleeping five seconds per batch accumulates lag
                            // during screenshot-heavy exploration runs.
                            tokio::time::sleep(Duration::from_millis(50)).await;
                            continue;
                        }
                        Ok(false) => {}
                        Err(code) => log("warning", "model_export_pending", json!({"error":code})),
                    }
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });
    }

    /// Takes the session advisory lock on a connection that stays checked out
    /// for as long as this process is the dispatcher.
    async fn try_lead(&self) -> GResult<bool> {
        let connection = self.db.dedicated().await?;
        let locked: bool = connection
            .query_one("SELECT pg_try_advisory_lock($1)", &[&LOCK_ID])
            .await
            .map_err(|_| "database_unavailable")?
            .get(0);
        if !locked {
            return Ok(false);
        }
        *self.leader.lock().await = Some(connection);
        Ok(true)
    }

    async fn leader_alive(&self) -> bool {
        let mut leader = self.leader.lock().await;
        let Some(connection) = leader.as_mut() else {
            return false;
        };
        if connection.is_closed() {
            return false;
        }
        connection.query_one("SELECT 1", &[]).await.is_ok()
    }

    async fn release_leader(&self) {
        if let Some(connection) = self.leader.lock().await.take()
            && !connection.is_closed()
        {
            let _ = connection
                .query_one("SELECT pg_advisory_unlock($1)", &[&LOCK_ID])
                .await;
        }
    }

    async fn recover(&self) -> GResult<()> {
        tokio::fs::create_dir_all(&self.spool)
            .await
            .map_err(|_| "journal_unavailable")?;
        let mut files = tokio::fs::read_dir(&self.spool)
            .await
            .map_err(|_| "journal_unavailable")?;
        while let Some(file) = files
            .next_entry()
            .await
            .map_err(|_| "journal_unavailable")?
        {
            if file.path().extension().is_some_and(|e| e == "json") {
                let bytes = tokio::fs::read(file.path())
                    .await
                    .map_err(|_| "journal_unavailable")?;
                let result: CallResult =
                    serde_json::from_slice(&bytes).map_err(|_| "journal_corrupt")?;
                if file.file_name().to_string_lossy() != format!("{}.json", result.call_id) {
                    return Err("journal_identity_mismatch");
                }
                self.settle(&result).await?;
                self.remove_journal(result.call_id).await?;
            }
        }
        let calls = self.conn().await?.query("SELECT c.call_id FROM model_calls c JOIN model_requests r USING(request_id) WHERE c.state='dispatched'",&[]).await.map_err(|_| "database_unavailable")?;
        for row in calls {
            // The provider might have billed this attempt. Never replay it.
            self.settle(&CallResult::unknown(
                row.get(0),
                "process_interrupted_after_dispatch",
            ))
            .await?;
        }
        self.conn()
            .await?
            .execute(
                "UPDATE model_requests SET state='queued' WHERE state='preparing'",
                &[],
            )
            .await
            .map_err(|_| "database_unavailable")?;
        Ok(())
    }

    pub(crate) async fn admit(
        &self,
        spec: &ModelRequest,
        principal: &crate::identity::Principal,
    ) -> GResult<bool> {
        spec.validate()?;
        let value = serde_json::to_value(spec).map_err(|_| "invalid_request")?;
        let bytes = serde_json::to_vec(&value).map_err(|_| "invalid_request")?;
        if self.redact(&spec.prompt) != spec.prompt
            || self.redact(&spec.system) != spec.system
            || self.redact(&spec.model) != spec.model
        {
            return Err("credential_in_prompt");
        }
        let sha = hash(&bytes);
        let mut db = self.conn().await?;
        let tx = db.transaction().await.map_err(|_| "database_unavailable")?;
        // Only the trusted operator/worker may submit raw model requests. Derive
        // ownership from its admitted run, never a client-supplied workspace ID.
        let (workspace_id, user_id, agent_id, run_config) = if let Some(id) = spec.run_id {
            let row=tx.query_opt("SELECT r.workspace_id,r.user_id,(SELECT agent_id FROM browser_jobs j WHERE j.run_id=r.run_id AND j.workspace_id=r.workspace_id AND j.user_id=r.user_id ORDER BY j.created_at,j.job_id LIMIT 1),r.config FROM runtime_runs r WHERE r.run_id=$1",&[&id]).await.map_err(|_|"database_unavailable")?.ok_or("run_not_found")?;
            (
                row.get::<_, Uuid>(0),
                row.get::<_, Uuid>(1),
                row.get::<_, Option<Uuid>>(2),
                Some(row.get::<_, Value>(3)),
            )
        } else {
            (
                principal.workspace_id,
                principal.user_id,
                principal.agent_id,
                None,
            )
        };
        if let Some(row) = tx
            .query_opt(
                "SELECT spec_sha256,workspace_id,user_id,execution_mode FROM model_requests WHERE request_id=$1",
                &[&spec.request_id],
            )
            .await
            .map_err(|_| "database_unavailable")?
        {
            if row.get::<_, String>(0) != sha
                || row.get::<_, Uuid>(1) != workspace_id
                || row.get::<_, Uuid>(2) != user_id
                || row.get::<_, String>(3) != self.execution_mode()
            {
                return Err("idempotency_conflict");
            }
            return Ok(false);
        }
        let owner = crate::identity::Principal {
            workspace_id,
            user_id,
            operator: principal.operator
                && workspace_id == crate::WORKSPACE_ID
                && user_id == USER_ID,
            ..principal.clone()
        };
        let reference = if let Some(config) = &run_config {
            let choices = [
                &config["model_connection"],
                &config["model_tiers"]["navigation"],
            ];
            let choice = choices.into_iter().find(|c| {
                c["provider"] == json!(spec.provider)
                    && c["model"] == spec.model
                    && spec
                        .provider_key_id
                        .as_ref()
                        .is_none_or(|id| c["providerKeyId"] == *id)
            });
            if let Some(choice) = choice {
                choice["providerKeyId"]
                    .as_str()
                    .or(spec.provider_key_id.as_deref())
            } else if owner.operator && spec.provider_key_id.is_none() {
                None
            } else {
                return Err("model_connection_mismatch");
            }
        } else {
            spec.provider_key_id.as_deref()
        };
        let funding = if self.fixture_url.is_some() {
            crate::provider_access::Funding {
                source: "operator",
                key_id: None,
            }
        } else {
            crate::provider_access::resolve(
                &*tx,
                &owner,
                spec.provider,
                &spec.model,
                reference,
                true,
            )
            .await?
        };
        if spec.computer_use && !spec.computer_use_probe {
            if run_config
                .as_ref()
                .is_none_or(|config| config["model_connection"]["computerUse"] != true)
            {
                return Err("computer_use_disabled");
            }
            if !crate::models::documented_computer_use(spec.provider, &spec.model)
                && !crate::computer_use::verified(
                    &*tx,
                    &owner,
                    &spec.model,
                    &funding,
                    self.execution_mode(),
                )
                .await?
            {
                return Err("computer_use_unverified");
            }
        }
        if funding.key_id.is_some() && self.vault.is_none() {
            return Err("provider_vault_not_configured");
        }
        if let Some(id) = funding.key_id {
            let key =
                crate::provider_access::key_secret(&*tx, self.vault.as_ref(), id, spec.provider)
                    .await?;
            if spec.prompt.contains(&key) || spec.system.contains(&key) || spec.model.contains(&key)
            {
                return Err("credential_in_prompt");
            }
        }
        if funding.source == "operator" && !self.keys.iter().any(|(p, _)| *p == spec.provider) {
            return Err("provider_not_configured");
        }
        if !self.is_ready() {
            return Err("gateway_not_ready");
        }
        let pending: i64 = tx.query_one("SELECT count(*) FROM model_requests WHERE workspace_id=$1 AND execution_mode=$2 AND state IN ('queued','preparing','dispatched')",&[&workspace_id,&self.execution_mode()]).await.map_err(|_| "database_unavailable")?.get(0);
        if pending >= 32 {
            return Err("queue_full");
        }
        if let Some(id) = spec.run_id {
            let run=tx.query_opt("SELECT (cancel_id IS NOT NULL OR lifecycle='cancelled') FROM runtime_runs WHERE run_id=$1 AND workspace_id=$2 AND user_id=$3 FOR UPDATE", &[&id,&workspace_id,&user_id])
                .await.map_err(|_| "database_unavailable")?.ok_or("run_not_found")?;
            if run.get::<_, bool>(0) {
                return Err("run_cancelled");
            }
        }
        if let Some(id) = spec.action_id
            && tx
                .query_opt(
                    "SELECT 1 FROM runtime_actions WHERE action_id=$1 AND run_id=$2",
                    &[&id, &spec.run_id],
                )
                .await
                .map_err(|_| "database_unavailable")?
                .is_none()
        {
            return Err("action_not_found");
        }
        for id in &spec.capture_ids {
            if tx.query_opt("SELECT 1 FROM runtime_captures WHERE capture_id=$1 AND run_id=$2 AND status='available' AND byte_length <= $3",&[id,&spec.run_id,&(MAX_IMAGE as i64)]).await.map_err(|_| "database_unavailable")?.is_none() { return Err("capture_unavailable_or_too_large"); }
        }
        // Derivatives must be recorded on this exact action and original pair.
        // A caller cannot substitute an arbitrary artifact, even from its run.
        for (index, id) in spec.assessment_image_ids.iter().enumerate() {
            if tx.query_opt("SELECT 1 FROM runtime_artifacts a JOIN runtime_actions x ON x.run_id=a.run_id WHERE a.artifact_id=$1 AND a.run_id=$2 AND a.kind='assessment_image' AND a.status='available' AND a.byte_length <= $3 AND x.action_id=$4 AND x.before_capture_id=$5 AND x.after_capture_id=$6 AND x.comparison->'assessment_images'->'artifacts'->($7::int)->>'artifact_id'=$8", &[id,&spec.run_id,&(MAX_IMAGE as i64),&spec.action_id,&spec.capture_ids[0],&spec.capture_ids[1],&(index as i32),&id.to_string()]).await.map_err(|_| "database_unavailable")?.is_none() {
                return Err("assessment_image_unavailable_or_unlinked");
            }
        }
        tx.execute("INSERT INTO model_requests(request_id,workspace_id,user_id,run_id,action_id,provider,model,spec,spec_sha256,state,execution_mode,agent_id,funding_source,provider_key_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$11,$12,$13)",&[&spec.request_id,&workspace_id,&user_id,&spec.run_id,&spec.action_id,&spec.provider.name(),&spec.model,&value,&sha,&self.execution_mode(),&agent_id,&funding.source,&funding.key_id]).await.map_err(|_| "database_unavailable")?;
        event(&tx,spec.request_id,None,"request_accepted",&json!({"spec":value,"training_status":if self.fixture_url.is_some(){"excluded_fixture"}else{"pending_review"}})).await?;
        tx.commit().await.map_err(|_| "database_unavailable")?;
        log(
            "info",
            "model_request_queued",
            json!({"provider":spec.provider.name(),"model":spec.model,"request_id":spec.request_id,"run_id":spec.run_id,"action_id":spec.action_id,"execution_mode":self.execution_mode(),"funding":funding.source}),
        );
        self.notify.notify_one();
        Ok(true)
    }

    async fn process_next(&self) -> GResult<bool> {
        let row = self.conn().await?.query_opt("UPDATE model_requests SET state='preparing' WHERE request_id=(SELECT request_id FROM model_requests WHERE execution_mode=$1 AND state='queued' AND next_attempt_at<=now() ORDER BY created_at LIMIT 1) RETURNING spec,funding_source,provider_key_id,user_id",&[&self.execution_mode()]).await.map_err(|_| "database_unavailable")?;
        let Some(row) = row else { return Ok(false) };
        let spec: ModelRequest =
            serde_json::from_value(row.get(0)).map_err(|_| "stored_request_invalid")?;
        let source: String = row.get(1);
        let key_id: Option<Uuid> = row.get(2);
        let user: Uuid = row.get(3);
        let selected = if let Some(id) = key_id {
            let db = self.conn().await?;
            crate::provider_access::key_secret(&**db, self.vault.as_ref(), id, spec.provider).await
        } else {
            self.keys
                .iter()
                .find(|(p, _)| *p == spec.provider)
                .map(|(_, k)| k.clone())
                .ok_or("provider_not_configured")
        };
        let key = match selected {
            Ok(key) => key,
            Err(code) => {
                self.fail_before_dispatch(spec.request_id, code).await?;
                return Ok(true);
            }
        };
        if spec.prompt.contains(&key) || spec.system.contains(&key) || spec.model.contains(&key) {
            self.fail_before_dispatch(spec.request_id, "credential_in_prompt")
                .await?;
            return Ok(true);
        }
        let mut images = Vec::new();
        let selected_images = if spec.assessment_image_ids.is_empty() {
            &spec.capture_ids
        } else {
            &spec.assessment_image_ids
        };
        for id in selected_images {
            match self
                .image(*id, spec.run_id, !spec.assessment_image_ids.is_empty())
                .await
            {
                Ok(image) => images.push(image),
                Err(code) => {
                    self.fail_before_dispatch(spec.request_id, code).await?;
                    return Ok(true);
                }
            }
        }
        let bytes =
            serde_json::to_vec(&wire_request(&spec, &images)).map_err(|_| "invalid_request")?;
        let demo_input = if source == "demo" {
            if let Some(run) = spec.run_id {
                let cancelled:bool=self.conn().await?.query_one("SELECT cancel_id IS NOT NULL OR lifecycle='cancelled' FROM runtime_runs WHERE run_id=$1",&[&run]).await.map_err(|_| "database_unavailable")?.get(0);
                if cancelled {
                    self.fail_before_dispatch(spec.request_id, "run_cancelled_before_dispatch")
                        .await?;
                    return Ok(true);
                }
            }
            match self.count_demo_input(&key, &bytes).await {
                Ok(tokens) => tokens,
                Err(code) => {
                    self.fail_before_dispatch(spec.request_id, code).await?;
                    return Ok(true);
                }
            }
        } else {
            0
        };
        let call_id = Uuid::new_v4();
        let attempt = {
            let mut db = self.conn().await?;
            let tx = db.transaction().await.map_err(|_| "database_unavailable")?;
            // Admission can precede cancellation while images are loading or
            // another provider call is running. Fence the actual dispatch too.
            if let Some(run_id) = spec.run_id {
                let row = tx
                    .query_one(
                        "SELECT (cancel_id IS NOT NULL OR lifecycle='cancelled') FROM runtime_runs WHERE run_id=$1 FOR UPDATE",
                        &[&run_id],
                    )
                    .await
                    .map_err(|_| "database_unavailable")?;
                if row.get::<_, bool>(0) {
                    tx.execute("UPDATE model_requests SET state='cancelled',finished_at=now(),error='run_cancelled_before_dispatch' WHERE request_id=$1", &[&spec.request_id]).await.map_err(|_| "database_unavailable")?;
                    event(
                        &tx,
                        spec.request_id,
                        None,
                        "request_cancelled",
                        &json!({"reason":"run_cancelled","provider_dispatched":false}),
                    )
                    .await?;
                    tx.commit().await.map_err(|_| "database_unavailable")?;
                    return Ok(true);
                }
            }
            let attempt: i32 = tx.query_one("UPDATE model_requests SET state='dispatched',attempt_count=attempt_count+1 WHERE request_id=$1 AND state='preparing' RETURNING attempt_count",&[&spec.request_id]).await.map_err(|_| "database_unavailable")?.get(0);
            tx.execute("INSERT INTO model_calls(call_id,request_id,attempt,state) VALUES($1,$2,$3,'dispatched')",&[&call_id,&spec.request_id,&attempt]).await.map_err(|_| "database_unavailable")?;
            if source == "demo"
                && let Err(code) = crate::provider_access::reserve(
                    &tx,
                    user,
                    call_id,
                    demo_input,
                    spec.max_output_tokens,
                    &spec.model,
                )
                .await
            {
                tx.rollback().await.map_err(|_| "database_unavailable")?;
                self.fail_before_dispatch(spec.request_id, code).await?;
                return Ok(true);
            }
            if let Some(id) = key_id && tx.query_opt("SELECT 1 FROM provider_keys WHERE key_id=$1 AND revoked_at IS NULL FOR SHARE",&[&id]).await.map_err(|_| "database_unavailable")?.is_none() {
                    tx.rollback().await.map_err(|_| "database_unavailable")?;
                    self.fail_before_dispatch(spec.request_id,"provider_key_unavailable").await?;return Ok(true);
            }
            let reference = payload(&tx, call_id, "request", &bytes).await?;
            event(&tx,spec.request_id,Some(call_id),"call_dispatched",&json!({"attempt":attempt,"request":reference,"prompt":spec.prompt,"system":spec.system,"capture_ids":spec.capture_ids,"assessment_image_ids":spec.assessment_image_ids})).await?;
            tx.commit().await.map_err(|_| "database_unavailable")?;
            attempt
        };
        // Identifiers and sizes only: the prompt, images and response stay in
        // the request's stored evidence.
        let call = json!({"provider":spec.provider.name(),"model":spec.model,"request_id":spec.request_id,"call_id":call_id,"run_id":spec.run_id,"action_id":spec.action_id,"attempt":attempt,"execution_mode":self.execution_mode(),"funding":source});
        let mut started = call.clone();
        started["endpoint"] = json!(self.endpoint(spec.provider));
        started["images"] = json!(images.len());
        started["request_bytes"] = json!(bytes.len());
        if spec.computer_use {
            started["computer_use"] = json!(true);
        }
        log("info", "model_call_started", started);
        let result = self.invoke(&spec, call_id, &key, bytes).await;
        let mut finished = call;
        let u = &result.usage;
        for (name, value) in [
            ("state", json!(result.state)),
            ("http_status", json!(result.http_status)),
            ("elapsed_ms", json!(result.elapsed_ms)),
            ("input_tokens", json!(u.input_tokens)),
            ("output_tokens", json!(u.output_tokens)),
            ("reasoning_tokens", json!(u.reasoning_tokens)),
            ("cached_input_tokens", json!(u.cached_input_tokens)),
            ("cost_usd", json!(u.cost_usd)),
            ("returned_model", json!(result.returned_model)),
            ("provider_request_id", json!(result.provider_request_id)),
            ("error", json!(result.error)),
        ] {
            finished[name] = value;
        }
        log(
            if result.state == "completed" {
                "info"
            } else {
                "warning"
            },
            "model_call_finished",
            finished,
        );
        // A sync'd response journal survives a crash or database outage before
        // settlement. Database idempotency makes replay safe and non-billable.
        if let Err(code) = self.write_journal(&result).await {
            // Preserve the response in PostgreSQL if the journal disk is full.
            self.settle(&result).await?;
            return Err(code);
        }
        self.settle(&result).await?;
        self.remove_journal(call_id).await?;
        Ok(true)
    }

    async fn image(&self, id: Uuid, run_id: Option<Uuid>, derivative: bool) -> GResult<Vec<u8>> {
        let sql = if derivative {
            "SELECT a.object_key,a.sha256,a.byte_length FROM runtime_artifacts a WHERE artifact_id=$1 AND a.run_id=$2 AND a.status='available' AND a.kind='assessment_image'"
        } else {
            "SELECT c.object_key,c.sha256,c.byte_length FROM runtime_captures c JOIN runtime_runs r USING(run_id) WHERE capture_id=$1 AND c.run_id=$2 AND c.status='available'"
        };
        let row = self
            .conn()
            .await?
            .query_opt(sql, &[&id, &run_id])
            .await
            .map_err(|_| "database_unavailable")?
            .ok_or("capture_unavailable")?;
        let key: String = row.get(0);
        let sha: String = row.get(1);
        let length: i64 = row.get(2);
        let object = self
            .store
            .get(&ObjectPath::from(key))
            .await
            .map_err(|_| "capture_download_failed")?;
        if object.meta.size > MAX_IMAGE || length < 0 || object.meta.size != length as u64 {
            return Err("capture_size_mismatch");
        }
        let bytes = object
            .bytes()
            .await
            .map_err(|_| "capture_download_failed")?;
        if hash(&bytes) != sha || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err("capture_hash_or_format_mismatch");
        }
        Ok(bytes.to_vec())
    }

    async fn fail_before_dispatch(&self, id: Uuid, code: &str) -> GResult<()> {
        let mut db = self.conn().await?;
        let tx = db.transaction().await.map_err(|_| "database_unavailable")?;
        tx.execute("UPDATE model_requests SET state=CASE WHEN $2='run_cancelled_before_dispatch' THEN 'cancelled' ELSE 'failed' END,finished_at=now(),error=$2 WHERE request_id=$1",&[&id,&code]).await.map_err(|_| "database_unavailable")?;
        event(
            &tx,
            id,
            None,
            if code == "run_cancelled_before_dispatch" {
                "request_cancelled"
            } else {
                "request_failed"
            },
            &json!({"error":code,"provider_dispatched":false}),
        )
        .await?;
        tx.commit().await.map_err(|_| "database_unavailable")?;
        let cancelled = code == "run_cancelled_before_dispatch";
        log(
            if cancelled { "info" } else { "warning" },
            if cancelled {
                "model_request_cancelled"
            } else {
                "model_request_failed"
            },
            json!({"request_id":id,"error":code,"provider_dispatched":false}),
        );
        Ok(())
    }

    async fn invoke(
        &self,
        spec: &ModelRequest,
        call_id: Uuid,
        key: &str,
        body: Vec<u8>,
    ) -> CallResult {
        let start = Instant::now();
        let mut request = self
            .http
            .post(self.endpoint(spec.provider))
            .header("content-type", "application/json")
            .body(body);
        if spec.provider == Provider::Anthropic {
            request = request
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01");
        } else {
            request = request.bearer_auth(key);
        }
        let mut result = CallResult::unknown(call_id, "transport_error");
        match request.send().await {
            Err(error) => {
                result.error = Some(
                    if error.is_timeout() {
                        "provider_timeout"
                    } else {
                        "transport_error"
                    }
                    .into(),
                );
                result.usage.usage_reason = result.error.clone();
            }
            Ok(mut response) => {
                result.http_status = Some(response.status().as_u16() as i32);
                result.provider_request_id = response
                    .headers()
                    .get("x-request-id")
                    .or_else(|| response.headers().get("request-id"))
                    .and_then(|h| h.to_str().ok())
                    .map(|s| {
                        self.redact(s)
                            .replace(key, "[REDACTED_CREDENTIAL]")
                            .chars()
                            .take(256)
                            .collect()
                    });
                let retry = response
                    .headers()
                    .get("retry-after")
                    .and_then(|h| h.to_str().ok())
                    .map(str::to_owned);
                let mut bytes = Vec::new();
                loop {
                    match response.chunk().await {
                        Ok(Some(chunk)) if bytes.len() + chunk.len() <= MAX_RESPONSE => {
                            bytes.extend_from_slice(&chunk)
                        }
                        Ok(Some(chunk)) => {
                            bytes.extend_from_slice(&chunk[..MAX_RESPONSE - bytes.len()]);
                            result.error = Some("response_size_limit".into());
                            break;
                        }
                        Ok(None) => {
                            result.response_complete = true;
                            break;
                        }
                        Err(_) => {
                            result.error = Some("response_interrupted".into());
                            break;
                        }
                    }
                }
                let cleaned = self.response_bytes(&bytes, key);
                result.response_base64 = STANDARD.encode(&cleaned);
                if result.response_complete {
                    interpret(spec.provider, &cleaned, &mut result);
                    if spec.computer_use {
                        crate::models::interpret_computer(&cleaned, &mut result);
                        if result.returned_model.as_deref() != Some(spec.model.as_str()) {
                            result.state = "failed".into();
                            result.error = Some("computer_use_model_mismatch".into());
                            result.output_text = None;
                        }
                    }
                    // Only explicit rate limits are retried. Ambiguous transport,
                    // timeout and 5xx errors require a new user decision.
                    if result.http_status == Some(429) {
                        result.retry_after_seconds = match retry.as_deref() {
                            None => Some(5),
                            Some(value) => retry_seconds(value),
                        };
                    }
                } else {
                    result.usage.usage_reason = result.error.clone();
                }
            }
        }
        result.elapsed_ms = Some(start.elapsed().as_millis().min(i64::MAX as u128) as i64);
        result
    }

    fn endpoint(&self, provider: Provider) -> String {
        self.fixture_url
            .as_ref()
            .map(|base| format!("{base}/{}", provider.name()))
            .unwrap_or_else(|| provider.endpoint().into())
    }

    /// Read-only ClickHouse query with bound `{name:Type}` parameters, as
    /// JSONEachRow objects. 64-bit integers come back as JSON numbers.
    pub(crate) async fn clickhouse_rows(
        &self,
        sql: &str,
        params: &[(String, String)],
    ) -> GResult<Vec<Value>> {
        let mut query = vec![
            ("readonly".to_owned(), "2".to_owned()),
            ("max_execution_time".to_owned(), "5".to_owned()),
            (
                "output_format_json_quote_64bit_integers".to_owned(),
                "0".to_owned(),
            ),
        ];
        query.extend(
            params
                .iter()
                .map(|(k, v)| (format!("param_{k}"), v.clone())),
        );
        let response = self
            .http
            .post(&self.clickhouse_url)
            .query(&query)
            .header("x-clickhouse-user", "scout")
            .header("x-clickhouse-key", &self.clickhouse_password)
            .body(sql.to_owned())
            .timeout(Duration::from_secs(8))
            .send()
            .await
            .map_err(|_| "clickhouse_unavailable")?;
        if !response.status().is_success() {
            return Err("clickhouse_query_failed");
        }
        let body = response
            .bytes()
            .await
            .map_err(|_| "clickhouse_unavailable")?;
        std::str::from_utf8(&body)
            .map_err(|_| "clickhouse_unexpected_response")?
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).map_err(|_| "clickhouse_unexpected_response"))
            .collect()
    }

    async fn count_demo_input(&self, key: &str, body: &[u8]) -> GResult<i64> {
        // Meta's non-generating count endpoint accepts the same Responses body,
        // including media, instructions, reasoning and server prompt scaffolding.
        let mut response = self
            .http
            .post("https://api.meta.ai/v1/responses/input_tokens")
            .bearer_auth(key)
            .header("content-type", "application/json")
            .body(body.to_vec())
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|_| "demo_token_count_unavailable")?;
        if !response.status().is_success() {
            return Err("demo_token_count_unavailable");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "demo_token_count_unavailable")?
        {
            if bytes.len() + chunk.len() > 16_384 {
                return Err("demo_token_count_unavailable");
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "demo_token_count_unavailable")?;
        value["input_tokens"]
            .as_i64()
            .filter(|n| (0..=1_048_576).contains(n))
            .ok_or("demo_token_count_unavailable")
    }

    async fn settle(&self, result: &CallResult) -> GResult<()> {
        let mut db = self.conn().await?;
        let tx = db.transaction().await.map_err(|_| "database_unavailable")?;
        let row = tx.query_opt("SELECT c.state,c.request_id,c.attempt,r.spec FROM model_calls c JOIN model_requests r USING(request_id) WHERE c.call_id=$1 FOR UPDATE OF c,r",&[&result.call_id]).await.map_err(|_| "database_unavailable")?.ok_or("journal_call_not_found")?;
        if row.get::<_, String>(0) != "dispatched" {
            return Ok(());
        }
        let request_id: Uuid = row.get(1);
        let attempt: i32 = row.get(2);
        let spec: ModelRequest =
            serde_json::from_value(row.get(3)).map_err(|_| "stored_request_invalid")?;
        let u = &result.usage;
        crate::provider_access::settle(&tx, result).await?;
        tx.execute("UPDATE model_calls SET state=$2,finished_at=now(),elapsed_ms=$3,http_status=$4,provider_request_id=$5,returned_model=$6,routed_provider=$7,output_text=$8,finish_reason=$9,error=$10,input_tokens=$11,output_tokens=$12,cached_input_tokens=$13,cache_write_tokens=$14,reasoning_tokens=$15,cost_usd=$16::text::numeric,usage_status=$17,usage_reason=$18,usage_raw=$19,response_complete=$20 WHERE call_id=$1",
            &[&result.call_id,&result.state,&result.elapsed_ms,&result.http_status,&result.provider_request_id,&result.returned_model,&result.routed_provider,&result.output_text,&result.finish_reason,&result.error,&u.input_tokens,&u.output_tokens,&u.cached_input_tokens,&u.cache_write_tokens,&u.reasoning_tokens,&u.cost_usd,&u.usage_status,&u.usage_reason,&u.usage_raw,&result.response_complete]).await.map_err(|_| "database_settlement_failed")?;
        let response = STANDARD
            .decode(&result.response_base64)
            .map_err(|_| "journal_corrupt")?;
        let reference = payload(&tx, result.call_id, "response", &response).await?;
        let mut details = serde_json::to_value(result).map_err(|_| "journal_corrupt")?;
        details.as_object_mut().unwrap().remove("response_base64");
        details["response"] = reference;
        event(
            &tx,
            request_id,
            Some(result.call_id),
            "call_finished",
            &details,
        )
        .await?;
        let retry = result.http_status == Some(429)
            && result.response_complete
            && result.retry_after_seconds.is_some()
            && attempt < i32::from(spec.max_attempts);
        let delay = result.retry_after_seconds.unwrap_or(5).max(1);
        let state = if retry {
            "queued"
        } else if result.state == "completed" {
            "completed"
        } else if result.state == "unknown" {
            "interrupted"
        } else {
            "failed"
        };
        tx.execute("UPDATE model_requests SET state=$2,error=$3,finished_at=CASE WHEN $2='queued' THEN NULL ELSE now() END,next_attempt_at=now()+($4::text || ' seconds')::interval WHERE request_id=$1",&[&request_id,&state,&result.error,&delay.to_string()]).await.map_err(|_| "database_settlement_failed")?;
        tx.commit()
            .await
            .map_err(|_| "database_settlement_failed")?;
        Ok(())
    }

    async fn write_journal(&self, result: &CallResult) -> GResult<()> {
        let directory = self.spool.clone();
        let id = result.call_id;
        let bytes = serde_json::to_vec(result).map_err(|_| "journal_encoding_failed")?;
        tokio::task::spawn_blocking(move || {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let temp = directory.join(format!("{id}.{}.tmp", Uuid::new_v4()));
            let target = directory.join(format!("{id}.json"));
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temp)
                .map_err(|_| "journal_unavailable")?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| "journal_write_failed")?;
            // hard_link atomically publishes without replacing an existing record.
            std::fs::hard_link(&temp, &target).map_err(|_| "journal_publish_failed")?;
            std::fs::remove_file(&temp).map_err(|_| "journal_publish_failed")?;
            std::fs::File::open(&directory)
                .and_then(|f| f.sync_all())
                .map_err(|_| "journal_sync_failed")?;
            Ok(())
        })
        .await
        .map_err(|_| "journal_task_failed")?
    }
    async fn remove_journal(&self, id: Uuid) -> GResult<()> {
        let directory = self.spool.clone();
        tokio::task::spawn_blocking(move || {
            std::fs::remove_file(directory.join(format!("{id}.json")))
                .map_err(|_| "journal_cleanup_failed")?;
            std::fs::File::open(&directory)
                .and_then(|f| f.sync_all())
                .map_err(|_| "journal_sync_failed")?;
            Ok(())
        })
        .await
        .map_err(|_| "journal_task_failed")?
    }

    async fn export_once(&self) -> GResult<bool> {
        let rows=self.conn().await?.query("SELECT payload_id,object_key,body,sha256 FROM model_payloads WHERE uploaded_at IS NULL ORDER BY payload_id LIMIT 10",&[]).await.map_err(|_| "database_unavailable")?;
        let mut progressed = !rows.is_empty();
        for row in rows {
            let id: Uuid = row.get(0);
            let key: String = row.get(1);
            let bytes: Vec<u8> = row.get(2);
            let sha: String = row.get(3);
            let path = ObjectPath::from(key);
            let result = self
                .store
                .put_opts(
                    &path,
                    bytes.clone().into(),
                    PutOptions {
                        mode: PutMode::Create,
                        ..Default::default()
                    },
                )
                .await;
            if !matches!(
                result,
                Ok(_)
                    | Err(object_store::Error::AlreadyExists { .. })
                    | Err(object_store::Error::Precondition { .. })
            ) {
                return Err("bucket_upload_failed");
            }
            let stored = self
                .store
                .get(&path)
                .await
                .map_err(|_| "bucket_readback_failed")?;
            if stored.meta.size != bytes.len() as u64 {
                return Err("bucket_hash_mismatch");
            }
            let stored = stored.bytes().await.map_err(|_| "bucket_readback_failed")?;
            if hash(&stored) != sha {
                return Err("bucket_hash_mismatch");
            }
            self.conn()
                .await?
                .execute(
                    "UPDATE model_payloads SET uploaded_at=now() WHERE payload_id=$1",
                    &[&id],
                )
                .await
                .map_err(|_| "database_unavailable")?;
        }
        let rows=self.conn().await?.query("SELECT e.event_id,jsonb_build_object('event_id',e.event_id,'workspace_id',r.workspace_id,'user_id',r.user_id,'agent_id',r.agent_id,'request_id',r.request_id,'call_id',e.call_id,'event_type',e.event_type,'occurred_at',to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.MS'),'provider',r.provider,'requested_model',r.model,'execution_mode',r.execution_mode,'run_id',r.run_id,'action_id',r.action_id,'payload',e.payload::text) FROM model_events e JOIN model_requests r USING(request_id) WHERE e.exported_at IS NULL ORDER BY e.occurred_at LIMIT 100",&[]).await.map_err(|_|"database_unavailable")?;
        if !rows.is_empty() {
            progressed = true;
            let ids: Vec<Uuid> = rows.iter().map(|r| r.get(0)).collect();
            let body = rows
                .iter()
                .map(|r| r.get::<_, Value>(1).to_string())
                .collect::<Vec<_>>()
                .join("\n");
            let response = self
                .http
                .post(&self.clickhouse_url)
                .query(&[
                    ("query", "INSERT INTO scout.model_events FORMAT JSONEachRow"),
                    ("async_insert", "0"),
                    ("wait_end_of_query", "1"),
                ])
                .header("x-clickhouse-user", "scout")
                .header("x-clickhouse-key", &self.clickhouse_password)
                .body(body)
                .timeout(Duration::from_secs(15))
                .send()
                .await
                .map_err(|_| "clickhouse_unavailable")?;
            if !response.status().is_success() {
                return Err("clickhouse_export_failed");
            }
            // Waiting for the full response avoids acknowledging a late HTTP error.
            let body = response
                .bytes()
                .await
                .map_err(|_| "clickhouse_unavailable")?;
            if !body.is_empty() {
                return Err("clickhouse_unexpected_response");
            }
            self.conn()
                .await?
                .execute(
                    "UPDATE model_events SET exported_at=now() WHERE event_id=ANY($1)",
                    &[&ids],
                )
                .await
                .map_err(|_| "database_unavailable")?;
        }
        Ok(progressed)
    }
}

fn retry_seconds(value: &str) -> Option<i64> {
    let n = value.parse::<i64>().ok().or_else(|| {
        chrono::DateTime::parse_from_rfc2822(value)
            .ok()
            .map(|time| time.timestamp() - chrono::Utc::now().timestamp())
    })?;
    // Delays over a week require a new explicit request; never retry earlier.
    (n <= 604_800).then_some(n.max(1))
}

async fn event(
    tx: &Transaction<'_>,
    request_id: Uuid,
    call_id: Option<Uuid>,
    kind: &str,
    body: &Value,
) -> GResult<()> {
    tx.execute("INSERT INTO model_events(event_id,request_id,call_id,event_type,payload) VALUES($1,$2,$3,$4,$5)",&[&Uuid::new_v4(),&request_id,&call_id,&kind,body]).await.map_err(|_|"event_write_failed")?;
    Ok(())
}
async fn payload(tx: &Transaction<'_>, call_id: Uuid, kind: &str, bytes: &[u8]) -> GResult<Value> {
    let id = Uuid::new_v4();
    let sha = hash(bytes);
    let workspace_id:Uuid=tx.query_one("SELECT r.workspace_id FROM model_requests r JOIN model_calls c USING(request_id) WHERE c.call_id=$1",&[&call_id]).await.map_err(|_|"payload_owner_unavailable")?.get(0);
    let key = format!("workspace/{workspace_id}/model-calls/{call_id}/{kind}-{sha}.json");
    tx.execute("INSERT INTO model_payloads(payload_id,call_id,kind,object_key,sha256,byte_length,body) VALUES($1,$2,$3,$4,$5,$6,$7)",&[&id,&call_id,&kind,&key,&sha,&(bytes.len() as i64),&bytes]).await.map_err(|_|"payload_write_failed")?;
    Ok(json!({"payload_id":id,"object_key":key,"sha256":sha,"byte_length":bytes.len()}))
}

pub async fn providers(ScopedState(state): ScopedState) -> Response {
    if let Some(g) = &state.gateway {
        match g.providers_for(&state.principal).await {
            Ok(v) => Json(v).into_response(),
            Err(code) => error(StatusCode::SERVICE_UNAVAILABLE, code),
        }
    } else {
        Json(json!({"gateway_ready":false,"providers":[],"keys":[],"vault_ready":false}))
            .into_response()
    }
}
pub async fn submit(
    ScopedState(state): ScopedState,
    body: Result<Json<ModelRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let spec = match body {
        Ok(Json(spec)) => spec,
        Err(rejection) => return error(rejection.status(), "invalid_model_request"),
    };
    let Some(g) = state.gateway.as_ref() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "gateway_unavailable");
    };
    match g.admit(&spec, &state.principal).await {
        Ok(created) => (if created {StatusCode::ACCEPTED}else{StatusCode::OK},Json(json!({"request_id":spec.request_id,"created":created,"status_url":format!("/v1/model-requests/{}",spec.request_id)}))).into_response(),
        Err(code) => error(match code {
            "idempotency_conflict"|"run_cancelled"=>StatusCode::CONFLICT,
            "queue_full"=>StatusCode::TOO_MANY_REQUESTS,
            "demo_credits_insufficient"=>StatusCode::PAYMENT_REQUIRED,
            "run_not_found"|"action_not_found"=>StatusCode::NOT_FOUND,
            "gateway_not_ready"|"database_unavailable"|"provider_not_configured"=>StatusCode::SERVICE_UNAVAILABLE,
            _=>StatusCode::BAD_REQUEST
        },code)
    }
}
pub async fn request(ScopedState(state): ScopedState, Path(id): Path<Uuid>) -> Response {
    match query(&state,"SELECT jsonb_build_object('request',to_jsonb(r),'calls',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY attempt) FROM model_calls c WHERE c.request_id=r.request_id),'[]'::jsonb),'payloads',COALESCE((SELECT jsonb_agg(to_jsonb(p)-'body' ORDER BY c.attempt,p.kind) FROM model_payloads p JOIN model_calls c USING(call_id) WHERE c.request_id=r.request_id),'[]'::jsonb),'events',COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.occurred_at,e.event_id) FROM model_events e WHERE e.request_id=r.request_id),'[]'::jsonb)) FROM model_requests r WHERE r.request_id=$1 AND ((workspace_id=$2 AND user_id=$3) OR $4::bool)",&[&id,&state.principal.workspace_id,&state.principal.user_id,&state.principal.operator]).await {
        Ok(Some(v))=>Json(v).into_response(),Ok(None)=>error(StatusCode::NOT_FOUND,"model_request_not_found"),Err(r)=>r
    }
}
pub async fn usage_report(ScopedState(state): ScopedState) -> Response {
    let mode = state
        .gateway
        .as_ref()
        .map(|g| g.execution_mode())
        .unwrap_or("live");
    match query(&state,"SELECT jsonb_build_object('user_id',$2::uuid,'execution_mode',$3::text,'requests',(SELECT count(*) FROM model_requests WHERE workspace_id=$1 AND user_id=$2 AND execution_mode=$3),'attempts',count(*),'in_flight_attempts',count(*) FILTER (WHERE c.state='dispatched'),'known_input_tokens',sum(input_tokens),'known_output_tokens',sum(output_tokens),'known_total_tokens',CASE WHEN count(c.input_tokens)+count(c.output_tokens)>0 THEN coalesce(sum(c.input_tokens),0)+coalesce(sum(c.output_tokens),0) END,'by_model',COALESCE((SELECT jsonb_agg(to_jsonb(u) ORDER BY u.provider,u.model) FROM (SELECT m.provider,m.model,count(*) AS attempts,sum(c.input_tokens) AS known_input_tokens,sum(c.output_tokens) AS known_output_tokens,CASE WHEN count(c.input_tokens)+count(c.output_tokens)>0 THEN coalesce(sum(c.input_tokens),0)+coalesce(sum(c.output_tokens),0) END AS known_total_tokens,count(*) FILTER (WHERE c.usage_status<>'reported') AS incomplete_usage_attempts,sum(c.cost_usd)::text AS provider_reported_cost_usd,count(*) FILTER (WHERE c.cost_usd IS NULL) AS unpriced_attempts FROM model_calls c JOIN model_requests m USING(request_id) WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.execution_mode=$3 GROUP BY m.provider,m.model) u),'[]'::jsonb),'incomplete_usage_attempts',count(*) FILTER (WHERE usage_status<>'reported'),'provider_reported_cost_usd',sum(cost_usd)::text,'unpriced_attempts',count(*) FILTER (WHERE cost_usd IS NULL),'cost_complete',count(*) FILTER (WHERE cost_usd IS NULL)=0,'by_agent',COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM (SELECT m.agent_id,count(*) AS attempts,sum(a.input_tokens) AS known_input_tokens,sum(a.output_tokens) AS known_output_tokens,CASE WHEN count(a.input_tokens)+count(a.output_tokens)>0 THEN coalesce(sum(a.input_tokens),0)+coalesce(sum(a.output_tokens),0) END AS known_total_tokens,sum(a.cost_usd)::text AS provider_reported_cost_usd,count(*) FILTER(WHERE a.usage_status<>'reported') AS incomplete_usage_attempts,count(*) FILTER(WHERE a.cost_usd IS NULL) AS unpriced_attempts FROM model_calls a JOIN model_requests m USING(request_id) WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.execution_mode=$3 GROUP BY m.agent_id) t),'[]'::jsonb),'complete',count(*) FILTER (WHERE usage_status<>'reported' OR c.state='dispatched')=0) FROM model_calls c JOIN model_requests r USING(request_id) WHERE r.workspace_id=$1 AND r.user_id=$2 AND r.execution_mode=$3",&[&state.principal.workspace_id,&state.principal.user_id,&mode]).await {
        Ok(Some(v))=>Json(v).into_response(),Ok(None)=>Json(json!({})).into_response(),Err(r)=>r
    }
}
