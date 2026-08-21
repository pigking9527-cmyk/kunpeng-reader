#!/usr/bin/env python3
"""Produces an aggregate-only report for the isolated bulk data smoke."""

import argparse
import json
import os


def parse_metric(name):
    if "{" not in name:
        return name, {}
    base, raw = name.split("{", 1)
    tags = {}
    for piece in raw.rstrip("}").split(","):
        if ":" in piece:
            key, value = piece.split(":", 1)
            tags[key] = value
    return base, tags


def values(metric):
    return metric.get("values", metric) if isinstance(metric, dict) else {}


def number(metric, key):
    value = metric.get(key, 0) if isinstance(metric, dict) else 0
    return round(float(value), 2) if isinstance(value, (int, float)) else 0.0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--summary", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--stage-seconds", type=int, default=300)
    args = parser.parse_args()
    if not os.path.isabs(args.summary) or not os.path.isabs(args.output):
        raise SystemExit("summary and output paths must be absolute")
    if args.stage_seconds != 300:
        raise SystemExit("bulk data smoke is fixed at 300 seconds")
    with open(args.summary, encoding="utf-8") as source:
        metrics = json.load(source).get("metrics", {})
    statuses, operations = {}, {}
    total_duration = successful_duration = {}
    upload = download = 0
    no_response = 0
    for name, metric in metrics.items():
        base, tags = parse_metric(name)
        current = values(metric)
        # k6 summary exports fixed Counter names without the request tags.
        # Consume those first; tagged trends below keep the latency series
        # scoped to this workload.
        if base.startswith("sync_data_") and "_http_" in base:
            _, _, operation, _, outcome = base.split("_", 4)
            statuses[f"{operation}-{outcome}"] = int(current.get("count", 0))
            operations[operation] = operations.get(operation, 0) + int(current.get("count", 0))
            continue
        if base == "sync_data_no_response" and not tags:
            no_response += int(current.get("count", 0))
            continue
        if base == "sync_data_upload_bytes" and not tags:
            upload += int(current.get("count", 0))
            continue
        if base == "sync_data_download_bytes" and not tags:
            download += int(current.get("count", 0))
            continue
        if tags.get("stage") != "bulk-transfer":
            continue
        if tags.get("profile") not in (None, args.profile):
            raise SystemExit("summary profile mismatch")
        if base == "sync_data_responses":
            count = int(current.get("count", 0))
            status = tags.get("status", "unknown")
            operation = tags.get("operation", "unknown")
            statuses[status] = statuses.get(status, 0) + count
            operations[operation] = operations.get(operation, 0) + count
        elif base == "sync_data_no_response":
            no_response += int(current.get("count", 0))
        elif base == "sync_data_duration":
            total_duration = current
        elif base == "sync_data_successful_duration":
            successful_duration = current
        elif base == "sync_data_upload_bytes":
            upload += int(current.get("count", 0))
        elif base == "sync_data_download_bytes":
            download += int(current.get("count", 0))
    # Tagged Counter submetrics are intentionally not retained by every k6
    # summary version.  Fixed operation/outcome counters below are therefore
    # the authoritative status aggregate; tagged names only enrich a future
    # summary implementation.
    outcome_total = sum(
        count for status, count in statuses.items()
        if status.endswith(("-2xx", "-4xx", "-5xx", "-other"))
    )
    total = outcome_total or sum(statuses.values())
    successful = sum(count for status, count in statuses.items() if status.endswith("-2xx"))
    if not successful:
        successful = sum(count for status, count in statuses.items() if status.isdecimal() and 200 <= int(status) < 300)
    output = {
        "complete": True,
        "measurementComplete": total > 0,
        "profile": args.profile,
        "workloadClass": "bulk-data-smoke",
        "plannedSeconds": args.stage_seconds,
        "requests": total,
        "successfulRequests": successful,
        "successfulRequestsPerSecond": round(successful / args.stage_seconds, 2),
        "statuses": statuses,
        "byOperation": operations,
        "noResponse": no_response,
        "p50Ms": number(total_duration, "med"),
        "p95Ms": number(total_duration, "p(95)"),
        "p99Ms": number(total_duration, "p(99)"),
        "successfulP50Ms": number(successful_duration, "med"),
        "successfulP95Ms": number(successful_duration, "p(95)"),
        "successfulP99Ms": number(successful_duration, "p(99)"),
        "uploadBytes": upload,
        "downloadBytes": download,
        "uploadMiB": round(upload / (1024 * 1024), 2),
        "downloadMiB": round(download / (1024 * 1024), 2),
        "uploadMiBPerSecond": round(upload / (1024 * 1024 * args.stage_seconds), 2),
        "downloadMiBPerSecond": round(download / (1024 * 1024 * args.stage_seconds), 2),
    }
    temporary = f"{args.output}.partial-{os.getpid()}"
    with open(temporary, "w", encoding="utf-8") as destination:
        json.dump(output, destination, separators=(",", ":"))
    os.replace(temporary, args.output)


if __name__ == "__main__":
    main()
