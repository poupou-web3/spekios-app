use scout_api::{AppState, router};
use std::{env, net::SocketAddr, sync::Arc, time::Duration};
use tokio_postgres::NoTls;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if env::args().nth(1).as_deref() == Some("--healthcheck") {
        use std::io::{Read, Write};
        let address: SocketAddr = env::var("SCOUT_API_BIND")
            .unwrap_or_else(|_| "127.0.0.1:18080".into())
            .parse()?;
        let loopback = SocketAddr::from(([127, 0, 0, 1], address.port()));
        let mut stream = std::net::TcpStream::connect_timeout(&loopback, Duration::from_secs(2))?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        stream
            .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
        let mut buffer = [0; 128];
        let count = stream.read(&mut buffer)?;
        if !buffer[..count].starts_with(b"HTTP/1.1 200 ") {
            return Err("Liveness check failed".into());
        }
        return Ok(());
    }
    let token = env::var("SCOUT_API_TOKEN").map_err(|_| "SCOUT_API_TOKEN is required")?;
    let mut state = AppState::new(None, &token)?
        .with_dev_auth_bypass(env::var("SCOUT_DEV_AUTH_BYPASS").as_deref() == Ok("true"))
        .with_public_origin(env::var("SCOUT_PUBLIC_ORIGIN").ok().as_deref())?;
    if let Ok(host) = env::var("PGHOST") {
        let mut config = tokio_postgres::Config::new();
        config
            .host(&host)
            .user("scout")
            .dbname("scout")
            .password(
                env::var("POSTGRES_PASSWORD")
                    .map_err(|_| "POSTGRES_PASSWORD is required with PGHOST")?,
            )
            .connect_timeout(Duration::from_secs(5))
            .options("-c statement_timeout=5000 -c default_transaction_read_only=on");
        let (client, connection) = config
            .connect(NoTls)
            .await
            .map_err(|_| "Database connection failed")?;
        tokio::spawn(async move {
            if connection.await.is_err() {
                eprintln!("database_connection_closed");
                std::process::exit(1);
            }
        });
        state.database = Some(Arc::new(client));
        config.options("-c statement_timeout=10000");
        let (writer, connection) = config
            .connect(NoTls)
            .await
            .map_err(|_| "Gateway database connection failed")?;
        tokio::spawn(async move {
            if connection.await.is_err() {
                eprintln!("gateway_database_connection_closed");
                std::process::exit(1);
            }
        });
        let gateway = scout_api::gateway::Gateway::from_env(writer)?;
        gateway.start();
        state.gateway = Some(gateway);
        let (jobs, connection) = config
            .connect(NoTls)
            .await
            .map_err(|_| "Job database connection failed")?;
        tokio::spawn(async move {
            if connection.await.is_err() {
                eprintln!("job_database_connection_closed");
                std::process::exit(1);
            }
        });
        state.jobs = Some(scout_api::jobs::Queue::from_env(jobs));
        let (reviews, connection) = config
            .connect(NoTls)
            .await
            .map_err(|_| "Review database connection failed")?;
        tokio::spawn(async move {
            if connection.await.is_err() {
                eprintln!("review_database_connection_closed");
                std::process::exit(1);
            }
        });
        state.reviews = Some(scout_api::reviews::Reviews::new(reviews));
        let (identity, connection) = config
            .connect(NoTls)
            .await
            .map_err(|_| "Identity database connection failed")?;
        tokio::spawn(async move {
            if connection.await.is_err() {
                eprintln!("identity_database_connection_closed");
                std::process::exit(1);
            }
        });
        state.identities = Some(scout_api::identity::Identities::new(identity));
    }
    let address: SocketAddr = env::var("SCOUT_API_BIND")
        .unwrap_or_else(|_| "127.0.0.1:18080".into())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    eprintln!("scout-api listening on {address}");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("signal handler");
            tokio::select! { _=tokio::signal::ctrl_c()=>{}, _=term.recv()=>{} }
        })
        .await?;
    Ok(())
}
