#!/usr/bin/env bash
# Run the fixed v5 capacity schedule from a separate load machine.
#
# All deployment-specific values come from the caller's private environment;
# this script deliberately contains no endpoint, credential, token, database
# name, or server path.  It starts the host-side monitor over SSH, runs the
# probe locally, and copies aggregate-only reports back to a private directory.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: run-capacity-test.sh (--short | --full | --smoke CONCURRENCY | --independent-smoke CONCURRENCY | --bulk-data-smoke | --diagnose | --tune-capacity-host | --install-capacity-build-toolchain | --stop-capacity-builds | --deploy-capacity-candidate) [--profile catchup|cursor-zero-replay] [--report-dir DIR]

Required private environment:
  KUNPENG_CAPACITY_SSH_TARGET       SSH destination of the disposable test host
  KUNPENG_CAPACITY_SSH_KEY          readable identity file for that host
  KUNPENG_CAPACITY_TEST_BASE        test base URL (no path, credentials or query)
  KUNPENG_CAPACITY_TOKENS_FILE      file containing 2048+ unique disposable session tokens
  KUNPENG_CAPACITY_K6               k6 executable (defaults to k6 on PATH)
  KUNPENG_CAPACITY_REMOTE_SERVICE   systemd service name to monitor
  KUNPENG_CAPACITY_REMOTE_MONITOR   absolute remote capacity-monitor.py path

Optional private environment:
  KUNPENG_CAPACITY_PROFILE          catchup (default) or cursor-zero-replay

For an explicitly source-firewalled direct target, also set:
  KUNPENG_CAPACITY_ALLOW_EXTERNAL_TARGET=1

--short runs every fixed stage for 30 seconds (330 seconds total).
--full runs the fixed 20-minute capacity schedule with independent VUs. Each
phase activates exactly its fixed VU count from one max-500 VU executor; there
is no controller batch barrier. Reports distinguish configured and active VUs.
--smoke CONCURRENCY runs one explicitly non-capacity 60-second stage at 1–500
HTTP in-flight requests through the legacy controller batch barrier. It is a
burst diagnostic retained for comparison and can never be a capacity result.
--independent-smoke CONCURRENCY runs fixed independent k6 VUs for 60 seconds.
Each VU owns a non-overlapping shard of the 2048+ account pool and advances
only its own accounts' cursors. It removes the controller batch barrier for
diagnosis, is not part of the fixed capacity schedule, and cannot support a
capacity conclusion.
--bulk-data-smoke is a fixed five-minute, non-capacity transfer smoke. It uses
2048 disposable accounts and one approximately 256 KiB entity per account,
then alternates entity updates and cursor-zero pulls to measure wire transfer.
It is deliberately reported separately from the fixed capacity schedule.
--profile selects one pull workload only. catchup is the default capacity
workload: each independent test account retains its successful nextCursor and
therefore advances after its initial catchup. cursor-zero-replay deliberately
reads cursor=0 on every pull as an adversarial replay; its report is explicitly
ineligible for a normal capacity conclusion. The runner never combines the
profiles. Every stage in the aggregate report records the selected profile.
The fixed stage numbers mean active independent k6 VUs. The executor is sized
to the curve maximum, and VUs above the current stage count remain idle. Each
active VU issues its next request as soon as its own previous request completes;
another VU's slow request cannot hold the phase behind a global batch barrier.
--diagnose reports only non-secret host and service capacity limits; it sends no
load and does not read service environment variables.
--tune-capacity-host raises only the selected disposable service's descriptor
limit and the host TCP SYN backlog. It must never be used for a production
service without separate deployment approval.
--deploy-capacity-candidate uploads the current local service source, builds it
on the test host, and restarts only the disposable service. It is deliberately
not a release or production deployment mechanism.
--install-capacity-build-toolchain installs the pinned minimal Rust toolchain
and native build prerequisites on the test host. It is for development only.
--stop-capacity-builds stops only unfinished disposable-candidate Cargo builds.
The k6 test keeps HTTP connections alive and deterministically rotates every
stage through independent test accounts, including low-VU stages. Reports
contain aggregate timings, status counts and hardware summaries only.
EOF
}

mode=""
smoke_concurrency=""
execution_model="independent-vus"
report_dir="${HOME}/.codex/private/kunpeng-load-reports"
profile="${KUNPENG_CAPACITY_PROFILE:-catchup}"
while (($#)); do
  case "$1" in
    --short|--full|--bulk-data-smoke|--diagnose|--tune-capacity-host|--install-capacity-build-toolchain|--stop-capacity-builds|--deploy-capacity-candidate)
      [[ -z "$mode" ]] || { usage >&2; exit 2; }
      mode="${1#--}"
      ;;
    --smoke)
      (($# >= 2)) || { usage >&2; exit 2; }
      [[ -z "$mode" ]] || { usage >&2; exit 2; }
      [[ "$2" =~ ^[0-9]+$ ]] && (( 10#$2 >= 1 && 10#$2 <= 500 )) || {
        echo 'smoke concurrency must be an integer from 1 through 500' >&2
        exit 2
      }
      mode="smoke"
      smoke_concurrency="$2"
      execution_model="batch-controller"
      shift
      ;;
    --independent-smoke)
      (($# >= 2)) || { usage >&2; exit 2; }
      [[ -z "$mode" ]] || { usage >&2; exit 2; }
      [[ "$2" =~ ^[0-9]+$ ]] && (( 10#$2 >= 1 && 10#$2 <= 500 )) || {
        echo 'independent smoke concurrency must be an integer from 1 through 500' >&2
        exit 2
      }
      mode="independent-smoke"
      smoke_concurrency="$2"
      execution_model="independent-vus"
      shift
      ;;
    --report-dir)
      (($# >= 2)) || { usage >&2; exit 2; }
      report_dir="$2"
      shift
      ;;
    --profile)
      (($# >= 2)) || { usage >&2; exit 2; }
      profile="$2"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

[[ -n "$mode" ]] || { usage >&2; exit 2; }
if [[ "$mode" == bulk-data-smoke ]]; then
  profile='bulk-entity-256k-v2'
else
  case "$profile" in
    catchup|cursor-zero-replay) ;;
    *) echo 'capacity profile must be catchup or cursor-zero-replay' >&2; exit 2 ;;
  esac
fi
for name in \
  KUNPENG_CAPACITY_SSH_TARGET \
  KUNPENG_CAPACITY_SSH_KEY \
  KUNPENG_CAPACITY_REMOTE_SERVICE \
  KUNPENG_CAPACITY_REMOTE_MONITOR; do
  [[ -n "${!name:-}" ]] || { printf '%s is required\n' "$name" >&2; exit 2; }
done

[[ -r "$KUNPENG_CAPACITY_SSH_KEY" ]] || { echo 'SSH identity is not readable' >&2; exit 2; }
ssh_common=(ssh -i "$KUNPENG_CAPACITY_SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$KUNPENG_CAPACITY_SSH_TARGET")
scp_common=(scp -i "$KUNPENG_CAPACITY_SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)

if [[ "$mode" == diagnose ]]; then
  "${ssh_common[@]}" bash -s -- "$KUNPENG_CAPACITY_REMOTE_SERVICE" <<'REMOTE'
set -euo pipefail
service="$1"
pid="$(systemctl show -p MainPID --value "$service")"
test "$pid" -gt 0
printf 'service_properties\n'
systemctl show "$service" -p MainPID -p LimitNOFILE -p TasksCurrent -p TasksMax --no-pager
printf 'service_capacity_config\n'
tr '\0' '\n' < "/proc/$pid/environ" |
  grep -E '^KUNPENG_SYNC_(DATABASE_MAX_CONNECTIONS|DATABASE_ACQUIRE_TIMEOUT_MILLIS|MAX_CONCURRENT_REQUESTS|MAX_CONCURRENT_CHECKPOINT_REQUESTS|MAX_QUEUED_READ_REQUESTS|MAX_QUEUED_CHECKPOINT_REQUESTS|MAX_CONCURRENT_WRITE_REQUESTS|MAX_QUEUED_WRITE_REQUESTS|REQUEST_QUEUE_TIMEOUT_MILLIS|REQUEST_TIMEOUT_SECONDS|LISTEN_BACKLOG)=' || true
printf 'process_limits\n'
grep -E 'Max open files|Max processes' "/proc/$pid/limits"
printf 'listen_and_kernel_limits\n'
ss -ltn | awk 'NR == 1 || /:(8790|8788) /'
sysctl net.core.somaxconn net.ipv4.tcp_max_syn_backlog 2>/dev/null || true
printf 'postgres_settings\n'
sudo -u postgres psql -Atqc "show max_connections; show shared_buffers;" 2>/dev/null
printf 'service_admission_metrics\n'
curl --fail --silent --max-time 2 http://127.0.0.1:8790/metrics 2>/dev/null |
  grep -E '^reader_sync_(active_requests|queued_requests|request_queue_(rejections_total|wait_seconds)|request_handler_duration_seconds|database_(pool_acquire|query)_seconds|requests_total)' || true
printf 'candidate_build_activity\n'
ps -C cargo -C rustc -o pid=,etime=,%cpu=,%mem=,comm= 2>/dev/null || true
printf 'vendored_dependency_cache=%s\n' "$(find /srv/kunpeng-reader -maxdepth 4 -name .cargo-checksum.json -print -quit 2>/dev/null | grep -q . && echo present || echo absent)"
REMOTE
  exit 0
fi

if [[ "$mode" == tune-capacity-host ]]; then
  "${ssh_common[@]}" bash -s -- "$KUNPENG_CAPACITY_REMOTE_SERVICE" <<'REMOTE'
set -euo pipefail
service="$1"
case "$service" in
  *dev-test*) ;;
  *) echo 'refusing to tune a service that is not explicitly disposable' >&2; exit 2 ;;
esac
mkdir -p "/etc/systemd/system/$service.d"
cat > "/etc/systemd/system/$service.d/20-capacity-host.conf" <<'UNIT'
[Service]
LimitNOFILE=8192
# Keep the disposable candidate's ordinary-read lane in the accepted operating
# range.  Above it the middleware sheds quickly, which makes a 500-request
# stress stage report overload as 503 rather than burying normal requests in
# seconds of queued work.  The production unit is never addressed here.
Environment=KUNPENG_SYNC_DATABASE_MAX_CONNECTIONS=48
Environment=KUNPENG_SYNC_DATABASE_ACQUIRE_TIMEOUT_MILLIS=300
Environment=KUNPENG_SYNC_MAX_CONCURRENT_REQUESTS=12
Environment=KUNPENG_SYNC_MAX_CONCURRENT_CHECKPOINT_REQUESTS=18
Environment=KUNPENG_SYNC_MAX_QUEUED_READ_REQUESTS=64
Environment=KUNPENG_SYNC_MAX_QUEUED_CHECKPOINT_REQUESTS=24
Environment=KUNPENG_SYNC_MAX_CONCURRENT_WRITE_REQUESTS=10
Environment=KUNPENG_SYNC_MAX_QUEUED_WRITE_REQUESTS=48
Environment=KUNPENG_SYNC_REQUEST_QUEUE_TIMEOUT_MILLIS=200
UNIT
cat > /etc/sysctl.d/70-kunpeng-capacity-test.conf <<'SYSCTL'
net.ipv4.tcp_max_syn_backlog = 2048
SYSCTL
env_file="$(systemctl show -p EnvironmentFiles --value "$service" | grep -oE '/[^ ]+' | head -1 || true)"
case "$env_file" in
  *test*|*dev*) ;;
  *) echo 'refusing to alter an environment file that is not explicitly test-only' >&2; exit 2 ;;
esac
set_env() {
  key="$1"
  value="$2"
  if grep -q "^$key=" "$env_file"; then
    sed -i "s|^$key=.*|$key=$value|" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$env_file"
  fi
}
set_env KUNPENG_SYNC_DATABASE_MAX_CONNECTIONS 48
set_env KUNPENG_SYNC_DATABASE_ACQUIRE_TIMEOUT_MILLIS 300
set_env KUNPENG_SYNC_MAX_CONCURRENT_REQUESTS 12
set_env KUNPENG_SYNC_MAX_CONCURRENT_CHECKPOINT_REQUESTS 18
set_env KUNPENG_SYNC_MAX_QUEUED_READ_REQUESTS 64
set_env KUNPENG_SYNC_MAX_QUEUED_CHECKPOINT_REQUESTS 24
set_env KUNPENG_SYNC_MAX_CONCURRENT_WRITE_REQUESTS 10
set_env KUNPENG_SYNC_MAX_QUEUED_WRITE_REQUESTS 48
set_env KUNPENG_SYNC_REQUEST_QUEUE_TIMEOUT_MILLIS 200
sysctl --system >/dev/null
systemctl daemon-reload
systemctl restart "$service"
pid="$(systemctl show -p MainPID --value "$service")"
test "$pid" -gt 0
printf 'capacity_host_tuned\n'
grep 'Max open files' "/proc/$pid/limits"
sysctl net.ipv4.tcp_max_syn_backlog
REMOTE
  exit 0
fi

if [[ "$mode" == install-capacity-build-toolchain ]]; then
  case "$KUNPENG_CAPACITY_REMOTE_SERVICE" in
    *dev-test*) ;;
    *) echo 'refusing to install a build toolchain without an explicitly disposable service' >&2; exit 2 ;;
  esac
  "${ssh_common[@]}" bash -s <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq build-essential pkg-config libssl-dev curl ca-certificates
if [ ! -x /root/.cargo/bin/rustup ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
    sh -s -- -y --profile minimal --default-toolchain 1.97.1 --no-modify-path
else
  /root/.cargo/bin/rustup toolchain install 1.97.1 --profile minimal
fi
/root/.cargo/bin/cargo +1.97.1 --version
REMOTE
  exit 0
fi

if [[ "$mode" == stop-capacity-builds ]]; then
  case "$KUNPENG_CAPACITY_REMOTE_SERVICE" in
    *dev-test*) ;;
    *) echo 'refusing to stop builds without an explicitly disposable service' >&2; exit 2 ;;
  esac
  "${ssh_common[@]}" bash -s <<'REMOTE'
set -euo pipefail
for pid in $(pgrep -x cargo || true); do
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  case "$cwd" in
    /srv/kunpeng-reader/capacity-candidates/*)
      # Cargo may already have spawned rustc children.  Stop that exact
      # process tree before a replacement build, otherwise the old compiler
      # keeps consuming the small disposable host after its cargo parent has
      # exited.  Never traverse an arbitrary process: the candidate cwd check
      # above is the sole admission condition.
      stop_tree() {
        local parent="$1"
        local child
        for child in $(pgrep -P "$parent" || true); do
          stop_tree "$child"
        done
        kill "$parent" 2>/dev/null || true
      }
      stop_tree "$pid"
      ;;
  esac
done
printf 'capacity_builds_stopped\n'
REMOTE
  exit 0
fi

if [[ "$mode" == deploy-capacity-candidate ]]; then
  case "$KUNPENG_CAPACITY_REMOTE_SERVICE" in
    *dev-test*) ;;
    *) echo 'refusing to deploy a candidate to a service that is not explicitly disposable' >&2; exit 2 ;;
  esac
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  remote_root="/srv/kunpeng-reader/capacity-candidates/$run_id"
  remote_binary="/usr/local/lib/kunpeng-capacity-test/reader-sync-api-$run_id"
  "${ssh_common[@]}" test -x /root/.cargo/bin/cargo || {
    echo 'pinned remote Rust toolchain is missing; run --install-capacity-build-toolchain first' >&2
    exit 2
  }
  "${ssh_common[@]}" "mkdir -p '$remote_root'"
  # The monitor is part of the candidate toolchain.  Keeping it in sync with
  # the runner is essential: otherwise a newer runner can pass arguments that
  # an old remote monitor silently rejects, leaving no hardware/PG report.
  "${scp_common[@]}" \
    "$repo_root/server/reader-sync-api-rs/scripts/capacity-monitor.py" \
    "$KUNPENG_CAPACITY_SSH_TARGET:$KUNPENG_CAPACITY_REMOTE_MONITOR"
  "${ssh_common[@]}" "chmod 0755 '$KUNPENG_CAPACITY_REMOTE_MONITOR'"
  (
    cd "$repo_root"
    COPYFILE_DISABLE=1 tar --no-xattrs -czf - \
      --exclude='target' \
      --exclude='._*' \
      server/reader-sync-api-rs contracts
  ) | "${ssh_common[@]}" "tar -xzf - -C '$remote_root'"
  "${ssh_common[@]}" bash -s -- \
    "$KUNPENG_CAPACITY_REMOTE_SERVICE" \
    "$remote_root" \
    "$remote_binary" <<'REMOTE'
set -euo pipefail
service="$1"
root="$2"
binary="$3"
case "$service" in
  *dev-test*) ;;
  *) echo 'refusing non-test service' >&2; exit 2 ;;
esac
vendor_checksum="$(find /srv/kunpeng-reader -maxdepth 5 -path '*/anyhow/.cargo-checksum.json' -print -quit 2>/dev/null || true)"
if [ -n "$vendor_checksum" ]; then
  vendor_dir="$(dirname "$(dirname "$vendor_checksum")")"
  mkdir -p "$root/server/reader-sync-api-rs/.cargo"
  cat > "$root/server/reader-sync-api-rs/.cargo/config.toml" <<CONFIG
[source.crates-io]
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "$vendor_dir"
CONFIG
fi
cd "$root/server/reader-sync-api-rs"
CARGO_TARGET_DIR=/srv/kunpeng-reader/capacity-candidates/target
CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse \
  CARGO_HTTP_TIMEOUT=60 \
  CARGO_NET_RETRY=3 \
  CARGO_TARGET_DIR="$CARGO_TARGET_DIR" \
  timeout 15m /root/.cargo/bin/cargo +1.97.1 build --release --locked
install -D -m 0755 "$CARGO_TARGET_DIR/release/reader-sync-api" "$binary"
mkdir -p "/etc/systemd/system/$service.d"
cat > "/etc/systemd/system/$service.d/30-capacity-candidate.conf" <<UNIT
[Service]
ExecStart=
ExecStart=$binary
UNIT
# A candidate can carry a new SQLx migration.  The disposable service must
# apply it before accepting a capacity run; otherwise the test can silently
# exercise an older schema and report application 503s as capacity failures.
env_file="$(systemctl show -p EnvironmentFiles --value "$service" | grep -oE '/[^ ]+' | head -1 || true)"
case "$env_file" in
  *test*|*dev*) ;;
  *) echo 'refusing to enable migrations outside a disposable environment file' >&2; exit 2 ;;
esac
if grep -q '^KUNPENG_SYNC_RUN_MIGRATIONS=' "$env_file"; then
  sed -i 's/^KUNPENG_SYNC_RUN_MIGRATIONS=.*/KUNPENG_SYNC_RUN_MIGRATIONS=1/' "$env_file"
else
  printf '%s\n' 'KUNPENG_SYNC_RUN_MIGRATIONS=1' >> "$env_file"
fi
systemctl daemon-reload
systemctl restart "$service"
pid="$(systemctl show -p MainPID --value "$service")"
test "$pid" -gt 0
sha256sum "$binary" | awk '{print "capacity_candidate_sha256=" $1}'
REMOTE
  exit 0
fi

for name in KUNPENG_CAPACITY_TEST_BASE KUNPENG_CAPACITY_TOKENS_FILE; do
  [[ -n "${!name:-}" ]] || { printf '%s is required\n' "$name" >&2; exit 2; }
done
[[ -r "$KUNPENG_CAPACITY_TOKENS_FILE" ]] || { echo 'test tokens file is not readable' >&2; exit 2; }
[[ "$report_dir" = /* ]] || { echo 'report directory must be absolute' >&2; exit 2; }
[[ "$KUNPENG_CAPACITY_REMOTE_MONITOR" = /* ]] || { echo 'remote monitor path must be absolute' >&2; exit 2; }

token_count="$(awk 'NF {count[$0]=1} END {for (value in count) total++; print total}' "$KUNPENG_CAPACITY_TOKENS_FILE")"
[[ "$token_count" =~ ^[0-9]+$ && "$token_count" -ge 2048 ]] || {
  echo 'test tokens file must contain at least 2048 unique tokens' >&2
  exit 2
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
k6="${KUNPENG_CAPACITY_K6:-k6}"
if [[ "$k6" == */* ]]; then
  [[ -x "$k6" ]] || { echo 'k6 executable is not executable' >&2; exit 2; }
else
  command -v "$k6" >/dev/null || { echo 'k6 is not installed or not on PATH' >&2; exit 2; }
fi
k6_script="$repo_root/server/reader-sync-api-rs/scripts/capacity-k6.js"
k6_reporter="$repo_root/server/reader-sync-api-rs/scripts/capacity-k6-report.py"
client_monitor="$repo_root/server/reader-sync-api-rs/scripts/capacity-client-monitor.py"
if [[ "$mode" == bulk-data-smoke ]]; then
  k6_script="$repo_root/server/reader-sync-api-rs/scripts/data-transfer-k6.js"
  k6_reporter="$repo_root/server/reader-sync-api-rs/scripts/data-transfer-report.py"
fi
for script in "$k6_script" "$k6_reporter" "$client_monitor"; do
  [[ -r "$script" ]] || { echo 'k6 capacity support script is missing' >&2; exit 2; }
done

single_stage_name=""
single_stage_concurrency=""
if [[ "$mode" == short ]]; then
  stage_seconds=30
  total_seconds=330
elif [[ "$mode" == smoke ]]; then
  stage_seconds=60
  total_seconds=60
  single_stage_name="smoke-$smoke_concurrency"
  single_stage_concurrency="$smoke_concurrency"
elif [[ "$mode" == independent-smoke ]]; then
  stage_seconds=60
  total_seconds=60
  single_stage_name="independent-$smoke_concurrency"
  single_stage_concurrency="$smoke_concurrency"
elif [[ "$mode" == bulk-data-smoke ]]; then
  stage_seconds=300
  total_seconds=300
else
  stage_seconds=""
  total_seconds=1200
fi

mkdir -p "$report_dir"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
probe_report="$report_dir/capacity-probe-$mode-$run_id.json"
monitor_report="$report_dir/capacity-monitor-$mode-$run_id.json"
client_report="$report_dir/capacity-client-$mode-$run_id.json"
k6_summary="$report_dir/capacity-k6-$mode-$run_id.json"
k6_output="$report_dir/capacity-k6-$mode-$run_id.log"
remote_report="/var/lib/kunpeng-reader/capacity-reports/capacity-monitor-$mode-$run_id.json"
remote_stage_seconds="${stage_seconds:--}"
"${ssh_common[@]}" bash -s -- \
  "$KUNPENG_CAPACITY_REMOTE_SERVICE" \
  "$KUNPENG_CAPACITY_REMOTE_MONITOR" \
  "$remote_report" \
  "$total_seconds" \
  "$remote_stage_seconds" \
  "$mode" \
  "$single_stage_name" <<'REMOTE'
set -euo pipefail
service="$1"
monitor="$2"
output="$3"
seconds="$4"
# SSH command argument joining does not preserve an empty positional argument.
# The caller therefore sends `-` for the full schedule's absent override so
# the following mode argument can never shift into the seconds position.
stage_seconds="${5:-}"
if [ "$stage_seconds" = - ]; then
  stage_seconds=""
fi
mode="${6:-}"
single_stage_name="${7:-}"
case "$service" in
  *dev-test*) ;;
  *) echo 'refusing PostgreSQL capacity observation outside the disposable service' >&2; exit 2 ;;
esac
test -x "$monitor" || test -r "$monitor"
mkdir -p "$(dirname "$output")"
pid="$(systemctl show -p MainPID --value "$service")"
test "$pid" -gt 0
# Read the already-running disposable service's database name without printing
# its connection string.  The monitor independently enforces the test database
# prefix before invoking psql, so a normal service/database can never be
# selected by this path.
test_database="$(python3 - "$pid" <<'PY'
import os
import re
import sys
from urllib.parse import unquote, urlsplit

pid = sys.argv[1]
with open(f"/proc/{pid}/environ", "rb") as source:
    environment = source.read().split(b"\0")
url = next((entry.split(b"=", 1)[1].decode("utf-8") for entry in environment
            if entry.startswith(b"KUNPENG_SYNC_DATABASE_URL=")), "")
database = unquote(urlsplit(url).path.lstrip("/"))
if not re.fullmatch(r"reader_sync_rust_test_[A-Za-z0-9_]+", database):
    raise SystemExit("disposable capacity database scope check failed")
print(database)
PY
)"
args=(python3 "$monitor" --service-pid "$pid" --postgres-database "$test_database" --metrics-url http://127.0.0.1:8790/metrics --seconds "$seconds" --output "$output")
if [ -n "$stage_seconds" ] && [ "$mode" != bulk-data-smoke ] && [ "$mode" != smoke ] && [ "$mode" != independent-smoke ]; then
  args+=(--stage-seconds "$stage_seconds")
fi
if [ "$mode" = bulk-data-smoke ] || [ "$mode" = smoke ] || [ "$mode" = independent-smoke ]; then
  # The host monitor intentionally supports the stable generic single-stage
  # shape. The probe itself carries the precise smoke concurrency label.
  args+=(--single-stage)
  if [ "$mode" = independent-smoke ]; then
    args+=(--single-stage-name "$single_stage_name")
  fi
fi
startup_log="${output}.startup.log"
nohup "${args[@]}" >"$startup_log" 2>&1 &
monitor_pid=$!
for _ in $(seq 1 10); do
  if [ -s "$output" ]; then
    exit 0
  fi
  if ! kill -0 "$monitor_pid" 2>/dev/null; then
    rm -f "$startup_log"
    echo 'remote capacity monitor failed during startup' >&2
    exit 1
  fi
  sleep 1
done
kill "$monitor_pid" 2>/dev/null || true
rm -f "$startup_log"
echo 'remote capacity monitor did not write its first sample' >&2
exit 1
REMOTE

if [[ "${KUNPENG_CAPACITY_ALLOW_EXTERNAL_TARGET:-}" != 1 ]]; then
  case "$KUNPENG_CAPACITY_TEST_BASE" in
    http://127.0.0.1:*|http://localhost:*|https://127.0.0.1:*|https://localhost:*) ;;
    *) echo 'external target requires KUNPENG_CAPACITY_ALLOW_EXTERNAL_TARGET=1' >&2; exit 2 ;;
  esac
fi
if [[ -n "$stage_seconds" ]]; then
  k6_stage_seconds="$stage_seconds"
else
  k6_stage_seconds=0
fi
k6_args=(
  run
  -e "SYNC_LOAD_TEST_TOKENS_FILE=$KUNPENG_CAPACITY_TOKENS_FILE"
  -e "SYNC_LOAD_TEST_BASE=$KUNPENG_CAPACITY_TEST_BASE"
  -e "SYNC_LOAD_TEST_STAGE_SECONDS=$k6_stage_seconds"
  -e "SYNC_LOAD_TEST_PROFILE=$profile"
  -e "SYNC_LOAD_TEST_EXECUTION_MODEL=$execution_model"
  -e "SYNC_LOAD_TEST_RUN_EPOCH_MILLIS=$(($(date +%s) * 1000))"
)
if [[ -n "$single_stage_concurrency" ]]; then
  k6_args+=(
    -e "SYNC_LOAD_TEST_SINGLE_STAGE_NAME=$single_stage_name"
    -e "SYNC_LOAD_TEST_SINGLE_CONCURRENCY=$single_stage_concurrency"
  )
fi
k6_args+=(
  --summary-export "$k6_summary"
  "$k6_script"
)
set +e
K6_NO_USAGE_REPORT=true \
  "$k6" "${k6_args[@]}" >"$k6_output" 2>&1 &
k6_pid=$!
client_monitor_args=(python3 "$client_monitor" --pid "$k6_pid" --seconds "$total_seconds" --output "$client_report")
if [[ "$mode" == bulk-data-smoke || "$mode" == smoke || "$mode" == independent-smoke ]]; then
  client_monitor_args+=(--single-stage)
  if [[ "$mode" == independent-smoke ]]; then
    client_monitor_args+=(--single-stage-name "$single_stage_name")
  fi
elif [[ -n "$stage_seconds" ]]; then
  client_monitor_args+=(--stage-seconds "$stage_seconds")
fi
"${client_monitor_args[@]}" >/dev/null 2>&1 &
client_monitor_pid=$!
wait "$k6_pid"
probe_status=$?
wait "$client_monitor_pid" || true
set -e

if [[ -s "$k6_summary" ]]; then
  reporter_args=(python3 "$k6_reporter" --summary "$k6_summary" --output "$probe_report" --profile "$profile")
  if [[ -n "$stage_seconds" ]]; then
    reporter_args+=(--stage-seconds "$stage_seconds")
  fi
  if [[ -n "$single_stage_concurrency" ]]; then
    reporter_args+=(
      --single-stage-name "$single_stage_name"
      --single-stage-concurrency "$single_stage_concurrency"
    )
  fi
  if [[ "$mode" != bulk-data-smoke ]]; then
    reporter_args+=(
      --execution-model "$execution_model"
      --account-pool-size "$token_count"
    )
  fi
  "${reporter_args[@]}"
  python3 - "$probe_report" <<'PY'
import json
import sys

report = json.load(open(sys.argv[1], encoding="utf-8"))
if report.get("measurementComplete") is not True:
    raise SystemExit("capacity probe missed one or more fixed phases; retained incomplete reports")
PY
fi

monitor_complete=0
for _ in $(seq 1 30); do
  if "${ssh_common[@]}" test -f "$remote_report"; then
    "${scp_common[@]}" "$KUNPENG_CAPACITY_SSH_TARGET:$remote_report" "$monitor_report"
    if python3 - "$monitor_report" <<'PY'
import json
import sys

try:
    report = json.load(open(sys.argv[1], encoding="utf-8"))
except (OSError, ValueError):
    raise SystemExit(1)
raise SystemExit(0 if report.get("complete") is True else 1)
PY
    then
      monitor_complete=1
      break
    fi
  fi
  sleep 1
done

if [[ ! -s "$monitor_report" ]]; then
  echo 'remote capacity monitor did not produce a report' >&2
  exit 1
fi
if [[ ! -s "$client_report" ]]; then
  echo 'local k6 client monitor did not produce a report' >&2
  exit 1
fi
if ((monitor_complete != 1)); then
  echo 'remote capacity monitor did not complete; retained incomplete aggregate report and remote diagnostic log' >&2
  exit 1
fi
python3 - "$monitor_report" "$client_report" <<'PY'
import json
import sys

for label, path in zip(("remote", "client"), sys.argv[1:]):
    report = json.load(open(path, encoding="utf-8"))
    if report.get("complete") is not True:
        raise SystemExit(f"{label} capacity monitor is incomplete")
    stages = report.get("hardware", {}).get("byStage", {})
    if not stages or any(row.get("samples", 0) <= 0 for row in stages.values()):
        raise SystemExit(f"{label} capacity monitor missed one or more fixed phases")
PY
if ((probe_status != 0)); then
  echo 'k6 capacity probe did not complete; retained aggregate reports' >&2
  exit "$probe_status"
fi
if [[ "$mode" == bulk-data-smoke || "$mode" == smoke || "$mode" == independent-smoke ]]; then
  capacity_conclusion="non-capacity-$mode"
elif [[ "$profile" == cursor-zero-replay ]]; then
  capacity_conclusion='ineligible-adversarial-cursor-zero-replay'
elif [[ "$mode" == short ]]; then
  capacity_conclusion='ineligible-short-rehearsal'
else
  capacity_conclusion='eligible'
fi
printf 'profile=%s\ncapacity_conclusion=%s\nprobe_report=%s\nmonitor_report=%s\nclient_report=%s\n' \
  "$profile" "$capacity_conclusion" "$probe_report" "$monitor_report" "$client_report"
