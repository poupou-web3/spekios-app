use super::{endpoint, valid_token};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

#[derive(Deserialize, Serialize)]
pub struct Credential {
    version: u8,
    pub api_url: String,
    pub agent_id: Uuid,
    workspace_id: Uuid,
    pub access_token: String,
    pub expires_at: u64,
}
fn private_parent(path: &Path) -> Result<(), &'static str> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or("Use a credential path with a parent directory.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder
            .create(parent)
            .map_err(|_| "Cannot create the private Scout configuration directory.")?;
        let metadata = fs::symlink_metadata(parent)
            .map_err(|_| "Cannot inspect the Scout configuration directory.")?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(
                "The Scout credential directory must be a real directory accessible only to its owner (mode 0700).",
            );
        }
    }
    Ok(())
}
pub fn default_file() -> Result<PathBuf, &'static str> {
    if let Some(path) = env::var_os("SCOUT_CREDENTIAL_FILE") {
        return Ok(path.into());
    }
    let base = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|p| PathBuf::from(p).join(".config")))
        .ok_or("Set HOME, XDG_CONFIG_HOME or --credential-file.")?;
    Ok(base.join("scout").join("credentials.json"))
}
pub fn read(path: &Path) -> Result<Credential, &'static str> {
    let before=fs::symlink_metadata(path).map_err(|_|"No saved agent connection. Run scout-mcp login first, or explicitly select an operator env file.")?;
    if !before.is_file() || before.file_type().is_symlink() || before.len() > 8192 {
        return Err("The Scout credential must be a small regular file, not a symlink.");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if before.permissions().mode() & 0o077 != 0 {
            return Err(
                "The Scout credential file must be accessible only to its owner (mode 0600).",
            );
        }
    }
    let mut file = fs::File::open(path).map_err(|_| "Cannot read the saved Scout credential.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let after = file
            .metadata()
            .map_err(|_| "Cannot inspect the saved Scout credential.")?;
        if before.ino() != after.ino() || before.dev() != after.dev() {
            return Err("The credential file changed while opening it.");
        }
    }
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(8193)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read the saved Scout credential.")?;
    let credential: Credential =
        serde_json::from_slice(&bytes).map_err(|_| "The saved Scout credential is invalid.")?;
    if credential.version != 1
        || credential.agent_id.is_nil()
        || credential.workspace_id.is_nil()
        || !valid_token(&credential.access_token)
        || endpoint(&credential.api_url).is_err()
    {
        return Err("The saved Scout credential is invalid.");
    }
    Ok(credential)
}
fn save(path: &Path, credential: &Credential) -> Result<(), &'static str> {
    private_parent(path)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file=options.open(path).map_err(|_|"A credential already exists or the selected path is not writable. Log out first or choose another --credential-file.")?;
    let bytes =
        serde_json::to_vec(credential).map_err(|_| "Cannot encode the Scout credential.")?;
    if file
        .write_all(&bytes)
        .and_then(|_| file.sync_all())
        .is_err()
    {
        let _ = fs::remove_file(path);
        return Err("Cannot persist the Scout credential.");
    }
    if let Some(parent) = path.parent() {
        let _ = fs::File::open(parent).and_then(|f| f.sync_all());
    }
    Ok(())
}
pub fn bridge_arguments(args: Vec<String>) -> Result<(Vec<String>, Option<PathBuf>), &'static str> {
    let mut args = args.into_iter();
    let mut rest = Vec::new();
    let mut file = None;
    while let Some(arg) = args.next() {
        if arg == "--credential-file" && file.is_none() {
            file = Some(PathBuf::from(
                args.next().ok_or("--credential-file needs a path.")?,
            ));
        } else {
            rest.push(arg)
        }
    }
    Ok((rest, file))
}
fn client() -> Result<Client, reqwest::Error> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
}
fn route(base: &Url, path: &str) -> Url {
    let mut result = base.clone();
    result.set_path(path);
    result
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn public_code(code: &str) -> String {
    code.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("-")
}
pub async fn command(command: &str, args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let (args, credential_file) = bridge_arguments(args)?;
    let path = credential_file.unwrap_or(default_file()?);
    let mut args = args.into_iter();
    let mut api = None;
    let mut name = "Local coding agent".to_owned();
    let mut no_browser = false;
    while let Some(arg) = args.next() {
        match arg.as_str(){
        "--api-url" if api.is_none()=>api=Some(args.next().ok_or("--api-url needs a URL.")?),
        "--name" if command=="login"=>name=args.next().ok_or("--name needs a name.")?,
        "--no-browser" if command=="login"=>no_browser=true,
        _=>return Err("Usage: scout-mcp login [--api-url URL] [--name NAME] [--credential-file PATH] [--no-browser], or scout-mcp logout [--credential-file PATH]".into())
    }
    }
    let client = client()?;
    if command == "logout" {
        let credential = read(&path)?;
        let url = endpoint(&credential.api_url)?;
        if api
            .as_ref()
            .is_some_and(|a| endpoint(a).ok() != Some(url.clone()))
        {
            return Err("The selected API does not match the credential's server.".into());
        }
        let response = client
            .post(route(
                &url,
                &format!("/v1/agents/{}/revoke", credential.agent_id),
            ))
            .bearer_auth(&credential.access_token)
            .json(&json!({}))
            .send()
            .await
            .map_err(
                |_| "Cannot reach Scout to revoke the credential. It has not been removed locally.",
            )?;
        if !response.status().is_success() && response.status() != 401 {
            return Err(
                "Scout could not revoke the credential. It has not been removed locally.".into(),
            );
        }
        fs::remove_file(&path)
            .map_err(|_| "Access is revoked, but the local credential could not be removed.")?;
        eprintln!("Scout agent disconnected. Existing browser work was not cancelled.");
        return Ok(());
    }
    if path.try_exists().unwrap_or(true) || fs::symlink_metadata(&path).is_ok() {
        return Err(
            "A credential already exists. Log out first or choose another --credential-file."
                .into(),
        );
    }
    private_parent(&path)?;
    let url = endpoint(
        &api.or_else(|| env::var("SCOUT_API_URL").ok())
            .unwrap_or_else(|| "http://127.0.0.1:18080".into()),
    )?;
    let verifier = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let challenge = format!("{:x}", Sha256::digest(verifier.as_bytes()));
    let response=client.post(route(&url,"/v1/agent-connections")).json(&json!({"agent_name":name,"scopes":["runs:read","runs:write","usage:read"],"code_challenge":challenge})).send().await.map_err(|_|"Cannot reach Scout to start agent login.")?;
    if !response.status().is_success() {
        return Err("Scout could not start agent login.".into());
    }
    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "Invalid Scout login response.")?;
    let device = data["device_code"]
        .as_str()
        .filter(|c| c.len() == 64)
        .ok_or("Missing device code.")?;
    let code = data["user_code"]
        .as_str()
        .filter(|c| c.len() == 12 && c.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("Missing approval code.")?;
    let mut browser = route(&url, "/connect");
    browser.set_fragment(Some(&format!("code={code}")));
    eprintln!(
        "Open {} and approve code {} for {}.\nWaiting for browser approval. No administrator token is needed by this connector.",
        browser,
        public_code(code),
        name
    );
    if !no_browser {
        #[cfg(target_os = "macos")]
        {
            let _ = std::process::Command::new("open")
                .arg(browser.as_str())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
        }
        #[cfg(target_os = "linux")]
        {
            let _ = std::process::Command::new("xdg-open")
                .arg(browser.as_str())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
        }
    }
    let deadline = now() + data["expires_in"].as_u64().unwrap_or(600).min(600);
    while now() < deadline {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let response = client
            .post(route(&url, "/v1/agent-connections/token"))
            .json(&json!({"device_code":device,"code_verifier":verifier}))
            .send()
            .await
            .map_err(
                |_| "Scout login was interrupted. Start a new login; no credential was saved.",
            )?;
        if response.status() == 202 || response.status() == 429 {
            continue;
        }
        if !response.status().is_success() {
            return Err(
                "Scout login was denied, expired or already consumed. Start a new login if needed."
                    .into(),
            );
        }
        let data: serde_json::Value = response
            .json()
            .await
            .map_err(|_| "Invalid Scout credential response.")?;
        let credential = Credential {
            version: 1,
            api_url: route(&url, "/").to_string(),
            agent_id: serde_json::from_value(data["agent_id"].clone())
                .map_err(|_| "Missing agent identity.")?,
            workspace_id: serde_json::from_value(data["workspace_id"].clone())
                .map_err(|_| "Missing workspace identity.")?,
            access_token: data["access_token"]
                .as_str()
                .filter(|v| valid_token(v))
                .ok_or("Missing agent credential.")?
                .to_owned(),
            expires_at: now() + data["expires_in"].as_u64().unwrap_or(0),
        };
        if let Err(error) = save(&path, &credential) {
            let _ = client
                .post(route(
                    &url,
                    &format!("/v1/agents/{}/revoke", credential.agent_id),
                ))
                .bearer_auth(&credential.access_token)
                .json(&json!({}))
                .send()
                .await;
            return Err(error.into());
        }
        eprintln!(
            "Connected agent {} to workspace {}. Credential saved privately at {}.\nConfigure your MCP client to run scout-mcp with this --credential-file; no token belongs in the client configuration.",
            credential.agent_id,
            credential.workspace_id,
            path.display()
        );
        return Ok(());
    }
    Err("Scout login expired. No credential was saved.".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credential_is_private_origin_bound_and_never_overwrites() {
        let directory = env::temp_dir().join(format!("scout-credential-test-{}", Uuid::new_v4()));
        let path = directory.join("credentials.json");
        let value = Credential {
            version: 1,
            api_url: "https://scout.example/".into(),
            agent_id: Uuid::new_v4(),
            workspace_id: Uuid::new_v4(),
            access_token: "scout_agent_fixture_secret_00000000000000000000".into(),
            expires_at: now() + 60,
        };
        save(&path, &value).unwrap();
        assert_eq!(read(&path).unwrap().agent_id, value.agent_id);
        assert!(save(&path, &value).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            assert!(read(&path).is_err());
        }
        fs::remove_dir_all(directory).unwrap();
    }
}
