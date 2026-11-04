//! Newline-delimited MCP stdio bridge. The Rust API remains the only tool
//! implementation; this process forwards messages without replaying commands.
#[path = "scout-mcp/connection.rs"]
mod connection;
use reqwest::{Client, Url};
use serde_json::{Value, json};
use std::{env, path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Stdout},
    sync::{Mutex, RwLock, Semaphore},
};

const MAX_INPUT: usize = 65_536;
const MAX_OUTPUT: usize = 16 * 1024 * 1024;
type Output = Arc<Mutex<Stdout>>;

fn endpoint(raw: &str) -> Result<Url, &'static str> {
    let mut url = Url::parse(raw).map_err(|_| "Invalid local API URL.")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || (url.scheme() == "http"
            && !matches!(
                url.host_str(),
                Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
            ))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "/" | "/mcp")
        || url.port() == Some(0)
    {
        return Err(
            "Use an HTTPS API origin (or literal loopback HTTP), without credentials, query, fragment or a path other than /mcp.",
        );
    }
    url.set_path("/mcp");
    Ok(url)
}
fn valid_token(token: &str) -> bool {
    token.len() >= 32
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn options(
    args: impl Iterator<Item = String>,
) -> Result<(Option<PathBuf>, Option<String>), &'static str> {
    let mut args = args;
    let (mut file, mut api) = (None, None);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--env-file" if file.is_none() => {
                file = Some(PathBuf::from(
                    args.next().ok_or("--env-file needs a path.")?,
                ))
            }
            "--api-url" if api.is_none() => {
                api = Some(args.next().ok_or("--api-url needs a URL.")?)
            }
            _ => {
                return Err(
                    "Usage: scout-mcp [--env-file /absolute/project/.env] [--api-url http://127.0.0.1:18080]",
                );
            }
        }
    }
    Ok((file, api))
}
fn token(file: Option<PathBuf>) -> Result<String, &'static str> {
    if let Ok(value) = env::var("SCOUT_API_TOKEN") {
        if valid_token(&value) {
            return Ok(value);
        }
        return Err("SCOUT_API_TOKEN is invalid.");
    }
    let path=file.ok_or("Set SCOUT_API_TOKEN or pass --env-file; the token is not printed or embedded in client configuration.")?;
    if std::fs::metadata(&path)
        .map_err(|_| "Cannot read the selected env file.")?
        .len()
        > 1024 * 1024
    {
        return Err("The selected env file is too large.");
    }
    let entries =
        dotenvy::from_path_iter(path).map_err(|_| "Cannot read the selected env file.")?;
    let mut found = None;
    for entry in entries {
        let (key, value) = entry.map_err(|_| "The selected env file could not be parsed.")?;
        if key == "SCOUT_API_TOKEN" {
            if found.is_some() {
                return Err("The selected env file has duplicate SCOUT_API_TOKEN keys.");
            }
            found = Some(value);
        }
    }
    found
        .filter(|value| valid_token(value))
        .ok_or("A valid SCOUT_API_TOKEN is required in the selected env file.")
}
async fn write(output: &Output, value: &Value) {
    let Ok(mut bytes) = serde_json::to_vec(value) else {
        return;
    };
    bytes.push(b'\n');
    let mut out = output.lock().await;
    let _ = out.write_all(&bytes).await;
    let _ = out.flush().await;
}
fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
async fn line(reader: &mut BufReader<tokio::io::Stdin>) -> std::io::Result<Option<Vec<u8>>> {
    let mut result = Vec::new();
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            return if result.is_empty() {
                Ok(None)
            } else {
                Ok(Some(result))
            };
        }
        let count = chunk
            .iter()
            .position(|b| *b == b'\n')
            .map(|n| n + 1)
            .unwrap_or(chunk.len());
        if result.len() + count > MAX_INPUT {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "MCP input line exceeds 64 KiB.",
            ));
        }
        let done = chunk[count - 1] == b'\n';
        result.extend_from_slice(&chunk[..count]);
        reader.consume(count);
        if done {
            return Ok(Some(result));
        }
    }
}
async fn forward(
    client: Client,
    url: Url,
    bearer: Arc<str>,
    message: Value,
    version: Arc<RwLock<Option<String>>>,
    output: Output,
) {
    let id = message.get("id").cloned();
    let initialize = message["method"] == "initialize";
    let mut request = client
        .post(url)
        .header("authorization", bearer.as_ref())
        .header("accept", "application/json, text/event-stream")
        .json(&message);
    if !initialize && let Some(protocol) = version.read().await.as_ref() {
        request = request.header("mcp-protocol-version", protocol);
    }
    let mut response = match request.send().await {
        Ok(value) => value,
        Err(_) => {
            if let Some(id) = id {
                write(&output,&rpc_error(id,-32001,"Spekios is unavailable or the MCP request timed out. Start/check the local API. No command was automatically retried.")).await;
            }
            return;
        }
    };
    if response.status() == reqwest::StatusCode::ACCEPTED && id.is_none() {
        return;
    }
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|n| n > MAX_OUTPUT as u64)
    {
        if let Some(id) = id {
            write(
                &output,
                &rpc_error(
                    id,
                    -32001,
                    "Spekios MCP response exceeds the bridge size limit.",
                ),
            )
            .await;
        }
        return;
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= MAX_OUTPUT => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => {
                if let Some(id) = id {
                    write(&output,&rpc_error(id,-32001,"Spekios MCP response was incomplete or too large. No command was automatically retried.")).await;
                }
                return;
            }
        }
    }
    let Some(id) = id else {
        return;
    };
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => {
            write(
                &output,
                &rpc_error(
                    id,
                    -32001,
                    &format!(
                        "Spekios MCP returned HTTP {} without a JSON response.",
                        status.as_u16()
                    ),
                ),
            )
            .await;
            return;
        }
    };
    if value["jsonrpc"] != "2.0"
        || value["id"] != id
        || (value.get("result").is_none() == value.get("error").is_none())
    {
        write(&output,&rpc_error(id,-32001,&format!("Spekios MCP request rejected (HTTP {}). Check the API token and protocol configuration.",status.as_u16()))).await;
        return;
    }
    if initialize && let Some(protocol) = value["result"]["protocolVersion"].as_str() {
        *version.write().await = Some(protocol.to_owned());
    }
    write(&output, &value).await;
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    if matches!(args.first().map(String::as_str), Some("login" | "logout")) {
        return connection::command(&args[0], args[1..].to_vec()).await;
    }
    let (args, credential_file) = connection::bridge_arguments(args)?;
    let (file, configured_url) = options(args.into_iter())?;
    let requested_url = configured_url.or_else(|| env::var("SCOUT_API_URL").ok());
    let (url, secret) = if file.is_some() || env::var_os("SCOUT_API_TOKEN").is_some() {
        if credential_file.is_some() {
            return Err(
                "Choose either an operator env token or an agent credential file, not both.".into(),
            );
        }
        (
            endpoint(requested_url.as_deref().unwrap_or("http://127.0.0.1:18080"))?,
            token(file)?,
        )
    } else {
        let credential = connection::read(&credential_file.unwrap_or(connection::default_file()?))?;
        if credential.expires_at
            <= std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_secs()
        {
            return Err(
                "Saved Spekios access has expired. Run scout-mcp logout, then login again.".into(),
            );
        }
        let bound = endpoint(&credential.api_url)?;
        if requested_url
            .as_ref()
            .is_some_and(|url| endpoint(url).ok() != Some(bound.clone()))
        {
            return Err("The requested API does not match this credential's server. Start a separate login for another server.".into());
        }
        (bound, credential.access_token)
    };
    let bearer: Arc<str> = Arc::from(format!("Bearer {secret}"));
    // Never send local credentials through a proxy or redirect.
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(45))
        .build()?;
    let output = Arc::new(Mutex::new(tokio::io::stdout()));
    let version = Arc::new(RwLock::new(None));
    let capacity = Arc::new(Semaphore::new(8));
    let mut reader = BufReader::new(tokio::io::stdin());
    let mut tasks = tokio::task::JoinSet::new();
    while let Some(bytes) = line(&mut reader).await? {
        while tasks.try_join_next().is_some() {}
        let message: Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => {
                write(
                    &output,
                    &rpc_error(Value::Null, -32700, "Invalid JSON MCP message."),
                )
                .await;
                continue;
            }
        };
        let valid_id = message
            .get("id")
            .is_none_or(|v| v.is_string() || v.as_i64().is_some() || v.as_u64().is_some());
        if !message.is_object()
            || message["jsonrpc"] != "2.0"
            || !message["method"].is_string()
            || !valid_id
        {
            write(
                &output,
                &rpc_error(
                    Value::Null,
                    -32600,
                    "Expected one JSON-RPC request or notification per line.",
                ),
            )
            .await;
            continue;
        }
        let permit = match capacity.clone().try_acquire_owned() {
            Ok(v) => v,
            Err(_) => {
                if let Some(id) = message.get("id") {
                    write(
                        &output,
                        &rpc_error(
                            id.clone(),
                            -32001,
                            "Spekios MCP bridge is busy; retry with the same command UUID.",
                        ),
                    )
                    .await;
                }
                continue;
            }
        };
        let (client, url, bearer, version, output) = (
            client.clone(),
            url.clone(),
            bearer.clone(),
            version.clone(),
            output.clone(),
        );
        tasks.spawn(async move {
            let _permit = permit;
            forward(client, url, bearer, message, version, output).await;
        });
    }
    // EOF terminates this client connection only. Durable Spekios jobs continue.
    tasks.abort_all();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bridge_endpoint_requires_tls_except_loopback_and_never_carries_url_credentials() {
        for s in [
            "http://127.0.0.1:18080",
            "http://localhost:18080/mcp",
            "http://[::1]:18080/",
            "https://scout.example",
        ] {
            assert_eq!(endpoint(s).unwrap().path(), "/mcp");
        }
        for s in [
            "http://example.com",
            "http://127.0.0.1.evil.test",
            "http://user:password@localhost",
            "http://localhost/path",
            "http://localhost/?token=secret",
            "http://localhost/#fragment",
            "http://localhost:0",
        ] {
            assert!(endpoint(s).is_err(), "{s}");
        }
    }
    #[test]
    fn bridge_configuration_does_not_accept_tokens_as_cli_arguments() {
        assert!(options(["--token".into(), "secret".into()].into_iter()).is_err());
        let opts = options(
            [
                "--env-file".into(),
                "/tmp/scout.env".into(),
                "--api-url".into(),
                "http://localhost:18080".into(),
            ]
            .into_iter(),
        )
        .unwrap();
        assert_eq!(opts.0.unwrap(), PathBuf::from("/tmp/scout.env"));
        assert!(options(["--api-url".into()].into_iter()).is_err());
    }
    #[test]
    fn bridge_token_shape_matches_api_authentication() {
        assert!(valid_token(&"a".repeat(32)));
        for v in ["short", "Bearer abc", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"] {
            assert!(!valid_token(v));
        }
    }
}
