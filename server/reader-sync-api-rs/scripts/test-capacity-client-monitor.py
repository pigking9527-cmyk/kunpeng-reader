#!/usr/bin/env python3
"""Offline checks for the cross-platform capacity client monitor."""

import importlib.util
import os
from pathlib import Path


SCRIPT = Path(__file__).with_name("capacity-client-monitor.py")
SPEC = importlib.util.spec_from_file_location("capacity_client_monitor", SCRIPT)
assert SPEC and SPEC.loader
monitor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(monitor)


summary = monitor.summarize([
    {"clientCpuPercent": 10.0, "clientRssKiB": 100, "memAvailableKiB": 300},
    {"clientCpuPercent": 30.0, "clientRssKiB": 200, "memAvailableKiB": 250},
])
assert summary == {
    "samples": 2,
    "clientCpuMeanPercent": 20.0,
    "clientCpuMaxPercent": 30.0,
    "clientRssMaxKiB": 200,
    "memAvailableMinKiB": 250,
}
assert monitor.summarize([]) == {}
available = monitor.memory_available_kib()
assert available is None or available > 0
measured = monitor.sample(os.getpid())
assert measured is not None
assert measured["clientCpuPercent"] >= 0
assert measured["clientRssKiB"] > 0
assert measured["memAvailableKiB"] is None or measured["memAvailableKiB"] > 0

print("capacity client monitor self-test passed")
