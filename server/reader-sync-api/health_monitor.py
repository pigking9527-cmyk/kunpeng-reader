#!/usr/bin/env python3
"""Content-free local health, metrics, and database monitor."""

import argparse
import json
import os
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def fetch(url):
    for attempt in range(3):
        try:
            with OPENER.open(url, timeout=5) as response:
                return response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            if error.code not in (429, 503) or attempt == 2:
                raise
            delay = min(5, max(1, int(error.headers.get("Retry-After", "1") or 1)))
            time.sleep(delay)
    raise RuntimeError("unreachable")


def metrics(text):
    result = {}
    for line in text.splitlines():
        if not line or line.startswith("#") or " " not in line:
            continue
        name, value = line.rsplit(" ", 1)
        try:
            result[name] = float(value)
        except ValueError:
            continue
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8787")
    parser.add_argument("--database")
    parser.add_argument("--max-active", type=int, default=28)
    parser.add_argument("--max-average-ms", type=float, default=500.0)
    args = parser.parse_args()
    parsed = urllib.parse.urlparse(args.base)
    if parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("monitor target must be loopback")

    health = json.loads(fetch(args.base + "/health"))
    observed = metrics(fetch(args.base + "/internal/metrics"))
    database_status = {}
    postgres_url = os.environ.get("SYNC_DATABASE_URL", "").strip()
    if postgres_url:
        import psycopg

        with psycopg.connect(postgres_url, connect_timeout=5) as conn:
            version, checksums, recovering = conn.execute(
                "SELECT current_setting('server_version'),"
                "current_setting('data_checksums'),pg_is_in_recovery()"
            ).fetchone()
            conn.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()
        database_status = {
            "backend": "postgresql",
            "version": version,
            "checksums": checksums,
            "recovering": recovering,
        }
    else:
        if not args.database:
            raise SystemExit("--database is required for SQLite")
        conn = sqlite3.connect(
            f"file:{os.path.abspath(args.database)}?mode=ro", uri=True
        )
        quick_check = conn.execute("PRAGMA quick_check").fetchone()[0]
        conn.close()
        database_status = {"backend": "sqlite", "quickCheck": quick_check}

    requests = observed.get("reader_sync_requests_total", 0.0)
    duration = observed.get("reader_sync_request_duration_seconds_total", 0.0)
    average_ms = duration * 1000.0 / requests if requests else 0.0
    active = observed.get("reader_sync_active_requests", 0.0)
    failures = []
    if not health.get("ok"):
        failures.append("health")
    if database_status["backend"] == "postgresql":
        if database_status["checksums"] != "on" or database_status["recovering"]:
            failures.append("postgresql")
    elif database_status["quickCheck"] != "ok":
        failures.append("sqlite")
    if active > args.max_active:
        failures.append("active_requests")
    if requests >= 20 and average_ms > args.max_average_ms:
        failures.append("average_latency")
    output = {
        "ok": not failures,
        "apiVersion": health.get("api_version", ""),
        "activeRequests": int(active),
        "averageMs": round(average_ms, 2),
        "database": database_status,
        "failures": failures,
    }
    print(json.dumps(output, separators=(",", ":"), sort_keys=True))
    raise SystemExit(0 if not failures else 1)


if __name__ == "__main__":
    main()
