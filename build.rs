fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    // `beforeBuildCommand` regenerates the optional standalone bridge beneath
    // `ui/`. Watching the whole frontend tree makes Cargo re-run Tauri's
    // asset embedding when a JavaScript/CSS/HTML-only change occurs; without
    // this, an old executable can be rebundled after a successful Vite build.
    println!("cargo:rerun-if-changed=ui");
    tauri_build::build()
}
