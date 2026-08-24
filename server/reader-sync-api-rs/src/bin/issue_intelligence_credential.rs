//! Issues one short-lived intelligence capability without echoing its secret.
//!
//! This is an operator-only utility.  It deliberately writes the generated
//! bearer value to a newly created private file and stores only its
//! domain-separated digest in `PostgreSQL`.

use std::{
    env,
    fs::{File, OpenOptions},
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use reader_sync_api::{
    config::Config,
    credentials::{intelligence_publisher_token_digest, new_session_token},
};
use secrecy::ExposeSecret;
use sqlx::{PgPool, postgres::PgPoolOptions};

#[derive(Debug)]
struct Args {
    installation_id: String,
    capability: String,
    expires_in_days: i64,
    token_file: PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = parse_args(env::args().skip(1))?;
    let config = Config::from_env()?;
    let token = new_session_token().context("generate capability credential")?;
    let digest = intelligence_publisher_token_digest(&config.token_hmac_key, &token)
        .context("hash capability credential")?;
    let mut token_file = create_private_file(&args.token_file)?;
    token_file
        .write_all(token.expose_secret().as_bytes())
        .context("write capability credential")?;
    token_file
        .write_all(b"\n")
        .context("terminate capability credential")?;
    token_file
        .sync_all()
        .context("flush capability credential")?;
    drop(token_file);

    let now = now_ms()?;
    let expires_at = now
        .checked_add(
            args.expires_in_days
                .checked_mul(86_400_000)
                .context("credential lifetime overflow")?,
        )
        .context("credential expiry overflow")?;
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(config.database_url.expose_secret())
        .await
        .context("connect credential database")?;
    if let Err(error) = insert_credential(&pool, &digest, &args, now, expires_at).await {
        let _ = std::fs::remove_file(&args.token_file);
        return Err(error);
    }
    println!("intelligence capability credential issued to a private file");
    Ok(())
}

async fn insert_credential(
    pool: &PgPool,
    digest: &[u8; 32],
    args: &Args,
    now: i64,
    expires_at: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO intelligence_publisher_credentials_v1 \
         (token_digest,installation_id,capabilities,expires_at,created_at) \
         VALUES ($1,$2,ARRAY[$3]::text[],$4,$5)",
    )
    .bind(digest.as_slice())
    .bind(&args.installation_id)
    .bind(&args.capability)
    .bind(expires_at)
    .bind(now)
    .execute(pool)
    .await
    .context("store capability credential digest")?;
    Ok(())
}

fn parse_args(mut values: impl Iterator<Item = String>) -> Result<Args> {
    let installation_id = next_value(&mut values, "--installation-id")?;
    let capability = next_value(&mut values, "--capability")?;
    let expires_in_days = next_value(&mut values, "--expires-in-days")?
        .parse::<i64>()
        .context("--expires-in-days must be an integer")?;
    let token_file = PathBuf::from(next_value(&mut values, "--token-file")?);
    if values.next().is_some() {
        bail!(
            "usage: issue_intelligence_credential --installation-id <id> --capability <intelligence:publish|intelligence:relay> --expires-in-days <1..=30> --token-file <absolute-new-file>"
        );
    }
    if installation_id.trim().is_empty() || installation_id.len() > 256 {
        bail!("--installation-id must contain 1 to 256 characters");
    }
    if !matches!(
        capability.as_str(),
        "intelligence:publish" | "intelligence:relay"
    ) {
        bail!("--capability must be intelligence:publish or intelligence:relay");
    }
    if !(1..=30).contains(&expires_in_days) {
        bail!("--expires-in-days must be between 1 and 30");
    }
    if !token_file.is_absolute() {
        bail!("--token-file must be absolute");
    }
    Ok(Args {
        installation_id,
        capability,
        expires_in_days,
        token_file,
    })
}

fn next_value(values: &mut impl Iterator<Item = String>, name: &str) -> Result<String> {
    if values.next().as_deref() != Some(name) {
        bail!(
            "usage: issue_intelligence_credential --installation-id <id> --capability <intelligence:publish|intelligence:relay> --expires-in-days <1..=30> --token-file <absolute-new-file>"
        );
    }
    values
        .next()
        .filter(|value| !value.is_empty())
        .with_context(|| format!("{name} requires a value"))
}

fn create_private_file(path: &PathBuf) -> Result<File> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("create new capability file at {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = file
            .metadata()
            .context("read capability file metadata")?
            .permissions();
        permissions.set_mode(0o600);
        file.set_permissions(permissions)
            .context("restrict capability file permissions")?;
    }
    Ok(file)
}

fn now_ms() -> Result<i64> {
    Ok(i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("system clock before Unix epoch")?
            .as_millis(),
    )?)
}

#[cfg(test)]
mod tests {
    use super::parse_args;

    #[test]
    fn accepts_only_short_lived_scoped_credentials() {
        let token_file = if cfg!(windows) {
            r"C:\\private\\token"
        } else {
            "/private/token"
        };
        let parsed = parse_args(
            [
                "--installation-id",
                "local-worker",
                "--capability",
                "intelligence:publish",
                "--expires-in-days",
                "7",
                "--token-file",
                token_file,
            ]
            .into_iter()
            .map(str::to_owned),
        )
        .expect("valid operator arguments");
        assert_eq!(parsed.capability, "intelligence:publish");
        assert_eq!(parsed.expires_in_days, 7);
    }

    #[test]
    fn refuses_wide_lifetime_or_unknown_capability() {
        let token_file = if cfg!(windows) {
            r"C:\\private\\token"
        } else {
            "/private/token"
        };
        let invalid = parse_args(
            [
                "--installation-id",
                "local-worker",
                "--capability",
                "all",
                "--expires-in-days",
                "31",
                "--token-file",
                token_file,
            ]
            .into_iter()
            .map(str::to_owned),
        );
        assert!(invalid.is_err());
    }
}
