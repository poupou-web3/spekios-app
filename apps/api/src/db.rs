//! Bounded PostgreSQL pools for one API process.
//!
//! Kubernetes runs several of these processes behind one Service. Each process
//! checks connections out of a read pool and a write pool, so token checks,
//! job admission, reviews and report reads proceed concurrently. A closed
//! connection is discarded and replaced. It does not terminate the process.
//!
//! The read pool uses `default_transaction_read_only`. Writers share one pool.
//! The model-gateway leader holds one extra connection outside either pool so
//! its session advisory lock cannot be recycled or handed to another request.
//!
//! `PGSSLMODE=disable` matches local Compose. A public deployment should set
//! `verify-full` (or `verify-ca` when the certificate name does not match the
//! host) and `PGSSLROOTCERT`. `require` encrypts without authenticating the
//! server. `allow` and `prefer` are rejected so a replica cannot silently fall
//! back to plaintext.
use std::{env, fs::File, io::BufReader, sync::Arc, time::Duration};

use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod, Runtime};
use rustls::{
    ClientConfig, RootCertStore, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::CryptoProvider,
    pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime},
};
use tokio_postgres::{NoTls, Socket, tls::MakeTlsConnect};

pub type Conn = deadpool_postgres::Object;

const DEFAULT_POOL: usize = 8;
const MAX_POOL: usize = 64;

enum Transport {
    Plain,
    Tls(tokio_postgres_rustls::MakeRustlsConnect),
}

pub struct Postgres {
    read: Pool,
    write: Pool,
    transport: Transport,
    write_config: tokio_postgres::Config,
}

/// A connection the caller owns until drop. Dropping it closes the session,
/// which releases any session advisory lock held on it.
pub struct Dedicated {
    client: tokio_postgres::Client,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Dedicated {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl std::ops::Deref for Dedicated {
    type Target = tokio_postgres::Client;
    fn deref(&self) -> &Self::Target {
        &self.client
    }
}

impl std::ops::DerefMut for Dedicated {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.client
    }
}

impl Postgres {
    pub async fn connect() -> Result<Self, &'static str> {
        let mode = ssl_mode()?;
        let transport = transport(mode)?;
        let mut config = base_config(mode)?;
        let read_size = pool_size("SCOUT_DB_READ_POOL_MAX")?;
        let write_size = pool_size("SCOUT_DB_WRITE_POOL_MAX")?;
        config.application_name("scout-api/read");
        config.options(
            "-c statement_timeout=5000 -c idle_in_transaction_session_timeout=10000 -c default_transaction_read_only=on",
        );
        let read = build_pool(config.clone(), &transport, read_size)?;
        config.application_name("scout-api/write");
        config.options("-c statement_timeout=10000 -c idle_in_transaction_session_timeout=15000");
        let write = build_pool(config.clone(), &transport, write_size)?;
        let database = Self {
            read,
            write,
            transport,
            write_config: config,
        };
        database
            .read()
            .await?
            .query_one("SELECT 1", &[])
            .await
            .map_err(|error| {
                eprintln!("database_connection_failed: {error}");
                "database_connection_failed"
            })?;
        database
            .write()
            .await?
            .query_one("SELECT 1", &[])
            .await
            .map_err(|error| {
                eprintln!("database_connection_failed: {error}");
                "database_connection_failed"
            })?;
        eprintln!(
            "database_pool tls={} read_pool={read_size} write_pool={write_size}",
            mode.label()
        );
        if mode == Ssl::Disable
            && env::var("SCOUT_PUBLIC_ORIGIN")
                .ok()
                .is_some_and(|value| !value.is_empty())
        {
            eprintln!(
                "database_tls=disable while SCOUT_PUBLIC_ORIGIN is set; set PGSSLMODE=verify-full and PGSSLROOTCERT before publishing this API"
            );
        }
        Ok(database)
    }

    pub async fn read(&self) -> Result<Conn, &'static str> {
        checkout(&self.read).await
    }

    pub async fn write(&self) -> Result<Conn, &'static str> {
        checkout(&self.write).await
    }

    pub async fn dedicated(&self) -> Result<Dedicated, &'static str> {
        let mut config = self.write_config.clone();
        config.application_name("scout-api/leader");
        match &self.transport {
            Transport::Plain => open_dedicated(&config, NoTls).await,
            Transport::Tls(tls) => open_dedicated(&config, tls.clone()).await,
        }
    }
}

async fn checkout(pool: &Pool) -> Result<Conn, &'static str> {
    pool.get().await.map_err(|error| {
        eprintln!("database_checkout_failed: {error}");
        "database_unavailable"
    })
}

async fn open_dedicated<T>(
    config: &tokio_postgres::Config,
    tls: T,
) -> Result<Dedicated, &'static str>
where
    T: MakeTlsConnect<Socket> + Clone + Sync + Send + 'static,
    T::Stream: Sync + Send,
    T::TlsConnect: Sync + Send,
    <T::TlsConnect as tokio_postgres::tls::TlsConnect<Socket>>::Future: Send,
{
    let (client, connection) = config.connect(tls).await.map_err(|error| {
        eprintln!("database_connection_failed: {error}");
        "database_connection_failed"
    })?;
    let task = tokio::spawn(async move {
        if let Err(error) = connection.await {
            eprintln!("database_connection_closed: {error}");
        }
    });
    Ok(Dedicated { client, task })
}

fn build_pool(
    config: tokio_postgres::Config,
    transport: &Transport,
    size: usize,
) -> Result<Pool, &'static str> {
    let manager_config = ManagerConfig {
        recycling_method: RecyclingMethod::Verified,
    };
    let manager = match transport {
        Transport::Plain => Manager::from_config(config, NoTls, manager_config),
        Transport::Tls(tls) => Manager::from_config(config, tls.clone(), manager_config),
    };
    Pool::builder(manager)
        .max_size(size)
        .wait_timeout(Some(Duration::from_secs(2)))
        .create_timeout(Some(Duration::from_secs(5)))
        .recycle_timeout(Some(Duration::from_secs(2)))
        .runtime(Runtime::Tokio1)
        .build()
        .map_err(|error| {
            eprintln!("database_pool_configuration_invalid: {error}");
            "database_pool_configuration_invalid"
        })
}

fn base_config(mode: Ssl) -> Result<tokio_postgres::Config, &'static str> {
    let host = env::var("PGHOST").map_err(|_| "PGHOST is required")?;
    if host.is_empty() || host.len() > 253 || host.bytes().any(|b| b.is_ascii_whitespace()) {
        return Err("invalid_database_host");
    }
    let password =
        env::var("POSTGRES_PASSWORD").map_err(|_| "POSTGRES_PASSWORD is required with PGHOST")?;
    if password.is_empty() {
        return Err("POSTGRES_PASSWORD is required with PGHOST");
    }
    let mut config = tokio_postgres::Config::new();
    config
        .host(&host)
        .port(port()?)
        .user(&setting("PGUSER", "scout")?)
        .dbname(&setting("PGDATABASE", "scout")?)
        .password(password)
        .connect_timeout(Duration::from_secs(5))
        .keepalives(true)
        .keepalives_idle(Duration::from_secs(30))
        .ssl_mode(match mode {
            Ssl::Disable => tokio_postgres::config::SslMode::Disable,
            _ => tokio_postgres::config::SslMode::Require,
        });
    Ok(config)
}

fn port() -> Result<u16, &'static str> {
    match env::var("PGPORT") {
        Err(_) => Ok(5432),
        Ok(raw) if raw.is_empty() => Ok(5432),
        Ok(raw) => {
            let port = raw.parse::<u16>().map_err(|_| "invalid_database_port")?;
            if port == 0 {
                return Err("invalid_database_port");
            }
            Ok(port)
        }
    }
}

fn setting(name: &str, default: &str) -> Result<String, &'static str> {
    let value = env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_owned());
    if value.len() > 63 || value.bytes().any(|b| b.is_ascii_whitespace() || b == 0) {
        return Err("invalid_database_name");
    }
    Ok(value)
}

fn pool_size(specific: &str) -> Result<usize, &'static str> {
    let specific = env::var(specific).ok().filter(|value| !value.is_empty());
    let shared = env::var("SCOUT_DB_POOL_MAX")
        .ok()
        .filter(|value| !value.is_empty());
    match specific.or(shared) {
        Some(raw) => parse_pool_size(&raw),
        None => Ok(DEFAULT_POOL),
    }
}

fn parse_pool_size(raw: &str) -> Result<usize, &'static str> {
    let size = raw
        .parse::<usize>()
        .map_err(|_| "invalid_database_pool_size")?;
    if (1..=MAX_POOL).contains(&size) {
        Ok(size)
    } else {
        Err("invalid_database_pool_size")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Ssl {
    Disable,
    Require,
    VerifyCa,
    VerifyFull,
}

impl Ssl {
    fn label(self) -> &'static str {
        match self {
            Self::Disable => "disable",
            Self::Require => "require",
            Self::VerifyCa => "verify-ca",
            Self::VerifyFull => "verify-full",
        }
    }
}

fn ssl_mode() -> Result<Ssl, &'static str> {
    match env::var("PGSSLMODE") {
        Err(_) => Ok(Ssl::Disable),
        Ok(raw) if raw.is_empty() => Ok(Ssl::Disable),
        Ok(raw) => parse_ssl_mode(&raw),
    }
}

fn parse_ssl_mode(raw: &str) -> Result<Ssl, &'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "disable" => Ok(Ssl::Disable),
        "require" => Ok(Ssl::Require),
        "verify-ca" => Ok(Ssl::VerifyCa),
        "verify-full" => Ok(Ssl::VerifyFull),
        "allow" | "prefer" => {
            Err("PGSSLMODE allow and prefer are not supported; choose disable or verify-full")
        }
        _ => Err("invalid_pgsslmode"),
    }
}

fn transport(mode: Ssl) -> Result<Transport, &'static str> {
    if mode == Ssl::Disable {
        return Ok(Transport::Plain);
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let _ = CryptoProvider::install_default(provider.as_ref().clone());
    let roots = trust_roots()?;
    let algorithms = provider.signature_verification_algorithms;
    let signatures = rustls::client::WebPkiServerVerifier::builder_with_provider(
        roots.clone(),
        provider.clone(),
    )
    .build()
    .map_err(|_| "database_tls_configuration_invalid")?;
    let config = match mode {
        Ssl::Disable => unreachable!(),
        Ssl::Require => finish_auth(
            ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .map_err(|_| "database_tls_configuration_invalid")?
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(EncryptOnly { signatures })),
        )?,
        Ssl::VerifyCa => finish_auth(
            ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .map_err(|_| "database_tls_configuration_invalid")?
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(CaOnly {
                    roots,
                    algorithms,
                    signatures,
                })),
        )?,
        Ssl::VerifyFull => finish_auth(
            ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .map_err(|_| "database_tls_configuration_invalid")?
                .with_root_certificates(roots.as_ref().clone()),
        )?,
    };
    Ok(Transport::Tls(
        tokio_postgres_rustls::MakeRustlsConnect::new(config),
    ))
}

fn finish_auth(
    builder: rustls::ConfigBuilder<ClientConfig, rustls::client::WantsClientCert>,
) -> Result<ClientConfig, &'static str> {
    let cert = env::var("PGSSLCERT").ok().filter(|value| !value.is_empty());
    let key = env::var("PGSSLKEY").ok().filter(|value| !value.is_empty());
    match (cert, key) {
        (None, None) => Ok(builder.with_no_client_auth()),
        (Some(cert), Some(key)) => builder
            .with_client_auth_cert(load_certs(&cert)?, load_key(&key)?)
            .map_err(|_| "invalid_database_client_certificate"),
        _ => Err("PGSSLCERT and PGSSLKEY must be set together"),
    }
}

fn trust_roots() -> Result<Arc<RootCertStore>, &'static str> {
    let mut roots = RootCertStore::empty();
    if let Some(path) = env::var("PGSSLROOTCERT")
        .ok()
        .filter(|value| !value.is_empty())
    {
        let file = File::open(&path).map_err(|_| "PGSSLROOTCERT could not be read")?;
        let mut reader = BufReader::new(file);
        let mut count = 0;
        for cert in rustls_pemfile::certs(&mut reader) {
            roots
                .add(cert.map_err(|_| "PGSSLROOTCERT is not valid PEM")?)
                .map_err(|_| "PGSSLROOTCERT could not be added")?;
            count += 1;
        }
        if count == 0 {
            return Err("PGSSLROOTCERT contained no certificates");
        }
    } else {
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    }
    if roots.is_empty() {
        return Err("database_tls_configuration_invalid");
    }
    Ok(Arc::new(roots))
}

fn load_certs(path: &str) -> Result<Vec<CertificateDer<'static>>, &'static str> {
    let file = File::open(path).map_err(|_| "PGSSLCERT could not be read")?;
    let mut reader = BufReader::new(file);
    let mut certs = Vec::new();
    for cert in rustls_pemfile::certs(&mut reader) {
        certs.push(cert.map_err(|_| "PGSSLCERT is not valid PEM")?);
    }
    if certs.is_empty() {
        return Err("PGSSLCERT contained no certificates");
    }
    Ok(certs)
}

fn load_key(path: &str) -> Result<PrivateKeyDer<'static>, &'static str> {
    let file = File::open(path).map_err(|_| "PGSSLKEY could not be read")?;
    let mut reader = BufReader::new(file);
    rustls_pemfile::private_key(&mut reader)
        .map_err(|_| "PGSSLKEY is not valid PEM")?
        .ok_or("PGSSLKEY contained no private key")
}

#[derive(Debug)]
struct EncryptOnly {
    signatures: Arc<rustls::client::WebPkiServerVerifier>,
}

impl ServerCertVerifier for EncryptOnly {
    fn verify_server_cert(
        &self,
        _: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.signatures.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.signatures.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.signatures.supported_verify_schemes()
    }
}

#[derive(Debug)]
struct CaOnly {
    roots: Arc<RootCertStore>,
    algorithms: rustls::crypto::WebPkiSupportedAlgorithms,
    signatures: Arc<rustls::client::WebPkiServerVerifier>,
}

impl ServerCertVerifier for CaOnly {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let cert = rustls::server::ParsedCertificate::try_from(end_entity)?;
        rustls::client::verify_server_cert_signed_by_trust_anchor(
            &cert,
            &self.roots,
            intermediates,
            now,
            self.algorithms.all,
        )?;
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.signatures.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.signatures.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.signatures.supported_verify_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssl_modes_match_libpq_names_and_reject_downgrade() {
        assert_eq!(parse_ssl_mode("disable").unwrap(), Ssl::Disable);
        assert_eq!(parse_ssl_mode("VERIFY-FULL").unwrap(), Ssl::VerifyFull);
        assert_eq!(parse_ssl_mode("verify-ca").unwrap(), Ssl::VerifyCa);
        assert_eq!(parse_ssl_mode("require").unwrap(), Ssl::Require);
        assert!(parse_ssl_mode("prefer").is_err());
        assert!(parse_ssl_mode("allow").is_err());
        assert!(parse_ssl_mode("").is_err());
    }

    #[test]
    fn pool_size_stays_inside_one_process_budget() {
        assert_eq!(parse_pool_size("1").unwrap(), 1);
        assert_eq!(parse_pool_size("64").unwrap(), 64);
        assert!(parse_pool_size("0").is_err());
        assert!(parse_pool_size("65").is_err());
        assert!(parse_pool_size("eight").is_err());
    }
}
