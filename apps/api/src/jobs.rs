use crate::identity::ScopedState;
use crate::{AppState, error, query};
#[cfg(test)]
use crate::{WORKSPACE_ID, gateway::USER_ID};
use axum::{
    Json,
    extract::Path,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{env, sync::Arc};
use uuid::Uuid;

/// Executed browser actions per exploration, matching the browser runtime.
pub const MAX_EXPLORATION_ACTIONS: u32 = 50;
const DEFAULT_EXPLORATION_ACTIONS: u32 = 20;
/// Total automatic replay actions per exploration; one full path fits twice.
pub const MAX_AUTO_REPLAY_ACTIONS: u32 = MAX_EXPLORATION_ACTIONS * 2;
/// Recorded actions in a verifiable issue path, including skipped plans.
const MAX_ISSUE_PATH: usize = MAX_EXPLORATION_ACTIONS as usize * 2;

fn enabled() -> bool {
    true
}

#[derive(Clone)]
pub struct Queue {
    db: Arc<crate::db::Postgres>,
    principal: crate::identity::Principal,
    pub settings: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsSubmission {
    request_id: Uuid,
    expected_revision: i64,
    provider: String,
    model: String,
    max_actions: u32,
    viewport_profile: String,
    free_only: bool,
    auto_reproduce: bool,
    max_auto_reproductions: u32,
    max_auto_replay_actions: u32,
    // Older clients omit it; memory is on unless explicitly disabled.
    #[serde(default = "enabled")]
    app_memory: bool,
}

#[derive(Debug)]
struct NormalizedSettings {
    request_id: Uuid,
    expected_revision: i64,
    settings: Value,
}

impl SettingsSubmission {
    fn normalize(self) -> Result<NormalizedSettings, &'static str> {
        if self.request_id.is_nil()
            || self.expected_revision < 0
            || self.expected_revision == i64::MAX
        {
            return Err("invalid_settings_request_id_or_revision");
        }
        if !matches!(
            self.provider.as_str(),
            "openai" | "anthropic" | "openrouter" | "meta"
        ) {
            return Err("invalid_settings_provider");
        }
        let model = self.model.trim();
        if self.model.chars().any(char::is_control)
            || model.is_empty()
            || model.len() > 200
            || !model
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"/:._-".contains(&c))
        {
            return Err("invalid_settings_model");
        }
        if !(1..=MAX_EXPLORATION_ACTIONS).contains(&self.max_actions)
            || !(1..=3).contains(&self.max_auto_reproductions)
            || !(1..=MAX_AUTO_REPLAY_ACTIONS).contains(&self.max_auto_replay_actions)
        {
            return Err("invalid_settings_limits");
        }
        if !matches!(
            self.viewport_profile.as_str(),
            "desktop" | "tablet" | "mobile"
        ) {
            return Err("invalid_settings_viewport");
        }
        let free_only = self.provider == "openrouter" && self.free_only;
        if free_only && model != "openrouter/free" && !model.ends_with(":free") {
            return Err("free_only_requires_free_model");
        }
        Ok(NormalizedSettings {
            request_id: self.request_id,
            expected_revision: self.expected_revision,
            settings: json!({
                "provider":self.provider,"model":model,"maxActions":self.max_actions,
                "viewportProfile":self.viewport_profile,"freeOnly":free_only,
                "autoReproduce":self.auto_reproduce,"maxAutoReproductions":self.max_auto_reproductions,
                "maxAutoReplayActions":self.max_auto_replay_actions,"appMemory":self.app_memory
            }),
        })
    }
}

fn settings_snapshot(base: &Value, saved: Option<&Value>, revision: i64) -> Value {
    let mut settings = base.clone();
    // Security policy, origins and secrets never come from a saved preference.
    if let Some(saved) = saved {
        for key in [
            "provider",
            "model",
            "maxActions",
            "viewportProfile",
            "freeOnly",
            "autoReproduce",
            "maxAutoReproductions",
            "maxAutoReplayActions",
            "appMemory",
        ] {
            if let Some(value) = saved.get(key) {
                settings[key] = value.clone();
            }
        }
    }
    settings["settingsRevision"] = json!(revision);
    settings
}

fn settings_retry(
    saved: &Value,
    input: &NormalizedSettings,
    workspace_id: Uuid,
    user_id: Uuid,
) -> Result<(), &'static str> {
    if saved["workspace_id"] != workspace_id.to_string()
        || saved["user_id"] != user_id.to_string()
        || saved["expected_revision"] != input.expected_revision
        || saved["settings"] != input.settings
    {
        return Err("settings_request_id_conflict");
    }
    Ok(())
}

fn next_settings_revision(expected: i64, current: i64) -> Result<i64, &'static str> {
    if expected != current {
        return Err("revision_conflict");
    }
    current.checked_add(1).ok_or("invalid_settings_revision")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Submission {
    job_id: Uuid,
    #[serde(default)]
    project_id: Option<Uuid>,
    #[serde(default)]
    task_id: Option<Uuid>,
    kind: String,
    #[serde(default)]
    target_url: Option<String>,
    #[serde(default)]
    source_action_id: Option<Uuid>,
    #[serde(default)]
    viewport_profile: Option<String>,
    #[serde(default)]
    auth_mode: Option<String>,
    #[serde(default)]
    session_id: Option<Uuid>,
    #[serde(default)]
    auto_reproduce: Option<bool>,
    #[serde(default)]
    app_memory: Option<bool>,
    #[serde(default)]
    issue_id: Option<Uuid>,
    #[serde(default)]
    deployment_ref: Option<String>,
}

fn bounded_setting(name: &str, default: u32, max: u32) -> u32 {
    env::var(name)
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|n| (1..=max).contains(n))
        .unwrap_or(default)
}

/// Public websites can be tested from a pasted URL. Private, HTTP and internal
/// hosts still need an exact entry in the operator allowlist.
fn public_https_origin(url: &reqwest::Url) -> bool {
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }
    if host.is_empty()
        || host.len() > 253
        || !host.contains('.')
        || host
            .split('.')
            .all(|label| label.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return false;
    }
    if host == "localhost"
        || [
            ".localhost",
            ".local",
            ".internal",
            ".localdomain",
            ".home.arpa",
        ]
        .iter()
        .any(|suffix| host.ends_with(suffix))
    {
        return false;
    }
    host.split('.').all(|label| {
        (1..=63).contains(&label.len())
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

fn target(value: &str, allowed: &[String]) -> Result<String, &'static str> {
    let url = reqwest::Url::parse(value).map_err(|_| "invalid_target_url")?;
    if value.len() > 2048
        || !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || !(allowed.contains(&url.origin().ascii_serialization()) || public_https_origin(&url))
    {
        return Err("target_origin_not_allowed");
    }
    Ok(url.to_string())
}

fn prepare_submission(
    input: &Submission,
    defaults: &Value,
) -> Result<(Value, Value), &'static str> {
    if input.project_id.is_some_and(|id| id.is_nil()) || input.task_id.is_some_and(|id| id.is_nil())
    {
        return Err("invalid_correlation_id");
    }
    let mut settings = defaults.clone();
    let mut request = match input.kind.as_str() {
        "explore"
            if input.source_action_id.is_none()
                && input.issue_id.is_none()
                && input.deployment_ref.is_none() =>
        {
            let allowed = defaults["allowedOrigins"]
                .as_array()
                .ok_or("target_origin_not_allowed")?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            json!({"kind":"explore","target_url":target(input.target_url.as_deref().ok_or("missing_target_url")?, &allowed)?})
        }
        "reproduce"
            if input.target_url.is_none()
                && input.viewport_profile.is_none()
                && input.auth_mode.is_none()
                && input.session_id.is_none()
                && input.auto_reproduce.is_none()
                && input.app_memory.is_none()
                && input.issue_id.is_none()
                && input.deployment_ref.is_none() =>
        {
            json!({"kind":"reproduce","source_action_id":input.source_action_id.ok_or("missing_source_action_id")?})
        }
        "verify_fix"
            if input.source_action_id.is_none()
                && input.viewport_profile.is_none()
                && input.auto_reproduce.is_none()
                && input.app_memory.is_none() =>
        {
            let issue_id = input
                .issue_id
                .filter(|id| !id.is_nil())
                .ok_or("missing_issue_id")?;
            let allowed = defaults["allowedOrigins"]
                .as_array()
                .ok_or("target_origin_not_allowed")?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let deployment = input.deployment_ref.as_deref().map(str::trim);
            if deployment
                .is_some_and(|v| v.is_empty() || v.len() > 200 || v.chars().any(char::is_control))
            {
                return Err("invalid_deployment_ref");
            }
            if input.auth_mode.as_deref() == Some("sign_in") {
                return Err("verification_requires_saved_session_or_public_access");
            }
            json!({"kind":"verify_fix","issue_id":issue_id,"target_url":target(input.target_url.as_deref().ok_or("missing_target_url")?,&allowed)?,"deployment_ref":deployment})
        }
        _ => return Err("invalid_job_kind_or_fields"),
    };
    if input.kind == "explore" {
        if let Some(enabled) = input.auto_reproduce {
            settings["autoReproduce"] = json!(enabled);
            // Keep omitted defaults omitted in the idempotency request.
            request["auto_reproduce"] = json!(enabled);
        }
        if let Some(enabled) = input.app_memory {
            settings["appMemory"] = json!(enabled);
            request["app_memory"] = json!(enabled);
        }
    } else {
        // Replays follow recorded evidence and never use exploration memory.
        settings["autoReproduce"] = json!(false);
        settings["appMemory"] = json!(false);
    }
    if let Some(mode) = &input.auth_mode {
        if !matches!(mode.as_str(), "auto" | "sign_in" | "public") {
            return Err("invalid_auth_mode");
        }
        if mode == "public" && input.session_id.is_some() {
            return Err("public_mode_cannot_use_session");
        }
        request["auth_mode"] = json!(mode);
    }
    if let Some(id) = input.session_id {
        request["session_id"] = json!(id);
    }
    if let Some(profile) = &input.viewport_profile {
        if !matches!(profile.as_str(), "desktop" | "tablet" | "mobile") {
            return Err("invalid_viewport_profile");
        }
        settings["viewportProfile"] = json!(profile);
        request["viewport_profile"] = settings["viewportProfile"].clone();
    }
    if !matches!(
        settings["viewportProfile"].as_str(),
        Some("desktop" | "tablet" | "mobile")
    ) {
        return Err("invalid_viewport_profile");
    }
    Ok((request, settings))
}

impl Queue {
    // Read requests use the read-only pool. Focus admission checks out a write
    // connection and performs its transaction inside PostgreSQL.
    pub async fn submit_steering(
        &self,
        run_id: Uuid,
        input: &crate::steering::Submission,
    ) -> Result<Value, &'static str> {
        let principal = &self.principal;
        let db = self.db.write().await?;
        let row = db
            .query_one(
                "SELECT scout_submit_steering($1,$2,$3,$4,$5,$6,$7)",
                &[
                    &run_id,
                    &principal.workspace_id,
                    &principal.user_id,
                    &principal.agent_id,
                    &input.steering_id,
                    &input.expected_revision,
                    &input.focus,
                ],
            )
            .await
            .map_err(|_| "database_unavailable")?;
        Ok(row.get(0))
    }
    /// Delete one remembered app scope. Run evidence is untouched. A scope
    /// that an active run is still writing cannot be forgotten until it ends.
    pub async fn forget_memory(&self, scope_id: Uuid) -> Result<Value, &'static str> {
        let mut db = self.db.write().await?;
        let tx = db.transaction().await.map_err(|_| "database_unavailable")?;
        let row = tx.query_opt("SELECT origin,viewport_profile,auth_scope,execution_mode,EXISTS(SELECT 1 FROM runtime_runs r WHERE r.run_id=s.last_run_id AND r.lifecycle='active') FROM app_memory_scopes s WHERE scope_id=$1 AND workspace_id=$2 AND user_id=$3 FOR UPDATE",&[&scope_id,&self.principal.workspace_id,&self.principal.user_id]).await.map_err(|_|"database_unavailable")?.ok_or("memory_scope_not_found")?;
        if row.get::<_, bool>(4) {
            return Err("memory_scope_in_use");
        }
        tx.execute(
            "DELETE FROM app_memory_scopes WHERE scope_id=$1",
            &[&scope_id],
        )
        .await
        .map_err(|_| "database_unavailable")?;
        tx.commit().await.map_err(|_| "database_unavailable")?;
        Ok(json!({
            "scope_id":scope_id,"forgotten":true,"origin":row.get::<_,String>(0),"viewport_profile":row.get::<_,String>(1),
            "auth_scope":row.get::<_,String>(2),"execution_mode":row.get::<_,String>(3),"run_evidence_retained":true
        }))
    }
    pub fn scoped(&self, principal: &crate::identity::Principal) -> Self {
        Self {
            db: self.db.clone(),
            settings: self.settings.clone(),
            principal: principal.clone(),
        }
    }
    pub async fn effective_settings(&self) -> Result<Value, &'static str> {
        let db = self.db.write().await?;
        let saved = db.query_opt("SELECT revision,settings FROM exploration_settings_versions WHERE workspace_id=$1 AND user_id=$2 ORDER BY revision DESC LIMIT 1",&[&self.principal.workspace_id,&self.principal.user_id]).await.map_err(|_|"database_unavailable")?;
        let (revision, settings) = saved
            .map(|row| (row.get::<_, i64>(0), Some(row.get::<_, Value>(1))))
            .unwrap_or((0, None));
        Ok(
            json!({"revision":revision,"settings":settings_snapshot(&self.settings,settings.as_ref(),revision)}),
        )
    }

    async fn save_settings(&self, input: SettingsSubmission) -> Result<Value, &'static str> {
        let input = input.normalize()?;
        let mut db = self.db.write().await?;
        let tx = db.transaction().await.map_err(|_| "database_unavailable")?;
        // New job admissions and preference revisions have one serialization
        // point across API instances. Already admitted jobs remain immutable.
        tx.query_one("SELECT pg_advisory_xact_lock(736268194002)", &[])
            .await
            .map_err(|_| "database_unavailable")?;
        if let Some(row) = tx
            .query_opt(
                "SELECT to_jsonb(v) FROM exploration_settings_versions v WHERE request_id=$1",
                &[&input.request_id],
            )
            .await
            .map_err(|_| "database_unavailable")?
        {
            let saved: Value = row.get(0);
            settings_retry(
                &saved,
                &input,
                self.principal.workspace_id,
                self.principal.user_id,
            )?;
            let revision = saved["revision"].as_i64().ok_or("database_unavailable")?;
            return Ok(
                json!({"revision":revision,"settings":settings_snapshot(&self.settings,Some(&saved["settings"]),revision),"reused":true}),
            );
        }
        let current:i64=tx.query_one("SELECT COALESCE(max(revision),0) FROM exploration_settings_versions WHERE workspace_id=$1 AND user_id=$2",&[&self.principal.workspace_id,&self.principal.user_id]).await.map_err(|_|"database_unavailable")?.get(0);
        let revision = next_settings_revision(input.expected_revision, current)?;
        tx.execute("INSERT INTO exploration_settings_versions(request_id,workspace_id,user_id,revision,expected_revision,settings) VALUES($1,$2,$3,$4,$5,$6)",&[&input.request_id,&self.principal.workspace_id,&self.principal.user_id,&revision,&input.expected_revision,&input.settings]).await.map_err(|_|"database_unavailable")?;
        tx.commit().await.map_err(|_| "database_unavailable")?;
        Ok(
            json!({"revision":revision,"settings":settings_snapshot(&self.settings,Some(&input.settings),revision),"reused":false}),
        )
    }

    async fn cancel(&self, id: Uuid, by_run: bool) -> Result<Value, &'static str> {
        let mut db = self.db.write().await?;
        let tx = db.transaction().await.map_err(|_| "database_unavailable")?;
        // Always lock the job before its run, matching the worker's linking
        // transaction. Dispatch/finalization serialize on the run row.
        let job_id = if by_run {
            tx.query_opt("SELECT job_id FROM browser_jobs WHERE run_id=$1 AND workspace_id=$2 AND user_id=$3 ORDER BY (status='running') DESC,created_at DESC LIMIT 1", &[&id,&self.principal.workspace_id,&self.principal.user_id])
                .await.map_err(|_| "database_unavailable")?.map(|r|r.get::<_,Uuid>(0))
        } else {
            Some(id)
        };
        let job: Option<Value> = if let Some(job_id) = job_id {
            tx.query_opt("SELECT to_jsonb(j) FROM browser_jobs j WHERE job_id=$1 AND workspace_id=$2 AND user_id=$3 FOR UPDATE", &[&job_id,&self.principal.workspace_id,&self.principal.user_id])
                .await.map_err(|_| "database_unavailable")?.map(|r|r.get(0))
        } else {
            None
        };
        if !by_run && job.is_none() {
            return Err("job_not_found");
        }
        let run_id = if by_run {
            Some(id)
        } else {
            job.as_ref()
                .and_then(|j| j["run_id"].as_str())
                .and_then(|s| Uuid::parse_str(s).ok())
        };
        let run: Option<Value> = if let Some(run_id) = run_id {
            tx.query_opt("SELECT to_jsonb(r) FROM runtime_runs r WHERE run_id=$1 AND workspace_id=$2 AND user_id=$3 FOR UPDATE", &[&run_id,&self.principal.workspace_id,&self.principal.user_id])
                .await.map_err(|_| "database_unavailable")?.map(|r|r.get(0))
        } else {
            None
        };
        if by_run && run.is_none() {
            return Err("run_not_found");
        }
        let existing = run
            .as_ref()
            .and_then(|r| r["cancel_id"].as_str())
            .or_else(|| job.as_ref().and_then(|j| j["cancel_id"].as_str()));
        let terminal = run.as_ref().is_some_and(|r| r["lifecycle"] != "active")
            || job
                .as_ref()
                .is_some_and(|j| !matches!(j["status"].as_str(), Some("queued" | "running")));
        if terminal {
            let cancelled = run.as_ref().is_some_and(|r| r["lifecycle"] == "cancelled")
                || job.as_ref().is_some_and(|j| j["status"] == "cancelled");
            return Ok(
                json!({"job_id":job_id,"run_id":run_id,"cancellation_id":existing,"status":if cancelled{"cancelled"}else{"already_finished"},"reused":true}),
            );
        }
        if run
            .as_ref()
            .is_some_and(|r| r["config"]["runtime_version"] != "explorer-v1")
        {
            return Err("run_cancellation_unsupported");
        }
        let cancellation_id = existing
            .and_then(|s| Uuid::parse_str(s).ok())
            .unwrap_or_else(Uuid::new_v4);
        let queued = job.as_ref().is_some_and(|j| j["status"] == "queued");
        if let Some(job_id) = job_id {
            tx.execute("UPDATE browser_jobs SET cancel_id=$2,cancel_requested_at=COALESCE(cancel_requested_at,now()),status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END WHERE job_id=$1",&[&job_id,&cancellation_id]).await.map_err(|_| "database_unavailable")?;
        }
        if let Some(run_id) = run_id
            && run.as_ref().is_some_and(|r| r["cancel_id"].is_null())
        {
            let row=tx.query_one("UPDATE runtime_runs SET cancel_id=$2,cancel_requested_at=now(),event_seq=event_seq+1 WHERE run_id=$1 RETURNING event_seq",&[&run_id,&cancellation_id]).await.map_err(|_| "database_unavailable")?;
            let seq: i64 = row.get(0);
            tx.execute("INSERT INTO runtime_events(event_id,run_id,seq,event_type,payload) VALUES($1,$2,$3,'run.cancel_requested',$4)",&[&Uuid::new_v4(),&run_id,&seq,&json!({"cancellation_id":cancellation_id,"actor":"user","in_flight_usage_may_settle":true})]).await.map_err(|_| "database_unavailable")?;
        }
        tx.commit().await.map_err(|_| "database_unavailable")?;
        Ok(
            json!({"job_id":job_id,"run_id":run_id,"cancellation_id":cancellation_id,"status":if queued{"cancelled"}else{"cancelling"},"reused":existing.is_some()}),
        )
    }

    async fn cancel_automatic(&self, run_id: Uuid) -> Result<Value, &'static str> {
        let (cancellation_id, reused) = {
            let mut db = self.db.write().await?;
            let tx = db.transaction().await.map_err(|_| "database_unavailable")?;
            // Match scheduler order: source job -> source run -> child jobs.
            // Persist every child stop intent in this same transaction so an
            // API crash after acknowledgement cannot leave a child running.
            let source_job: Option<Value> = tx.query_opt("SELECT to_jsonb(j) FROM browser_jobs j WHERE run_id=$1 AND workspace_id=$2 AND user_id=$3 AND request->>'kind'='explore' ORDER BY created_at,job_id LIMIT 1 FOR UPDATE",&[&run_id,&self.principal.workspace_id,&self.principal.user_id]).await.map_err(|_|"database_unavailable")?.map(|row|row.get(0));
            let run: Value = tx.query_opt("SELECT to_jsonb(r) FROM runtime_runs r WHERE run_id=$1 AND workspace_id=$2 AND user_id=$3 FOR UPDATE",&[&run_id,&self.principal.workspace_id,&self.principal.user_id]).await.map_err(|_|"database_unavailable")?.ok_or("run_not_found")?.get(0);
            if source_job
                .as_ref()
                .is_none_or(|j| j["settings"]["autoReproduce"] != true)
                || run["config"]["runtime_version"] != "explorer-v1"
                || !run["config"]["replay_of"].is_null()
            {
                return Err("automatic_reproduction_not_enabled");
            }
            let existing = run["auto_reproduction_cancel_id"]
                .as_str()
                .and_then(|v| Uuid::parse_str(v).ok());
            let cancellation_id = existing.unwrap_or_else(Uuid::new_v4);
            if existing.is_none() {
                let seq: i64 = tx.query_one("UPDATE runtime_runs SET auto_reproduction_cancel_id=$2,auto_reproduction_cancelled_at=now(),event_seq=event_seq+1 WHERE run_id=$1 RETURNING event_seq",&[&run_id,&cancellation_id]).await.map_err(|_|"database_unavailable")?.get(0);
                tx.execute("INSERT INTO runtime_events(event_id,run_id,seq,event_type,payload) VALUES($1,$2,$3,'auto_reproduction.cancel_requested',$4)",&[&Uuid::new_v4(),&run_id,&seq,&json!({"cancellation_id":cancellation_id,"actor":"user","in_flight_usage_may_settle":true})]).await.map_err(|_|"database_unavailable")?;
            }
            let skipped = tx.query("UPDATE automatic_reproduction_tasks SET status='skipped',reason='user_cancelled',updated_at=now() WHERE source_run_id=$1 AND status='pending' RETURNING task_id,source_action_id",&[&run_id]).await.map_err(|_|"database_unavailable")?;
            for row in skipped {
                let task_id: Uuid = row.get(0);
                let action_id: Uuid = row.get(1);
                let seq: i64 = tx.query_one("UPDATE runtime_runs SET event_seq=event_seq+1 WHERE run_id=$1 RETURNING event_seq",&[&run_id]).await.map_err(|_|"database_unavailable")?.get(0);
                tx.execute("INSERT INTO runtime_events(event_id,run_id,seq,event_type,action_id,payload) VALUES($1,$2,$3,'auto_reproduction.skipped',$4,$5)",&[&Uuid::new_v4(),&run_id,&seq,&action_id,&json!({"task_id":task_id,"source_action_id":action_id,"reason":"user_cancelled","cancellation_id":cancellation_id})]).await.map_err(|_|"database_unavailable")?;
            }
            let children=tx.query("SELECT j.job_id,j.run_id,j.cancel_id FROM automatic_reproduction_tasks t JOIN browser_jobs j ON j.job_id=t.child_job_id JOIN browser_jobs p ON p.job_id=t.source_job_id WHERE t.source_run_id=$1 AND p.workspace_id=$2 AND p.user_id=$3 AND j.workspace_id=$2 AND j.user_id=$3 AND j.parent_job_id=p.job_id AND j.automatic_source_action_id=t.source_action_id AND j.status IN ('queued','running') ORDER BY j.created_at,j.job_id FOR UPDATE OF j",&[&run_id,&self.principal.workspace_id,&self.principal.user_id]).await.map_err(|_|"database_unavailable")?;
            for child in children {
                let child_id: Uuid = child.get(0);
                let child_run_id: Option<Uuid> = child.get(1);
                let job_cancel_id: Option<Uuid> = child.get(2);
                let child_run = if let Some(id) = child_run_id {
                    tx.query_opt("SELECT lifecycle,cancel_id FROM runtime_runs WHERE run_id=$1 AND workspace_id=$2 AND user_id=$3 FOR UPDATE",&[&id,&self.principal.workspace_id,&self.principal.user_id]).await.map_err(|_|"database_unavailable")?
                } else {
                    None
                };
                // A replay that already finished keeps its original outcome,
                // even if its job is still publishing evidence.
                if child_run
                    .as_ref()
                    .is_some_and(|r| r.get::<_, String>(0) != "active")
                {
                    continue;
                }
                let run_cancel_id = child_run.as_ref().and_then(|r| r.get::<_, Option<Uuid>>(1));
                let child_cancel_id = job_cancel_id.or(run_cancel_id).unwrap_or_else(Uuid::new_v4);
                tx.execute("UPDATE browser_jobs SET cancel_id=$2,cancel_requested_at=COALESCE(cancel_requested_at,now()),finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END WHERE job_id=$1",&[&child_id,&child_cancel_id]).await.map_err(|_|"database_unavailable")?;
                if let Some(id) = child_run_id
                    && run_cancel_id.is_none()
                {
                    let seq:i64=tx.query_one("UPDATE runtime_runs SET cancel_id=$2,cancel_requested_at=now(),event_seq=event_seq+1 WHERE run_id=$1 RETURNING event_seq",&[&id,&child_cancel_id]).await.map_err(|_|"database_unavailable")?.get(0);
                    tx.execute("INSERT INTO runtime_events(event_id,run_id,seq,event_type,payload) VALUES($1,$2,$3,'run.cancel_requested',$4)",&[&Uuid::new_v4(),&id,&seq,&json!({"cancellation_id":child_cancel_id,"parent_cancellation_id":cancellation_id,"source_run_id":run_id,"actor":"user","in_flight_usage_may_settle":true})]).await.map_err(|_|"database_unavailable")?;
                }
            }
            tx.commit().await.map_err(|_| "database_unavailable")?;
            (cancellation_id, existing.is_some())
        };
        let db = self.db.write().await?;
        let remaining: i64 = db.query_one("SELECT count(*) FROM automatic_reproduction_tasks t JOIN browser_jobs j ON j.job_id=t.child_job_id WHERE t.source_run_id=$1 AND j.workspace_id=$2 AND j.user_id=$3 AND j.parent_job_id=t.source_job_id AND j.automatic_source_action_id=t.source_action_id AND j.status IN ('queued','running')",&[&run_id,&self.principal.workspace_id,&self.principal.user_id]).await.map_err(|_|"database_unavailable")?.get(0);
        Ok(
            json!({"cancellation_id":cancellation_id,"run_id":run_id,"status":if remaining>0{"cancelling"}else{"cancelled"},"reused":reused}),
        )
    }

    pub fn from_env(db: Arc<crate::db::Postgres>) -> Arc<Self> {
        let provider = env::var("SCOUT_EXPLORER_PROVIDER").unwrap_or_else(|_| "openrouter".into());
        let model = env::var("SCOUT_EXPLORER_MODEL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| match provider.as_str() {
                "openrouter" => "openrouter/free".into(),
                "meta" => "muse-wonder-1.0".into(),
                _ => String::new(),
            });
        Arc::new(Self {
            db,
            principal: crate::identity::Principal::default(),
            settings: json!({
                "provider":provider,"model":model,"freeOnly":provider=="openrouter" && env::var("SCOUT_EXPLORER_FREE_ONLY").as_deref()!=Ok("false"),
                "maxActions":bounded_setting("SCOUT_EXPLORER_MAX_ACTIONS",DEFAULT_EXPLORATION_ACTIONS,MAX_EXPLORATION_ACTIONS),
                "appMemory":env::var("SCOUT_EXPLORER_APP_MEMORY").as_deref()!=Ok("false"),
                "autoReproduce":env::var("SCOUT_AUTO_REPRODUCE").as_deref()==Ok("true"),
                "maxAutoReproductions":bounded_setting("SCOUT_AUTO_REPRODUCE_MAX_CASES",2,3),
                "maxAutoReplayActions":bounded_setting("SCOUT_AUTO_REPRODUCE_MAX_ACTIONS",12,MAX_AUTO_REPLAY_ACTIONS),
                "viewportProfile":env::var("SCOUT_EXPLORER_VIEWPORT").unwrap_or_else(|_|"desktop".into()),
                "allowedOrigins":env::var("SCOUT_ALLOWED_ORIGINS").unwrap_or_else(|_|"http://exploration-fixture:8082".into()).split(',').map(str::trim).collect::<Vec<_>>()
            }),
        })
    }

    async fn admit(&self, input: Submission, providers: Value) -> Result<Value, &'static str> {
        let mut db = self.db.write().await?;
        let tx = db.transaction().await.map_err(|_| "database_unavailable")?;
        // Serialize admission across API instances, including the queue limit.
        tx.query_one("SELECT pg_advisory_xact_lock(736268194002)", &[])
            .await
            .map_err(|_| "database_unavailable")?;
        if let Some(row) = tx
            .query_opt(
                "SELECT to_jsonb(j) FROM browser_jobs j WHERE job_id=$1",
                &[&input.job_id],
            )
            .await
            .map_err(|_| "database_unavailable")?
        {
            let saved: Value = row.get(0);
            if saved["workspace_id"] != self.principal.workspace_id.to_string()
                || saved["user_id"] != self.principal.user_id.to_string()
            {
                return Err("job_id_conflict");
            }
            // Reconstruct against the original snapshot. A retry cannot adopt
            // new preferences or fail because the current model changed.
            let (request, _) = prepare_submission(&input, &saved["settings"])?;
            if saved["request"] != request
                || saved["project_id"] != json!(input.project_id)
                || saved["task_id"] != json!(input.task_id)
            {
                return Err("job_id_conflict");
            }
            return Ok(json!({"job":saved,"reused":true}));
        }
        let latest=tx.query_opt("SELECT revision,settings FROM exploration_settings_versions WHERE workspace_id=$1 AND user_id=$2 ORDER BY revision DESC LIMIT 1",&[&self.principal.workspace_id,&self.principal.user_id]).await.map_err(|_|"database_unavailable")?;
        let (revision, saved) = latest
            .map(|row| (row.get::<_, i64>(0), Some(row.get::<_, Value>(1))))
            .unwrap_or((0, None));
        let defaults = settings_snapshot(&self.settings, saved.as_ref(), revision);
        let (request, mut settings) = prepare_submission(&input, &defaults)?;
        let verification_source = if let Some(issue_id) = input.issue_id {
            let row=tx.query_opt("SELECT to_jsonb(i),r.lifecycle,r.config,scout_issue_path(a.run_id,a.ordinal),a.state,a.assessment,a.tool_error FROM issues i JOIN runtime_runs r ON r.run_id=i.source_run_id JOIN runtime_actions a ON a.action_id=i.source_action_id AND a.run_id=r.run_id WHERE i.issue_id=$1 AND i.workspace_id=$2 AND i.user_id=$3",&[&issue_id,&self.principal.workspace_id,&self.principal.user_id]).await.map_err(|_|"database_unavailable")?.ok_or("issue_not_found")?;
            let issue: Value = row.get(0);
            let lifecycle: String = row.get(1);
            let config: Value = row.get(2);
            let path: Value = row.get(3);
            let action_state: String = row.get(4);
            let assessment: Value = row.get(5);
            let tool_error: Option<String> = row.get(6);
            if lifecycle == "active"
                || config["runtime_version"] != "explorer-v1"
                || !config["replay_of"].is_null()
                || !config["fix_verification"].is_null()
                || action_state != "completed"
                || assessment["verdict"] != "suspect"
                || assessment["expectation_uncertain"] == true
                || tool_error.is_some()
            {
                return Err("issue_source_not_verifiable");
            }
            if path
                .as_array()
                .is_none_or(|p| p.is_empty() || p.len() > MAX_ISSUE_PATH)
            {
                return Err("issue_source_path_not_supported");
            }
            Some((issue, path, config))
        } else {
            None
        };
        // Automatic and manual admission share this transaction lock, so the
        // same suspect cannot start two queued/running paid replays.
        if let Some(id) = input.source_action_id
            && let Some(row) = tx.query_opt("SELECT to_jsonb(j) FROM browser_jobs j WHERE workspace_id=$1 AND user_id=$2 AND request->>'kind'='reproduce' AND request->>'source_action_id'=$3 AND status IN ('queued','running') ORDER BY created_at,job_id LIMIT 1",&[&self.principal.workspace_id,&self.principal.user_id,&id.to_string()]).await.map_err(|_|"database_unavailable")?
        {
            return Ok(json!({"job":row.get::<_,Value>(0),"reused":true}));
        }
        let connected = providers["gateway_ready"] == true
            && providers["providers"].as_array().is_some_and(|list| {
                list.iter()
                    .any(|p| p["provider"] == settings["provider"] && p["configured"] == true)
            });
        if !connected || settings["model"].as_str().is_none_or(str::is_empty) {
            return Err("provider_not_configured");
        }
        if let Some(id) = input.source_action_id
            && tx.query_opt("SELECT 1 FROM runtime_actions a JOIN runtime_runs r USING(run_id) WHERE a.action_id=$1 AND r.workspace_id=$2 AND r.user_id=$3 AND r.lifecycle<>'active' AND a.state='completed' AND a.assessment->>'verdict'='suspect' AND r.config->>'runtime_version'='explorer-v1' AND COALESCE(r.config->>'replay_of','')=''", &[&id,&self.principal.workspace_id,&self.principal.user_id]).await.map_err(|_|"database_unavailable")?.is_none() { return Err("source_is_not_an_eligible_suspect"); }
        let count: i64 = tx.query_one("SELECT count(*) FROM browser_jobs WHERE workspace_id=$1 AND status IN ('queued','running')", &[&self.principal.workspace_id]).await.map_err(|_|"database_unavailable")?.get(0);
        if count >= 10 {
            return Err("browser_queue_full");
        }
        let mode = if providers["test_mode"] == true {
            "protocol_fixture"
        } else {
            "live"
        };
        // Simulated-model runs check contracts against fixed fixture apps and
        // must not depend on earlier test runs: memory only when requested.
        if mode == "protocol_fixture" && input.app_memory.is_none() {
            settings["appMemory"] = json!(false);
        }
        if let Some((_, _, config)) = &verification_source
            && config["execution_mode"] != mode
        {
            return Err("verification_execution_mode_mismatch");
        }
        if let Some(id) = input.session_id {
            let origin =
                reqwest::Url::parse(request["target_url"].as_str().ok_or("missing_target_url")?)
                    .map_err(|_| "invalid_target_url")?
                    .origin()
                    .ascii_serialization();
            if tx.query_opt("SELECT 1 FROM browser_sessions WHERE session_id=$1 AND workspace_id=$2 AND user_id=$3 AND origin=$4 AND execution_mode=$5 AND revoked_at IS NULL AND expires_at>now()",&[&id,&self.principal.workspace_id,&self.principal.user_id,&origin,&mode]).await.map_err(|_|"database_unavailable")?.is_none(){return Err("saved_session_unavailable");}
        }
        let row = tx.query_one("INSERT INTO browser_jobs(job_id,workspace_id,user_id,request,settings,execution_mode,status,agent_id,project_id,task_id) VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9) RETURNING to_jsonb(browser_jobs)", &[&input.job_id,&self.principal.workspace_id,&self.principal.user_id,&request,&settings,&mode,&self.principal.agent_id,&input.project_id,&input.task_id]).await.map_err(|_|"database_unavailable")?;
        let job: Value = row.get(0);
        if let Some((issue, path, _)) = verification_source {
            tx.execute("INSERT INTO issue_verifications(verification_id,issue_id,workspace_id,user_id,job_id,candidate_url,deployment_ref,source_snapshot) VALUES($1,$2,$3,$4,$1,$5,$6,$7)",&[&input.job_id,&input.issue_id.unwrap(),&self.principal.workspace_id,&self.principal.user_id,&request["target_url"].as_str().unwrap(),&request["deployment_ref"].as_str(),&json!({"issue":issue["snapshot"],"source_run_id":issue["source_run_id"],"source_action_id":issue["source_action_id"],"path":path})]).await.map_err(|_|"database_unavailable")?;
        }
        tx.commit().await.map_err(|_| "database_unavailable")?;
        Ok(json!({"job":job,"reused":false}))
    }
}

pub async fn submit(
    ScopedState(state): ScopedState,
    input: Result<Json<Submission>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Some(queue) = &state.jobs else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "browser_queue_unavailable");
    };
    let Ok(Json(input)) = input else {
        return error(StatusCode::BAD_REQUEST, "invalid_job_request");
    };
    let providers = state
        .gateway
        .as_ref()
        .map(|g| g.providers())
        .unwrap_or(json!({}));
    match queue.admit(input, providers).await {
        Ok(value) => (
            if value["reused"] == true {
                StatusCode::OK
            } else {
                StatusCode::ACCEPTED
            },
            Json(value),
        )
            .into_response(),
        Err(code) => error(
            match code {
                "database_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                "issue_not_found" => StatusCode::NOT_FOUND,
                "job_id_conflict" | "provider_not_configured" | "browser_queue_full" => {
                    StatusCode::CONFLICT
                }
                _ => StatusCode::BAD_REQUEST,
            },
            code,
        ),
    }
}

pub async fn list(ScopedState(state): ScopedState) -> Response {
    let effective = match &state.jobs {
        Some(queue) => match queue.effective_settings().await {
            Ok(value) => value,
            Err(code) => return error(StatusCode::SERVICE_UNAVAILABLE, code),
        },
        None => json!({"revision":0,"settings":{}}),
    };
    match query(&state,"SELECT jsonb_build_object('jobs',COALESCE((SELECT jsonb_agg(to_jsonb(j) ORDER BY created_at DESC) FROM (SELECT * FROM browser_jobs WHERE workspace_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 50) j),'[]'::jsonb),'workers',COALESCE((SELECT jsonb_agg(to_jsonb(w)||jsonb_build_object('available',status='online' AND heartbeat_at>now()-interval '20 seconds') ORDER BY started_at DESC) FROM (SELECT * FROM browser_workers WHERE workspace_id=$1 OR workspace_id='00000000-0000-4000-8000-000000000001'::uuid ORDER BY started_at DESC LIMIT 10) w),'[]'::jsonb))",&[&state.principal.workspace_id,&state.principal.user_id]).await {
        Ok(Some(mut value))=>{value["settings"]=effective["settings"].clone();value["settings_revision"]=effective["revision"].clone();Json(value).into_response()},
        Ok(None)=>Json(json!({})).into_response(),Err(r)=>r,
    }
}

pub async fn exploration_settings(ScopedState(state): ScopedState) -> Response {
    let Some(queue) = &state.jobs else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "browser_queue_unavailable");
    };
    match queue.effective_settings().await {
        Ok(value) => Json(value).into_response(),
        Err(code) => error(StatusCode::SERVICE_UNAVAILABLE, code),
    }
}

pub async fn get_job(ScopedState(state): ScopedState, Path(id): Path<Uuid>) -> Response {
    match query(&state,"SELECT jsonb_build_object('job',to_jsonb(j)) FROM browser_jobs j WHERE j.job_id=$1 AND j.workspace_id=$2 AND j.user_id=$3",&[&id,&state.principal.workspace_id,&state.principal.user_id]).await {
        Ok(Some(value))=>Json(value).into_response(),
        Ok(None)=>error(StatusCode::NOT_FOUND,"job_not_found"),
        Err(response)=>response,
    }
}

pub async fn save_exploration_settings(
    ScopedState(state): ScopedState,
    input: Result<Json<SettingsSubmission>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Some(queue) = &state.jobs else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "browser_queue_unavailable");
    };
    let Ok(Json(input)) = input else {
        return error(StatusCode::BAD_REQUEST, "invalid_settings_request");
    };
    match queue.save_settings(input).await {
        Ok(value) => (
            if value["reused"] == true {
                StatusCode::OK
            } else {
                StatusCode::CREATED
            },
            Json(value),
        )
            .into_response(),
        Err(code) => error(
            match code {
                "database_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                "revision_conflict" | "settings_request_id_conflict" => StatusCode::CONFLICT,
                _ => StatusCode::BAD_REQUEST,
            },
            code,
        ),
    }
}

async fn cancel_response(state: AppState, id: Uuid, by_run: bool) -> Response {
    let Some(queue) = &state.jobs else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "browser_queue_unavailable");
    };
    match queue.cancel(id, by_run).await {
        Ok(value) => (
            if value["status"] == "cancelling" {
                StatusCode::ACCEPTED
            } else {
                StatusCode::OK
            },
            Json(value),
        )
            .into_response(),
        Err(code) => error(
            match code {
                "job_not_found" | "run_not_found" => StatusCode::NOT_FOUND,
                "database_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                _ => StatusCode::CONFLICT,
            },
            code,
        ),
    }
}
pub async fn cancel_job(ScopedState(state): ScopedState, Path(id): Path<Uuid>) -> Response {
    cancel_response(state, id, false).await
}
pub async fn cancel_run(ScopedState(state): ScopedState, Path(id): Path<Uuid>) -> Response {
    cancel_response(state, id, true).await
}

pub async fn cancel_automatic(ScopedState(state): ScopedState, Path(id): Path<Uuid>) -> Response {
    let Some(queue) = &state.jobs else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "browser_queue_unavailable");
    };
    match queue.cancel_automatic(id).await {
        Ok(value) => (
            if value["status"] == "cancelling" {
                StatusCode::ACCEPTED
            } else {
                StatusCode::OK
            },
            Json(value),
        )
            .into_response(),
        Err(code) => error(
            match code {
                "run_not_found" => StatusCode::NOT_FOUND,
                "database_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                _ => StatusCode::CONFLICT,
            },
            code,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn submission(value: Value) -> Submission {
        serde_json::from_value(value).unwrap()
    }

    fn defaults() -> Value {
        json!({"autoReproduce":false,"viewportProfile":"desktop","allowedOrigins":["http://app:8082"]})
    }

    fn settings_input() -> Value {
        json!({"request_id":Uuid::new_v4(),"expected_revision":0,"provider":"openrouter","model":"openrouter/free", "max_actions":6,"viewport_profile":"desktop","free_only":true,"auto_reproduce":false,"max_auto_reproductions":2,"max_auto_replay_actions":12})
    }

    fn normalize_settings(value: Value) -> Result<NormalizedSettings, &'static str> {
        serde_json::from_value::<SettingsSubmission>(value)
            .map_err(|_| "invalid_settings_request")?
            .normalize()
    }

    #[test]
    fn settings_are_typed_bounded_and_cannot_change_security_or_credentials() {
        for (key, value) in [
            ("provider", json!("other")),
            ("model", json!("")),
            ("model", json!("a b")),
            ("model", json!(" model\n")),
            ("model", json!("a".repeat(201))),
            ("model", json!("méta/model")),
            ("max_actions", json!(0)),
            ("max_actions", json!(MAX_EXPLORATION_ACTIONS + 1)),
            ("max_auto_reproductions", json!(0)),
            ("max_auto_reproductions", json!(4)),
            ("max_auto_replay_actions", json!(0)),
            (
                "max_auto_replay_actions",
                json!(MAX_AUTO_REPLAY_ACTIONS + 1),
            ),
            ("app_memory", json!("yes")),
            ("viewport_profile", json!("watch")),
            ("expected_revision", json!(-1)),
            ("expected_revision", json!(i64::MAX)),
            ("request_id", json!(Uuid::nil())),
            ("free_only", json!("true")),
            ("auto_reproduce", json!(1)),
            ("max_actions", json!(1.5)),
            ("api_key", json!("cannot-save-secrets")),
            ("allowed_origins", json!(["https://other.test"])),
            ("allowedOrigins", json!(["https://other.test"])),
            ("workspace_id", json!(Uuid::new_v4())),
        ] {
            let mut input = settings_input();
            input[key] = value;
            assert!(normalize_settings(input).is_err(), "Rejected field {key}");
        }
        for missing in [
            "request_id",
            "expected_revision",
            "provider",
            "model",
            "max_actions",
            "viewport_profile",
            "free_only",
            "auto_reproduce",
            "max_auto_reproductions",
            "max_auto_replay_actions",
        ] {
            let mut input = settings_input();
            input.as_object_mut().unwrap().remove(missing);
            assert!(
                normalize_settings(input).is_err(),
                "Required field {missing}"
            );
        }
        let mut maximum = settings_input();
        maximum["model"] = json!("a".repeat(200));
        maximum["free_only"] = json!(false);
        maximum["max_actions"] = json!(MAX_EXPLORATION_ACTIONS);
        maximum["max_auto_reproductions"] = json!(3);
        maximum["max_auto_replay_actions"] = json!(MAX_AUTO_REPLAY_ACTIONS);
        assert!(normalize_settings(maximum).is_ok());
        assert_eq!(
            normalize_settings(settings_input()).unwrap().settings["appMemory"],
            true,
            "Omitted memory preference defaults on"
        );
        let mut fresh = settings_input();
        fresh["app_memory"] = json!(false);
        assert_eq!(
            normalize_settings(fresh).unwrap().settings["appMemory"],
            false
        );
    }

    #[test]
    fn settings_normalize_models_and_direct_provider_free_flags_without_model_calls() {
        for provider in ["openai", "anthropic", "meta"] {
            let mut input = settings_input();
            input["provider"] = json!(provider);
            input["model"] = json!("  valid-model  ");
            let settings = normalize_settings(input).unwrap().settings;
            assert_eq!(settings["model"], "valid-model");
            assert_eq!(settings["freeOnly"], false);
            assert_eq!(settings["provider"], provider);
        }
        for model in ["openrouter/free", "vendor/model:free"] {
            let mut input = settings_input();
            input["model"] = json!(model);
            assert_eq!(
                normalize_settings(input).unwrap().settings["freeOnly"],
                true
            );
        }
        let mut input = settings_input();
        input["model"] = json!("vendor/paid-model");
        assert_eq!(
            normalize_settings(input.clone()).unwrap_err(),
            "free_only_requires_free_model"
        );
        input["free_only"] = json!(false);
        assert!(normalize_settings(input).is_ok());
    }

    #[test]
    fn settings_history_retry_is_scoped_normalized_and_independent_of_later_revisions() {
        let raw = settings_input();
        let normalized = normalize_settings(raw.clone()).unwrap();
        let saved = json!({"request_id":normalized.request_id,"workspace_id":WORKSPACE_ID,"user_id":USER_ID,"revision":1,"expected_revision":0,"settings":normalized.settings});
        assert!(settings_retry(&saved, &normalized, WORKSPACE_ID, USER_ID).is_ok());
        // A later revision prevents a new write, but never invalidates an
        // identical UUID retry of the already committed revision.
        assert_eq!(
            next_settings_revision(0, 2).unwrap_err(),
            "revision_conflict"
        );
        assert!(settings_retry(&saved, &normalized, WORKSPACE_ID, USER_ID).is_ok());
        let mut trimmed = raw.clone();
        trimmed["model"] = json!("  openrouter/free  ");
        assert!(
            settings_retry(
                &saved,
                &normalize_settings(trimmed).unwrap(),
                WORKSPACE_ID,
                USER_ID
            )
            .is_ok()
        );
        for (key, value) in [("expected_revision", json!(1)), ("max_actions", json!(7))] {
            let mut changed = raw.clone();
            changed[key] = value;
            assert_eq!(
                settings_retry(
                    &saved,
                    &normalize_settings(changed).unwrap(),
                    WORKSPACE_ID,
                    USER_ID
                )
                .unwrap_err(),
                "settings_request_id_conflict"
            );
        }
        for key in ["workspace_id", "user_id"] {
            let mut foreign = saved.clone();
            foreign[key] = json!(Uuid::new_v4());
            assert_eq!(
                settings_retry(&foreign, &normalized, WORKSPACE_ID, USER_ID).unwrap_err(),
                "settings_request_id_conflict"
            );
        }
        assert_eq!(next_settings_revision(2, 2).unwrap(), 3);
    }

    #[test]
    fn preferences_overlay_only_editable_fields_and_old_job_snapshots_remain_frozen() {
        let mut base = defaults();
        base["provider"] = json!("openrouter");
        base["model"] = json!("openrouter/free");
        base["maxActions"] = json!(6);
        let original = settings_snapshot(&base, None, 0);
        let mut saved = json!({"provider":"anthropic","model":"new-model","maxActions":9,"viewportProfile":"mobile","allowedOrigins":["https://unsafe.test"],"secret":"not-permitted"});
        let updated = settings_snapshot(&base, Some(&saved), 3);
        assert_eq!(updated["settingsRevision"], 3);
        assert_eq!(updated["provider"], "anthropic");
        assert_eq!(updated["maxActions"], 9);
        assert_eq!(updated["allowedOrigins"], base["allowedOrigins"]);
        assert!(updated.get("secret").is_none());
        assert_eq!(original["model"], "openrouter/free");
        assert_eq!(original["maxActions"], 6);
        assert_eq!(original["settingsRevision"], 0);
        let input = submission(
            json!({"job_id":Uuid::new_v4(),"kind":"explore","target_url":"http://app:8082/path"}),
        );
        let (original_request, original_job) = prepare_submission(&input, &original).unwrap();
        saved["viewportProfile"] = json!("tablet");
        let updated = settings_snapshot(&base, Some(&saved), 4);
        let (new_request, new_job) = prepare_submission(&input, &updated).unwrap();
        assert_eq!(new_request, original_request);
        assert_eq!(new_job["model"], "new-model");
        assert_eq!(new_job["settingsRevision"], 4);
        let (retry_request, retry_job) = prepare_submission(&input, &original_job).unwrap();
        assert_eq!(retry_request, original_request);
        assert_eq!(retry_job, original_job);
    }

    #[test]
    fn automatic_reproduction_is_opt_in_and_request_identity_keeps_omissions() {
        let base =
            json!({"job_id":Uuid::new_v4(),"kind":"explore","target_url":"http://app:8082/"});
        let (request, settings) =
            prepare_submission(&submission(base.clone()), &defaults()).unwrap();
        assert_eq!(settings["autoReproduce"], false);
        assert!(request.get("auto_reproduce").is_none());
        let mut enabled_defaults = defaults();
        enabled_defaults["autoReproduce"] = json!(true);
        let (same_request, settings) =
            prepare_submission(&submission(base.clone()), &enabled_defaults).unwrap();
        assert_eq!(same_request, request);
        assert_eq!(settings["autoReproduce"], true);
        for enabled in [true, false] {
            let mut explicit = base.clone();
            explicit["auto_reproduce"] = json!(enabled);
            let (request, settings) =
                prepare_submission(&submission(explicit), &enabled_defaults).unwrap();
            assert_eq!(settings["autoReproduce"], enabled);
            assert_eq!(request["auto_reproduce"], enabled);
        }
    }

    #[test]
    fn reproductions_cannot_enable_automatic_descendants() {
        let base =
            json!({"job_id":Uuid::new_v4(),"kind":"reproduce","source_action_id":Uuid::new_v4()});
        let mut enabled_defaults = defaults();
        enabled_defaults["autoReproduce"] = json!(true);
        let (_, settings) =
            prepare_submission(&submission(base.clone()), &enabled_defaults).unwrap();
        assert_eq!(settings["autoReproduce"], false);
        for enabled in [true, false] {
            let mut explicit = base.clone();
            explicit["auto_reproduce"] = json!(enabled);
            assert_eq!(
                prepare_submission(&submission(explicit), &enabled_defaults).unwrap_err(),
                "invalid_job_kind_or_fields"
            );
        }
    }

    #[test]
    fn automatic_reproduction_flag_requires_boolean_and_cannot_supply_limits() {
        let base =
            json!({"job_id":Uuid::new_v4(),"kind":"explore","target_url":"http://app:8082/"});
        for invalid in [json!("true"), json!(1), json!([])] {
            let mut input = base.clone();
            input["auto_reproduce"] = invalid;
            assert!(serde_json::from_value::<Submission>(input).is_err());
        }
        let mut input = base;
        input["max_auto_reproductions"] = json!(100);
        assert!(serde_json::from_value::<Submission>(input).is_err());
    }

    #[test]
    fn target_requires_exact_origin_without_credentials() {
        let allowed = vec!["http://app:8082".to_owned()];
        assert_eq!(
            target("http://app:8082/path", &allowed).unwrap(),
            "http://app:8082/path"
        );
        for value in [
            "http://app:8082.evil/path",
            "http://app:8083/",
            "file:///tmp/a",
            "http://user:pass@app:8082/",
            "http://other:8082/",
            "http://bubblemaps.io/",
            "https://127.0.0.1/",
            "https://10.0.0.8/admin",
            "https://app.internal/",
            "https://localhost/",
            "https://bubblemaps.io:8443/",
            "https://user:pass@bubblemaps.io/",
        ] {
            assert!(target(value, &allowed).is_err(), "{value}");
        }
        assert_eq!(
            target("https://bubblemaps.io/map", &allowed).unwrap(),
            "https://bubblemaps.io/map"
        );
        assert_eq!(
            target("https://www.bubblemaps.io/", &allowed).unwrap(),
            "https://www.bubblemaps.io/"
        );
    }

    #[test]
    fn fix_verification_keeps_issue_candidate_and_label_in_request_identity() {
        let base = json!({"job_id":Uuid::new_v4(),"kind":"verify_fix","issue_id":Uuid::new_v4(),"target_url":"http://app:8082/preview","deployment_ref":" Preview 42 "});
        let (request, settings) =
            prepare_submission(&submission(base.clone()), &defaults()).unwrap();
        assert_eq!(request["issue_id"], base["issue_id"]);
        assert_eq!(request["target_url"], "http://app:8082/preview");
        assert_eq!(request["deployment_ref"], "Preview 42");
        assert_eq!(settings["autoReproduce"], false);
        for (key, value) in [
            ("viewport_profile", json!("mobile")),
            ("source_action_id", json!(Uuid::new_v4())),
            ("auto_reproduce", json!(false)),
            ("auth_mode", json!("sign_in")),
            ("issue_id", json!(Uuid::nil())),
            ("deployment_ref", json!("\n")),
            ("target_url", json!("https://10.0.0.8/preview")),
        ] {
            let mut invalid = base.clone();
            invalid[key] = value;
            assert!(
                prepare_submission(&submission(invalid), &defaults()).is_err(),
                "{key}"
            );
        }
    }
}
