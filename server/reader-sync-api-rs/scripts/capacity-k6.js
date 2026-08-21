import http from 'k6/http';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// The fixed schedule uses independent k6 VUs. Within every phase, each account
// belongs to exactly one VU and that VU rotates through its complete shard.
// The legacy batch controller remains available only for a one-stage burst
// diagnostic and can never support a normal capacity conclusion.
const tokensPath = __ENV.SYNC_LOAD_TEST_TOKENS_FILE;
const base = __ENV.SYNC_LOAD_TEST_BASE;
if (!tokensPath || !base) {
  throw new Error('capacity test requires a token file and base URL');
}
const minTestAccounts = 2048;
const tokens = new SharedArray('capacity-test-tokens', () => {
  const values = open(tokensPath)
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length < minTestAccounts || new Set(values).size !== values.length) {
    throw new Error(`capacity test requires at least ${minTestAccounts} unique test tokens`);
  }
  return values;
});

// `catchup` models a real client: a token begins at cursor=0 and retains only
// its own successful nextCursor. `cursor-zero-replay` intentionally disables
// that state as an adversarial workload and is never a normal capacity result.
const profile = (__ENV.SYNC_LOAD_TEST_PROFILE || 'catchup').toLowerCase();
if (!['catchup', 'cursor-zero-replay'].includes(profile)) {
  throw new Error('capacity test profile must be catchup or cursor-zero-replay');
}
const executionModel = (__ENV.SYNC_LOAD_TEST_EXECUTION_MODEL || 'independent-vus').toLowerCase();
if (!['batch-controller', 'independent-vus'].includes(executionModel)) {
  throw new Error('capacity test execution model must be batch-controller or independent-vus');
}

const stages = [
  ['baseline', 5, 60],
  ['elevated', 75, 180],
  ['peak', 150, 180],
  ['stress-200', 200, 210],
  ['stress-250', 250, 60],
  ['stress-300', 300, 60],
  ['stress-350', 350, 60],
  ['stress-400', 400, 60],
  ['stress-450', 450, 90],
  ['stress-500', 500, 150],
  ['recovery', 25, 90],
];

const stageSeconds = Number(__ENV.SYNC_LOAD_TEST_STAGE_SECONDS || '0');
const singleStageConcurrencyRaw = __ENV.SYNC_LOAD_TEST_SINGLE_CONCURRENCY || '';
const singleStageConcurrency = Number(singleStageConcurrencyRaw || '0');
const singleStageName = __ENV.SYNC_LOAD_TEST_SINGLE_STAGE_NAME || '';
if (singleStageConcurrencyRaw && (
  !Number.isInteger(singleStageConcurrency)
  || singleStageConcurrency < 1
  || singleStageConcurrency > 500
  || !/^[a-z0-9-]{1,48}$/.test(singleStageName)
  || stageSeconds < 1
)) {
  throw new Error('single-stage smoke requires a safe name, 1..500 concurrency, and a positive duration');
}
const effectiveStages = singleStageConcurrencyRaw
  ? [[singleStageName, singleStageConcurrency, stageSeconds]]
  : stageSeconds > 0
    ? stages.map(([name, concurrency]) => [name, concurrency, stageSeconds])
    : stages;
const totalSeconds = effectiveStages.reduce((total, [, , seconds]) => total + seconds, 0);
const maxHttpInFlight = Math.max(...effectiveStages.map(([, concurrency]) => concurrency));
// Keep the steady independent-VU workload reproducible without coupling its
// account and operation phases to small factors of the requested concurrency.
// The legacy batch controller below intentionally remains the synchronized
// burst diagnostic.
const independentWorkloadSeed = 0x6d2b79f5;
const independentStageStartSpreadMs = 1000;

const scenarios = executionModel === 'independent-vus'
  ? {
      capacity: {
        executor: 'constant-vus',
        exec: 'independentVu',
        // One scenario guarantees stable 1..max VU identities. Creating one
        // scenario per phase lets k6 reuse an arbitrary global VU subset, so
        // idInTest cannot safely identify a phase-local shard.
        vus: maxHttpInFlight,
        duration: `${totalSeconds}s`,
        // Every request has a two-second client timeout. Give an iteration one
        // additional second to record that response instead of leaving a
        // forced end-of-run stageCutoff and a possibly live server handler.
        gracefulStop: '3s',
      },
    }
  : {
      burst: {
        executor: 'constant-vus',
        vus: 1,
        duration: `${totalSeconds}s`,
        gracefulStop: '0s',
      },
    };

const operations = ['pull', 'checkpoint', 'push', 'inventory'];
const responseStatuses = [
  '0', '200', '400', '401', '403', '404', '409', '426', '429', '500', '503', '504',
];
const thresholds = {};
for (const [stage] of effectiveStages) {
  // k6 exports tagged sub-metrics in its JSON summary only when a threshold
  // references them. These permissive thresholds retain the exact per-stage
  // report data without turning expected load-induced responses into test
  // failures.
  thresholds[`sync_stage_duration{stage:${stage},profile:${profile}}`] = ['p(99)<600000'];
  thresholds[`sync_successful_stage_duration{stage:${stage},profile:${profile}}`] = ['p(99)<600000'];
  thresholds[`sync_no_response{stage:${stage},profile:${profile}}`] = ['count>=0'];
  thresholds[`sync_accounts_exercised{stage:${stage},profile:${profile},executionModel:${executionModel}}`] = ['count>=0'];
  if (executionModel === 'independent-vus') {
    const concurrency = effectiveStages.find(([name]) => name === stage)[1];
    for (let shard = 0; shard < concurrency; shard += 1) {
      thresholds[`sync_shard_claims{stage:${stage},profile:${profile},executionModel:${executionModel},shard:${shard}}`] = ['count>=0'];
    }
  }
  for (const operation of operations) {
    thresholds[`sync_requests_started{stage:${stage},profile:${profile},executionModel:${executionModel},operation:${operation}}`] = ['count>=0'];
    for (const status of responseStatuses) {
      thresholds[`sync_responses{stage:${stage},profile:${profile},executionModel:${executionModel},operation:${operation},status:${status}}`] = ['count>=0'];
    }
  }
}

export const options = {
  scenarios,
  thresholds,
  // http.batch defaults would silently limit same-host concurrency to six.
  batch: maxHttpInFlight,
  batchPerHost: maxHttpInFlight,
  discardResponseBodies: true,
  summaryTrendStats: ['med', 'p(95)', 'p(99)'],
  systemTags: ['status', 'scenario'],
};

const responses = new Counter('sync_responses');
const noResponses = new Counter('sync_no_response');
const requestsStarted = new Counter('sync_requests_started');
const accountsExercised = new Counter('sync_accounts_exercised');
const shardClaims = new Counter('sync_shard_claims');
const stageDuration = new Trend('sync_stage_duration', true);
const successfulStageDuration = new Trend('sync_successful_stage_duration', true);
const expectedSuccess = http.expectedStatuses(200);
// A capacity phase must not silently vanish because one broken connection uses
// k6's much longer default timeout and holds the controller batch across the
// next 30-second boundary.  This remains comfortably above the service's
// 200 ms admission wait and the accepted-path latency target, while exposing a
// truly stalled request as status 0 in that phase.
const requestTimeout = '2s';
const runEpoch = Number(__ENV.SYNC_LOAD_TEST_RUN_EPOCH_MILLIS || Date.now());
if (!Number.isSafeInteger(runEpoch) || runEpoch < 1) {
  throw new Error('capacity test run epoch must be a positive safe integer');
}
const cursors = new Map();
const checkpointNeedsPull = new Set();
const independentAccountVisits = new Map();
const independentAccountsExercised = new Set();
const independentShardsClaimed = new Set();
const independentLastAccountRequestAt = new Map();
const independentLastEntityUpdatedAt = new Map();
const independentStageRequestSequences = new Map();
const independentStagesStarted = new Set();
// The 1.2 s interval targets 50 requests/minute within one owner VU. When a
// phase repartitions accounts, a rolling minute can contain at most 50 old-
// owner requests, 50 new-owner requests, and one immediate handoff request:
// 101 remains below the historical 120/minute test admission setting (and the
// current 600/minute default). At the fixed 25% push mix, the full run can
// accept at most 275 small entity updates/account after rounding every phase
// and its handoff separately: 2.75% of the 10,000-entity daily quota and <=
// 281,600 bytes under the 1 KiB generated-entity guard.
const accountRequestIntervalMs = 1200;
const maxGeneratedEntityBytes = 1024;
let activeStage = '';
let batchesInStage = 0;
let totalBatches = 0;

function stageAt(elapsedMs) {
  let boundaryMs = 0;
  for (let ordinal = 0; ordinal < effectiveStages.length; ordinal += 1) {
    const [name, concurrency, seconds] = effectiveStages[ordinal];
    boundaryMs += seconds * 1000;
    if (elapsedMs < boundaryMs) {
      return { name, concurrency, ordinal, endsAtMs: boundaryMs };
    }
  }
  return null;
}

function stageStartMillis(ordinal) {
  return effectiveStages
    .slice(0, ordinal)
    .reduce((total, [, , seconds]) => total + (seconds * 1000), 0);
}

function accountsForBatch(stage) {
  if (activeStage !== stage.name) {
    activeStage = stage.name;
    batchesInStage = 0;
  }
  // Each batch contains distinct accounts. Advancing by the whole batch makes
  // a low-concurrency stage traverse the complete account pool rather than
  // keeping its first few accounts hot.
  const start = (batchesInStage * stage.concurrency) % tokens.length;
  batchesInStage += 1;
  return Array.from({ length: stage.concurrency }, (_, offset) => (
    tokens[(start + offset) % tokens.length]
  ));
}

function mutationId(stageOrdinal, sequence) {
  const suffix = `${stageOrdinal.toString(16).padStart(2, '0')}${sequence
    .toString(16)
    .padStart(10, '0')}`.slice(-12);
  return `a82fb5c3-6c4a-4f3d-99de-${suffix}`;
}

function pushBody(stage, sequence, accountIndex, entityVersion) {
  const entity = {
    id: entityVersion
      ? `capacity-k6-account-${accountIndex}`
      : `capacity-k6-${stage.name}-${accountIndex}`,
    kind: 'reading_progress_v1',
    updatedAt: entityVersion ? entityVersion.updatedAt : runEpoch,
    deletedAt: 0,
    deviceId: 'capacity-k6-device',
    syncVersion: entityVersion ? entityVersion.syncVersion : 1,
    payload: { progress: entityVersion ? entityVersion.progress : 0.5 },
  };
  if (entityVersion && JSON.stringify(entity).length > maxGeneratedEntityBytes) {
    throw new Error('generated capacity entity exceeded its quota-safe byte guard');
  }
  return JSON.stringify({
    mutationId: mutationId(stage.ordinal, sequence),
    dataGeneration: 1,
    entities: [entity],
  });
}

function operationFor(batch, offset, token) {
  const slot = ((batch * 7) + offset) % 20;
  if (slot < 14) {
    // A steady client substitutes a cursor high-water check for a redundant
    // empty pull.  Its own successful push does not disclose the new cursor,
    // so a false checkpoint deliberately schedules one normal pull before
    // trying the lightweight path again.
    if (profile === 'catchup' && cursors.has(token) && !checkpointNeedsPull.has(token)) {
      return 'checkpoint';
    }
    return 'pull';
  }
  return slot < 19 ? 'push' : 'inventory';
}

function requestFor(operation, stage, token, sequence, accountIndex, entityVersion = null) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-Sync-Protocol-Version': '5',
  };
  const params = {
    headers,
    tags: { stage: stage.name, profile, operation },
    responseCallback: expectedSuccess,
    timeout: requestTimeout,
  };
  if (operation === 'pull') {
    const cursor = profile === 'cursor-zero-replay' ? 0 : (cursors.get(token) || 0);
    // The normal catchup profile retains just the response metadata needed to
    // persist nextCursor. Replay deliberately discards bodies.
    params.responseType = profile === 'catchup' ? 'text' : 'none';
    return {
      token,
      operation,
      cursor,
      request: ['GET', `${base}/v1/sync/pull?cursor=${cursor}&limit=50`, null, params],
    };
  }
  if (operation === 'checkpoint') {
    const cursor = cursors.get(token);
    params.responseType = profile === 'catchup' ? 'text' : 'none';
    return {
      token,
      operation,
      cursor,
      request: ['GET', `${base}/v1/sync/checkpoint?dataGeneration=1&cursor=${cursor}`, null, params],
    };
  }
  if (operation === 'inventory') {
    return {
      token,
      operation,
      request: ['GET', `${base}/v1/sync/inventory`, null, params],
    };
  }
  headers['Content-Type'] = 'application/json';
  return {
    token,
    operation,
    request: [
      'POST',
      `${base}/v1/sync/push`,
      pushBody(stage, sequence, accountIndex, entityVersion),
      params,
    ],
  };
}

function recordResponse(response, request, stage) {
  if (profile === 'catchup' && request.operation === 'pull' && response.status === 200) {
    try {
      const nextCursor = Number(response.json().nextCursor);
      if (Number.isSafeInteger(nextCursor) && nextCursor >= request.cursor) {
        cursors.set(request.token, nextCursor);
        checkpointNeedsPull.delete(request.token);
      }
    } catch (_) {
      // Do not fabricate a cursor from a malformed response. The failed
      // response remains visible through its normal request metrics.
    }
  }
  if (profile === 'catchup' && request.operation === 'checkpoint' && response.status === 200) {
    try {
      if (response.json().caughtUp === true) {
        checkpointNeedsPull.delete(request.token);
      } else {
        checkpointNeedsPull.add(request.token);
      }
    } catch (_) {
      checkpointNeedsPull.add(request.token);
    }
  }
  const status = String(response.status);
  const tags = {
    stage: stage.name,
    profile,
    executionModel,
    operation: request.operation,
  };
  responses.add(1, { ...tags, status });
  stageDuration.add(response.timings.duration, tags);
  if (response.status >= 200 && response.status < 300) {
    successfulStageDuration.add(response.timings.duration, tags);
  }
  if (response.status === 0) {
    noResponses.add(1, {
      ...tags,
      error: String(response.error_code || 'unknown'),
    });
  }
}

export default function () {
  // k6 supplies one Unix-millisecond scenario start time to all VUs. It keeps
  // the dynamic stage labels aligned with the monitor's fixed wall-clock plan.
  const stage = stageAt(Date.now() - exec.scenario.startTime);
  if (!stage) {
    return;
  }
  const batch = batchesInStage;
  const uniqueBatch = totalBatches;
  totalBatches += 1;
  const requests = accountsForBatch(stage).map((token, offset) => (
    requestFor(
      operationFor(batch, offset, token),
      stage,
      token,
      (uniqueBatch * maxHttpInFlight) + offset,
      offset,
    )
  ));
  requests.forEach((request) => requestsStarted.add(1, {
    stage: stage.name,
    profile,
    executionModel,
    operation: request.operation,
  }));
  const batchResponses = http.batch(requests.map((item) => item.request));
  batchResponses.forEach((response, index) => recordResponse(response, requests[index], stage));
}

function independentStateKey(stage, accountIndex) {
  return `${stage.name}:${accountIndex}`;
}

function independentIntegerHash(value) {
  let hash = (Number(value) ^ independentWorkloadSeed) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad);
  hash = Math.imul(hash ^ (hash >>> 15), 0x735a2d97);
  return (hash ^ (hash >>> 15)) >>> 0;
}

function independentPhaseHash(stage, value) {
  return independentIntegerHash(
    (Number(value) ^ Math.imul(stage.ordinal + 1, 0x9e3779b1)) >>> 0,
  );
}

function dephaseIndependentStageStart(stage, vuIndex) {
  const key = `${stage.name}:${vuIndex}`;
  if (independentStagesStarted.has(key)) {
    return;
  }
  independentStagesStarted.add(key);
  const delayMs = independentPhaseHash(stage, vuIndex) % independentStageStartSpreadMs;
  if (delayMs > 0) {
    sleep(delayMs / 1000);
  }
}

function nextIndependentStageSequence(stage) {
  const sequence = independentStageRequestSequences.get(stage.name) || 0;
  independentStageRequestSequences.set(stage.name, sequence + 1);
  return sequence;
}

function independentOperation(stage, token, accountIndex) {
  const stateKey = independentStateKey(stage, accountIndex);
  const visit = independentAccountVisits.get(stateKey) || 0;
  independentAccountVisits.set(stateKey, visit + 1);
  if (profile === 'catchup' && !cursors.has(token)) {
    return 'pull';
  }
  // Hashing the account phase avoids harmonics such as 40 VUs repeatedly
  // assigning push to one synchronized VU group merely because 40 is a
  // multiple of the 20-slot workload cycle. Multiplication by seven still
  // visits every slot exactly once over twenty visits for each account.
  const slot = ((visit * 7) + (independentPhaseHash(stage, accountIndex) % 20)) % 20;
  if (slot < 14) {
    if (profile === 'catchup' && !checkpointNeedsPull.has(token)) {
      return 'checkpoint';
    }
    return 'pull';
  }
  return slot < 19 ? 'push' : 'inventory';
}

function paceIndependentAccount(token) {
  const now = Date.now();
  const previous = independentLastAccountRequestAt.get(token) || 0;
  const waitMs = accountRequestIntervalMs - (now - previous);
  if (waitMs > 0) {
    sleep(waitMs / 1000);
  }
  independentLastAccountRequestAt.set(token, Date.now());
}

function nextIndependentEntityVersion(stage, token, accountIndex) {
  const visit = independentAccountVisits.get(independentStateKey(stage, accountIndex)) || 1;
  const scheduledVersion = runEpoch + stageStartMillis(stage.ordinal) + visit;
  const previous = independentLastEntityUpdatedAt.get(token) || 0;
  const updatedAt = Math.max(scheduledVersion, previous + 1);
  independentLastEntityUpdatedAt.set(token, updatedAt);
  return {
    updatedAt,
    syncVersion: updatedAt,
    progress: updatedAt / Number.MAX_SAFE_INTEGER,
  };
}

export function independentVu() {
  const elapsedMs = Date.now() - exec.scenario.startTime;
  const stage = stageAt(elapsedMs);
  if (!stage) {
    sleep(0.01);
    return;
  }
  const vuIndex = exec.vu.idInTest - 1;
  // The fixed executor holds the maximum required VUs so k6 gives this one
  // scenario stable IDs 1..max. A phase activates only its first N VUs. Idle
  // VUs sleep through the remainder of the phase instead of adding traffic.
  if (vuIndex >= stage.concurrency) {
    const untilBoundarySeconds = Math.max(0.01, (stage.endsAtMs - elapsedMs) / 1000);
    sleep(Math.min(1, untilBoundarySeconds));
    return;
  }
  const shardKey = `${stage.name}:${vuIndex}`;
  if (!independentShardsClaimed.has(shardKey)) {
    independentShardsClaimed.add(shardKey);
    shardClaims.add(1, {
      stage: stage.name,
      profile,
      executionModel,
      shard: String(vuIndex),
    });
  }
  dephaseIndependentStageStart(stage, vuIndex);
  const shardLength = Math.floor((tokens.length - 1 - vuIndex) / stage.concurrency) + 1;
  const stageSequence = nextIndependentStageSequence(stage);
  const shardStart = independentPhaseHash(stage, vuIndex) % shardLength;
  const shardOffset = (shardStart + stageSequence) % shardLength;
  const accountIndex = vuIndex + (shardOffset * stage.concurrency);
  const token = tokens[accountIndex];
  const stateKey = independentStateKey(stage, accountIndex);
  if (!independentAccountsExercised.has(stateKey)) {
    independentAccountsExercised.add(stateKey);
    accountsExercised.add(1, {
      stage: stage.name,
      profile,
      executionModel,
    });
  }
  paceIndependentAccount(token);
  const iteration = exec.scenario.iterationInTest;
  const operation = independentOperation(stage, token, accountIndex);
  const entityVersion = operation === 'push'
    ? nextIndependentEntityVersion(stage, token, accountIndex)
    : null;
  const request = requestFor(
    operation,
    stage,
    token,
    iteration,
    accountIndex,
    entityVersion,
  );
  requestsStarted.add(1, {
    stage: stage.name,
    profile,
    executionModel,
    operation: request.operation,
  });
  const [method, url, body, params] = request.request;
  const response = http.request(method, url, body, params);
  recordResponse(response, request, stage);
}
