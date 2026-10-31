//! Append-only human review overlay. A reproduced model suspicion is never an
//! automatic product verdict or approval to use the evidence for training.
use crate::error;
use crate::identity::ScopedState;
#[cfg(test)]
use crate::{AppState, WORKSPACE_ID, gateway::USER_ID};
use axum::{
    Json,
    extract::Path,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio_postgres::Transaction;
use uuid::Uuid;

pub struct Reviews {
    db: Arc<crate::db::Postgres>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Submission {
    review_id: Uuid,
    expected_revision: u32,
    disposition: String,
    rationale: String,
    expectation_basis: String,
    severity: Option<String>,
}

impl Submission {
    fn validate(&mut self) -> Result<(), &'static str> {
        self.rationale = self.rationale.trim().to_owned();
        self.expectation_basis = self.expectation_basis.trim().to_owned();
        if self.expected_revision >= i32::MAX as u32
            || !matches!(
                self.disposition.as_str(),
                "confirmed" | "dismissed" | "needs_review"
            )
            || self.rationale.is_empty()
            || self.rationale.chars().count() > 2000
            || self.rationale.contains('\0')
            || self.expectation_basis.chars().count() > 2000
            || self.expectation_basis.contains('\0')
            || self
                .severity
                .as_deref()
                .is_some_and(|s| !matches!(s, "low" | "medium" | "high" | "critical"))
            || (self.disposition == "confirmed"
                && (self.expectation_basis.chars().count() < 10 || self.severity.is_none()))
        {
            return Err("invalid_review_request");
        }
        Ok(())
    }

    fn matches(&self, saved: &Value, action_id: Uuid, workspace_id: Uuid, user_id: Uuid) -> bool {
        saved["action_id"] == action_id.to_string()
            && saved["workspace_id"] == workspace_id.to_string()
            && saved["user_id"] == user_id.to_string()
            && saved["reviewer_id"] == user_id.to_string()
            && saved["revision"].as_u64() == Some(u64::from(self.expected_revision) + 1)
            && saved["disposition"] == self.disposition
            && saved["rationale"] == self.rationale
            && saved["expectation_basis"] == self.expectation_basis
            && saved["severity"] == json!(self.severity)
    }
}

fn id(value: &Value) -> Result<Uuid, &'static str> {
    value
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or("incomplete_evidence")
}

fn hash(value: &Value) -> bool {
    value.as_str().is_some_and(|v| {
        v.len() == 64
            && v.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}

fn complete_action(action: &Value) -> bool {
    action["state"] == "completed"
        && action["finished_at"].is_string()
        && action["tool_error"].is_null()
        && action["assessment"].is_object()
        && matches!(
            action["assessment"]["verdict"].as_str(),
            Some("suspect" | "no_issue_observed")
        )
        && action["assessment"]["expectation_uncertain"] != true
        && action["assessment"]["tool_error"].is_null()
        && action["assessment"]["override_reason"].is_null()
        && action["comparison"].is_object()
        && (action["outcome"].is_null() || action["outcome"]["status"] == "settled")
}

fn completion_ready(action: &Value, run: &Value) -> bool {
    let version = &run["config"]["completion_version"];
    // Runs recorded before completion evidence existed remain reviewable under
    // their original contract. A modern run must retain its declared evidence
    // for every step, including the fresh replay and source prerequisites.
    version.is_null()
        || (version.as_str().is_some_and(|v| !v.is_empty())
            && action["outcome"]["version"] == *version
            && action["outcome"]["status"] == "settled"
            && action["outcome"]["completion_artifact"]["kind"] == "action_completion"
            && id(&action["outcome"]["completion_artifact"]["artifact_id"]).is_ok()
            && action["outcome"]["diagnostics_artifact"]["kind"] == "action_diagnostics"
            && id(&action["outcome"]["diagnostics_artifact"]["artifact_id"]).is_ok())
}

fn source_eligible(run: &Value, action: &Value) -> bool {
    run["lifecycle"] != "active"
        && run["finished_at"].is_string()
        && run["config"]["runtime_version"] == "explorer-v1"
        && run["config"]["replay_of"].is_null()
        && matches!(
            run["config"]["training_status"].as_str(),
            Some("unreviewed" | "excluded_fixture")
        )
        && complete_action(action)
        && completion_ready(action, run)
        && action["assessment"]["verdict"] == "suspect"
        && action["assessment"]["confirmed_bug"] == false
        && action["spec"]["prediction"]["source"] == "model"
        && action["spec"]["prediction"]["expected_result"]
            .as_str()
            .is_some_and(|v| !v.trim().is_empty())
        && id(&action["spec"]["prediction"]["request_id"]).is_ok()
}

fn artifact_refs(value: &Value, refs: &mut BTreeMap<Uuid, Value>) -> Result<(), &'static str> {
    if let Some(object) = value.as_object() {
        if object.contains_key("artifact_id") {
            let artifact_id = id(&value["artifact_id"])?;
            if refs
                .get(&artifact_id)
                .is_some_and(|previous| previous != value)
            {
                return Err("incomplete_evidence");
            }
            refs.insert(artifact_id, value.clone());
        } else {
            for child in object.values() {
                artifact_refs(child, refs)?;
            }
        }
    } else if let Some(array) = value.as_array() {
        for child in array {
            artifact_refs(child, refs)?;
        }
    }
    Ok(())
}

fn capture_ready(capture: &Value, action: &Value, phase: &str, workspace_id: Uuid) -> bool {
    capture["capture_id"] == action[format!("{phase}_capture_id")]
        && capture["run_id"] == action["run_id"]
        && capture["action_id"] == action["action_id"]
        && capture["phase"] == phase
        && capture["status"] == "available"
        && capture["error"].is_null()
        && capture["observation"].is_object()
        && capture["observation"]["observation_error"].is_null()
        && capture["object_key"].as_str().is_some_and(|key| {
            key == format!(
                "workspace/{workspace_id}/blobs/sha256/{}.png",
                capture["sha256"].as_str().unwrap_or("")
            )
        })
        && capture["metadata_key"]
            == format!(
                "workspace/{workspace_id}/captures/{}.json",
                capture["capture_id"].as_str().unwrap_or("")
            )
        && hash(&capture["sha256"])
        && capture["byte_length"]
            .as_u64()
            .is_some_and(|n| n > 0 && n <= 32 * 1024 * 1024)
}

#[derive(Clone)]
struct Evidence {
    snapshot: Value,
    // The records are verified from storage for confirmation. The snapshot
    // retains immutable IDs/hashes rather than embedding every screenshot.
    blobs: Vec<Value>,
    captures: Vec<Value>,
}

async fn action_evidence(
    tx: &Transaction<'_>,
    action: &Value,
    workspace_id: Uuid,
) -> Result<Evidence, &'static str> {
    if !complete_action(action) {
        return Err("incomplete_evidence");
    }
    if action["comparison"]["before_capture_id"] != action["before_capture_id"]
        || action["comparison"]["after_capture_id"] != action["after_capture_id"]
        || (!action["outcome"].is_null()
            && (action["outcome"]["completion_artifact"]["kind"] != "action_completion"
                || action["outcome"]["diagnostics_artifact"]["kind"] != "action_diagnostics"))
        || (!action["comparison"]["geometry_mask_artifact"].is_null()
            && action["comparison"]["geometry_mask_artifact"]["kind"] != "geometry_mask")
    {
        return Err("incomplete_evidence");
    }
    let run_id = id(&action["run_id"])?;
    let action_id = id(&action["action_id"])?;
    let capture_ids = [
        id(&action["before_capture_id"])?,
        id(&action["after_capture_id"])?,
    ];
    let rows = tx.query("SELECT to_jsonb(c) FROM runtime_captures c WHERE c.run_id=$1 AND c.action_id=$2 AND c.capture_id=ANY($3::uuid[])", &[&run_id, &action_id, &&capture_ids[..]])
        .await.map_err(|_| "database_unavailable")?;
    let captures: Vec<Value> = rows.iter().map(|row| row.get(0)).collect();
    let before = captures
        .iter()
        .find(|c| c["phase"] == "before")
        .ok_or("incomplete_evidence")?;
    let after = captures
        .iter()
        .find(|c| c["phase"] == "after")
        .ok_or("incomplete_evidence")?;
    if captures.len() != 2
        || !capture_ready(before, action, "before", workspace_id)
        || !capture_ready(after, action, "after", workspace_id)
    {
        return Err("incomplete_evidence");
    }
    let mut refs = BTreeMap::new();
    for (field, kind) in [
        ("raw_mask_artifact", "raw_mask"),
        ("absolute_delta_artifact", "absolute_delta"),
        ("metadata_artifact", "comparison"),
    ] {
        if action["comparison"][field]["kind"] != kind
            || id(&action["comparison"][field]["artifact_id"]).is_err()
        {
            return Err("incomplete_evidence");
        }
    }
    artifact_refs(&action["comparison"], &mut refs)?;
    artifact_refs(&action["outcome"], &mut refs)?;
    if refs.len() > 8 {
        return Err("incomplete_evidence");
    }
    let artifact_ids: Vec<_> = refs.keys().copied().collect();
    let rows = tx.query("SELECT to_jsonb(a) FROM runtime_artifacts a WHERE a.run_id=$1 AND a.artifact_id=ANY($2::uuid[])", &[&run_id, &artifact_ids])
        .await.map_err(|_| "database_unavailable")?;
    let artifacts: Vec<Value> = rows.iter().map(|row| row.get(0)).collect();
    if artifacts.len() != refs.len() {
        return Err("incomplete_evidence");
    }
    for artifact in &artifacts {
        let reference = &refs[&id(&artifact["artifact_id"])?];
        if artifact["status"] != "available"
            || !hash(&artifact["sha256"])
            || artifact["byte_length"]
                .as_u64()
                .is_none_or(|n| n == 0 || n > 32 * 1024 * 1024)
            || ["object_key", "sha256", "byte_length", "kind"]
                .iter()
                .any(|field| artifact[field] != reference[field])
            || !artifact["object_key"].as_str().is_some_and(|key| {
                key.starts_with(&format!("workspace/{workspace_id}/blobs/sha256/"))
            })
        {
            return Err("incomplete_evidence");
        }
    }
    let graph = tx.query_opt("SELECT jsonb_build_object('before',s1.fingerprint,'after',s2.fingerprint) FROM exploration_edges e JOIN exploration_states s1 ON s1.run_id=e.run_id AND s1.state_id=e.from_state_id JOIN exploration_states s2 ON s2.run_id=e.run_id AND s2.state_id=e.to_state_id WHERE e.run_id=$1 AND e.action_id=$2", &[&run_id,&action_id])
        .await.map_err(|_| "database_unavailable")?.map(|row|row.get::<_,Value>(0)).ok_or("incomplete_evidence")?;
    let capture_snapshot = |capture: &Value| json!({"capture_id":capture["capture_id"],"phase":capture["phase"],"sha256":capture["sha256"],"byte_length":capture["byte_length"],"object_key":capture["object_key"],"metadata_key":capture["metadata_key"]});
    let snapshot = json!({"run_id":run_id,"action_id":action_id,"prediction_id":action["prediction_id"],
        "frozen_prediction":action["spec"]["prediction"],"command":action["spec"]["command"],"auth_context_id":action["spec"]["auth_context_id"],
        "assessment":action["assessment"],"before_capture":capture_snapshot(before),"after_capture":capture_snapshot(after),
        "state_fingerprints":graph,"comparison":action["comparison"],"outcome":action["outcome"],"artifacts":artifacts});
    let mut blobs = artifacts;
    blobs.extend(captures.clone());
    Ok(Evidence {
        snapshot,
        blobs,
        captures,
    })
}

fn reproduction_eligible(
    reproduction: &Value,
    source: &Value,
    source_run: &Value,
    replay_run: &Value,
) -> bool {
    reproduction["status"] == "completed"
        && reproduction["finished_at"].is_string()
        && reproduction["source_action_id"] == source["action_id"]
        && reproduction["source_run_id"] == source["run_id"]
        && reproduction["replay_run_id"] == replay_run["run_id"]
        && reproduction["replay_run_id"] != source["run_id"]
        && reproduction["result"]["outcome"] == "reproduced"
        && reproduction["result"]["matching_after_state"] == true
        && reproduction["result"]["confirmed_bug"] == false
        && reproduction["result"]["source_action_id"] == source["action_id"]
        && reproduction["result"]["source_capture_ids"]
            == json!([source["before_capture_id"], source["after_capture_id"]])
        && replay_run["lifecycle"] == "completed"
        && replay_run["finished_at"].is_string()
        && replay_run["workspace_id"] == source_run["workspace_id"]
        && replay_run["user_id"] == source_run["user_id"]
        && replay_run["target_url"] == source_run["target_url"]
        && replay_run["config"]["runtime_version"] == "explorer-v1"
        && replay_run["config"]["replay_of"]["source_action_id"] == source["action_id"]
        && replay_run["config"]["replay_of"]["source_run_id"] == source["run_id"]
        && replay_run["config"]["replay_of"]["reproduction_id"] == reproduction["reproduction_id"]
        && [
            "viewport",
            "viewport_profile",
            "device_scale",
            "execution_mode",
            "training_status",
            "purpose",
        ]
        .iter()
        .all(|field| replay_run["config"][field] == source_run["config"][field])
}

async fn confirmation_evidence(
    tx: &Transaction<'_>,
    reproduction: &Value,
    source: &Value,
    source_run: &Value,
    replay_run: &Value,
) -> Result<Vec<Evidence>, &'static str> {
    if !reproduction_eligible(reproduction, source, source_run, replay_run) {
        return Err("reproduction_required");
    }
    let steps = reproduction["source_snapshot"]
        .as_array()
        .filter(|steps| !steps.is_empty() && steps.len() <= 12)
        .ok_or("reproduction_required")?;
    if steps.last().unwrap()["source_action_id"] != source["action_id"] {
        return Err("reproduction_required");
    }
    let replay_id = id(&replay_run["run_id"])?;
    let rows = tx
        .query(
            "SELECT to_jsonb(a) FROM runtime_actions a WHERE run_id=$1 ORDER BY ordinal LIMIT 13",
            &[&replay_id],
        )
        .await
        .map_err(|_| "database_unavailable")?;
    if rows.len() != steps.len() {
        return Err("reproduction_required");
    }
    let source_id = id(&source_run["run_id"])?;
    let mut evidence = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for (step, row) in steps.iter().zip(rows) {
        let source_action_id = id(&step["source_action_id"])?;
        if !seen.insert(source_action_id) {
            return Err("reproduction_required");
        }
        let saved: Value = tx
            .query_opt(
                "SELECT to_jsonb(a) FROM runtime_actions a WHERE run_id=$1 AND action_id=$2",
                &[&source_id, &source_action_id],
            )
            .await
            .map_err(|_| "database_unavailable")?
            .ok_or("reproduction_required")?
            .get(0);
        let replay: Value = row.get(0);
        if !completion_ready(&saved, source_run) || !completion_ready(&replay, replay_run) {
            return Err("incomplete_evidence");
        }
        let prediction = &saved["spec"]["prediction"];
        let replay_prediction = &replay["spec"]["prediction"];
        if !complete_action(&saved)
            || !complete_action(&replay)
            || prediction["source"] != "model"
            || replay_prediction["source"] != "recorded_replay"
            || step["source_prediction_id"] != saved["prediction_id"]
            || step["source_model_request_id"] != prediction["request_id"]
            || step["before_capture_id"] != saved["before_capture_id"]
            || step["after_capture_id"] != saved["after_capture_id"]
            || ["goal", "expected_result"].iter().any(|field| {
                step[field] != prediction[field] || replay_prediction[field] != prediction[field]
            })
            || step["command"] != saved["spec"]["command"]
            || replay["spec"]["command"] != saved["spec"]["command"]
            || replay["spec"]["auth_context_id"] != saved["spec"]["auth_context_id"]
            || replay["spec"]["replay_source_action_id"] != saved["action_id"]
            || replay_prediction["source_prediction_id"] != saved["prediction_id"]
            || replay_prediction["source_model_request_id"] != prediction["request_id"]
        {
            return Err("reproduction_required");
        }
        let original = action_evidence(tx, &saved, id(&source_run["workspace_id"])?).await?;
        let fresh = action_evidence(tx, &replay, id(&replay_run["workspace_id"])?).await?;
        if step["before_fingerprint"] != original.snapshot["state_fingerprints"]["before"]
            || step["after_fingerprint"] != original.snapshot["state_fingerprints"]["after"]
            || fresh.snapshot["state_fingerprints"]["before"]
                != original.snapshot["state_fingerprints"]["before"]
        {
            return Err("reproduction_required");
        }
        if saved["action_id"] == source["action_id"]
            && (replay["assessment"]["verdict"] != "suspect"
                || replay["assessment"]["confirmed_bug"] != false
                || reproduction["result"]["replay_action_id"] != replay["action_id"]
                || reproduction["result"]["replay_capture_ids"]
                    != json!([replay["before_capture_id"], replay["after_capture_id"]])
                || fresh.snapshot["state_fingerprints"]["after"]
                    != original.snapshot["state_fingerprints"]["after"])
        {
            return Err("reproduction_required");
        }
        evidence.push(original);
        evidence.push(fresh);
    }
    Ok(evidence)
}

async fn verify_evidence(
    gateway: &Arc<crate::gateway::Gateway>,
    evidence: &[Evidence],
    run: &Value,
) -> Result<(), &'static str> {
    let mut unique = BTreeMap::new();
    for item in evidence {
        for blob in &item.blobs {
            unique.insert(
                blob["object_key"]
                    .as_str()
                    .ok_or("incomplete_evidence")?
                    .to_owned(),
                blob.clone(),
            );
        }
    }
    // Bound simultaneous object reads even for the maximum twelve-step replay.
    let mut reads = tokio::task::JoinSet::new();
    for blob in unique.into_values() {
        let gateway = gateway.clone();
        reads.spawn(async move {
            gateway
                .evidence_bytes(
                    blob["object_key"].as_str().ok_or("incomplete_evidence")?,
                    blob["sha256"].as_str().ok_or("incomplete_evidence")?,
                    blob["byte_length"].as_u64().ok_or("incomplete_evidence")?,
                )
                .await
                .map(|_| ())
        });
        if reads.len() >= 4 {
            reads
                .join_next()
                .await
                .ok_or("evidence_unavailable")?
                .map_err(|_| "evidence_unavailable")??;
        }
    }
    while let Some(read) = reads.join_next().await {
        read.map_err(|_| "evidence_unavailable")??;
    }
    let expected_training = if run["config"]["training_status"] == "unreviewed" {
        "unreviewed"
    } else {
        "excluded_fixture"
    };
    let expected_purpose = if run["config"]["purpose"] == "exploration" {
        "exploration"
    } else {
        "runtime_validation"
    };
    for item in evidence {
        for capture in &item.captures {
            let metadata = gateway
                .evidence_metadata(
                    capture["metadata_key"]
                        .as_str()
                        .ok_or("incomplete_evidence")?,
                )
                .await?;
            if [
                "capture_id",
                "run_id",
                "action_id",
                "phase",
                "object_key",
                "metadata_key",
                "sha256",
                "byte_length",
                "observation",
            ]
            .iter()
            .any(|field| metadata[field] != capture[field])
                || metadata["training_status"] != expected_training
                || metadata["purpose"] != expected_purpose
            {
                return Err("evidence_invalid_metadata");
            }
        }
    }
    Ok(())
}

impl Reviews {
    pub fn new(db: Arc<crate::db::Postgres>) -> Arc<Self> {
        Arc::new(Self { db })
    }

    async fn save(
        &self,
        action_id: Uuid,
        principal: &crate::identity::Principal,
        input: Submission,
        gateway: Option<&Arc<crate::gateway::Gateway>>,
    ) -> Result<Value, &'static str> {
        let mut db = self.db.write().await?;
        let tx = db.transaction().await.map_err(|_| "database_unavailable")?;
        // A global review UUID cannot be reused against another action. The run
        // row lock then serializes revisions and event sequence allocation.
        tx.query_one(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,736268194011))",
            &[&input.review_id.to_string()],
        )
        .await
        .map_err(|_| "database_unavailable")?;
        if let Some(row) = tx
            .query_opt(
                "SELECT to_jsonb(f) FROM finding_reviews f WHERE review_id=$1",
                &[&input.review_id],
            )
            .await
            .map_err(|_| "database_unavailable")?
        {
            let saved: Value = row.get(0);
            return if input.matches(&saved, action_id, principal.workspace_id, principal.user_id) {
                Ok(json!({"review":saved,"reused":true}))
            } else {
                Err("review_id_conflict")
            };
        }
        let row = tx.query_opt("SELECT to_jsonb(a),to_jsonb(r) FROM runtime_actions a JOIN runtime_runs r USING(run_id) WHERE a.action_id=$1 AND r.workspace_id=$2 AND r.user_id=$3 FOR UPDATE OF a,r", &[&action_id,&principal.workspace_id,&principal.user_id]).await.map_err(|_|"database_unavailable")?.ok_or("action_not_found")?;
        let action: Value = row.get(0);
        let run: Value = row.get(1);
        if !source_eligible(&run, &action) {
            return Err("source_not_reviewable");
        }
        let revision: i32 = tx
            .query_one(
                "SELECT COALESCE(max(revision),0) FROM finding_reviews WHERE action_id=$1",
                &[&action_id],
            )
            .await
            .map_err(|_| "database_unavailable")?
            .get(0);
        if revision as u32 != input.expected_revision {
            return Err("revision_conflict");
        }
        let source = action_evidence(&tx, &action, principal.workspace_id).await?;
        let reproduction = tx.query_opt("SELECT to_jsonb(v),to_jsonb(r) FROM runtime_reproductions v JOIN runtime_runs r ON r.run_id=v.replay_run_id WHERE v.source_action_id=$1 AND v.source_run_id=$2 AND r.workspace_id=$3 AND r.user_id=$4", &[&action_id,&id(&run["run_id"])?,&principal.workspace_id,&principal.user_id]).await.map_err(|_|"database_unavailable")?;
        let (reproduction, replay_run): (Value, Value) = reproduction
            .map(|r| (r.get(0), r.get(1)))
            .unwrap_or((Value::Null, Value::Null));
        let confirmation = if input.disposition == "confirmed" {
            let evidence =
                confirmation_evidence(&tx, &reproduction, &action, &run, &replay_run).await?;
            let gateway = gateway.ok_or("evidence_unavailable")?;
            tokio::time::timeout(
                Duration::from_secs(45),
                verify_evidence(gateway, &evidence, &run),
            )
            .await
            .map_err(|_| "evidence_timeout")??;
            evidence
        } else {
            Vec::new()
        };
        let training = json!({"training_status":run["config"]["training_status"],"purpose":run["config"]["purpose"],"execution_mode":run["config"]["execution_mode"],"review_is_training_approval":false});
        let snapshot = json!({"schema_version":1,"source":source.snapshot,"reproduction":reproduction,
            "replay_run_id":replay_run["run_id"],"verified_path":confirmation.iter().map(|e|e.snapshot.clone()).collect::<Vec<_>>(),
            "storage_verified":input.disposition=="confirmed","training":training});
        let revision = revision + 1;
        let run_id = id(&run["run_id"])?;
        let saved: Value = tx.query_one("INSERT INTO finding_reviews(review_id,action_id,run_id,workspace_id,user_id,reviewer_id,revision,disposition,rationale,expectation_basis,severity,evidence_snapshot) VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11) RETURNING to_jsonb(finding_reviews)", &[&input.review_id,&action_id,&run_id,&principal.workspace_id,&principal.user_id,&revision,&input.disposition,&input.rationale,&input.expectation_basis,&input.severity,&snapshot]).await.map_err(|_|"database_unavailable")?.get(0);
        let sequence: i64 = tx
            .query_one(
                "UPDATE runtime_runs SET event_seq=event_seq+1 WHERE run_id=$1 RETURNING event_seq",
                &[&run_id],
            )
            .await
            .map_err(|_| "database_unavailable")?
            .get(0);
        let event = json!({"actor":"human","reviewer_id":principal.user_id,"review_id":input.review_id,"action_id":action_id,"revision":revision,"disposition":input.disposition,"review":saved,"training":training});
        tx.execute("INSERT INTO runtime_events(event_id,run_id,seq,event_type,action_id,payload) VALUES($1,$2,$3,'finding.reviewed',$4,$5)", &[&Uuid::new_v4(),&run_id,&sequence,&action_id,&event]).await.map_err(|_|"database_unavailable")?;
        tx.commit().await.map_err(|_| "database_unavailable")?;
        Ok(json!({"review":saved,"reused":false}))
    }
}

pub async fn submit(
    ScopedState(state): ScopedState,
    Path(action_id): Path<Uuid>,
    input: Result<Json<Submission>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(mut input)) = input else {
        return error(StatusCode::BAD_REQUEST, "invalid_review_request");
    };
    if let Err(code) = input.validate() {
        return error(StatusCode::BAD_REQUEST, code);
    }
    let Some(reviews) = &state.reviews else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "reviews_unavailable");
    };
    match reviews
        .save(action_id, &state.principal, input, state.gateway.as_ref())
        .await
    {
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
                "action_not_found" => StatusCode::NOT_FOUND,
                "database_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                "evidence_unavailable"
                | "evidence_checksum_mismatch"
                | "evidence_timeout"
                | "evidence_invalid_metadata"
                | "evidence_too_large" => StatusCode::BAD_GATEWAY,
                _ => StatusCode::CONFLICT,
            },
            code,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;
    const TOKEN: &str = "fixture_token_for_review_tests_only_000001";
    fn submission() -> Submission {
        serde_json::from_value(json!({"review_id":Uuid::new_v4(),"expected_revision":0,"disposition":"needs_review","rationale":"Inspect the original expected result.","expectation_basis":"","severity":null})).unwrap()
    }
    async fn request(body: Value, authorized: bool) -> Response {
        let mut request = Request::builder()
            .method("POST")
            .uri(format!("/v1/actions/{}/reviews", Uuid::new_v4()))
            .header("content-type", "application/json");
        if authorized {
            request = request.header("authorization", format!("Bearer {TOKEN}"));
        }
        crate::router(AppState::new(None, TOKEN).unwrap())
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap()
    }
    #[tokio::test]
    async fn authorization_precedes_review_validation_and_storage() {
        assert_eq!(
            request(json!({}), false).await.status(),
            StatusCode::UNAUTHORIZED
        );
        let response = request(json!({"review_id":Uuid::new_v4(),"expected_revision":0,"disposition":"needs_review","rationale":"Needs inspection","expectation_basis":"","severity":null}),true).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body["error"], "reviews_unavailable");
    }
    #[tokio::test]
    async fn malformed_and_injected_review_fields_are_rejected() {
        for body in [
            json!({}),
            json!({"review_id":Uuid::new_v4(),"expected_revision":0,"disposition":"confirmed","rationale":"Observed issue","expectation_basis":"","severity":"high"}),
            json!({"review_id":Uuid::new_v4(),"expected_revision":0,"disposition":"needs_review","rationale":"Inspect","expectation_basis":"","reviewer_id":Uuid::new_v4()}),
        ] {
            assert_eq!(request(body, true).await.status(), StatusCode::BAD_REQUEST);
        }
    }
    #[test]
    fn confirmation_requires_a_human_basis_and_severity() {
        let mut input = submission();
        input.disposition = "confirmed".into();
        assert!(input.validate().is_err());
        input.expectation_basis = "The page specification requires a result.".into();
        assert!(input.validate().is_err());
        input.severity = Some("medium".into());
        assert!(input.validate().is_ok());
        input.rationale = "🦀".repeat(2001);
        assert!(input.validate().is_err());
    }
    #[test]
    fn idempotency_checks_the_action_owner_revision_and_normalized_content() {
        let input = submission();
        let action_id = Uuid::new_v4();
        let saved = json!({"action_id":action_id,"workspace_id":WORKSPACE_ID,"user_id":USER_ID,"reviewer_id":USER_ID,"revision":1,"disposition":input.disposition,"rationale":input.rationale,"expectation_basis":input.expectation_basis,"severity":input.severity});
        assert!(input.matches(&saved, action_id, WORKSPACE_ID, USER_ID));
        assert!(!input.matches(&saved, Uuid::new_v4(), WORKSPACE_ID, USER_ID));
        for field in [
            "user_id",
            "reviewer_id",
            "workspace_id",
            "revision",
            "rationale",
            "disposition",
            "expectation_basis",
            "severity",
        ] {
            let mut changed = saved.clone();
            changed[field] = json!("changed");
            assert!(
                !input.matches(&changed, action_id, WORKSPACE_ID, USER_ID),
                "{field}"
            );
        }
    }
    #[test]
    fn source_eligibility_does_not_accept_tool_failures_or_uncertain_predictions() {
        let run = json!({"lifecycle":"completed","finished_at":"now","config":{"runtime_version":"explorer-v1","replay_of":null,"training_status":"unreviewed"}});
        let action = json!({"state":"completed","finished_at":"now","tool_error":null,"comparison":{},"assessment":{"verdict":"suspect","expectation_uncertain":false,"confirmed_bug":false},"spec":{"prediction":{"source":"model","expected_result":"A result appears.","request_id":Uuid::new_v4()}},"outcome":{"status":"settled"}});
        assert!(source_eligible(&run, &action));
        for patch in [
            json!({"tool_error":"timeout"}),
            json!({"state":"evidence_failed"}),
            json!({"outcome":{"status":"timed_out"}}),
            json!({"assessment":{"verdict":"suspect","expectation_uncertain":true}}),
            json!({"assessment":{"verdict":"inconclusive"}}),
        ] {
            let mut changed = action.clone();
            for (key, value) in patch.as_object().unwrap() {
                changed[key] = value.clone();
            }
            assert!(!source_eligible(&run, &changed));
        }
        let mut replay = run;
        replay["config"]["replay_of"] = json!({"source_action_id":Uuid::new_v4()});
        assert!(!source_eligible(&replay, &action));
    }

    #[test]
    fn reproduction_must_match_the_durable_source_scope_and_replay() {
        let source_id = Uuid::new_v4();
        let replay_id = Uuid::new_v4();
        let action_id = Uuid::new_v4();
        let reproduction_id = Uuid::new_v4();
        let source = json!({"action_id":action_id,"run_id":source_id,"before_capture_id":Uuid::new_v4(),"after_capture_id":Uuid::new_v4()});
        let source_run = json!({"run_id":source_id,"workspace_id":WORKSPACE_ID,"user_id":USER_ID,"target_url":"http://fixture.test/","config":{"viewport":{"width":390,"height":844},"viewport_profile":"mobile","device_scale":1,"execution_mode":"protocol_fixture","training_status":"excluded_fixture","purpose":"runtime_validation"}});
        let mut replay_run = source_run.clone();
        replay_run["run_id"] = json!(replay_id);
        replay_run["lifecycle"] = json!("completed");
        replay_run["finished_at"] = json!("now");
        replay_run["config"]["runtime_version"] = json!("explorer-v1");
        replay_run["config"]["replay_of"] = json!({"source_run_id":source_id,"source_action_id":action_id,"reproduction_id":reproduction_id});
        let reproduction = json!({"reproduction_id":reproduction_id,"source_run_id":source_id,"source_action_id":action_id,"replay_run_id":replay_id,"status":"completed","finished_at":"now","result":{"outcome":"reproduced","matching_after_state":true,"confirmed_bug":false,"source_action_id":action_id,"source_capture_ids":[source["before_capture_id"],source["after_capture_id"]]}});
        assert!(reproduction_eligible(
            &reproduction,
            &source,
            &source_run,
            &replay_run
        ));
        for field in [
            "source_action_id",
            "source_run_id",
            "replay_run_id",
            "status",
            "finished_at",
        ] {
            let mut changed = reproduction.clone();
            changed[field] = Value::Null;
            assert!(
                !reproduction_eligible(&changed, &source, &source_run, &replay_run),
                "{field}"
            );
        }
        for field in [
            "outcome",
            "matching_after_state",
            "confirmed_bug",
            "source_action_id",
            "source_capture_ids",
        ] {
            let mut changed = reproduction.clone();
            changed["result"][field] = Value::Null;
            assert!(
                !reproduction_eligible(&changed, &source, &source_run, &replay_run),
                "{field}"
            );
        }
        for field in [
            "viewport",
            "viewport_profile",
            "device_scale",
            "execution_mode",
            "training_status",
            "purpose",
            "replay_of",
        ] {
            let mut changed = replay_run.clone();
            changed["config"][field] = Value::Null;
            assert!(
                !reproduction_eligible(&reproduction, &source, &source_run, &changed),
                "{field}"
            );
        }
        for field in ["user_id", "workspace_id", "target_url", "lifecycle"] {
            let mut changed = replay_run.clone();
            changed[field] = Value::Null;
            assert!(
                !reproduction_eligible(&reproduction, &source, &source_run, &changed),
                "{field}"
            );
        }
    }

    #[test]
    fn declared_completion_requires_matching_available_artifact_references_on_every_step() {
        let legacy_run = json!({"config":{}});
        let modern_run = json!({"config":{"completion_version":"action-completion-v1"}});
        let action = json!({"outcome":{"version":"action-completion-v1","status":"settled",
            "completion_artifact":{"artifact_id":Uuid::new_v4(),"kind":"action_completion"},
            "diagnostics_artifact":{"artifact_id":Uuid::new_v4(),"kind":"action_diagnostics"}}});
        assert!(completion_ready(&json!({}), &legacy_run));
        assert!(completion_ready(&action, &modern_run));
        assert!(!completion_ready(&json!({"outcome":null}), &modern_run));
        for patch in [
            json!({"version":"another-version"}),
            json!({"status":"timed_out"}),
            json!({"completion_artifact":null}),
            json!({"diagnostics_artifact":null}),
            json!({"completion_artifact":{"artifact_id":"invalid","kind":"action_completion"}}),
            json!({"diagnostics_artifact":{"artifact_id":"invalid","kind":"action_diagnostics"}}),
            json!({"completion_artifact":{"artifact_id":Uuid::new_v4(),"kind":"comparison"}}),
            json!({"diagnostics_artifact":{"artifact_id":Uuid::new_v4(),"kind":"comparison"}}),
        ] {
            let mut changed = action.clone();
            for (key, value) in patch.as_object().unwrap() {
                changed["outcome"][key] = value.clone();
            }
            assert!(!completion_ready(&changed, &modern_run), "{patch}");
        }
    }
}
