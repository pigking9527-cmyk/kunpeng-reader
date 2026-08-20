import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

// This is intentionally a five-minute data-transfer smoke, not a capacity
// conclusion.  It uses the same 2048 independently authenticated disposable
// accounts as the capacity runner, but gives every account one moderately
// sized entity and alternates writes with full cursor-zero reads of that
// entity.  No production endpoint or normal account can be selected by the
// guarded runner.
const tokensPath = __ENV.SYNC_LOAD_TEST_TOKENS_FILE;
const base = __ENV.SYNC_LOAD_TEST_BASE;
if (!tokensPath || !base) {
  throw new Error('data-transfer smoke requires a token file and base URL');
}
const tokens = open(tokensPath)
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter(Boolean);
if (tokens.length < 2048 || new Set(tokens).size !== tokens.length) {
  throw new Error('data-transfer smoke requires at least 2048 unique test tokens');
}

const durationSeconds = 300;
// Eight simultaneous 256 KiB bodies keep this a sustained wire/data-path
// smoke (roughly 2 MiB in flight), rather than turning the five-minute check
// into a request-timeout test of the small development host.
const concurrency = 8;
// Revisit a small, independent cohort after every eight batches.  The first
// visit seeds it, then later visits alternate pull and update.  A full 2048
// account fixture remains required by the guarded runner, but a five-minute
// data-path smoke must revisit accounts inside that window to exercise both
// directions without turning a single account into a rate-limit test.
const cohortCount = 8;
const entityPayloadBytes = 256 * 1024;
const stage = 'bulk-transfer';
const profile = 'bulk-entity-256k-v2';
const responses = new Counter('sync_data_responses');
const noResponses = new Counter('sync_data_no_response');
const push2xx = new Counter('sync_data_push_http_2xx');
const push4xx = new Counter('sync_data_push_http_4xx');
const push5xx = new Counter('sync_data_push_http_5xx');
const pushOther = new Counter('sync_data_push_http_other');
const pull2xx = new Counter('sync_data_pull_http_2xx');
const pull4xx = new Counter('sync_data_pull_http_4xx');
const pull5xx = new Counter('sync_data_pull_http_5xx');
const pullOther = new Counter('sync_data_pull_http_other');
const uploadBytes = new Counter('sync_data_upload_bytes');
const downloadBytes = new Counter('sync_data_download_bytes');
const duration = new Trend('sync_data_duration', true);
const successfulDuration = new Trend('sync_data_successful_duration', true);
const expectedSuccess = http.expectedStatuses(200);
const runEpoch = Date.now();
const states = new Map();
let batchNumber = 0;

// A deterministic pseudo-random payload avoids testing PostgreSQL's TOAST
// compression of a repeated character rather than the intended wire size.
function payloadText(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let state = 0x4d595df4;
  const pieces = new Array(bytes);
  for (let index = 0; index < bytes; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    pieces[index] = alphabet[state & 63];
  }
  return pieces.join('');
}

const entityPayload = payloadText(entityPayloadBytes);

export const options = {
  scenarios: {
    bulk_transfer: {
      executor: 'constant-vus',
      vus: 1,
      duration: `${durationSeconds}s`,
      gracefulStop: '0s',
    },
  },
  batch: concurrency,
  batchPerHost: concurrency,
  discardResponseBodies: true,
  summaryTrendStats: ['med', 'p(95)', 'p(99)'],
  systemTags: ['status', 'scenario'],
  thresholds: {
    [`sync_data_duration{stage:${stage},profile:${profile}}`]: ['p(99)<600000'],
    [`sync_data_successful_duration{stage:${stage},profile:${profile}}`]: ['p(99)<600000'],
  },
};

function stateFor(index) {
  let value = states.get(index);
  if (!value) {
    value = { seeded: false, nextPull: false, version: 0 };
    states.set(index, value);
  }
  return value;
}

function mutationId(batch, index) {
  const suffix = ((batch * 10000) + index).toString(16).padStart(12, '0').slice(-12);
  return `b19b5719-4a85-4cf7-9e5f-${suffix}`;
}

function pushRequest(token, index, value, batch) {
  value.version += 1;
  const body = JSON.stringify({
    mutationId: mutationId(batch, index),
    dataGeneration: 1,
    entities: [{
      id: `bulk-data-${index}`,
      kind: 'reading_data_v1',
      updatedAt: runEpoch + batch,
      deletedAt: 0,
      deviceId: 'data-transfer-k6',
      syncVersion: value.version,
      payload: { transferSample: entityPayload },
    }],
  });
  return {
    index,
    value,
    operation: 'push',
    requestBytes: body.length,
    request: ['POST', `${base}/v1/sync/push`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Sync-Protocol-Version': '5',
        'Content-Type': 'application/json',
      },
      tags: { stage, profile, operation: 'push' },
      responseCallback: expectedSuccess,
      timeout: '5s',
    }],
  };
}

function pullRequest(token, index, value) {
  return {
    index,
    value,
    operation: 'pull',
    requestBytes: 0,
    request: ['GET', `${base}/v1/sync/pull?cursor=0&limit=10`, null, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Sync-Protocol-Version': '5',
      },
      tags: { stage, profile, operation: 'pull' },
      responseCallback: expectedSuccess,
      responseType: 'text',
      timeout: '5s',
    }],
  };
}

function record(response, request) {
  const tags = { stage, profile, operation: request.operation };
  const status = String(response.status);
  responses.add(1, { ...tags, status });
  duration.add(response.timings.duration, tags);
  if (response.status === 0) {
    noResponses.add(1, { ...tags, error: String(response.error_code || 'unknown') });
    return;
  }
  const outcome = response.status >= 200 && response.status < 300
    ? '2xx'
    : response.status >= 400 && response.status < 500
      ? '4xx'
      : response.status >= 500 && response.status < 600
        ? '5xx'
        : 'other';
  const outcomeCounter = request.operation === 'push'
    ? ({ '2xx': push2xx, '4xx': push4xx, '5xx': push5xx, other: pushOther })[outcome]
    : ({ '2xx': pull2xx, '4xx': pull4xx, '5xx': pull5xx, other: pullOther })[outcome];
  outcomeCounter.add(1);
  if (response.status < 200 || response.status >= 300) {
    return;
  }
  successfulDuration.add(response.timings.duration, tags);
  uploadBytes.add(request.requestBytes, tags);
  if (request.operation === 'pull') {
    const received = response.body ? response.body.length : Number(response.headers['Content-Length'] || 0);
    downloadBytes.add(Number.isFinite(received) ? received : 0, tags);
  }
  request.value.seeded = true;
  request.value.nextPull = request.operation === 'push';
}

export default function () {
  const start = ((batchNumber % cohortCount) * concurrency) % tokens.length;
  const requests = Array.from({ length: concurrency }, (_, offset) => {
    const index = (start + offset) % tokens.length;
    const value = stateFor(index);
    return value.seeded && value.nextPull
      ? pullRequest(tokens[index], index, value)
      : pushRequest(tokens[index], index, value, batchNumber);
  });
  batchNumber += 1;
  http.batch(requests.map((request) => request.request))
    .forEach((response, index) => record(response, requests[index]));
}
