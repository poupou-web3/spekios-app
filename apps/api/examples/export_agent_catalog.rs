//! Export the shared, pure MCP/HTTP tool catalog without starting services.
fn main() {
    let catalog = serde_json::json!({
        "interface_version": 1,
        "tools": scout_api::agent::tools(),
    });
    println!("{}", serde_json::to_string_pretty(&catalog).unwrap());
}
