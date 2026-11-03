// Embeds the customer workspace, shared UI kit, and public CLI downloads.
// The generated table is a closed list: requests are matched against it and never read from disk.
// The operator back office (apps/backoffice) is deployed separately and is never embedded here.
use std::{
    collections::{BTreeSet, hash_map::DefaultHasher},
    env, fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Command,
};

fn collect(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("{}: {error}", dir.display()))
        .map(|entry| entry.expect("readable asset directory").path())
        .collect();
    entries.sort();
    for path in entries {
        let name = path
            .file_name()
            .expect("asset file name")
            .to_string_lossy()
            .into_owned();
        if path.is_dir() {
            collect(&path, &format!("{prefix}{name}/"), out);
        } else if name.ends_with(".js") || name.ends_with(".css") {
            out.push((format!("{prefix}{name}"), path));
        }
    }
}

/// Every `/assets/app/` and `/assets/ui/` reference gets the build's version segment, so browsers can
/// keep each file for good: a new build changes every URL and nothing stale is ever served.
fn versioned(body: &str, version: &str) -> String {
    body.replace("/assets/app/", &format!("/assets/{version}/app/"))
        .replace("/assets/ui/", &format!("/assets/{version}/ui/"))
}

/// Static imports of one module, as served paths below /assets/ (`import(...)` stays lazy).
fn imports(path: &str, body: &str) -> Vec<String> {
    let base = &path[..path.rfind('/').map_or(0, |i| i + 1)];
    let mut found = Vec::new();
    for marker in ["from '", "from \"", "import '", "import \""] {
        let mut rest = body;
        while let Some(at) = rest.find(marker) {
            rest = &rest[at + marker.len()..];
            let quote = marker.chars().last().unwrap();
            let Some(end) = rest.find(quote) else { break };
            let spec = &rest[..end];
            if let Some(absolute) = spec.strip_prefix("/assets/") {
                found.push(absolute.to_string());
            } else if spec.starts_with("./") || spec.starts_with("../") {
                let mut parts: Vec<&str> = base.trim_end_matches('/').split('/').filter(|p| !p.is_empty()).collect();
                for piece in spec.split('/') {
                    match piece {
                        "." => {}
                        ".." => {
                            parts.pop();
                        }
                        other => parts.push(other),
                    }
                }
                found.push(parts.join("/"));
            }
        }
    }
    found
}

/// Preload a page's whole static module graph at once, instead of discovering it one import at a time.
fn page(source: &Path, entry: &str, modules: &[(String, String)], version: &str) -> String {
    let html = fs::read_to_string(source).expect("readable page");
    let mut seen = BTreeSet::new();
    let mut queue = vec![entry.to_string()];
    while let Some(next) = queue.pop() {
        if !seen.insert(next.clone()) {
            continue;
        }
        if let Some((_, body)) = modules.iter().find(|(name, _)| *name == next) {
            queue.extend(imports(&next, body));
        }
    }
    let links: String = seen
        .iter()
        .filter(|name| *name != entry && modules.iter().any(|(m, _)| m == *name))
        .map(|name| format!("<link rel=\"modulepreload\" href=\"/assets/{name}\">"))
        .collect();
    versioned(&html.replacen("</head>", &format!("{links}</head>"), 1), version)
}

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let app = manifest.join("../web/src");
    let ui = manifest.join("../../packages/web-ui/src");
    let mut assets = Vec::new();
    collect(&app, "app/", &mut assets);
    collect(&ui, "ui/", &mut assets);
    let cli = manifest.join("../../packages/cli/spekios.mjs");
    assets.push(("cli/spekios.mjs".into(), cli.clone()));
    let out = PathBuf::from(env::var("OUT_DIR").expect("build output directory"));
    let bodies: Vec<(String, String)> = assets
        .iter()
        .map(|(path, file)| (path.clone(), fs::read_to_string(file).expect("readable asset")))
        .collect();
    let pages = ["index.html", "connect.html", "issues.html"].map(|name| manifest.join("../web").join(name));
    let fonts = app.join("fonts");
    let mut hasher = DefaultHasher::new();
    for (path, body) in &bodies {
        (path, body).hash(&mut hasher);
    }
    for file in pages.iter().cloned().chain(fs::read_dir(&fonts).expect("fonts").map(|e| e.expect("font").path())) {
        fs::read(&file).expect("readable page or font").hash(&mut hasher);
    }
    let version = format!("v{:012x}", hasher.finish() & 0xffff_ffff_ffff);
    let staged = out.join("web");
    let mut code = format!(
        "/// Generated by build.rs: the segment that versions every asset URL of this build.\npub static ASSET_VERSION: &str = {version:?};\n/// (served path below /assets/, content type, embedded body).\npub static ASSETS: &[(&str, &str, &str)] = &[\n",
    );
    for (path, body) in &bodies {
        let content_type = if path.ends_with(".css") {
            "text/css; charset=utf-8"
        } else {
            "text/javascript; charset=utf-8"
        };
        let file = staged.join(path);
        fs::create_dir_all(file.parent().unwrap()).expect("stage asset directory");
        fs::write(&file, versioned(body, &version)).expect("stage asset");
        code.push_str(&format!(
            "    ({path:?}, {content_type:?}, include_str!({:?})),\n",
            file.display().to_string()
        ));
    }
    code.push_str("];\n");
    fs::write(out.join("web_assets.rs"), code).expect("write embedded asset table");
    for (source, entry) in pages.iter().zip(["app/main.js", "app/connect.js", "app/issues.js"]) {
        fs::write(staged.join(source.file_name().unwrap()), page(source, entry, &bodies, &version)).expect("stage page");
    }
    println!("cargo:rerun-if-changed={}", manifest.join("../web/index.html").display());
    println!("cargo:rerun-if-changed={}", manifest.join("../web/connect.html").display());
    println!("cargo:rerun-if-changed={}", manifest.join("../web/issues.html").display());
    // Serve an installable package without requiring Node/npm on the build host.
    // Only this fixed file list enters the archive; profiles and tests stay out.
    let package_root = out.join("cli-package");
    let package = package_root.join("package");
    if package_root.exists() {
        fs::remove_dir_all(&package_root).expect("clear CLI package staging directory");
    }
    fs::create_dir_all(&package).expect("create CLI package staging directory");
    for name in ["package.json", "README.md", "spekios.mjs"] {
        let source = cli.parent().unwrap().join(name);
        fs::copy(&source, package.join(name)).expect("stage CLI package file");
        println!("cargo:rerun-if-changed={}", source.display());
    }
    let status = Command::new("tar")
        .env("COPYFILE_DISABLE", "1")
        .arg("-czf")
        .arg(out.join("spekios-cli.tgz"))
        .arg("-C")
        .arg(&package_root)
        .arg("package")
        .status()
        .expect("tar is required to build the hosted CLI package");
    assert!(status.success(), "create hosted CLI package");
    println!("cargo:rerun-if-changed={}", app.display());
    println!("cargo:rerun-if-changed={}", ui.display());
    println!("cargo:rerun-if-changed={}", cli.display());
}
