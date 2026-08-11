#!/bin/zsh
# 将已构建的 macOS 应用覆盖安装到唯一的本机运行位置。
# 用法：scripts/install-macos-app.sh [--build]
set -euo pipefail

repo_root=${0:A:h:h}
target_triple="${KUNPENG_MACOS_TARGET:-aarch64-apple-darwin}"
source_app="$repo_root/target/$target_triple/release/bundle/macos/鲲鹏阅读器.app"
installed_app="/Applications/鲲鹏阅读器.app"
bundle_id="com.pigking.ebookreader"

if [[ "${1:-}" == "--build" ]]; then
  (cd "$repo_root" && cargo tauri build --target "$target_triple" --bundles app)
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

ditto "$source_app" "$installed_app"
open -a "$installed_app"
print "已覆盖并启动唯一应用：$installed_app"
