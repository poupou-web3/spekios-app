//! Token counting is read-only: transient failures can be retried before any
//! inference, reservation or browser action is dispatched. Never guess a count
//! or bypass the demo budget when the provider remains unavailable.
use crate::logs::emit as log;
use reqwest::Client;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use uuid::Uuid;

const ATTEMPTS: u32 = 3;
const MAX_RESPONSE: usize = 16_384;
const UNAVAILABLE: &str = "demo_token_count_unavailable";
const INVALID: &str = "demo_token_count_invalid";
const REJECTED: &str = "demo_token_count_rejected";

struct Failure {
    code: &'static str,
    reason: &'static str,
    status: Option<u16>,
    retry_delay: Option<Duration>,
}

fn transport(error: reqwest::Error) -> Failure {
    Failure {
        code: UNAVAILABLE,
        reason: if error.is_timeout() {
            "timeout"
        } else {
            "transport_error"
        },
        status: None,
        retry_delay: Some(Duration::ZERO),
    }
}

async fn attempt(
    http: &Client,
    endpoint: &str,
    key: &str,
    body: &[u8],
    timeout: Duration,
) -> Result<i64, Failure> {
    let mut response = http
        .post(endpoint)
        .bearer_auth(key)
        .header("content-type", "application/json")
        .body(body.to_vec())
        .timeout(timeout)
        .send()
        .await
        .map_err(transport)?;
    let status = response.status();
    if !status.is_success() {
        let transient =
            status.as_u16() == 408 || status.as_u16() == 429 || status.is_server_error();
        // Respect Retry-After, but don't hold the shared dispatcher indefinitely
        // or retry earlier than the provider permits. Invalid headers stop retries.
        let delay = match response.headers().get("retry-after") {
            None => Some(Duration::ZERO),
            Some(value) => value
                .to_str()
                .ok()
                .and_then(super::retry_seconds)
                .filter(|seconds| *seconds <= 5)
                .map(|seconds| Duration::from_secs(seconds as u64)),
        };
        return Err(Failure {
            code: if transient { UNAVAILABLE } else { REJECTED },
            reason: "http_error",
            status: Some(status.as_u16()),
            retry_delay: if transient { delay } else { None },
        });
    }
    let invalid = || Failure {
        code: INVALID,
        reason: "invalid_response",
        status: Some(status.as_u16()),
        retry_delay: None,
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(transport)? {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err(invalid());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    value["input_tokens"]
        .as_i64()
        .filter(|n| (0..=1_048_576).contains(n))
        .ok_or_else(invalid)
}

pub(super) async fn count(
    http: &Client,
    request_id: Uuid,
    key: &str,
    body: &[u8],
) -> Result<i64, &'static str> {
    // Multimodal counts can exceed the old ten-second limit. The worker allows
    // this bounded preparation phase plus the ordinary inference timeout.
    count_at(
        http,
        "https://api.meta.ai/v1/responses/input_tokens",
        request_id,
        key,
        body,
        Duration::from_secs(20),
        Duration::from_secs(1),
    )
    .await
}

async fn count_at(
    http: &Client,
    endpoint: &str,
    request_id: Uuid,
    key: &str,
    body: &[u8],
    timeout: Duration,
    backoff: Duration,
) -> Result<i64, &'static str> {
    for number in 1..=ATTEMPTS {
        let start = Instant::now();
        match attempt(http, endpoint, key, body, timeout).await {
            Ok(tokens) => return Ok(tokens),
            Err(failure) => {
                let delay = failure.retry_delay.map(|delay| delay.max(backoff * number));
                let retry = number < ATTEMPTS && delay.is_some();
                log(
                    "warning",
                    "model_token_count_failed",
                    json!({"request_id":request_id,
                    "attempt":number,"reason":failure.reason,"http_status":failure.status,
                    "elapsed_ms":start.elapsed().as_millis() as u64,"retrying":retry,
                    "retry_delay_ms":if retry { delay.map(|d| d.as_millis() as u64) } else { None },
                    "provider_dispatched":false}),
                );
                if !retry {
                    return Err(failure.code);
                }
                tokio::time::sleep(delay.unwrap()).await;
            }
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::Bytes,
        extract::State,
        http::{HeaderMap, StatusCode},
        response::{IntoResponse, Response},
        routing::post,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[derive(Clone)]
    struct Fixture {
        calls: Arc<AtomicUsize>,
        failures: usize,
        status: u16,
        body: String,
        slow_first: bool,
        retry_after: Option<&'static str>,
    }

    async fn serve(State(f): State<Fixture>, headers: HeaderMap, body: Bytes) -> Response {
        assert_eq!(headers["authorization"], "Bearer disposable-test-key");
        assert_eq!(
            body.as_ref(),
            br#"{"model":"test-model","input":"same request"}"#
        );
        let index = f.calls.fetch_add(1, Ordering::SeqCst);
        if f.slow_first && index == 0 {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        let status = if index < f.failures { f.status } else { 200 };
        let mut response = (StatusCode::from_u16(status).unwrap(), f.body).into_response();
        if let Some(value) = f.retry_after {
            response
                .headers_mut()
                .insert("retry-after", value.parse().unwrap());
        }
        response
    }

    async fn check(
        failures: usize,
        status: u16,
        body: &str,
        slow_first: bool,
        retry_after: Option<&'static str>,
    ) -> (Result<i64, &'static str>, usize) {
        let calls = Arc::new(AtomicUsize::new(0));
        let fixture = Fixture {
            calls: calls.clone(),
            failures,
            status,
            body: body.into(),
            slow_first,
            retry_after,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/input_tokens", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route("/input_tokens", post(serve))
                    .with_state(fixture),
            )
            .await
            .unwrap();
        });
        let result = count_at(
            &Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .build()
                .unwrap(),
            &endpoint,
            Uuid::nil(),
            "disposable-test-key",
            br#"{"model":"test-model","input":"same request"}"#,
            Duration::from_millis(80),
            Duration::ZERO,
        )
        .await;
        server.abort();
        (result, calls.load(Ordering::SeqCst))
    }

    #[tokio::test]
    async fn transient_errors_and_timeouts_recover_without_changing_the_request() {
        for status in [408, 429, 500, 502, 503, 504] {
            assert_eq!(
                check(2, status, r#"{"input_tokens":123}"#, false, None).await,
                (Ok(123), 3)
            );
        }
        assert_eq!(
            check(0, 200, r#"{"input_tokens":123}"#, true, None).await,
            (Ok(123), 2)
        );
    }

    #[tokio::test]
    async fn persistent_outage_stops_after_three_attempts_without_an_estimated_count() {
        assert_eq!(
            check(99, 503, "unavailable", false, None).await,
            (Err(UNAVAILABLE), 3)
        );
    }

    #[tokio::test]
    async fn rejected_requests_and_invalid_counts_are_not_retried() {
        for status in [400, 401, 403, 404, 413] {
            assert_eq!(
                check(99, status, "rejected", false, None).await,
                (Err(REJECTED), 1)
            );
        }
        for body in [
            "not json",
            "{}",
            r#"{"input_tokens":-1}"#,
            r#"{"input_tokens":1048577}"#,
            r#"{"input_tokens":1.5}"#,
            r#"{"input_tokens":"123"}"#,
        ] {
            assert_eq!(check(0, 200, body, false, None).await, (Err(INVALID), 1));
        }
        assert_eq!(
            check(0, 200, &"x".repeat(MAX_RESPONSE + 1), false, None).await,
            (Err(INVALID), 1)
        );
        for count in [0, 1_048_576] {
            assert_eq!(
                check(
                    0,
                    200,
                    &format!(r#"{{"input_tokens":{count}}}"#),
                    false,
                    None
                )
                .await,
                (Ok(count), 1)
            );
        }
    }

    #[tokio::test]
    async fn long_or_invalid_retry_after_is_never_ignored() {
        for header in ["60", "invalid"] {
            assert_eq!(
                check(99, 429, "rate limited", false, Some(header)).await,
                (Err(UNAVAILABLE), 1)
            );
        }
    }

    #[tokio::test]
    async fn short_retry_after_is_honored_before_recovering() {
        let start = Instant::now();
        assert_eq!(
            check(1, 429, r#"{"input_tokens":123}"#, false, Some("1")).await,
            (Ok(123), 2)
        );
        assert!(start.elapsed() >= Duration::from_secs(1));
    }
}
