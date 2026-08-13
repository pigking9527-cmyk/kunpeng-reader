#!/bin/zsh
# 将已构建的 macOS 应用覆盖安装到唯一的本机运行位置。
# 用法：scripts/install-macos-app.sh [--build]
set -euo pipefail

repo_root=${0:A:h:h}
target_triple="${KUNPENG_MACOS_TARGET:-aarch64-apple-darwin}"
source_app="$repo_root/target/$target_triple/release/bundle/macos/鲲鹏阅读器.app"
installed_app="/Applications/鲲鹏阅读器.app"
bundle_id="com.kunpeng.reader"
staged_app="/Applications/.鲲鹏阅读器.app.codex-stage-$$"

cleanup_stage() {
  [[ -d "$staged_app" ]] && rm -rf "$staged_app"
}
trap cleanup_stage EXIT

if [[ "${1:-}" == "--build" ]]; then
  # Tauri embeds `frontendDist` through a compile-time macro. A package-scoped
  # clean prevents Cargo from reusing an old macro expansion after HTML-only
  # changes, which would otherwise mix a stale page with newer scripts.
  (cd "$repo_root" && node scripts/check-licenses.mjs && cargo clean --release --target "$target_triple" && cargo tauri build --target "$target_triple" --bundles app)
elif [[ $# -gt 0 ]]; then
  print -u2 "用法：$0 [--build]"
  exit 64
fi

if [[ ! -d "$source_app" ]]; then
  print -u2 "未找到构建产物：$source_app"
  print -u2 "请先执行 cargo tauri build，或使用 $0 --build。"
  exit 1
fi

# 先退出所有同 bundle id 的窗口，避免覆盖正在执行的应用包。
osascript >/dev/null 2>&1 <<EOF || true
with timeout of 5 seconds
  tell application id "$bundle_id" to quit
end timeout
EOF

for _ in {1..20}; do
  pgrep -x ebook-reader-tauri >/dev/null 2>&1 || break
  sleep 0.25
done

if pgrep -x ebook-reader-tauri >/dev/null 2>&1; then
  print -u2 "阅读器尚未退出，未覆盖安装。请关闭阅读器后重试。"
  exit 1
fi

# `ditto` merges into an existing bundle and can retain files removed from the
# new artifact. Stage a complete replacement on the same volume instead, sign
# the finished bundle, then rename it atomically. This only replaces the app
# package; the user's configuration, library, and account data stay outside it.
ditto "$source_app" "$staged_app"
codesign --force --deep --sign - "$staged_app"
codesign --verify --deep --strict "$staged_app"
if [[ -d "$installed_app" ]]; then
  backup_app="/Applications/.鲲鹏阅读器.app.previous-$$"
  mv "$installed_app" "$backup_app"
  if ! mv "$staged_app" "$installed_app"; then
    mv "$backup_app" "$installed_app"
    exit 1
  fi
  rm -rf "$backup_app"
else
  mv "$staged_app" "$installed_app"
fi
open -a "$installed_app"
print "已覆盖并启动唯一应用：$installed_app"
