#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run-capacity-test.sh"
k6_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/capacity-k6.js"
monitor_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/capacity-monitor.py"
monitor_test="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/test-capacity-monitor.py"

if "$script" --help | grep -q 'fixed 20-minute capacity schedule'; then
  :
else
  echo 'help text is missing full schedule documentation' >&2
  exit 1
fi

if ! "$script" --help | grep -Fq -- '--full runs the fixed 20-minute capacity schedule with independent VUs'; then
  echo 'help text is missing the independent-VU full capacity model' >&2
  exit 1
fi

if ! "$script" --help | grep -Fq -- 'burst diagnostic retained for comparison and can never be a capacity result'; then
  echo 'help text no longer marks the batch-controller smoke as ineligible' >&2
  exit 1
fi

if ! "$script" --help | grep -Fq -- '--independent-smoke CONCURRENCY runs fixed independent k6 VUs for 60 seconds'; then
  echo 'help text is missing the independent-VU diagnostic mode' >&2
  exit 1
fi

if ! grep -Fq 'execution_model="independent-vus"' "$script" || \
  ! grep -Fq 'execution_model="batch-controller"' "$script" || \
  ! grep -Fq -- '--execution-model "$execution_model"' "$script"; then
  echo 'runner no longer selects independent VUs for capacity and batch controller only for burst smoke' >&2
  exit 1
fi

if ! grep -Fq -- '--expected-service-sha256 "$service_sha"' "$script" || \
  ! grep -Fq 'sha256sum -- "/proc/$pid/exe"' "$script"; then
  echo 'runner no longer pins the monitored service process image' >&2
  exit 1
fi

if ! grep -Fq 'const minTestAccounts = 2048;' "$k6_script"; then
  echo 'k6 script no longer requires a sufficiently large independent account pool' >&2
  exit 1
fi

if ! grep -Fq 'maxRedirects: 0,' "$k6_script" || \
  ! grep -Fq 'redirects: 0,' "$k6_script"; then
  echo 'k6 script may follow redirects away from the direct test origin' >&2
  exit 1
fi

if ! grep -Fq 'const cursors = new Map();' "$k6_script" || \
  ! grep -Fq 'Date.now() - exec.scenario.startTime' "$k6_script"; then
  echo 'k6 script no longer keeps VU-local cursors on the shared fixed timeline' >&2
  exit 1
fi

checkpoint_block="$(sed -n "/if (operation === 'checkpoint')/,/if (operation === 'inventory')/p" "$k6_script")"
if ! grep -Fq "params.responseType = profile === 'catchup' ? 'text' : 'none';" <<<"$checkpoint_block"; then
  echo 'checkpoint responses no longer retain the caughtUp body required by catchup state' >&2
  exit 1
fi

if ! grep -Fq "executor: 'constant-vus'" "$k6_script" || \
  ! grep -Fq "exec: 'independentVu'" "$k6_script" || \
  ! grep -Fq 'vus: maxHttpInFlight,' "$k6_script" || \
  ! grep -Fq 'const vuIndex = exec.vu.idInTest - 1;' "$k6_script" || \
  ! grep -Fq 'if (vuIndex >= stage.concurrency)' "$k6_script" || \
  ! grep -Fq 'const accountIndex = vuIndex + (shardOffset * stage.concurrency);' "$k6_script"; then
  echo 'k6 script no longer provides one stable VU pool with non-overlapping active shards' >&2
  exit 1
fi

node <<'JS'
const stages = [
  ['baseline', 5, 60], ['elevated', 75, 180], ['peak', 150, 180],
  ['stress-200', 200, 210], ['stress-250', 250, 60],
  ['stress-300', 300, 60], ['stress-350', 350, 60],
  ['stress-400', 400, 60], ['stress-450', 450, 90],
  ['stress-500', 500, 150], ['recovery', 25, 90],
];
if (stages.reduce((total, row) => total + row[2], 0) !== 1200) {
  throw new Error('fixed stage schedule is no longer 20 minutes');
}
let stageStartMs = 0;
let previousMaximumVersion = 0;
for (const [stage, _vus, seconds] of stages) {
  const maximumVisits = Math.ceil((seconds * 50) / 60) + 1;
  const firstVersion = 1_700_000_000_000 + stageStartMs + 1;
  const maximumVersion = 1_700_000_000_000 + stageStartMs + maximumVisits;
  if (firstVersion <= previousMaximumVersion) {
    throw new Error(`entity versions are not monotonic across ${stage}`);
  }
  if (!(maximumVersion / Number.MAX_SAFE_INTEGER < 1)) {
    throw new Error(`generated reading progress is outside the payload boundary in ${stage}`);
  }
  previousMaximumVersion = maximumVersion;
  stageStartMs += seconds * 1000;
}
for (const tokenCount of [2048, 2053]) {
  for (const [stage, vus] of stages) {
    const owners = new Array(tokenCount).fill(0);
    const localVus = new Set();
    // One max-500 scenario always activates its first N stable VU IDs.
    for (let idInTest = 1; idInTest <= vus; idInTest += 1) {
      const vuIndex = idInTest - 1;
      localVus.add(vuIndex);
      const shardLength = Math.floor((tokenCount - 1 - vuIndex) / vus) + 1;
      for (let shardOffset = 0; shardOffset < shardLength; shardOffset += 1) {
        const accountIndex = vuIndex + (shardOffset * vus);
        owners[accountIndex] += 1;
      }
    }
    if (localVus.size !== vus) {
      throw new Error(`global VU ids do not map bijectively in ${stage}`);
    }
    if (!owners.every((count) => count === 1)) {
      throw new Error(`account shards overlap or omit an account: ${stage}/${tokenCount}/${vus}`);
    }
  }
}

const independentSeed = 0x6d2b79f5;
function independentHash(value) {
  let hash = (Number(value) ^ independentSeed) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad);
  hash = Math.imul(hash ^ (hash >>> 15), 0x735a2d97);
  return (hash ^ (hash >>> 15)) >>> 0;
}
function phaseHash(stageOrdinal, value) {
  return independentHash(
    (Number(value) ^ Math.imul(stageOrdinal + 1, 0x9e3779b1)) >>> 0,
  );
}
// The former accountIndex % 20 schedule made 40 VUs assign push to the same
// fixed owner group on every shard pass. Hashed phases must change that group
// while retaining the exact five push slots in every account's 20-visit cycle.
for (const vus of [30, 40, 50, 51, 52, 53, 54]) {
  const pushOwnerSets = new Set();
  let pushAssignments = 0;
  let assignments = 0;
  for (let shardOffset = 0; shardOffset < 20; shardOffset += 1) {
    const pushOwners = [];
    for (let vuIndex = 0; vuIndex < vus; vuIndex += 1) {
      const accountIndex = vuIndex + (shardOffset * vus);
      const phase = phaseHash(0, accountIndex) % 20;
      if (phase >= 14 && phase < 19) {
        pushOwners.push(vuIndex);
        pushAssignments += 1;
      }
      assignments += 1;
      let accountPushes = 0;
      for (let visit = 0; visit < 20; visit += 1) {
        const slot = ((visit * 7) + phase) % 20;
        accountPushes += Number(slot >= 14 && slot < 19);
      }
      if (accountPushes !== 5) {
        throw new Error(`hashed operation mix drifted for ${vus}/${accountIndex}`);
      }
    }
    pushOwnerSets.add(pushOwners.join(','));
  }
  const pushShare = pushAssignments / assignments;
  if (pushOwnerSets.size < 5 || pushShare < 0.15 || pushShare > 0.35) {
    throw new Error(`hashed operation phases remain synchronized for ${vus}`);
  }
}

function mutationId(runEpoch, stageOrdinal, sequence) {
  const epochHex = runEpoch.toString(16).padStart(12, '0').slice(-12);
  const stageHex = stageOrdinal.toString(16).padStart(2, '0').slice(-2);
  const sequenceHex = sequence.toString(16).padStart(16, '0').slice(-16);
  return `${epochHex.slice(0, 8)}-${epochHex.slice(8)}-4${stageHex}${sequenceHex[0]}`
    + `-8${sequenceHex.slice(1, 4)}-${sequenceHex.slice(4)}`;
}
const mutationIds = new Set();
for (const epoch of [1_700_000_000_000, 1_700_000_000_001]) {
  for (const stage of [0, 1, 10]) {
    for (const sequence of [0, 1, 65_535, 1_000_000]) {
      const id = mutationId(epoch, stage, sequence);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
        throw new Error(`capacity mutation id is not a version-4 UUID: ${id}`);
      }
      if (mutationIds.has(id)) {
        throw new Error(`capacity mutation id repeated across run/stage/sequence: ${id}`);
      }
      mutationIds.add(id);
    }
  }
}
JS

if ! grep -Fq 'const batchResponses = http.batch(' "$k6_script" || \
  ! grep -Fq "SYNC_LOAD_TEST_EXECUTION_MODEL || 'independent-vus'" "$k6_script" || \
  ! grep -Fq "burst:" "$k6_script"; then
  echo 'k6 script no longer separates formal independent VUs from legacy burst batches' >&2
  exit 1
fi

if ! grep -Fq 'const slot = ((batch * 7) + offset) % 20;' "$k6_script"; then
  echo 'k6 script no longer dephases the mixed request workload across accounts' >&2
  exit 1
fi

if ! grep -Fq 'const independentWorkloadSeed = 0x6d2b79f5;' "$k6_script" || \
  ! grep -Fq 'const independentStageStartSpreadMs = 1000;' "$k6_script" || \
  ! grep -Fq 'independentPhaseHash(stage, accountIndex) % 20' "$k6_script" || \
  ! grep -Fq "gracefulStop: '3s'" "$k6_script"; then
  echo 'independent capacity workload no longer has reproducible hashed phases and graceful drain' >&2
  exit 1
fi

if ! grep -Fq 'const accountRequestIntervalMs = 1200;' "$k6_script" || \
  ! grep -Fq 'runEpoch + stageStartMillis(stage.ordinal) + visit' "$k6_script" || \
  ! grep -Fq 'syncVersion: updatedAt,' "$k6_script" || \
  ! grep -Fq 'progress: updatedAt / Number.MAX_SAFE_INTEGER,' "$k6_script"; then
  echo 'independent capacity writes no longer remain real, monotonic, and quota-safe' >&2
  exit 1
fi

if ! grep -Fq 'SYNC_LOAD_TEST_RUN_EPOCH_MILLIS=$(($(date +%s) * 1000))' "$script"; then
  echo 'runner no longer gives every capacity VU one shared version epoch' >&2
  exit 1
fi

if ! grep -Fq "const epochHex = runEpoch.toString(16).padStart(12, '0').slice(-12);" "$k6_script" || \
  grep -Fq 'a82fb5c3-6c4a-4f3d-99de-' "$k6_script"; then
  echo 'capacity mutation ids no longer isolate repeated runs' >&2
  exit 1
fi

if ! grep -Fq 'KUNPENG_SYNC_RUN_MIGRATIONS=1' "$script"; then
  echo 'candidate deployment no longer applies pending migrations to its test-only database' >&2
  exit 1
fi

if ! grep -Fq 'set_env KUNPENG_SYNC_MAX_CONCURRENT_REQUESTS 15' "$script" || \
  ! grep -Fq 'set_env KUNPENG_SYNC_MAX_CONCURRENT_CHECKPOINT_REQUESTS 23' "$script" || \
  ! grep -Fq 'set_env KUNPENG_SYNC_MAX_CONCURRENT_WRITE_REQUESTS 12' "$script" || \
  ! grep -Fq 'set_env KUNPENG_SYNC_DATABASE_ACQUIRE_TIMEOUT_MILLIS 300' "$script" || \
  ! grep -Fq 'set_env KUNPENG_SYNC_MAX_QUEUED_WRITE_REQUESTS 48' "$script" || \
  ! grep -Fq 'set_env KUNPENG_SYNC_REQUEST_QUEUE_TIMEOUT_MILLIS 200' "$script"; then
  echo 'candidate runner no longer enforces the early-backpressure operating range' >&2
  exit 1
fi

if ! grep -Fq 'stage_seconds="${5:-}"' "$script"; then
  echo 'full capacity run no longer tolerates the intentionally empty stage override' >&2
  exit 1
fi
if ! grep -Fq "capacity_conclusion='ineligible-short-rehearsal'" "$script"; then
  echo 'runner must mark the shortened fixed schedule as capacity-ineligible' >&2
  exit 1
fi
if ! grep -Fq 'remote_stage_seconds="${stage_seconds:--}"' "$script" ||
   ! grep -Fq 'if [ "$stage_seconds" = - ]; then' "$script"; then
  echo 'runner must preserve the full-schedule empty stage override across SSH' >&2
  exit 1
fi
if ! grep -Fq "echo 'remote capacity monitor did not write its first sample'" "$script"; then
  echo 'runner must verify remote monitor startup before sending load' >&2
  exit 1
fi

if ! grep -Fq "profile === 'cursor-zero-replay' ? 0 : (cursors.get(token) || 0)" "$k6_script"; then
  echo 'k6 catchup profile no longer retains a real per-account cursor' >&2
  exit 1
fi

if ! grep -Fq "['catchup', 'cursor-zero-replay']" "$k6_script"; then
  echo 'k6 script no longer exposes the explicit cursor-zero replay profile' >&2
  exit 1
fi

if ! grep -Fq 'capacity_conclusion=' "$script"; then
  echo 'runner no longer labels adversarial replay as ineligible for capacity conclusions' >&2
  exit 1
fi

if ! grep -Fq -- '--postgres-database "$test_database"' "$script" || \
  ! grep -Fq 'disposable capacity database scope check failed' "$script"; then
  echo 'runner no longer derives and guards the disposable PostgreSQL scope' >&2
  exit 1
fi

if ! grep -Fq 'postgresPssMaxKiB' "$monitor_script" || \
  ! grep -Fq 'postgresAggregateRssMaxKiB' "$monitor_script" || \
  grep -Fq '"postgresRssMaxKiB"' "$monitor_script"; then
  echo 'monitor PostgreSQL memory metrics no longer distinguish PSS from aggregate RSS' >&2
  exit 1
fi

if ! grep -Fq 'pg_stat_statements_unavailable' "$monitor_script" || \
  ! grep -Fq 'disposable-test-database' "$monitor_script"; then
  echo 'monitor no longer reports unavailable PostgreSQL statement statistics safely' >&2
  exit 1
fi

if ! grep -Fq -- '--metrics-url http://127.0.0.1:8790/metrics' "$script" || \
  ! grep -Fq 'reader_sync_request_queue_wait_seconds_bucket' "$monitor_script" || \
  ! grep -Fq 'reader_sync_request_handler_duration_seconds_bucket' "$monitor_script"; then
  echo 'runner no longer records the safe per-stage queue and handler latency split' >&2
  exit 1
fi

python3 "$monitor_test"

if "$script" --short >/dev/null 2>&1; then
  echo 'runner unexpectedly accepted missing private configuration' >&2
  exit 1
fi

if "$script" --short --full >/dev/null 2>&1; then
  echo 'runner unexpectedly accepted two modes' >&2
  exit 1
fi

if "$script" --short --profile unsupported >/dev/null 2>&1; then
  echo 'runner unexpectedly accepted an unsupported profile' >&2
  exit 1
fi

if "$script" --short --profile steady >/dev/null 2>&1; then
  echo 'runner unexpectedly accepted the retired ambiguous steady profile' >&2
  exit 1
fi

if "$script" --independent-smoke 0 >/dev/null 2>&1; then
  echo 'runner unexpectedly accepted zero independent VUs' >&2
  exit 1
fi

if "$script" --independent-smoke 501 >/dev/null 2>&1; then
  echo 'runner unexpectedly accepted more than 500 independent VUs' >&2
  exit 1
fi

if "$script" --tune-capacity-host >/dev/null 2>&1; then
  echo 'runner unexpectedly tuned without private configuration' >&2
  exit 1
fi

if "$script" --deploy-capacity-candidate >/dev/null 2>&1; then
  echo 'runner unexpectedly deployed without private configuration' >&2
  exit 1
fi

if "$script" --install-capacity-build-toolchain >/dev/null 2>&1; then
  echo 'runner unexpectedly installed a toolchain without private configuration' >&2
  exit 1
fi

temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
summary="$temporary/k6-summary.json"
report="$temporary/probe.json"
cat >"$summary" <<'JSON'
{"metrics":{"sync_stage_duration{stage:baseline,profile:catchup}":{"med":10,"p(95)":20,"p(99)":30},"sync_successful_stage_duration{stage:baseline,profile:catchup}":{"med":11,"p(95)":21,"p(99)":31},"sync_requests_started{stage:baseline,profile:catchup,executionModel:independent-vus,operation:pull}":{"count":6},"sync_responses{stage:baseline,profile:catchup,executionModel:independent-vus,operation:pull,status:200}":{"count":4},"sync_responses{stage:baseline,profile:catchup,executionModel:independent-vus,operation:push,status:503}":{"count":1},"sync_accounts_exercised{stage:baseline,profile:catchup,executionModel:independent-vus}":{"count":2048},"sync_shard_claims{stage:baseline,profile:catchup,executionModel:independent-vus,shard:0}":{"count":1},"sync_shard_claims{stage:baseline,profile:catchup,executionModel:independent-vus,shard:1}":{"count":1},"sync_shard_claims{stage:baseline,profile:catchup,executionModel:independent-vus,shard:2}":{"count":1},"sync_shard_claims{stage:baseline,profile:catchup,executionModel:independent-vus,shard:3}":{"count":1},"sync_shard_claims{stage:baseline,profile:catchup,executionModel:independent-vus,shard:4}":{"count":1},"sync_no_response{stage:baseline,profile:catchup}":{"count":1}}}
JSON
python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/capacity-k6-report.py" \
  --summary "$summary" --output "$report" --stage-seconds 30 --profile catchup \
  --execution-model independent-vus --account-pool-size 2048
python3 - "$report" <<'PY'
import json
import sys

report = json.load(open(sys.argv[1], encoding="utf-8"))
baseline = report["stages"][0]
assert baseline["requests"] == 5
assert baseline["completedRequests"] == 5
assert baseline["completedRequestsPerSecond"] == 0.17
assert baseline["successfulRequests"] == 4
assert baseline["successfulRequestsPerSecond"] == 0.13
assert report["profile"] == "catchup"
assert report["executionModel"] == "independent-vus"
assert report["concurrencyUnit"] == "active-independent-k6-vus"
assert report["executorConfiguredVus"] == 500
assert report["maxStageActiveVus"] == 500
assert report["workloadClass"] == "capacity-rehearsal"
assert report["measurementComplete"] is False
assert report["capacityConclusionEligible"] is False
assert baseline["profile"] == "catchup"
assert baseline["workloadClass"] == "capacity-rehearsal"
assert baseline["measurementComplete"] is False
assert baseline["requestAccountingComplete"] is False
assert baseline["capacityConclusionEligible"] is False
assert baseline["executorConfiguredVus"] == 500
assert baseline["activeVus"] == 5
assert baseline["httpInFlightUpperBound"] == 5
assert baseline["issuedRequests"] == 6
assert baseline["issuedRequestsPerSecond"] == 0.2
assert baseline["responsesRecordedPerSecond"] == 0.17
assert baseline["stageCutoff"] == 1
assert baseline["shardsClaimed"] == 5
assert baseline["shardClaimsValid"] is True
assert baseline["byOperation"] == {"pull": 4, "push": 1}
assert baseline["statuses"] == {"200": 4, "503": 1}
assert baseline["noResponse"] == 1
assert baseline["p50Ms"] == 10.0
assert baseline["p95Ms"] == 20.0
assert baseline["p99Ms"] == 30.0
assert baseline["successfulP99Ms"] == 31.0
PY

smoke_report="$temporary/smoke-100.json"
sed -e 's/stage:baseline/stage:smoke-100/g' \
  -e 's/executionModel:independent-vus/executionModel:batch-controller/g' \
  "$summary" >"$temporary/smoke-summary.json"
python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/capacity-k6-report.py" \
  --summary "$temporary/smoke-summary.json" --output "$smoke_report" \
  --stage-seconds 60 --single-stage-name smoke-100 --single-stage-concurrency 100 \
  --profile catchup --execution-model batch-controller
python3 - "$smoke_report" <<'PY'
import json
import sys

report = json.load(open(sys.argv[1], encoding="utf-8"))
stage = report["stages"][0]
assert report["executionModel"] == "batch-controller"
assert report["workloadClass"] == "non-capacity-burst"
assert report["capacityConclusionEligible"] is False
assert report["totalPlannedSeconds"] == 60
assert stage["name"] == "smoke-100"
assert stage["httpInFlightConcurrency"] == 100
assert stage["plannedSeconds"] == 60
assert stage["capacityConclusionEligible"] is False
PY

adversarial_report="$temporary/cursor-zero-replay.json"
sed 's/profile:catchup/profile:cursor-zero-replay/g' "$summary" >"$temporary/adversarial-summary.json"
python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/capacity-k6-report.py" \
  --summary "$temporary/adversarial-summary.json" --output "$adversarial_report" \
  --stage-seconds 30 --profile cursor-zero-replay \
  --execution-model independent-vus --account-pool-size 2048
python3 - "$adversarial_report" <<'PY'
import json
import sys

report = json.load(open(sys.argv[1], encoding="utf-8"))
assert report["profile"] == "cursor-zero-replay"
assert report["concurrencyUnit"] == "active-independent-k6-vus"
assert report["workloadClass"] == "adversarial"
assert report["capacityConclusionEligible"] is False
assert report["stages"][0]["capacityConclusionEligible"] is False
PY

independent_summary="$temporary/independent-summary.json"
independent_report="$temporary/independent-100.json"
python3 - "$independent_summary" <<'PY'
import json
import sys

tags = "stage:independent-100,profile:catchup,executionModel:independent-vus"
metrics = {
    f"sync_stage_duration{{{tags}}}": {"med": 8, "p(95)": 18, "p(99)": 28},
    f"sync_successful_stage_duration{{{tags}}}": {"med": 7, "p(95)": 17, "p(99)": 27},
    f"sync_requests_started{{{tags},operation:pull}}": {"count": 5000},
    f"sync_responses{{{tags},operation:pull,status:200}}": {"count": 5000},
    f"sync_accounts_exercised{{{tags}}}": {"count": 2048},
}
for shard in range(100):
    metrics[f"sync_shard_claims{{{tags},shard:{shard}}}"] = {"count": 1}
with open(sys.argv[1], "w", encoding="utf-8") as destination:
    json.dump({"metrics": metrics}, destination)
PY
python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/capacity-k6-report.py" \
  --summary "$independent_summary" --output "$independent_report" \
  --stage-seconds 60 --single-stage-name independent-100 \
  --single-stage-concurrency 100 --profile catchup \
  --execution-model independent-vus --account-pool-size 2048
python3 - "$independent_report" <<'PY'
import json
import sys

report = json.load(open(sys.argv[1], encoding="utf-8"))
stage = report["stages"][0]
assert report["executionModel"] == "independent-vus"
assert report["workloadClass"] == "non-capacity-diagnostic"
assert report["concurrencyUnit"] == "active-independent-k6-vus"
assert report["executorConfiguredVus"] == 100
assert report["maxStageActiveVus"] == 100
assert report["accountPoolSize"] == 2048
assert report["measurementComplete"] is True
assert report["capacityConclusionEligible"] is False
assert "k6ControllerVus" not in report
assert report["loadGuards"]["targetRequestsPerAccountPerMinute"] == 50
assert report["loadGuards"]["maxRequestsPerAccountPerMinuteIncludingStageTransition"] == 101
assert report["loadGuards"]["maxPushAttemptsPerAccount"] == 15
assert report["loadGuards"]["maxGeneratedAcceptedBytesPerAccount"] == 15 * 1024
assert report["loadGuards"]["workloadScheduleVersion"] == "hashed-phase-v1"
assert report["loadGuards"]["workloadSeed"] == 0x6D2B79F5
assert report["loadGuards"]["stageStartSpreadMs"] == 1000
assert report["loadGuards"]["gracefulStopSeconds"] == 3
assert stage["executionModel"] == "independent-vus"
assert stage["executorConfiguredVus"] == 100
assert stage["activeVus"] == 100
assert stage["httpInFlightUpperBound"] == 100
assert stage["issuedRequests"] == 5000
assert stage["issuedRequestsPerSecond"] == 83.33
assert stage["requests"] == 5000
assert stage["responsesRecordedPerSecond"] == 83.33
assert stage["stageCutoff"] == 0
assert stage["requestAccountingComplete"] is True
assert stage["accountsExercised"] == 2048
assert stage["accountCoverageComplete"] is True
assert stage["shardsClaimed"] == 100
assert stage["shardClaimsValid"] is True
assert stage["capacityConclusionEligible"] is False
assert "httpInFlightConcurrency" not in stage
PY

invalid_shards_summary="$temporary/independent-invalid-shards.json"
invalid_shards_report="$temporary/independent-invalid-shards-report.json"
python3 - "$independent_summary" "$invalid_shards_summary" <<'PY'
import json
import sys

summary = json.load(open(sys.argv[1], encoding="utf-8"))
metrics = summary["metrics"]
missing = next(name for name in metrics if name.endswith(",shard:99}"))
metrics.pop(missing)
duplicate = next(name for name in metrics if name.endswith(",shard:98}"))
metrics[duplicate]["count"] = 2
with open(sys.argv[2], "w", encoding="utf-8") as destination:
    json.dump(summary, destination)
PY
python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/capacity-k6-report.py" \
  --summary "$invalid_shards_summary" --output "$invalid_shards_report" \
  --stage-seconds 60 --single-stage-name independent-100 \
  --single-stage-concurrency 100 --profile catchup \
  --execution-model independent-vus --account-pool-size 2048
python3 - "$invalid_shards_report" <<'PY'
import json
import sys

report = json.load(open(sys.argv[1], encoding="utf-8"))
stage = report["stages"][0]
assert stage["shardClaimsValid"] is False
assert stage["measurementComplete"] is False
assert report["measurementComplete"] is False
assert report["capacityConclusionEligible"] is False
PY

full_summary="$temporary/full-summary.json"
full_report="$temporary/full-report.json"
python3 - "$full_summary" <<'PY'
import json
import sys

stages = (
    ("baseline", 5, 60), ("elevated", 75, 180), ("peak", 150, 180),
    ("stress-200", 200, 210), ("stress-250", 250, 60),
    ("stress-300", 300, 60), ("stress-350", 350, 60),
    ("stress-400", 400, 60), ("stress-450", 450, 90),
    ("stress-500", 500, 150), ("recovery", 25, 90),
)
metrics = {}
for name, concurrency, _seconds in stages:
    tags = f"stage:{name},profile:catchup,executionModel:independent-vus"
    metrics[f"sync_stage_duration{{{tags}}}"] = {"med": 10, "p(95)": 20, "p(99)": 30}
    metrics[f"sync_successful_stage_duration{{{tags}}}"] = {"med": 9, "p(95)": 19, "p(99)": 29}
    metrics[f"sync_requests_started{{{tags},operation:pull}}"] = {"count": concurrency * 100}
    metrics[f"sync_responses{{{tags},operation:pull,status:200}}"] = {"count": concurrency * 100}
    metrics[f"sync_accounts_exercised{{{tags}}}"] = {"count": 2048}
    for shard in range(concurrency):
        metrics[f"sync_shard_claims{{{tags},shard:{shard}}}"] = {"count": 1}
with open(sys.argv[1], "w", encoding="utf-8") as destination:
    json.dump({"metrics": metrics}, destination)
PY
python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/capacity-k6-report.py" \
  --summary "$full_summary" --output "$full_report" --profile catchup \
  --execution-model independent-vus --account-pool-size 2048
python3 - "$full_report" <<'PY'
import json
import sys

report = json.load(open(sys.argv[1], encoding="utf-8"))
assert report["executionModel"] == "independent-vus"
assert report["workloadClass"] == "capacity"
assert report["totalPlannedSeconds"] == 1200
assert report["measurementComplete"] is True
assert report["capacityConclusionEligible"] is True
assert report["executorConfiguredVus"] == 500
assert report["maxStageActiveVus"] == 500
assert report["loadGuards"]["maxPushAttemptsPerAccount"] == 275
assert report["loadGuards"]["maxGeneratedAcceptedBytesPerAccount"] == 281600
assert report["loadGuards"]["workloadScheduleVersion"] == "hashed-phase-v1"
assert report["loadGuards"]["workloadSeed"] == 0x6D2B79F5
assert report["loadGuards"]["stageStartSpreadMs"] == 1000
assert report["loadGuards"]["gracefulStopSeconds"] == 3
assert len(report["stages"]) == 11
assert [stage["executorConfiguredVus"] for stage in report["stages"]] == [500] * 11
assert [stage["activeVus"] for stage in report["stages"]] == [
    5, 75, 150, 200, 250, 300, 350, 400, 450, 500, 25,
]
assert all(stage["accountCoverageComplete"] for stage in report["stages"])
assert all(stage["shardClaimsValid"] for stage in report["stages"])
assert all(stage["capacityConclusionEligible"] for stage in report["stages"])
assert all(stage["stageCutoff"] == 0 for stage in report["stages"])
assert all(stage["requestAccountingComplete"] for stage in report["stages"])
PY
