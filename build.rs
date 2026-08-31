use std::{
    hash::{Hash, Hasher},
    path::Path,
    process::Command,
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

fn ensure_embedded_reader_page_output() {
    let status = Command::new("node")
        .args(["apps/desktop-ui/scripts/build-reader-page-ts.mjs"])
        .status()
        .unwrap_or_else(|error| {
            panic!("无法生成内嵌 EPUB 阅读页脚本：需要 Node.js；请先安装项目的前端依赖。{error}")
        });
    if !status.success() {
        panic!("内嵌 EPUB 阅读页脚本生成失败（退出码：{status}）");
    }
}

fn is_loopback_http_endpoint(value: &str) -> bool {
    let Some(port) = value.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    !port.is_empty()
        && port.bytes().all(|byte| byte.is_ascii_digit())
        && matches!(port.parse::<u16>(), Ok(1..=u16::MAX))
}

fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-env-changed=KUNPENG_DEFAULT_SYNC_URL");
    println!("cargo:rerun-if-env-changed=KUNPENG_GITHUB_REPO");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    // reader_page.rs uses include_str! for the single embedded EPUB engine.
    // Build it here so a fresh clone can run Cargo directly rather than relying
    // on a developer having generated an untracked JavaScript bundle first.
    ensure_embedded_reader_page_output();
    // Cargo tracks a directory entry, not every descendant reliably on every
    // platform. Tauri embeds the complete UI tree in the executable, so watch
    // every file: otherwise a recent bridge can be bundled with a stale HTML
    // asset and leave the macOS window blank at startup.
    let mut ui_fingerprint = std::collections::hash_map::DefaultHasher::new();
    watch_tree(Path::new("ui"), &mut ui_fingerprint);
    // The embedded EPUB scripts are generated from strict TypeScript but are
    // compiled into reader_page.rs with include_str!. Track their sources too:
    // a clean build must never silently embed an older generated reader engine.
    watch_tree(
        Path::new("apps/desktop-ui/src/legacy-ts/reader-page-modules"),
        &mut ui_fingerprint,
    );
    for path in [
        "apps/desktop-ui/reader-page-ts.entries.json",
        "apps/desktop-ui/scripts/build-reader-page-ts.mjs",
        "apps/desktop-ui/scripts/reader-page-ts-manifest.mjs",
        "apps/desktop-ui/vite.legacy-ts.config.ts",
        "package-lock.json",
    ] {
        println!("cargo:rerun-if-changed={path}");
        path.hash(&mut ui_fingerprint);
        std::fs::read(path)
            .unwrap_or_else(|error| panic!("无法读取前端构建输入 {path}：{error}"))
            .hash(&mut ui_fingerprint);
    }
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
            || !(value.starts_with("https://") || is_loopback_http_endpoint(value))
        {
            panic!(
                "KUNPENG_DEFAULT_SYNC_URL must be an HTTPS URL or a 127.0.0.1 HTTP endpoint without whitespace"
            );
        }
        println!("cargo:rustc-env=KUNPENG_DEFAULT_SYNC_URL={value}");
    }
    tauri_build::build()
}
