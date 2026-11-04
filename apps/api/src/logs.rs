//! Process logs: one JSON object per line on stdout, and the operator viewer over them.
//!
//! The log collector (infra/logs/vector.yaml) ships every container line to the
//! ClickHouse table `scout.service_logs`; `GET /v1/admin/logs` reads it back for
//! the back office Logs tab. Lines carry identifiers, states, counts, durations
//! and error codes. Prompts, model output, request bodies, query strings and
//! credentials are never logged.

use std::{io::Write, time::Instant};

use axum::{
    Json,
    extract::{MatchedPath, Query, Request},
    http::{Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::identity::ScopedState;

/// Days `scout.service_logs` keeps a line (its TTL in infra/clickhouse).
pub const RETENTION_DAYS: u32 = 14;
const LEVELS: [&str; 4] = ["debug", "info", "warning", "error"];
const DEFAULT_LIMIT: u32 = 200;
const MAX_LIMIT: u32 = 500;
// Aliases differ from column names: ClickHouse resolves an alias before a
// column of the same name, which would turn WHERE and ORDER BY into string
// comparisons.
const COLUMNS: &str = "toString(log_id) AS id,toString(ts) AS at,toUnixTimestamp64Micro(ingested_at) AS ingested_us,service,replica,stream,level,message,fields,run_id,request_id";
const FILTERS: &str = "level IN {levels:Array(String)} AND NOT has({exclude:Array(String)},service) AND ({q:String}='' OR positionCaseInsensitiveUTF8(message,{q:String})>0 OR positionCaseInsensitiveUTF8(fields,{q:String})>0) AND ({run:String}='' OR run_id={run:String})";

/// Prints one log line: `{"level":..,"msg":..,<fields>}`. Null fields are left out.
pub fn emit(level: &str, msg: &str, fields: Value) {
    let line = render(level, msg, fields);
    let _ = writeln!(std::io::stdout().lock(), "{line}");
}

fn render(level: &str, msg: &str, fields: Value) -> String {
    let mut line = format!("{{\"level\":{},\"msg\":{}", json!(level), json!(msg));
    if let Value::Object(fields) = fields {
        for (key, value) in fields.into_iter().filter(|(_, v)| !v.is_null()) {
            line.push_str(&format!(",{}:{value}", json!(key)));
        }
    }
    line.push('}');
    line
}

/// One line per HTTP request: method, route template, status and duration.
/// The concrete path is kept only when every route parameter is a UUID, so
/// pairing codes, wildcard paths and query strings stay out of the logs.
pub async fn access_log(request: Request, next: Next) -> Response {
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|p| p.as_str().to_owned());
    if route.as_deref().is_some_and(quiet) {
        return next.run(request).await;
    }
    let method = request.method().clone();
    let path = route
        .as_deref()
        .and_then(|r| uuid_path(r, request.uri().path()));
    let started = Instant::now();
    let response = next.run(request).await;
    let status = response.status().as_u16();
    let level = match status {
        500.. => "error",
        400.. => "warning",
        _ if method == Method::GET || method == Method::HEAD => "debug",
        _ => "info",
    };
    emit(
        level,
        "http_request",
        json!({"method":method.as_str(),"route":route,"path":path,"status":status,"elapsed_ms":started.elapsed().as_millis() as u64}),
    );
    response
}

/// Health probes, static assets and the log viewer's own polling.
fn quiet(route: &str) -> bool {
    matches!(
        route,
        "/healthz" | "/readyz" | "/favicon.svg" | "/assets/{*path}" | "/v1/admin/logs"
    )
}

fn uuid_path(route: &str, path: &str) -> Option<String> {
    let template: Vec<&str> = route.split('/').collect();
    let concrete: Vec<&str> = path.split('/').collect();
    if template.len() != concrete.len() || !route.contains('{') {
        return None;
    }
    template
        .iter()
        .zip(&concrete)
        .all(|(t, c)| !t.starts_with('{') || (!t.starts_with("{*") && Uuid::parse_str(c).is_ok()))
        .then(|| path.to_owned())
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LogQuery {
    /// Cursor from a previous response: lines stored after it, oldest first.
    after: Option<String>,
    /// A line's `ts`: older lines, for scrolling back.
    before: Option<String>,
    /// Minimum level: debug, info, warning or error.
    level: Option<String>,
    /// Comma-separated services to leave out.
    exclude: Option<String>,
    /// Case-insensitive text in the message or fields.
    q: Option<String>,
    run_id: Option<String>,
    limit: Option<u32>,
}

#[derive(Debug, PartialEq)]
enum Page {
    /// The newest lines, plus a cursor for the tail.
    Latest,
    Older(String),
    After(i64, Uuid),
}

#[derive(Debug)]
struct Plan {
    page: Page,
    params: Vec<(String, String)>,
    limit: u32,
}

fn plan(query: LogQuery) -> Result<Plan, &'static str> {
    let invalid = "invalid_log_query";
    let page = match (query.after, query.before) {
        (Some(_), Some(_)) => return Err(invalid),
        (Some(cursor), None) => {
            let (us, id) = parse_cursor(&cursor).ok_or(invalid)?;
            Page::After(us, id)
        }
        (None, Some(before)) => Page::Older(
            chrono::DateTime::parse_from_rfc3339(&before)
                .map_err(|_| invalid)?
                .with_timezone(&chrono::Utc)
                .format("%Y-%m-%d %H:%M:%S%.9f")
                .to_string(),
        ),
        (None, None) => Page::Latest,
    };
    let level = query.level.as_deref().unwrap_or("debug");
    let from = LEVELS.iter().position(|l| *l == level).ok_or(invalid)?;
    let exclude: Vec<&str> = query
        .exclude
        .as_deref()
        .unwrap_or("")
        .split(',')
        .filter(|s| !s.is_empty())
        .collect();
    if exclude.len() > 32 || !exclude.iter().all(|s| service_name(s)) {
        return Err(invalid);
    }
    let q = query.q.as_deref().unwrap_or("").trim();
    if q.chars().count() > 200 || q.chars().any(char::is_control) {
        return Err(invalid);
    }
    let run = match query.run_id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => Uuid::parse_str(id).map_err(|_| invalid)?.to_string(),
        None => String::new(),
    };
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(invalid);
    }
    // Both lists hold validated names only, so quoting them cannot break out.
    let array = |items: &[&str]| {
        format!(
            "[{}]",
            items
                .iter()
                .map(|s| format!("'{s}'"))
                .collect::<Vec<_>>()
                .join(",")
        )
    };
    Ok(Plan {
        page,
        limit,
        params: vec![
            ("levels".into(), array(&LEVELS[from..])),
            ("exclude".into(), array(&exclude)),
            ("q".into(), q.to_owned()),
            ("run".into(), run),
        ],
    })
}

fn service_name(s: &str) -> bool {
    s.len() <= 63
        && s.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_.-".contains(&b))
}

/// `<ingested_at microseconds>_<log_id>`. The newest-page cursor uses the
/// largest UUID, meaning "everything stored at or before that instant".
fn cursor(us: i64, id: Uuid) -> String {
    format!("{us}_{id}")
}

fn parse_cursor(value: &str) -> Option<(i64, Uuid)> {
    let (us, id) = value.split_once('_')?;
    let us: i64 = us.parse().ok().filter(|n| *n >= 0)?;
    Some((us, Uuid::parse_str(id).ok()?))
}

fn row(mut value: Value) -> Value {
    let text = |v: &Value| v.as_str().unwrap_or_default().to_owned();
    let id = |v: &Value| Some(text(v)).filter(|s| !s.is_empty());
    let fields = serde_json::from_str::<Value>(&text(&value["fields"]))
        .ok()
        .filter(Value::is_object);
    json!({
        "log_id": text(&value["id"]),
        "ts": format!("{}Z", text(&value["at"]).replacen(' ', "T", 1)),
        "service": text(&value["service"]),
        "replica": text(&value["replica"]),
        "stream": text(&value["stream"]),
        "level": text(&value["level"]),
        "message": value["message"].take(),
        "fields": fields,
        "run_id": id(&value["run_id"]),
        "request_id": id(&value["request_id"]),
    })
}

/// Operator log viewer: newest lines, lines after a cursor, or older lines.
pub async fn list(
    ScopedState(state): ScopedState,
    query: Result<Query<LogQuery>, axum::extract::rejection::QueryRejection>,
) -> Response {
    if !state.principal.operator {
        return crate::error(StatusCode::FORBIDDEN, "operator_required");
    }
    let Ok(Query(query)) = query else {
        return crate::error(StatusCode::BAD_REQUEST, "invalid_log_query");
    };
    let plan = match plan(query) {
        Ok(plan) => plan,
        Err(code) => return crate::error(StatusCode::BAD_REQUEST, code),
    };
    let Some(gateway) = state.gateway.as_ref() else {
        return crate::error(StatusCode::SERVICE_UNAVAILABLE, "logs_unavailable");
    };
    match read(gateway, plan).await {
        Ok(body) => Json(body).into_response(),
        Err(_) => crate::error(StatusCode::SERVICE_UNAVAILABLE, "logs_unavailable"),
    }
}

async fn read(gateway: &crate::gateway::Gateway, plan: Plan) -> Result<Value, &'static str> {
    let Plan {
        page,
        mut params,
        limit,
    } = plan;
    params.push(("limit".into(), (limit + 1).to_string()));
    let full = |rows: &Vec<Value>| rows.len() > limit as usize;
    let head = |after: i64| async move {
        let rows = gateway.clickhouse_rows("SELECT toUnixTimestamp64Micro(max(ingested_at)) AS head FROM scout.service_logs WHERE ingested_at>fromUnixTimestamp64Micro({after:Int64},'UTC') FORMAT JSONEachRow", &[("after".into(), after.to_string())]).await?;
        Ok::<i64, &'static str>(
            rows.first()
                .and_then(|r| r["head"].as_i64())
                .unwrap_or(0)
                .max(after),
        )
    };
    let mut body = json!({"retention_days": RETENTION_DAYS});
    match page {
        Page::After(us, id) => {
            let top = head(us).await?;
            if top == us {
                body["logs"] = json!([]);
                body["cursor"] = json!(cursor(us, id));
                body["has_more"] = json!(false);
                return Ok(body);
            }
            params.extend([
                ("after_us".into(), us.to_string()),
                ("after_id".into(), id.to_string()),
                ("head".into(), top.to_string()),
            ]);
            let mut rows = gateway.clickhouse_rows(&format!("SELECT {COLUMNS} FROM scout.service_logs WHERE (ingested_at,log_id)>(fromUnixTimestamp64Micro({{after_us:Int64}},'UTC'),{{after_id:UUID}}) AND ingested_at<=fromUnixTimestamp64Micro({{head:Int64}},'UTC') AND {FILTERS} ORDER BY ingested_at,log_id LIMIT {{limit:UInt32}} FORMAT JSONEachRow"), &params).await?;
            let more = full(&rows);
            rows.truncate(limit as usize);
            let next = match rows.last() {
                Some(last) if more => cursor(
                    last["ingested_us"]
                        .as_i64()
                        .ok_or("clickhouse_unexpected_response")?,
                    last["id"]
                        .as_str()
                        .and_then(|s| Uuid::parse_str(s).ok())
                        .ok_or("clickhouse_unexpected_response")?,
                ),
                _ => cursor(top, Uuid::from_u128(u128::MAX)),
            };
            body["logs"] = rows.into_iter().map(row).collect();
            body["cursor"] = json!(next);
            body["has_more"] = json!(more);
        }
        Page::Latest | Page::Older(_) => {
            let (bound, top) = match &page {
                Page::Older(before) => {
                    params.push(("before".into(), before.clone()));
                    ("ts<{before:DateTime64(9,'UTC')}", None)
                }
                _ => {
                    let top = head(0).await?;
                    params.push(("head".into(), top.to_string()));
                    (
                        "ingested_at<=fromUnixTimestamp64Micro({head:Int64},'UTC')",
                        Some(top),
                    )
                }
            };
            let mut rows = gateway.clickhouse_rows(&format!("SELECT {COLUMNS} FROM scout.service_logs WHERE {bound} AND {FILTERS} ORDER BY ts DESC,log_id DESC LIMIT {{limit:UInt32}} FORMAT JSONEachRow"), &params).await?;
            let more = full(&rows);
            rows.truncate(limit as usize);
            rows.reverse();
            body["logs"] = rows.into_iter().map(row).collect();
            body["has_more"] = json!(more);
            if let Some(top) = top {
                body["cursor"] = json!(cursor(top, Uuid::from_u128(u128::MAX)));
                body["services"] = Value::Array(gateway.clickhouse_rows("SELECT service,toString(max(ts)) AS last_seen,count() AS lines FROM scout.service_logs WHERE ts>now64(9)-INTERVAL 1 DAY GROUP BY service ORDER BY service FORMAT JSONEachRow", &[]).await?.into_iter().map(|mut s| {
                    s["last_seen"] = json!(format!("{}Z", s["last_seen"].as_str().unwrap_or_default().replacen(' ', "T", 1)));
                    s
                }).collect());
            }
        }
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parses pairs the way the handler does; values are already URL-safe.
    fn query(pairs: &[(&str, &str)]) -> LogQuery {
        let text = pairs
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("&");
        Query::<LogQuery>::try_from_uri(&format!("/v1/admin/logs?{text}").parse().unwrap())
            .unwrap()
            .0
    }
    fn param<'a>(plan: &'a Plan, key: &str) -> &'a str {
        &plan.params.iter().find(|(k, _)| k == key).unwrap().1
    }

    #[test]
    fn lines_are_single_json_objects_without_null_fields() {
        let line = render(
            "info",
            "model_call_finished",
            json!({"provider":"meta","error":null,"note":"a\nb \"quoted\""}),
        );
        assert!(!line.contains('\n'));
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["level"], "info");
        assert_eq!(value["msg"], "model_call_finished");
        assert_eq!(value["provider"], "meta");
        assert_eq!(value["note"], "a\nb \"quoted\"");
        assert!(value.get("error").is_none());
        assert!(line.starts_with("{\"level\":\"info\",\"msg\":"));
    }

    #[test]
    fn request_paths_are_kept_only_for_uuid_parameters() {
        let id = "0b6f4c53-6d3d-4a0e-9a59-3c7f5f0f6a11";
        assert_eq!(
            uuid_path("/v1/runs/{run_id}", &format!("/v1/runs/{id}")),
            Some(format!("/v1/runs/{id}"))
        );
        assert_eq!(
            uuid_path(
                "/v1/agent-connections/{code}",
                "/v1/agent-connections/ABCD-EFGH"
            ),
            None
        );
        assert_eq!(
            uuid_path("/workspace/{*rest}", &format!("/workspace/{id}")),
            None
        );
        assert_eq!(uuid_path("/v1/runs", "/v1/runs"), None);
        assert_eq!(uuid_path("/v1/runs/{run_id}", "/v1/runs/a/b"), None);
        assert!(quiet("/v1/admin/logs") && quiet("/healthz") && !quiet("/v1/runs"));
    }

    #[test]
    fn query_plans_bind_validated_filters() {
        let plan = plan(query(&[
            ("level", "warning"),
            ("exclude", "evidence,browser-sandbox"),
            ("q", "%20%20model_call%20%20"),
            ("run_id", "0B6F4C53-6D3D-4A0E-9A59-3C7F5F0F6A11"),
            ("limit", "50"),
        ]))
        .unwrap();
        assert_eq!(plan.page, Page::Latest);
        assert_eq!(plan.limit, 50);
        assert_eq!(param(&plan, "levels"), "['warning','error']");
        assert_eq!(param(&plan, "exclude"), "['evidence','browser-sandbox']");
        assert_eq!(param(&plan, "q"), "model_call");
        assert_eq!(param(&plan, "run"), "0b6f4c53-6d3d-4a0e-9a59-3c7f5f0f6a11");

        let defaults = super::plan(LogQuery::default()).unwrap();
        assert_eq!(
            param(&defaults, "levels"),
            "['debug','info','warning','error']"
        );
        assert_eq!(param(&defaults, "exclude"), "[]");
        assert_eq!(defaults.limit, DEFAULT_LIMIT);
    }

    #[test]
    fn query_plans_reject_unsafe_or_ambiguous_input() {
        for pairs in [
            vec![("level", "verbose")],
            vec![("exclude", "api','x")],
            vec![("exclude", "API")],
            vec![("q", "a%07b")],
            vec![("run_id", "not-a-run")],
            vec![("limit", "0")],
            vec![("limit", "501")],
            vec![("after", "12_nope")],
            vec![("after", "-1_0b6f4c53-6d3d-4a0e-9a59-3c7f5f0f6a11")],
            vec![("before", "yesterday")],
            vec![
                ("after", "1_0b6f4c53-6d3d-4a0e-9a59-3c7f5f0f6a11"),
                ("before", "2026-11-04T10:00:00Z"),
            ],
        ] {
            assert_eq!(
                plan(query(&pairs)).unwrap_err(),
                "invalid_log_query",
                "{pairs:?}"
            );
        }
        assert!(plan(query(&[("q", &"x".repeat(201))])).is_err());
    }

    #[test]
    fn cursors_and_older_pages_round_trip() {
        let id = Uuid::new_v4();
        assert_eq!(
            parse_cursor(&cursor(1_793_786_352_460_008, id)),
            Some((1_793_786_352_460_008, id))
        );
        let after = plan(query(&[("after", &cursor(5, id))])).unwrap();
        assert_eq!(after.page, Page::After(5, id));
        let older = plan(query(&[("before", "2026-11-04T10:12:03.123456789Z")])).unwrap();
        assert_eq!(
            older.page,
            Page::Older("2026-11-04 10:12:03.123456789".into())
        );
    }

    #[test]
    fn selected_aliases_never_shadow_filtered_or_sorted_columns() {
        for alias in COLUMNS
            .split(',')
            .filter_map(|c| c.split_once(" AS ").map(|(_, a)| a))
        {
            for column in [
                "log_id",
                "ts",
                "ingested_at",
                "level",
                "service",
                "message",
                "fields",
                "run_id",
            ] {
                assert_ne!(
                    alias, column,
                    "{alias} would replace the {column} column in WHERE/ORDER BY"
                );
            }
        }
    }

    #[test]
    fn rows_expose_rfc3339_times_parsed_fields_and_optional_ids() {
        let out = row(
            json!({"id":"0b6f4c53-6d3d-4a0e-9a59-3c7f5f0f6a11","at":"2026-11-04 10:12:03.123456789","ingested_us":1,"service":"api","replica":"api-1","stream":"stdout","level":"info","message":"model_call_finished","fields":"{\"provider\":\"meta\"}","run_id":"","request_id":"0b6f4c53-6d3d-4a0e-9a59-3c7f5f0f6a12"}),
        );
        assert_eq!(out["ts"], "2026-11-04T10:12:03.123456789Z");
        assert_eq!(out["log_id"], "0b6f4c53-6d3d-4a0e-9a59-3c7f5f0f6a11");
        assert_eq!(out["fields"]["provider"], "meta");
        assert!(out["run_id"].is_null());
        assert_eq!(out["request_id"], "0b6f4c53-6d3d-4a0e-9a59-3c7f5f0f6a12");
        assert!(out.get("ingested_us").is_none());
        let plain = row(json!({"fields":"","message":"plain text"}));
        assert!(plain["fields"].is_null());
        assert_eq!(plain["message"], "plain text");
    }
}
