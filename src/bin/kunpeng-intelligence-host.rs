//! Local control plane for the independent intelligence workstation.
//!
//! This binary intentionally owns no reader window. It starts only when the
//! operator launches it, stores no server credential, and can expose a
//! loopback-only local dashboard for the processing machine. The reader
//! remains a client of published content.

#[path = "../intelligence_worker/archive.rs"]
mod archive;
#[path = "../atomic_file.rs"]
mod atomic_file;
#[path = "../intelligence_host/mod.rs"]
mod intelligence_host;
#[path = "../intelligence_worker_lifecycle.rs"]
mod intelligence_worker_lifecycle;
#[path = "../profile.rs"]
mod profile;
#[path = "../secret_store.rs"]
mod secret_store;

fn main() {
    if profile::preflight_process_args()
        .and_then(|()| profile::initialize_from_process_args())
        .is_err()
    {
        eprintln!("本机情报工作台启动配置无效");
        std::process::exit(2);
    }
    std::process::exit(intelligence_host::run(std::env::args_os()));
}
