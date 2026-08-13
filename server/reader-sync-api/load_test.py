#!/usr/bin/env python3
"""Bounded local HTTP load probe for the reader sync service.

Only localhost is accepted by default. The probe uses an existing test token
passed through the environment and never prints it or any entity payload.
"""

import argparse
import concurrent.futures
import json
import os
import statistics
import time
import urllib.parse
import urllib.request

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def percentile(values, ratio):
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int((len(ordered) - 1) * ratio))]


def request(base, path, token):
    started = time.monotonic()
    request = urllib.request.Request(
        base + path,
        headers={"Authorization": f"Bearer {token}"} if token else {},
    )
    try:
        with OPENER.open(request, timeout=15) as response:
            response.read()
            return response.status, time.monotonic() - started
    except Exception as error:
        status = int(getattr(error, "code", 0) or 0)
        return status, time.monotonic() - started


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8787")
    parser.add_argument("--path", default="/health")
    parser.add_argument("--requests", type=int, default=200)
    parser.add_argument("--concurrency", type=int, default=20)
    args = parser.parse_args()
    parsed = urllib.parse.urlparse(args.base)
    if parsed.hostname not in ("127.0.0.1", "localhost", "::1") and os.environ.get("ALLOW_REMOTE_LOAD_TEST") != "1":
        raise SystemExit("remote targets require ALLOW_REMOTE_LOAD_TEST=1")
    total = max(1, min(args.requests, 10_000))
    workers = max(1, min(args.concurrency, 256))
    token = os.environ.get("SYNC_LOAD_TEST_TOKEN", "")
    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        results = list(executor.map(lambda _: request(args.base, args.path, token), range(total)))
    elapsed = time.monotonic() - started
    statuses = {}
    durations = []
    for status, duration in results:
        statuses[str(status)] = statuses.get(str(status), 0) + 1
        durations.append(duration)
    print(json.dumps({
        "requests": total,
        "concurrency": workers,
        "elapsedSeconds": round(elapsed, 3),
        "requestsPerSecond": round(total / elapsed, 2),
        "meanMs": round(statistics.mean(durations) * 1000, 2),
        "p50Ms": round(percentile(durations, 0.50) * 1000, 2),
        "p95Ms": round(percentile(durations, 0.95) * 1000, 2),
        "p99Ms": round(percentile(durations, 0.99) * 1000, 2),
        "statuses": statuses,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
