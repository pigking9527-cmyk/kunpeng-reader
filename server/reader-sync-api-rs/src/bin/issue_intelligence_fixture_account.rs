//! Creates one disposable, verified intelligence integration account.
//!
//! This operator-only utility generates a unique username and password in
//! process, writes them only to a newly created private file, and persists a
//! verified, feed-enabled account. It never prints the account secret.

use std::{
    env,
    fs::{File, OpenOptions},
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use reader_sync_api::{
    account_validation::{normalize_username, valid_new_password},
    config::Config,
    credentials::{hash_password, new_session_token},
};
use secrecy::{ExposeSecret, SecretString};
use sqlx::{PgPool, postgres::PgPoolOptions};
use uuid::Uuid;

#[derive(Debug)]
struct Args {
    account_file: PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = parse_args(env::args().skip(1))?;
    let account_id = format!("intelligence-fixture-{}", Uuid::new_v4());
    let username = fixture_username()?;
    let password = fixture_password()?;
    let password_hash = hash_password(&password).context("hash fixture account password")?;
    let (_, username_key) = normalize_username(&username)
        .map_err(|_| anyhow::anyhow!("generated fixture username violates account policy"))?;
    let now = now_ms()?;

    let mut account_file = create_private_file(&args.account_file)?;
    write_account_file(&mut account_file, &account_id, &username, &password)?;
    account_file
        .sync_all()
        .context("flush fixture account file")?;
    drop(account_file);

    let config = Config::from_env()?;
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(config.database_url.expose_secret())
        .await
        .context("connect fixture account database")?;
    if let Err(error) = insert_account(
        &pool,
        &account_id,
        &username,
        &username_key,
        &password_hash,
        now,
    )
    .await
    {
        let _ = std::fs::remove_file(&args.account_file);
        return Err(error);
    }
    println!("synthetic intelligence fixture account issued to a private file");
    Ok(())
}

async fn insert_account(
    pool: &PgPool,
    account_id: &str,
    username: &str,
    username_key: &str,
    password_hash: &str,
    now: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO users \\
         (id,username,password_hash,created_at,sync_verified_at,username_key,intelligence_feed_enabled) \\
         VALUES ($1,$2,$3,$4,$4,$5,true)",
    )
    .bind(account_id)
    .bind(username)
    .bind(password_hash)
    .bind(now)
    .bind(username_key)
    .execute(pool)
    .await
    .context("store synthetic fixture account")?;
    Ok(())
}

fn fixture_username() -> Result<String> {
    let generated = Uuid::new_v4().simple().to_string();
    let username = format!("it-{}", &generated[..20]);
    normalize_username(&username)
        .map_err(|_| anyhow::anyhow!("generated fixture username violates account policy"))?;
    Ok(username)
}

fn fixture_password() -> Result<SecretString> {
    let token = new_session_token().context("generate fixture password")?;
    let password = SecretString::from(token.expose_secret()[..24].to_owned());
    if !valid_new_password(password.expose_secret()) {
        bail!("generated fixture password violates account policy");
    }
    Ok(password)
}

fn write_account_file(
    file: &mut File,
    account_id: &str,
    username: &str,
    password: &SecretString,
) -> Result<()> {
    writeln!(file, "account_id={account_id}").context("write fixture account id")?;
    writeln!(file, "username={username}").context("write fixture username")?;
    writeln!(file, "password={}", password.expose_secret()).context("write fixture password")?;
    Ok(())
}

fn parse_args(mut values: impl Iterator<Item = String>) -> Result<Args> {
    let account_file = PathBuf::from(next_value(&mut values, "--account-file")?);
    if values.next().is_some() {
        bail!("usage: issue_intelligence_fixture_account --account-file <absolute-new-file>");
    }
    if !account_file.is_absolute() {
        bail!("--account-file must be absolute");
    }
    Ok(Args { account_file })
}

fn next_value(values: &mut impl Iterator<Item = String>, name: &str) -> Result<String> {
    if values.next().as_deref() != Some(name) {
        bail!("usage: issue_intelligence_fixture_account --account-file <absolute-new-file>");
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
        .with_context(|| format!("create new fixture account file at {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = file
            .metadata()
            .context("read fixture account file metadata")?
            .permissions();
        permissions.set_mode(0o600);
        file.set_permissions(permissions)
            .context("restrict fixture account file permissions")?;
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
    use super::{fixture_password, fixture_username, parse_args};
    use reader_sync_api::account_validation::{normalize_username, valid_new_password};
    use secrecy::ExposeSecret;

    #[test]
    fn accepts_only_one_absolute_private_output_file() {
        let account_file = if cfg!(windows) {
            r"C:\\private\\fixture-account"
        } else {
            "/private/fixture-account"
        };
        let parsed = parse_args(
            ["--account-file", account_file]
                .into_iter()
                .map(str::to_owned),
        )
        .expect("valid operator arguments");
        assert!(parsed.account_file.is_absolute());
        assert!(
            parse_args(
                ["--account-file", "relative"]
                    .into_iter()
                    .map(str::to_owned)
            )
            .is_err()
        );
    }

    #[test]
    fn generated_account_identity_obeys_public_registration_rules() {
        let username = fixture_username().expect("fixture username");
        assert!(normalize_username(&username).is_ok());
        let password = fixture_password().expect("fixture password");
        assert!(valid_new_password(password.expose_secret()));
        assert_eq!(password.expose_secret().chars().count(), 24);
    }
}
