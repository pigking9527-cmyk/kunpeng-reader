#!/usr/bin/env python3
"""Records aggregate CPU/RSS samples for the local k6 load process."""

import argparse
import json
import os
import re
import statistics
import subprocess
import time


STAGES = (
    ("baseline", 60), ("elevated", 180), ("peak", 180),
    ("stress-200", 210), ("stress-250", 60), ("stress-300", 60),
    ("stress-350", 60), ("stress-400", 60), ("stress-450", 90),
    ("stress-500", 150), ("recovery", 90),
)


def stage_name(elapsed, stages):
    boundary = 0
    for name, seconds in stages:
        boundary += seconds
        if elapsed < boundary:
            return name
    return "after"


def sample(pid):
    result = subprocess.run(
        ["ps", "-o", "%cpu=", "-o", "rss=", "-p", str(pid)],
        check=False, capture_output=True, text=True,
    )
    fields = result.stdout.split()
    if len(fields) != 2:
        return None
    return {"clientCpuPercent": round(float(fields[0]), 2), "clientRssKiB": int(fields[1])}


def summarize(samples):
    if not samples:
        return {}
    return {
        "samples": len(samples),
        "clientCpuMeanPercent": round(statistics.mean(row["clientCpuPercent"] for row in samples), 2),
        "clientCpuMaxPercent": round(max(row["clientCpuPercent"] for row in samples), 2),
        "clientRssMaxKiB": max(row["clientRssKiB"] for row in samples),
    }


def write_report(path, report):
    temporary = f"{path}.partial-{os.getpid()}"
    with open(temporary, "w", encoding="utf-8") as destination:
        json.dump(report, destination, separators=(",", ":"))
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", required=True, type=int)
    parser.add_argument("--seconds", required=True, type=int)
    parser.add_argument("--output", required=True)
    parser.add_argument("--stage-seconds", type=int)
    parser.add_argument("--single-stage", action="store_true")
    parser.add_argument("--single-stage-name", default="bulk-transfer")
    args = parser.parse_args()
    if not os.path.isabs(args.output) or os.path.exists(args.output):
        raise SystemExit("output path must be a new absolute path")
    if args.stage_seconds is not None and not (30 <= args.stage_seconds <= 300):
        raise SystemExit("stage-seconds must be between 30 and 300")
    if args.single_stage:
        if args.stage_seconds is not None:
            raise SystemExit("single-stage monitoring must not set stage-seconds")
        if not re.fullmatch(r"[a-z0-9-]{1,48}", args.single_stage_name):
            raise SystemExit("single-stage-name must be a safe metric label")
        stages = ((args.single_stage_name, args.seconds),)
    else:
        stages = tuple((name, args.stage_seconds if args.stage_seconds else seconds) for name, seconds in STAGES)
    if args.seconds != sum(seconds for _name, seconds in stages):
        raise SystemExit("seconds must match selected stage schedule")
    started, samples = time.monotonic(), []
    while time.monotonic() - started < args.seconds:
        time.sleep(1)
        measured = sample(args.pid)
        if measured:
            measured["stage"] = stage_name(time.monotonic() - started, stages)
            samples.append(measured)
            write_report(args.output, {
                "complete": False,
                "hardware": {
                    "overall": summarize(samples),
                    "byStage": {name: summarize([row for row in samples if row["stage"] == name]) for name, _ in stages},
                },
            })
    write_report(args.output, {
        "complete": True,
        "hardware": {
            "overall": summarize(samples),
            "byStage": {name: summarize([row for row in samples if row["stage"] == name]) for name, _ in stages},
        },
    })


if __name__ == "__main__":
    main()
