use std::{
    hash::{Hash, Hasher},
    path::Path,
};

fn watch_tree(root: &Path, hasher: &mut impl Hasher) {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) => panic!("无法读取前端资源目录 {}：{error}", root.display()),
    };
    for entry in entries {
        let entry = entry
            .unwrap_or_else(|error| panic!("无法读取前端资源目录条目 {}：{error}", root.display()));
        let path = entry.path();
        if path.is_dir() {
            watch_tree(&path, hasher);
        } else if path.is_file() {
            println!("cargo:rerun-if-changed={}", path.display());
            path.hash(hasher);
            std::fs::read(&path)
                .unwrap_or_else(|error| panic!("无法读取前端资源文件 {}：{error}", path.display()))
                .hash(hasher);
        }
    }
}

fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-env-changed=KUNPENG_DEFAULT_SYNC_URL");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    // Cargo tracks a directory entry, not every descendant reliably on every
    // platform. Tauri embeds the complete UI tree in the executable, so watch
    // every file: otherwise a recent bridge can be bundled with a stale HTML
    // asset and leave the macOS window blank at startup.
    let mut ui_fingerprint = std::collections::hash_map::DefaultHasher::new();
    watch_tree(Path::new("ui"), &mut ui_fingerprint);
    // Also expose a deterministic tree fingerprint for build diagnostics.
    println!(
        "cargo:rustc-env=KUNPENG_UI_ASSET_FINGERPRINT={:016x}",
        ui_fingerprint.finish()
    );
    if let Ok(value) = std::env::var("KUNPENG_DEFAULT_SYNC_URL") {
        let value = value.trim();
        if value.is_empty() {
            panic!("KUNPENG_DEFAULT_SYNC_URL must not be empty when set");
        }
        if value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
            || !value.starts_with("https://")
        {
            panic!("KUNPENG_DEFAULT_SYNC_URL must be an HTTPS URL without whitespace");
        }
        println!("cargo:rustc-env=KUNPENG_DEFAULT_SYNC_URL={value}");
    }
    tauri_build::build()
}
