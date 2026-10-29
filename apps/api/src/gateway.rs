//! A single local worker owns the PostgreSQL advisory lock. Admission, dispatch,
//! usage settlement and outbox creation commit before their external effects.
use crate::identity::ScopedState;
use crate::{
    error,
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
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Notify};
use tokio_postgres::{Client, Transaction};
use uuid::Uuid;

pub const USER_ID: Uuid = Uuid::from_u128(0x00000000000040008000000000000002);
type GResult<T> = Result<T, &'static str>;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const MAX_IMAGE: u64 = 4 * 1024 * 1024;
const LOCK_ID: i64 = 736_268_194_001;
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub struct Gateway {
    db: Mutex<Client>,
    http: reqwest::Client,
    store: Arc<dyn ObjectStore>,
    keys: Vec<(Provider, String)>,
    secrets: Vec<String>,
    fixture_url: Option<String>,
    clickhouse_url: String,
    clickhouse_password: String,
    spool: PathBuf,
    notify: Notify,
    ready: AtomicBool,
}

impl Gateway {
    pub fn from_env(db: Client) -> GResult<Arc<Self>> {
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
        for p in [Provider::Openai, Provider::Anthropic, Provider::Openrouter] {
            let key = if fixture_url.is_some() {
                "scout_fixture_credential_not_a_real_key".into()
            } else {
                env::var(p.key_env()).unwrap_or_default()
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
            "POSTGRES_PASSWORD",
            "S3_ACCESS_KEY_ID",
            "S3_SECRET_ACCESS_KEY",
            "CLICKHOUSE_PASSWORD",
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
            db: Mutex::new(db),
            http,
            store: Arc::new(store),
            keys,
            secrets,
            fixture_url,
            clickhouse_url: env::var("CLICKHOUSE_URL")
                .unwrap_or_else(|_| "http://clickhouse:8123".into()),
            clickhouse_password: env::var("CLICKHOUSE_PASSWORD")
                .map_err(|_| "missing_clickhouse_credentials")?,
            spool: env::var("MODEL_SPOOL")
                .unwrap_or_else(|_| "/data/gateway".into())
                .into(),
            notify: Notify::new(),
            ready: AtomicBool::new(false),
        }))
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
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
        let providers = [Provider::Openai, Provider::Anthropic, Provider::Openrouter]
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
    fn redact(&self, text: &str) -> String {
        self.secrets.iter().fold(text.to_owned(), |text, secret| {
            text.replace(secret, "[REDACTED_CREDENTIAL]")
        })
    }
    fn response_bytes(&self, bytes: &[u8]) -> Vec<u8> {
        fn scrub(g: &Gateway, value: &mut Value) {
            match value {
                Value::String(text) => *text = g.redact(text).replace('\0', "[NUL]"),
                Value::Array(values) => values.iter_mut().for_each(|v| scrub(g, v)),
                Value::Object(map) => {
                    let old = std::mem::take(map);
                    for (key, mut value) in old {
                        scrub(g, &mut value);
                        map.insert(g.redact(&key).replace('\0', "[NUL]"), value);
                    }
                }
                _ => {}
            }
        }
        if let Ok(original) = serde_json::from_slice::<Value>(bytes) {
            let mut cleaned = original.clone();
            scrub(self, &mut cleaned);
            if cleaned != original {
                return serde_json::to_vec(&cleaned).expect("JSON value");
            }
        }
        self.redact(&String::from_utf8_lossy(bytes)).into_bytes()
    }

    pub fn start(self: &Arc<Self>) {
        let worker = self.clone();
        tokio::spawn(async move {
            loop {
                match worker.initialize().await {
                    Ok(()) => break,
                    Err(code) => eprintln!("model_gateway_initializing: {code}"),
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            worker.ready.store(true, Ordering::SeqCst);
            loop {
                match worker.process_next().await {
                    Ok(true) => continue,
                    Ok(false) => {}
                    Err(code) => {
                        // A failed local journal/settlement must stop new spending.
                        worker.ready.store(false, Ordering::SeqCst);
                        eprintln!("model_gateway_halted: {code}; restart after restoring storage");
                        break;
                    }
                }
                tokio::select! { _=worker.notify.notified()=>{}, _=tokio::time::sleep(Duration::from_secs(1))=>{} }
            }
        });
        let exporter = self.clone();
        tokio::spawn(async move {
            loop {
                if exporter.is_ready() {
                    match exporter.export_once().await {
                        Ok(true) => {
                            // Keep draining bounded batches while work exists;
                            // sleeping five seconds per batch accumulates lag
                            // during screenshot-heavy exploration runs.
                            tokio::time::sleep(Duration::from_millis(50)).await;
                            continue;
                        }
                        Ok(false) => {}
                        Err(code) => eprintln!("model_export_pending: {code}"),
                    }
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });
    }

    async fn initialize(&self) -> GResult<()> {
        // A per-process dedicated database connection holds the singleton lock.
        // Re-entrant lock calls are avoided: after a recoverable initialization
        // failure explicitly unlock before trying again.
        let locked: bool = self
            .db
            .lock()
            .await
            .query_one("SELECT pg_try_advisory_lock($1)", &[&LOCK_ID])
            .await
            .map_err(|_| "database_unavailable")?
            .get(0);
        if !locked {
            return Err("another_gateway_worker_is_active");
        }
        let result = self.recover().await;
        if result.is_err() {
            let _ = self
                .db
                .lock()
                .await
                .query_one("SELECT pg_advisory_unlock($1)", &[&LOCK_ID])
                .await;
        }
        result
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
        let calls = self.db.lock().await.query("SELECT c.call_id FROM model_calls c JOIN model_requests r USING(request_id) WHERE c.state='dispatched'",&[]).await.map_err(|_| "database_unavailable")?;
        for row in calls {
            // The provider might have billed this attempt. Never replay it.
            self.settle(&CallResult::unknown(
                row.get(0),
                "process_interrupted_after_dispatch",
            ))
            .await?;
        }
        self.db
            .lock()
            .await
            .execute(
                "UPDATE model_requests SET state='queued' WHERE state='preparing'",
                &[],
            )
            .await
            .map_err(|_| "database_unavailable")?;
        Ok(())
    }

    async fn admit(
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
        let mut db = self.db.lock().await;
        let tx = db.transaction().await.map_err(|_| "database_unavailable")?;
        // Only the trusted operator/worker may submit raw model requests. Derive
        // ownership from its admitted run, never a client-supplied workspace ID.
        let (workspace_id, user_id, agent_id) = if let Some(id) = spec.run_id {
            let row=tx.query_opt("SELECT r.workspace_id,r.user_id,(SELECT agent_id FROM browser_jobs j WHERE j.run_id=r.run_id AND j.workspace_id=r.workspace_id AND j.user_id=r.user_id ORDER BY j.created_at,j.job_id LIMIT 1) FROM runtime_runs r WHERE r.run_id=$1",&[&id]).await.map_err(|_|"database_unavailable")?.ok_or("run_not_found")?;
            (
                row.get::<_, Uuid>(0),
                row.get::<_, Uuid>(1),
                row.get::<_, Option<Uuid>>(2),
            )
        } else {
            (
                principal.workspace_id,
                principal.user_id,
                principal.agent_id,
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
        if !self.keys.iter().any(|(p, _)| *p == spec.provider) {
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
        tx.execute("INSERT INTO model_requests(request_id,workspace_id,user_id,run_id,action_id,provider,model,spec,spec_sha256,state,execution_mode,agent_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$11)",&[&spec.request_id,&workspace_id,&user_id,&spec.run_id,&spec.action_id,&spec.provider.name(),&spec.model,&value,&sha,&self.execution_mode(),&agent_id]).await.map_err(|_| "database_unavailable")?;
        event(&tx,spec.request_id,None,"request_accepted",&json!({"spec":value,"training_status":if self.fixture_url.is_some(){"excluded_fixture"}else{"pending_review"}})).await?;
        tx.commit().await.map_err(|_| "database_unavailable")?;
        self.notify.notify_one();
        Ok(true)
    }

    async fn process_next(&self) -> GResult<bool> {
        let row = self.db.lock().await.query_opt("UPDATE model_requests SET state='preparing' WHERE request_id=(SELECT request_id FROM model_requests WHERE execution_mode=$1 AND state='queued' AND next_attempt_at<=now() ORDER BY created_at LIMIT 1) RETURNING spec",&[&self.execution_mode()]).await.map_err(|_| "database_unavailable")?;
        let Some(row) = row else { return Ok(false) };
        let spec: ModelRequest =
            serde_json::from_value(row.get(0)).map_err(|_| "stored_request_invalid")?;
        let Some((_, key)) = self.keys.iter().find(|(p, _)| *p == spec.provider) else {
            self.fail_before_dispatch(spec.request_id, "provider_not_configured")
                .await?;
            return Ok(true);
        };
        let mut images = Vec::new();
        for id in &spec.capture_ids {
            match self.image(*id, spec.run_id).await {
                Ok(image) => images.push(image),
                Err(code) => {
                    self.fail_before_dispatch(spec.request_id, code).await?;
                    return Ok(true);
                }
            }
        }
        let bytes =
            serde_json::to_vec(&wire_request(&spec, &images)).map_err(|_| "invalid_request")?;
        let call_id = Uuid::new_v4();
        {
            let mut db = self.db.lock().await;
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
            let reference = payload(&tx, call_id, "request", &bytes).await?;
            event(&tx,spec.request_id,Some(call_id),"call_dispatched",&json!({"attempt":attempt,"request":reference,"prompt":spec.prompt,"system":spec.system,"capture_ids":spec.capture_ids})).await?;
            tx.commit().await.map_err(|_| "database_unavailable")?;
        }
        let result = self.invoke(&spec, call_id, key, bytes).await;
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

    async fn image(&self, id: Uuid, run_id: Option<Uuid>) -> GResult<Vec<u8>> {
        let row = self.db.lock().await.query_opt("SELECT c.object_key,c.sha256,c.byte_length FROM runtime_captures c JOIN runtime_runs r USING(run_id) WHERE capture_id=$1 AND c.run_id=$2 AND c.status='available'",&[&id,&run_id]).await.map_err(|_| "database_unavailable")?.ok_or("capture_unavailable")?;
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
        let mut db = self.db.lock().await;
        let tx = db.transaction().await.map_err(|_| "database_unavailable")?;
        tx.execute("UPDATE model_requests SET state='failed',finished_at=now(),error=$2 WHERE request_id=$1",&[&id,&code]).await.map_err(|_| "database_unavailable")?;
        event(
            &tx,
            id,
            None,
            "request_failed",
            &json!({"error":code,"provider_dispatched":false}),
        )
        .await?;
        tx.commit().await.map_err(|_| "database_unavailable")?;
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
        let endpoint = self
            .fixture_url
            .as_ref()
            .map(|base| format!("{base}/{}", spec.provider.name()))
            .unwrap_or_else(|| spec.provider.endpoint().into());
        let mut request = self
            .http
            .post(endpoint)
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
                    .map(|s| self.redact(s).chars().take(256).collect());
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
                let cleaned = self.response_bytes(&bytes);
                result.response_base64 = STANDARD.encode(&cleaned);
                if result.response_complete {
                    interpret(spec.provider, &cleaned, &mut result);
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

    async fn settle(&self, result: &CallResult) -> GResult<()> {
        let mut db = self.db.lock().await;
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
        let rows=self.db.lock().await.query("SELECT payload_id,object_key,body,sha256 FROM model_payloads WHERE uploaded_at IS NULL ORDER BY payload_id LIMIT 10",&[]).await.map_err(|_| "database_unavailable")?;
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
            self.db
                .lock()
                .await
                .execute(
                    "UPDATE model_payloads SET uploaded_at=now() WHERE payload_id=$1",
                    &[&id],
                )
                .await
                .map_err(|_| "database_unavailable")?;
        }
        let rows=self.db.lock().await.query("SELECT e.event_id,jsonb_build_object('event_id',e.event_id,'workspace_id',r.workspace_id,'user_id',r.user_id,'agent_id',r.agent_id,'request_id',r.request_id,'call_id',e.call_id,'event_type',e.event_type,'occurred_at',to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.MS'),'provider',r.provider,'requested_model',r.model,'execution_mode',r.execution_mode,'run_id',r.run_id,'action_id',r.action_id,'payload',e.payload::text) FROM model_events e JOIN model_requests r USING(request_id) WHERE e.exported_at IS NULL ORDER BY e.occurred_at LIMIT 100",&[]).await.map_err(|_|"database_unavailable")?;
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
            self.db
                .lock()
                .await
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

pub async fn providers(ScopedState(state): ScopedState) -> Json<Value> {
    Json(
        state
            .gateway
            .as_ref()
            .map(|g| g.providers())
            .unwrap_or_else(|| json!({"gateway_ready":false,"providers":[]})),
    )
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
    match query(&state,"SELECT jsonb_build_object('user_id',$2::uuid,'execution_mode',$3::text,'requests',(SELECT count(*) FROM model_requests WHERE workspace_id=$1 AND user_id=$2 AND execution_mode=$3),'attempts',count(*),'in_flight_attempts',count(*) FILTER (WHERE c.state='dispatched'),'known_input_tokens',sum(input_tokens),'known_output_tokens',sum(output_tokens),'incomplete_usage_attempts',count(*) FILTER (WHERE usage_status<>'reported'),'provider_reported_cost_usd',sum(cost_usd)::text,'unpriced_attempts',count(*) FILTER (WHERE cost_usd IS NULL),'cost_complete',count(*) FILTER (WHERE cost_usd IS NULL)=0,'by_agent',COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM (SELECT m.agent_id,count(*) AS attempts,sum(a.input_tokens) AS known_input_tokens,sum(a.output_tokens) AS known_output_tokens,sum(a.cost_usd)::text AS provider_reported_cost_usd,count(*) FILTER(WHERE a.usage_status<>'reported') AS incomplete_usage_attempts,count(*) FILTER(WHERE a.cost_usd IS NULL) AS unpriced_attempts FROM model_calls a JOIN model_requests m USING(request_id) WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.execution_mode=$3 GROUP BY m.agent_id) t),'[]'::jsonb),'complete',count(*) FILTER (WHERE usage_status<>'reported' OR c.state='dispatched')=0) FROM model_calls c JOIN model_requests r USING(request_id) WHERE r.workspace_id=$1 AND r.user_id=$2 AND r.execution_mode=$3",&[&state.principal.workspace_id,&state.principal.user_id,&mode]).await {
        Ok(Some(v))=>Json(v).into_response(),Ok(None)=>Json(json!({})).into_response(),Err(r)=>r
    }
}
