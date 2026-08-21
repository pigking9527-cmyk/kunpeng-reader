use anyhow::Result;
use reader_sync_api::{config::Config, init_tracing, serve};

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing()?;
    serve(Config::from_env()?).await
}
