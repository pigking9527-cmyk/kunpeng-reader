#!/usr/bin/env python3
"""Bounded capacity probe for a disposable v5 service.

The runner receives a test-session token through the environment. It never
prints the token, request body, account identity, database URL, or host path.
"""

import argparse
import asyncio
import contextlib
import json
import os
import random
import resource
import ssl
import statistics
import sys
import threading
import time
import urllib.parse
import uuid


# Fixed 20-minute sequence. It restores a low-concurrency baseline before
# deliberately stepping through 500 concurrent clients and recovery.
STAGES = (("baseline", 5, 60), ("elevated", 75, 180),
          ("peak", 150, 180), ("stress-200", 200, 210),
          ("stress-250", 250, 60), ("stress-300", 300, 60),
          ("stress-350", 350, 60), ("stress-400", 400, 60),
          ("stress-450", 450, 90), ("stress-500", 500, 150),
          ("recovery", 25, 90))
SYNC_HEADER = "X-Sync-Protocol-Version"


def percentile(values, ratio):
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int((len(ordered) - 1) * ratio))]


def self_rss_kib():
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return value // 1024 if sys.platform == "darwin" else value


class Monitor:
    def __init__(self, stages):
        self.stop = threading.Event()
        self.samples = []
        self.stages = stages
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()

    def close(self):
        self.stop.set()
        self.thread.join(timeout=2)

    def _run(self):
        last_cpu = resource.getrusage(resource.RUSAGE_SELF)
        last_total_cpu = last_cpu.ru_utime + last_cpu.ru_stime
        last_wall = time.monotonic()
        while not self.stop.wait(1):
            now = time.monotonic()
            usage = resource.getrusage(resource.RUSAGE_SELF)
            total_cpu = usage.ru_utime + usage.ru_stime
            elapsed = max(now - last_wall, 0.001)
            self.samples.append({
                "stage": stage_name(now - self.started, self.stages),
                "clientCpuPercent": round(100 * (total_cpu - last_total_cpu) / elapsed, 2),
                "clientRssKiB": self_rss_kib(),
            })
            last_total_cpu, last_wall = total_cpu, now

    def summary(self, samples=None):
        samples = self.samples if samples is None else samples
        if not samples:
            return {}
        def values(key):
            return [sample[key] for sample in samples]
        return {
            "samples": len(samples),
            "clientCpuMeanPercent": round(statistics.mean(values("clientCpuPercent")), 2),
            "clientCpuMaxPercent": round(max(values("clientCpuPercent")), 2),
            "clientRssMaxKiB": max(values("clientRssKiB")),
        }


def stage_name(elapsed, stages):
    boundary = 0
    for name, _concurrency, seconds in stages:
        boundary += seconds
        if elapsed < boundary:
            return name
    return "after"


async def request(base, operation, token, body, deadline):
    """Make one cancellable HTTP/1.1 request without inheriting proxy settings.

    The former thread/urllib runner could leave a blocked socket alive past a
    stage boundary.  Async cancellation closes the stream at that boundary,
    so the published 20-minute schedule is a real wall-clock contract.
    """
    if operation == "pull":
        path, data = "/v1/sync/pull?cursor=0&limit=50", None
    elif operation == "inventory":
        path, data = "/v1/sync/inventory", None
    else:
        path, data = "/v1/sync/push", body
    parsed = urllib.parse.urlparse(base)
    headers = {
        "Host": parsed.netloc,
        "Authorization": f"Bearer {token}",
        SYNC_HEADER: "5",
        "Connection": "close",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    started = time.monotonic()
    remaining_stage_seconds = deadline - started
    if remaining_stage_seconds <= 0:
        return operation, "stage_cutoff", 0.0, None
    timeout_seconds = min(15, remaining_stage_seconds)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    tls = (ssl.create_default_context() if parsed.scheme == "https" else None)
    writer = None
    try:
        async with asyncio.timeout(timeout_seconds):
            reader, writer = await asyncio.open_connection(
                parsed.hostname,
                port,
                ssl=tls,
                server_hostname=parsed.hostname if tls else None,
            )
            request_lines = [
                f"{'POST' if data is not None else 'GET'} {path} HTTP/1.1",
                *(f"{name}: {value}" for name, value in headers.items()),
            ]
            if data is not None:
                request_lines.append(f"Content-Length: {len(data)}")
            writer.write(("\r\n".join(request_lines) + "\r\n\r\n").encode())
            if data is not None:
                writer.write(data)
            await writer.drain()
            status_line = await reader.readline()
            fields = status_line.decode("ascii", "replace").split()
            if len(fields) < 2 or not fields[1].isdecimal():
                raise ConnectionError("malformed HTTP response")
            for _ in range(128):
                line = await reader.readline()
                if not line or line == b"\r\n":
                    break
            return operation, fields[1], time.monotonic() - started, None
    except TimeoutError:
        elapsed = time.monotonic() - started
        status = "stage_cutoff" if time.monotonic() >= deadline - 0.01 else "no_response"
        return operation, status, elapsed, "TimeoutError"
    except Exception as error:
        return operation, "no_response", time.monotonic() - started, type(error).__name__
    finally:
        if writer is not None:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()


def push_body(run_id, worker_index, request_index, now_ms):
    """Creates a fresh sync-batch key without growing test payloads.

    A real client creates one mutation id per push batch.  Reusing one id here
    exercised only the replay/conflict path, so every request gets a stable,
    deterministic id unique to this test run and worker sequence.  The entity
    itself stays unchanged after its first accepted write, preventing a load
    test from manufacturing unnecessary quota consumption.
    """
    mutation_id = uuid.uuid5(run_id, f"worker:{worker_index}:push:{request_index}")
    return json.dumps({
        "mutationId": str(mutation_id),
        "dataGeneration": 1,
        "entities": [{
            "id": f"capacity-probe-entity-{worker_index}",
            "kind": "reading_progress_v1",
            "updatedAt": now_ms,
            "deletedAt": 0,
            "deviceId": "capacity-probe-device",
            "syncVersion": 1,
            "payload": {"progress": 0.5},
        }],
    }, separators=(",", ":")).encode()


async def stage_async(bases, token, run_id, now_ms, concurrency, seconds):
    deadline = time.monotonic() + seconds
    results = []

    async def worker(worker_index):
        local = []
        pick = random.Random(worker_index)
        base = bases[worker_index % len(bases)]
        push_index = 0
        # Bring a stage up over two seconds instead of scheduling hundreds of
        # TCP handshakes on the same event-loop tick.  The remaining 28+ sec
        # are sustained configured concurrency, while the measurement no
        # longer mistakes a synthetic SYN burst for application throughput.
        ramp_seconds = min(2.0, seconds / 10)
        if ramp_seconds:
            await asyncio.sleep(ramp_seconds * worker_index / concurrency)
        while time.monotonic() < deadline:
            value = pick.randrange(20)
            operation = "pull" if value < 14 else ("push" if value < 19 else "inventory")
            body = None
            if operation == "push":
                body = push_body(run_id, worker_index, push_index, now_ms)
                push_index += 1
            local.append(await request(base, operation, token, body, deadline))
        return local

    for local in await asyncio.gather(*(worker(index) for index in range(concurrency))):
        results.extend(local)
    def summarize(operation_results):
        statuses, failures, durations = {}, {}, []
        for _operation, status, elapsed, failure in operation_results:
            statuses[status] = statuses.get(status, 0) + 1
            if failure is not None:
                failures[failure] = failures.get(failure, 0) + 1
            # Latency percentiles describe completed HTTP responses. Timeouts
            # and connection failures remain separately visible below.
            if status.isdecimal():
                durations.append(elapsed * 1000)
        return {
            "requests": len(operation_results),
            "statuses": statuses,
            "failureClasses": failures,
            "noResponse": statuses.get("no_response", 0),
            "stageCutoff": statuses.get("stage_cutoff", 0),
            "p50Ms": round(percentile(durations, 0.50), 2),
            "p95Ms": round(percentile(durations, 0.95), 2),
            "p99Ms": round(percentile(durations, 0.99), 2),
        }

    by_operation = {}
    per_operation = {}
    for operation in ("pull", "push", "inventory"):
        operation_results = [result for result in results if result[0] == operation]
        by_operation[operation] = len(operation_results)
        per_operation[operation] = summarize(operation_results)

    summary = summarize(results)
    return {
        "requests": summary["requests"],
        "byOperation": by_operation,
        "operationMetrics": per_operation,
        "statuses": summary["statuses"],
        "failureClasses": summary["failureClasses"],
        "noResponse": summary["noResponse"],
        "stageCutoff": summary["stageCutoff"],
        "p50Ms": summary["p50Ms"],
        "p95Ms": summary["p95Ms"],
        "p99Ms": summary["p99Ms"],
    }


def stage(bases, token, run_id, now_ms, concurrency, seconds):
    return asyncio.run(stage_async(bases, token, run_id, now_ms, concurrency, seconds))


def save_report(path, report):
    """Atomically checkpoint aggregate-only metrics after every stage."""
    temporary = f"{path}.partial-{os.getpid()}"
    with open(temporary, "w", encoding="utf-8") as destination:
        json.dump(report, destination, separators=(",", ":"))
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", action="append", required=True,
                        help="repeat a localhost tunnel URL or explicitly approved test target")
    parser.add_argument("--allow-external-test-target", action="store_true",
                        help="required for a temporary source-firewalled test endpoint")
    parser.add_argument("--output", required=True)
    parser.add_argument("--stage-seconds", type=int,
                        help="explicit short-run override; each fixed stage lasts this many seconds")
    args = parser.parse_args()
    for base in args.base:
        parsed = urllib.parse.urlparse(base)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise SystemExit("each capacity target must be an absolute HTTP(S) URL")
        if parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query:
            raise SystemExit("capacity target must not include credentials, a path, or a query")
        local = parsed.hostname in ("127.0.0.1", "localhost", "::1")
        if not local and not args.allow_external_test_target:
            raise SystemExit("external target requires --allow-external-test-target")
    if args.stage_seconds is not None and not (30 <= args.stage_seconds <= 300):
        raise SystemExit("stage-seconds must be between 30 and 300")
    stages = (STAGES if args.stage_seconds is None else
              tuple((name, concurrency, args.stage_seconds)
                    for name, concurrency, _seconds in STAGES))
    token = os.environ.get("SYNC_LOAD_TEST_TOKEN", "")
    if len(token) < 32:
        raise SystemExit("test session token is missing")
    now_ms = int(time.time() * 1000)
    run_id = uuid.uuid4()
    monitor = Monitor(stages)
    started = time.monotonic()
    monitor.started = started
    monitor.start()
    output = {
        "complete": False,
        "totalPlannedSeconds": sum(stage[2] for stage in stages),
        "stages": [],
    }
    try:
        for name, concurrency, seconds in stages:
            result = stage(args.base, token, run_id, now_ms, concurrency, seconds)
            result.update({"name": name, "concurrency": concurrency, "plannedSeconds": seconds})
            output["stages"].append(result)
            output["elapsedSeconds"] = round(time.monotonic() - started, 2)
            output["clientHardware"] = {
                "overall": monitor.summary(),
                "byStage": {
                    stage_name: monitor.summary(samples)
                    for stage_name, _concurrency, _seconds in stages
                    for samples in [[
                        sample for sample in monitor.samples
                        if sample["stage"] == stage_name
                    ]]
                },
            }
            save_report(args.output, output)
    finally:
        monitor.close()
    output["elapsedSeconds"] = round(time.monotonic() - started, 2)
    output["clientHardware"] = {
        "overall": monitor.summary(),
        "byStage": {
            name: monitor.summary(samples)
            for name, _concurrency, _seconds in stages
            for samples in [[sample for sample in monitor.samples if sample["stage"] == name]]
        },
    }
    output["complete"] = True
    save_report(args.output, output)


if __name__ == "__main__":
    main()
