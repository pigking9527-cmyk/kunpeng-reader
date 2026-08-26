#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "console"
)]

#[path = "../intelligence_worker/archive.rs"]
mod archive;
#[path = "../atomic_file.rs"]
mod atomic_file;
// Relay task execution is covered by its isolated state-machine tests. The
// production worker does not claim private host tasks until a transport is
// explicitly wired, so it must not make dormant crypto APIs appear live.
#[cfg(test)]
#[path = "../host_inference_crypto.rs"]
mod host_inference_crypto;
#[path = "../intelligence_worker/mod.rs"]
mod intelligence_worker;
#[path = "../intelligence_worker_lifecycle.rs"]
// This sidecar uses only the service-loop credential reader. Pairing, status
// and desktop-launch helpers belong to the reader/dashboard binary.
#[allow(dead_code)]
mod intelligence_worker_lifecycle;
#[path = "../profile.rs"]
// The worker needs profile parsing and archive paths; desktop-only helpers
// remain reachable in the main reader process.
#[allow(dead_code)]
mod profile;
#[path = "../ai_reader/provider.rs"]
// The worker uses the synchronous loopback model request only. Async reader
// provider APIs are intentionally not pulled into its no-UI loop.
#[allow(dead_code)]
mod provider;
#[path = "../secret_store.rs"]
// The worker reads its paired DPAPI record, while sync/media secret APIs are
// owned by the reader process.
#[allow(dead_code)]
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
