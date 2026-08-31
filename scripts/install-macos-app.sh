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
local_signing_dir="${KUNPENG_LOCAL_SIGNING_DIR:-$HOME/Library/Application Support/鲲鹏阅读器/signing}"
local_signing_keychain="$local_signing_dir/local-development.keychain-db"
local_signing_password_file="$local_signing_dir/keychain-password"
local_signing_identity="Kunpeng Reader Local Development"

cleanup_stage() {
  [[ -d "$staged_app" ]] && rm -rf "$staged_app"
}
trap cleanup_stage EXIT

ensure_local_signing_identity() {
  mkdir -p "$local_signing_dir"
  chmod 700 "$local_signing_dir"
  if [[ ! -f "$local_signing_password_file" ]]; then
    umask 077
    openssl rand -hex 32 > "$local_signing_password_file"
  fi
  chmod 600 "$local_signing_password_file"
  local keychain_password
  keychain_password="$(<"$local_signing_password_file")"
  if [[ ! -f "$local_signing_keychain" ]]; then
    security create-keychain -p "$keychain_password" "$local_signing_keychain" >/dev/null
    security set-keychain-settings -lut 21600 "$local_signing_keychain" >/dev/null
  fi
  security unlock-keychain -p "$keychain_password" "$local_signing_keychain" >/dev/null

  # codesign requires the identity keychain to stay on the user's search list,
  # even when --keychain is passed. Add this app-owned keychain once and leave
  # it there; the old add-then-restore approach caused macOS to repeatedly ask
  # for private-key authorization on later builds.
  local -a user_keychains
  user_keychains=("${(@f)$(security list-keychains -d user \
    | sed -E 's/^[[:space:]]*"//; s/"[[:space:]]*$//')}")
  if (( ${user_keychains[(I)$local_signing_keychain]} == 0 )); then
    security list-keychains -d user -s "$local_signing_keychain" "${user_keychains[@]}"
  fi

  if ! security find-identity -v -p codesigning "$local_signing_keychain" 2>/dev/null | grep -Fq "$local_signing_identity"; then
    local signing_key="$local_signing_dir/local-development.key"
    local signing_cert="$local_signing_dir/local-development.crt"
    local signing_p12="$local_signing_dir/local-development.p12"
    umask 077
    openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 \
      -subj "/CN=$local_signing_identity/O=Kunpeng Reader Local Development/OU=macOS" \
      -addext "basicConstraints=critical,CA:false" \
      -addext "keyUsage=critical,digitalSignature" \
      -addext "extendedKeyUsage=codeSigning" \
      -keyout "$signing_key" -out "$signing_cert"
    openssl pkcs12 -export -name "$local_signing_identity" \
      -inkey "$signing_key" -in "$signing_cert" \
      -out "$signing_p12" -passout "pass:$keychain_password"
    security add-trusted-cert -r trustRoot -p codeSign \
      -k "$local_signing_keychain" "$signing_cert" >/dev/null
    security import "$signing_p12" -k "$local_signing_keychain" \
      -P "$keychain_password" -T /usr/bin/codesign >/dev/null
    rm -f "$signing_key" "$signing_cert" "$signing_p12"
  fi

  # Keep the signing key accessible to codesign without prompting on every
  # subsequent local build. Run this after both fresh imports and existing
  # keychains so installations created by older versions are migrated once.
  security set-key-partition-list -S apple-tool:,apple:,codesign: \
    -s -k "$keychain_password" "$local_signing_keychain" >/dev/null
}

local_signing_identity_hash() {
  security find-identity -v -p codesigning "$local_signing_keychain" 2>/dev/null \
    | awk -F '"' -v label="$local_signing_identity" '$2 == label {print $1}' \
    | awk '{print $2}' \
    | tail -n 1
}

sign_with_local_identity() {
  local app_path="$1"
  local identity_hash
  identity_hash="$(local_signing_identity_hash)"
  if [[ -z "$identity_hash" ]]; then
    print -u2 "未找到本机代码签名身份：$local_signing_identity"
    return 1
  fi

  # Passing the dedicated keychain directly avoids changing the user's
  # keychain search list on every build, which can trigger repeated macOS
  # private-key authorization prompts.
  codesign --force --deep --keychain "$local_signing_keychain" \
    --sign "$local_signing_identity" "$app_path"
}

if [[ "${1:-}" == "--build" ]]; then
  # build.rs fingerprints every UI asset and emits rerun-if-changed for it, so an
  # incremental Tauri build is sufficient even after HTML-only changes. This
  # keeps local acceptance builds fast without risking a stale frontendDist.
  (cd "$repo_root" && node scripts/check-licenses.mjs && cargo tauri build --target "$target_triple" --bundles app)
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
ensure_local_signing_identity
sign_with_local_identity "$staged_app"
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
