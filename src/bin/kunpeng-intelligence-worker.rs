#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "console"
)]

#[path = "../intelligence_worker/archive.rs"]
mod archive;
#[path = "../atomic_file.rs"]
mod atomic_file;
#[path = "../host_inference_crypto.rs"]
mod host_inference_crypto;
#[path = "../intelligence_worker/mod.rs"]
mod intelligence_worker;
#[path = "../intelligence_worker_lifecycle.rs"]
mod intelligence_worker_lifecycle;
#[path = "../profile.rs"]
mod profile;
#[path = "../ai_reader/provider.rs"]
mod provider;
#[path = "../secret_store.rs"]
mod secret_store;

fn main() {
    if profile::preflight_process_args()
        .and_then(|()| profile::initialize_from_process_args())
        .is_err()
    {
        // Startup parsing can include a local filesystem argument. Keep the
        // worker's machine-readable output redacted even on invalid profiles.
        println!("{{\"kind\":\"kunpeng-intelligence-worker\",\"mode\":\"invalid\",\"outcome\":\"invalid_profile\",\"configured\":false,\"archivePresent\":false,\"queued\":0,\"processing\":0,\"claimed\":0,\"triaged\":0,\"retried\":0,\"remaining\":0}}");
        std::process::exit(2);
    }
    std::process::exit(intelligence_worker::run(std::env::args_os()));
}
