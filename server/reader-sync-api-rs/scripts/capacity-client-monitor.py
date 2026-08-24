#!/usr/bin/env python3
"""Records aggregate CPU/RSS samples for the local k6 load process."""

import argparse
import ctypes
import json
import os
import re
import statistics
import subprocess
import time


_WINDOWS_PROCESS_SAMPLES = {}


if os.name == "nt":
    from ctypes import wintypes

    class _FileTime(ctypes.Structure):
        _fields_ = (("low", wintypes.DWORD), ("high", wintypes.DWORD))

    class _ProcessMemoryCounters(ctypes.Structure):
        _fields_ = (
            ("cb", wintypes.DWORD),
            ("page_fault_count", wintypes.DWORD),
            ("peak_working_set_size", ctypes.c_size_t),
            ("working_set_size", ctypes.c_size_t),
            ("quota_peak_paged_pool_usage", ctypes.c_size_t),
            ("quota_paged_pool_usage", ctypes.c_size_t),
            ("quota_peak_non_paged_pool_usage", ctypes.c_size_t),
            ("quota_non_paged_pool_usage", ctypes.c_size_t),
            ("pagefile_usage", ctypes.c_size_t),
            ("peak_pagefile_usage", ctypes.c_size_t),
        )

    class _MemoryStatusEx(ctypes.Structure):
        _fields_ = (
            ("length", wintypes.DWORD),
            ("memory_load", wintypes.DWORD),
            ("total_phys", ctypes.c_ulonglong),
            ("avail_phys", ctypes.c_ulonglong),
            ("total_page_file", ctypes.c_ulonglong),
            ("avail_page_file", ctypes.c_ulonglong),
            ("total_virtual", ctypes.c_ulonglong),
            ("avail_virtual", ctypes.c_ulonglong),
            ("avail_extended_virtual", ctypes.c_ulonglong),
        )

    _KERNEL32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _PSAPI = ctypes.WinDLL("psapi", use_last_error=True)
    _KERNEL32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    _KERNEL32.OpenProcess.restype = wintypes.HANDLE
    _KERNEL32.CloseHandle.argtypes = (wintypes.HANDLE,)
    _KERNEL32.CloseHandle.restype = wintypes.BOOL
    _KERNEL32.GetProcessTimes.argtypes = (
        wintypes.HANDLE,
        ctypes.POINTER(_FileTime), ctypes.POINTER(_FileTime),
        ctypes.POINTER(_FileTime), ctypes.POINTER(_FileTime),
    )
    _KERNEL32.GetProcessTimes.restype = wintypes.BOOL
    _KERNEL32.GlobalMemoryStatusEx.argtypes = (ctypes.POINTER(_MemoryStatusEx),)
    _KERNEL32.GlobalMemoryStatusEx.restype = wintypes.BOOL
    _PSAPI.GetProcessMemoryInfo.argtypes = (
        wintypes.HANDLE, ctypes.POINTER(_ProcessMemoryCounters), wintypes.DWORD,
    )
    _PSAPI.GetProcessMemoryInfo.restype = wintypes.BOOL


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


def _filetime_ticks(value):
    return (int(value.high) << 32) | int(value.low)


def _windows_sample(pid):
    # PROCESS_QUERY_INFORMATION | PROCESS_VM_READ. The load process runs under
    # the same desktop user, so no elevation or broad process enumeration is
    # required.
    handle = _KERNEL32.OpenProcess(0x0400 | 0x0010, False, pid)
    if not handle:
        return None
    try:
        created, exited, kernel, user = _FileTime(), _FileTime(), _FileTime(), _FileTime()
        memory = _ProcessMemoryCounters()
        memory.cb = ctypes.sizeof(memory)
        if not _KERNEL32.GetProcessTimes(
            handle, ctypes.byref(created), ctypes.byref(exited),
            ctypes.byref(kernel), ctypes.byref(user),
        ):
            return None
        if not _PSAPI.GetProcessMemoryInfo(handle, ctypes.byref(memory), memory.cb):
            return None
        now = time.monotonic()
        cpu_seconds = (_filetime_ticks(kernel) + _filetime_ticks(user)) / 10_000_000
        previous = _WINDOWS_PROCESS_SAMPLES.get(pid)
        _WINDOWS_PROCESS_SAMPLES[pid] = (now, cpu_seconds)
        cpu_percent = 0.0
        if previous is not None:
            wall = max(now - previous[0], 0.001)
            cpu_percent = max(0.0, 100 * (cpu_seconds - previous[1]) / wall)
        return {
            "clientCpuPercent": round(cpu_percent, 2),
            "clientRssKiB": int(memory.working_set_size // 1024),
        }
    finally:
        _KERNEL32.CloseHandle(handle)


def memory_available_kib():
    if os.name == "nt":
        status = _MemoryStatusEx()
        status.length = ctypes.sizeof(status)
        if _KERNEL32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return int(status.avail_phys // 1024)
        return None
    try:
        with open("/proc/meminfo", encoding="utf-8") as source:
            for line in source:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1])
    except (FileNotFoundError, OSError, ValueError):
        return None
    return None


def sample(pid):
    if os.name == "nt":
        measured = _windows_sample(pid)
        if measured is not None:
            measured["memAvailableKiB"] = memory_available_kib()
        return measured
    result = subprocess.run(
        ["ps", "-o", "%cpu=", "-o", "rss=", "-p", str(pid)],
        check=False, capture_output=True, text=True,
    )
    fields = result.stdout.split()
    if len(fields) != 2:
        return None
    return {
        "clientCpuPercent": round(float(fields[0]), 2),
        "clientRssKiB": int(fields[1]),
        "memAvailableKiB": memory_available_kib(),
    }


def summarize(samples):
    if not samples:
        return {}
    summary = {
        "samples": len(samples),
        "clientCpuMeanPercent": round(statistics.mean(row["clientCpuPercent"] for row in samples), 2),
        "clientCpuMaxPercent": round(max(row["clientCpuPercent"] for row in samples), 2),
        "clientRssMaxKiB": max(row["clientRssKiB"] for row in samples),
    }
    available = [row["memAvailableKiB"] for row in samples if row.get("memAvailableKiB") is not None]
    summary["memAvailableMinKiB"] = min(available) if available else None
    return summary


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
