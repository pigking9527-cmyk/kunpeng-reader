use anyhow::{Result, bail};
use reader_sync_api::config::Config;

/// Validates deployment configuration without opening `PostgreSQL` or binding a socket.
fn main() -> Result<()> {
    let mut args = std::env::args_os();
    let _program = args.next();
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--offline")) || args.next().is_some() {
        bail!("usage: config_check --offline");
    }

    let _config = Config::from_env()?;
    println!(
        "Offline deployment configuration check passed; no database connection or listener started."
    );
    Ok(())
}
