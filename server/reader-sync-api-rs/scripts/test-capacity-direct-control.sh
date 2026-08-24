#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/capacity-direct-control.sh"

bash -n "$script"
"$script" --self-test | grep -Fxq 'self_test=passed'

expect_rejection() {
  local label=$1
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'expected rejection: %s\n' "$label" >&2
    exit 1
  fi
}

expect_rejection 'missing action' "$script"
expect_rejection 'production service as dev-test' "$script" prepare --service reader-sync.service
expect_rejection 'unsafe service name' "$script" prepare --service 'reader-sync-dev-test.service;bad'
expect_rejection 'missing service option' "$script" status
expect_rejection 'extra self-test argument' "$script" --self-test unexpected

for required in \
  '((EUID == 0))' \
  'SSH_CONNECTION' \
  'database_is_disposable' \
  'KUNPENG_SYNC_TLS_CERTIFICATE_PEM' \
  'KUNPENG_SYNC_TLS_PRIVATE_KEY_PEM' \
  'KUNPENG_SYNC_ALLOW_PUBLIC_BIND=1' \
  'validate_probe_endpoint' \
  'for endpoint in /health /ready /metrics' \
  'listener_scope_from_ss' \
  'wait_for_service_gate' \
  'local_endpoint_gate http "$DIRECT_PORT" 0 "$ORIGINAL_BIND_FAMILY"' \
  'wait_for_service_gate "$SERVICE" "$DIRECT_PORT" all-interfaces https 1 "$SERVER_FAMILY"' \
  'local_endpoint_gate https "$DIRECT_PORT" 1 "$ST_SERVER_FAMILY"' \
  'wait_for_service_gate "$SERVICE" "$ST_PORT" loopback http 0 "$ST_ORIGINAL_BIND_FAMILY"' \
  'production_pid_matches "$ST_PRODUCTION_PID" "$production_pid"' \
  'production_pid_unchanged "$ST_PRODUCTION_PID" "$production_pid_before" "$production_pid_after"' \
  'production_unchanged=%s' \
  "die 'cleanup completed safely, but production service PID changed'" \
  'iptables -w 5 -A' \
  'ip6tables -w 5 -A' \
  'caddy_port_reference_count' \
  "trap 'prepare_rollback \$?' EXIT" \
  'atomic_restore_file' \
  'separate binary paths' \
  'byte-identical binaries'; do
  grep -Fq "$required" "$script" || {
    printf 'direct-control safety marker is missing: %s\n' "$required" >&2
    exit 1
  }
done

if grep -Eq '(https?://[A-Za-z0-9.-]+|/home/|/root/|Users\\\\)' "$script"; then
  echo 'direct-control script appears to contain a hard-coded endpoint, account, or private path' >&2
  exit 1
fi

echo 'capacity direct-control tests passed'
