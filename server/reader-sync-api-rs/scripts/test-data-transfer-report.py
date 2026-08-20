#!/usr/bin/env python3
"""Regression checks for the aggregate-only bulk transfer reporter."""

import json
import os
import subprocess
import tempfile


root = os.path.dirname(os.path.abspath(__file__))
with tempfile.TemporaryDirectory() as temporary:
    summary = os.path.join(temporary, "summary.json")
    output = os.path.join(temporary, "report.json")
    with open(summary, "w", encoding="utf-8") as destination:
        json.dump({"metrics": {
            "sync_data_duration{stage:bulk-transfer,profile:bulk-entity-256k-v2}": {
                "med": 20, "p(95)": 40, "p(99)": 60},
            "sync_data_successful_duration{stage:bulk-transfer,profile:bulk-entity-256k-v2}": {
                "med": 21, "p(95)": 41, "p(99)": 61},
            "sync_data_responses{stage:bulk-transfer,profile:bulk-entity-256k-v2,operation:push,status:200}": {
                "count": 3},
            "sync_data_responses{stage:bulk-transfer,profile:bulk-entity-256k-v2,operation:pull,status:503}": {
                "count": 1},
            "sync_data_upload_bytes{stage:bulk-transfer,profile:bulk-entity-256k-v2,operation:push}": {
                "count": 1048576},
            "sync_data_download_bytes{stage:bulk-transfer,profile:bulk-entity-256k-v2,operation:pull}": {
                "count": 2097152},
        }}, destination)
    subprocess.run([
        "python3", os.path.join(root, "data-transfer-report.py"),
        "--summary", summary, "--output", output,
        "--profile", "bulk-entity-256k-v2",
    ], check=True)
    report = json.load(open(output, encoding="utf-8"))
    assert report["measurementComplete"] is True
    assert report["requests"] == 4
    assert report["successfulRequests"] == 3
    assert report["p99Ms"] == 60.0
    assert report["successfulP99Ms"] == 61.0
    assert report["uploadMiB"] == 1.0
    assert report["downloadMiB"] == 2.0

print("data transfer reporter self-test passed")
