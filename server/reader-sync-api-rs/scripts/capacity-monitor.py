#!/usr/bin/env python3
"""Records aggregate resource and PostgreSQL statistics for a capacity run.

The monitor is deliberately scoped to one disposable PostgreSQL database.  It
emits aggregate counters only: no connection string, address, account, SQL
text, query ID, token, request data, or filesystem path can reach its JSON
report.  ``pg_stat_statements`` is optional; when it is unavailable the report
explicitly says so rather than silently substituting a different signal.
"""

import argparse
import json
import os
import re
import statistics
import subprocess
import time
from urllib.error import URLError
from urllib.request import urlopen


STAGES = (("baseline", 60), ("elevated", 180), ("peak", 180),
          ("stress-200", 210), ("stress-250", 60), ("stress-300", 60),
          ("stress-350", 60), ("stress-400", 60), ("stress-450", 90),
          ("stress-500", 150), ("recovery", 90))

TEST_DATABASE = re.compile(r"reader_sync_rust_test_[A-Za-z0-9_]+\Z")
LOOPBACK_METRICS = re.compile(r"http://(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?/metrics\Z")
PROMETHEUS_SAMPLE = re.compile(
    r"^(?P<name>reader_sync_[A-Za-z0-9_]+)(?:\{(?P<labels>[^}]*)\})?\s+(?P<value>[-+0-9.eE]+)$"
)
METRIC_NAMES = {
    "reader_sync_request_queue_wait_seconds_bucket",
    "reader_sync_request_handler_duration_seconds_bucket",
    "reader_sync_database_pool_acquire_seconds_bucket",
    "reader_sync_database_query_seconds_bucket",
    "reader_sync_request_queue_rejections_total",
    "reader_sync_api_errors_total",
    "reader_sync_busy_rejections_total",
    "reader_sync_database_failures_total",
    "reader_sync_active_requests",
    "reader_sync_queued_requests",
    "reader_sync_database_pool_size",
    "reader_sync_database_pool_idle",
}
SAFE_METRIC_LABELS = {
    "route", "class", "lane", "operation", "phase", "outcome", "reason", "code", "source", "le"
}

# The SQL lives only in the monitor and is never copied to a report.  It
# contains neither interpolated input nor an application query: all values are
# server-maintained aggregate counters for ``current_database()``.
ACTIVITY_SNAPSHOT_SQL = """
SELECT json_build_object(
  'connections', json_build_object(
    'total', count(*),
    'active', count(*) FILTER (WHERE state = 'active'),
    'waiting', count(*) FILTER (WHERE wait_event_type IS NOT NULL),
    'idleInTransaction', count(*) FILTER (WHERE state = 'idle in transaction')
  ),
  'waitEvents', json_build_object(
    'lock', count(*) FILTER (WHERE wait_event_type = 'Lock'),
    'io', count(*) FILTER (WHERE wait_event_type = 'IO'),
    'lwLock', count(*) FILTER (WHERE wait_event_type = 'LWLock'),
    'client', count(*) FILTER (WHERE wait_event_type = 'Client'),
    'other', count(*) FILTER (
      WHERE wait_event_type IS NOT NULL
        AND wait_event_type NOT IN ('Lock', 'IO', 'LWLock', 'Client')
    )
  )
)::text
FROM pg_stat_activity
WHERE datname = current_database();
"""

STATEMENTS_AVAILABILITY_SQL = """
SELECT json_build_object(
  'available', EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
  )
)::text;
"""

STATEMENTS_AGGREGATE_SQL = """
SELECT json_build_object(
  'calls', COALESCE(sum(calls), 0),
  'totalExecMs', COALESCE(sum(total_exec_time), 0),
  'rows', COALESCE(sum(rows), 0),
  'sharedBlksHit', COALESCE(sum(shared_blks_hit), 0),
  'sharedBlksRead', COALESCE(sum(shared_blks_read), 0),
  'tempBlksRead', COALESCE(sum(temp_blks_read), 0),
  'tempBlksWritten', COALESCE(sum(temp_blks_written), 0)
)::text
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database());
"""

# This query classifies only the *already normalized* pg_stat_statements text.
# It never returns that text (nor a query ID) to Python or to a report.  The
# labels use stable table ownership rather than endpoint names, so they remain
# useful when one request performs several database operations.  `other`
# makes the totals exhaustive without creating an accidental reporting channel
# for a newly introduced statement.
STATEMENTS_CATEGORIZED_SQL = """
WITH category_catalog(category) AS (
  VALUES ('entity'), ('history'), ('receipt'), ('generation'),
         ('accountAdmission'), ('quotaOrStorage'), ('auth'), ('other')
), categorized AS (
  SELECT
    CASE
      WHEN query ILIKE '%sync_entities_v4%' THEN 'entity'
      WHEN query ILIKE '%sync_entity_history_v4%' THEN 'history'
      WHEN query ILIKE '%sync_push_receipts_v4%' THEN 'receipt'
      WHEN query ILIKE '%account_data_generations%' THEN 'generation'
      WHEN query ILIKE '%rate_limit_buckets_v4%' THEN 'accountAdmission'
      WHEN query ILIKE '%account_daily_usage_v4%'
        OR query ILIKE '%account_storage_usage_v5%' THEN 'quotaOrStorage'
      WHEN query ILIKE '%auth_sessions_v4%'
        OR query ILIKE '%users%' THEN 'auth'
      ELSE 'other'
    END AS category,
    calls,
    total_exec_time,
    rows,
    shared_blks_hit,
    shared_blks_read,
    temp_blks_read,
    temp_blks_written
  FROM pg_stat_statements
  WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
), aggregated AS (
  SELECT category,
         COALESCE(sum(calls), 0) AS calls,
         COALESCE(sum(total_exec_time), 0) AS total_exec_ms,
         COALESCE(sum(rows), 0) AS rows,
         COALESCE(sum(shared_blks_hit), 0) AS shared_blks_hit,
         COALESCE(sum(shared_blks_read), 0) AS shared_blks_read,
         COALESCE(sum(temp_blks_read), 0) AS temp_blks_read,
         COALESCE(sum(temp_blks_written), 0) AS temp_blks_written
  FROM categorized
  GROUP BY category
)
SELECT COALESCE(json_object_agg(
  category_catalog.category,
  json_build_object(
    'calls', COALESCE(aggregated.calls, 0),
    'totalExecMs', COALESCE(aggregated.total_exec_ms, 0),
    'rows', COALESCE(aggregated.rows, 0),
    'sharedBlksHit', COALESCE(aggregated.shared_blks_hit, 0),
    'sharedBlksRead', COALESCE(aggregated.shared_blks_read, 0),
    'tempBlksRead', COALESCE(aggregated.temp_blks_read, 0),
    'tempBlksWritten', COALESCE(aggregated.temp_blks_written, 0)
  )
), '{}'::json)::text
FROM category_catalog
LEFT JOIN aggregated USING (category);
"""


def cpu_totals():
    with open("/proc/stat", encoding="utf-8") as source:
        fields = next(line.split() for line in source if line.startswith("cpu "))
    values = [int(value) for value in fields[1:]]
    return sum(values), values[3] + values[4]


def mem_available_kib():
    with open("/proc/meminfo", encoding="utf-8") as source:
        for line in source:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1])
    return 0


def process_usage(pid):
    try:
        with open(f"/proc/{pid}/status", encoding="utf-8") as source:
            values = dict(
                line.rstrip().split(":", 1)
                for line in source
                if ":" in line
            )
        with open(f"/proc/{pid}/stat", encoding="utf-8") as source:
            stat = source.read().split()
        rss = int(values.get("VmRSS", "0 kB").split()[0])
        return rss, int(stat[13]) + int(stat[14])
    # `/proc/<pid>` can disappear between directory enumeration and either
    # read. Linux may surface that race as FileNotFoundError or
    # ProcessLookupError; both are OSError subclasses and mean this sample
    # should simply treat the exited process as absent.
    except (OSError, ValueError, IndexError):
        return 0, 0


def process_pss_kib(pid):
    """Return proportional-set-size for one process, if the kernel permits it.

    Summing PostgreSQL VmRSS double-counts shared_buffers across every backend.
    PSS apportions those shared mappings and is the memory figure capacity
    reports should use for interpretation.  Aggregate RSS is retained only
    under an explicit, non-memory-pressure label for compatibility audits.
    """
    try:
        with open(f"/proc/{pid}/smaps_rollup", encoding="utf-8") as source:
            for line in source:
                if line.startswith("Pss:"):
                    return int(line.split()[1])
    except (OSError, ValueError):
        pass
    return None


def postgres_usage():
    total_rss = 0
    total_pss = 0
    pss_complete = True
    total_ticks = 0
    count = 0
    for name in os.listdir("/proc"):
        if not name.isdecimal():
            continue
        try:
            with open(f"/proc/{name}/comm", encoding="utf-8") as source:
                if source.read().strip() != "postgres":
                    continue
        except OSError:
            continue
        rss, ticks = process_usage(name)
        total_rss += rss
        pss = process_pss_kib(name)
        if pss is None:
            pss_complete = False
        else:
            total_pss += pss
        total_ticks += ticks
        count += 1
    return count, total_rss, (total_pss if pss_complete else None), total_ticks


def psql_json(database, query):
    """Run one fixed aggregate query through local peer auth only.

    The database argument is guarded before it reaches ``psql``.  It is passed
    as an argv item rather than SQL interpolation, and stderr is intentionally
    discarded so database names/connection details cannot leak into reports.
    """
    if not TEST_DATABASE.fullmatch(database):
        raise ValueError("postgres database is not an approved disposable test database")
    result = subprocess.run(
        ["sudo", "-n", "-u", "postgres", "psql", "-X", "-qAt",
         "-v", "ON_ERROR_STOP=1", "-d", database, "-c", query],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError("postgres aggregate snapshot unavailable")
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise RuntimeError("postgres aggregate snapshot returned invalid data")
    try:
        payload = json.loads(lines[0])
    except json.JSONDecodeError as error:
        raise RuntimeError("postgres aggregate snapshot returned invalid JSON") from error
    if not isinstance(payload, dict):
        raise RuntimeError("postgres aggregate snapshot returned invalid shape")
    return payload


def postgres_snapshot(database):
    """Return safe before/after counters for the one disposable test database."""
    try:
        activity = psql_json(database, ACTIVITY_SNAPSHOT_SQL)
    except (RuntimeError, ValueError):
        return {
            "available": False,
            "reason": "postgres_activity_snapshot_unavailable",
        }
    try:
        statements = psql_json(database, STATEMENTS_AVAILABILITY_SQL)
    except RuntimeError:
        statements = {"available": False}
    statements_available = statements.get("available") is True
    aggregate = None
    categories = None
    if statements_available:
        try:
            aggregate = psql_json(database, STATEMENTS_AGGREGATE_SQL)
            categories = psql_json(database, STATEMENTS_CATEGORIZED_SQL)
        except RuntimeError:
            statements_available = False
    return {
        "available": True,
        "connections": activity.get("connections", {}),
        "waitEvents": activity.get("waitEvents", {}),
        "statements": {
            "available": statements_available,
            "reason": None if statements_available else "pg_stat_statements_unavailable",
            "aggregate": aggregate if statements_available else None,
            "categories": categories if statements_available else None,
        },
    }


def counter_delta(before, after):
    """Subtract aggregate counters without treating a stats reset as progress."""
    if not isinstance(before, dict) or not isinstance(after, dict):
        return None
    delta = {}
    for key, after_value in after.items():
        before_value = before.get(key)
        if not isinstance(before_value, (int, float)) or not isinstance(after_value, (int, float)):
            return None
        change = after_value - before_value
        if change < 0:
            return None
        delta[key] = round(change, 2) if isinstance(change, float) else change
    return delta


def category_counter_delta(before, after):
    """Subtract fixed, report-safe pg_stat_statements categories.

    A reset invalidates the complete category sample just as it invalidates the
    aggregate sample.  Returning no partial delta avoids presenting an
    incomplete category as a measured zero.
    """
    if not isinstance(before, dict) or not isinstance(after, dict):
        return None
    if set(before) != set(after):
        return None
    delta = {}
    for category in sorted(after):
        value = counter_delta(before.get(category), after.get(category))
        if value is None:
            return None
        delta[category] = value
    return delta


def postgres_report(before, after):
    """Build a report shape that never exposes a DB name or statement details."""
    output = {"scope": "disposable-test-database", "before": before, "after": after}
    before_statements = before.get("statements", {}) if isinstance(before, dict) else {}
    after_statements = after.get("statements", {}) if isinstance(after, dict) else {}
    if before_statements.get("available") and after_statements.get("available"):
        delta = counter_delta(before_statements.get("aggregate"), after_statements.get("aggregate"))
        category_delta = category_counter_delta(
            before_statements.get("categories"), after_statements.get("categories"))
        output["statementDelta"] = {
            "available": delta is not None,
            "reason": None if delta is not None else "pg_stat_statements_reset_or_invalid",
            "aggregate": delta,
            "categories": category_delta if delta is not None else None,
        }
    else:
        output["statementDelta"] = {
            "available": False,
            "reason": "pg_stat_statements_unavailable",
            "aggregate": None,
            "categories": None,
        }
    return output


def parse_prometheus_labels(value):
    """Parse only the fixed, non-sensitive labels emitted by this service."""
    labels = {}
    if not value:
        return labels
    for part in value.split(","):
        if "=" not in part:
            return None
        key, raw = part.split("=", 1)
        key = key.strip()
        if key not in SAFE_METRIC_LABELS or not raw.startswith('"') or not raw.endswith('"'):
            return None
        label = raw[1:-1]
        if '\\"' in label or "\\\\" in label:
            return None
        labels[key] = label
    return labels


def metrics_snapshot(url):
    """Fetch only fixed aggregate service metrics from loopback.

    The endpoint is never supplied by a caller other than the guarded runner.
    Unknown metrics and labels are discarded so no route parameter, identity,
    request body, or future high-cardinality metric leaks into reports.
    """
    if not LOOPBACK_METRICS.fullmatch(url):
        raise ValueError("metrics URL must be a loopback /metrics endpoint")
    try:
        with urlopen(url, timeout=1.5) as response:  # noqa: S310 -- loopback guard above
            payload = response.read().decode("utf-8")
    except (OSError, URLError, UnicodeDecodeError):
        return {"available": False, "reason": "service_metrics_unavailable", "samples": {}}
    samples = {}
    for line in payload.splitlines():
        if not line or line.startswith("#"):
            continue
        match = PROMETHEUS_SAMPLE.fullmatch(line)
        if not match or match.group("name") not in METRIC_NAMES:
            continue
        labels = parse_prometheus_labels(match.group("labels"))
        if labels is None:
            continue
        try:
            number = float(match.group("value"))
        except ValueError:
            continue
        if number < 0:
            continue
        key = (match.group("name"), tuple(sorted(labels.items())))
        samples[key] = number
    return {"available": True, "reason": None, "samples": samples}


def histogram_p99_upper_millis(before, after, metric, labels):
    """Return the safest P99 statement possible from Prometheus buckets.

    Histograms provide bucketed, not exact, quantiles.  We report the bucket's
    upper bound and deliberately leave an unbounded +Inf bucket as null.
    """
    buckets = []
    for key, after_value in after.items():
        name, pairs = key
        all_labels = dict(pairs)
        if name != metric or {key: value for key, value in all_labels.items() if key != "le"} != labels:
            continue
        before_value = before.get(key, 0)
        delta = after_value - before_value
        if delta < 0:
            return None
        buckets.append((all_labels.get("le", "+Inf"), delta))
    if not buckets:
        return None
    buckets.sort(key=lambda row: float("inf") if row[0] == "+Inf" else float(row[0]))
    total = buckets[-1][1]
    if total <= 0:
        return None
    target = total * 0.99
    for upper, count in buckets:
        if count >= target:
            if upper == "+Inf":
                return None
            return round(float(upper) * 1000, 2)
    return None


def counter_delta_for_labels(before, after, metric, labels):
    """Return an exact counter delta for a controlled metric-label prefix."""
    total = 0
    seen = False
    for key, after_value in after.items():
        name, pairs = key
        actual = dict(pairs)
        if name != metric or any(actual.get(key) != value for key, value in labels.items()):
            continue
        before_value = before.get(key, 0)
        delta = after_value - before_value
        if delta < 0:
            return None
        total += delta
        seen = True
    return int(total) if seen else 0


def counter_breakdown(before, after, metric, labels):
    """Return deltas grouped by controlled low-cardinality labels."""
    values = set()
    for name, pairs in set(before) | set(after):
        if name != metric:
            continue
        actual = dict(pairs)
        value = tuple(actual.get(label) for label in labels)
        if all(item is not None for item in value):
            values.add(value)
    rows = []
    for value in sorted(values):
        selected = dict(zip(labels, value, strict=True))
        count = counter_delta_for_labels(before, after, metric, selected)
        if count != 0:
            rows.append({**selected, "count": count})
    return rows


def stage_service_metrics(before, after, maxima):
    """Summarize queue, handler and pool pressure per fixed route/class."""
    if not before.get("available") or not after.get("available"):
        return {
            "available": False,
            "reason": "service_metrics_unavailable",
            "paths": [],
            "apiErrors": [],
            "busySources": [],
            "databaseFailures": [],
            "queueRejectionReasons": [],
        }
    before_samples = before.get("samples", {})
    after_samples = after.get("samples", {})
    groups = set()
    database_operations = set()
    for name, pairs in set(before_samples) | set(after_samples):
        if name not in {
            "reader_sync_request_queue_wait_seconds_bucket",
            "reader_sync_request_handler_duration_seconds_bucket",
            "reader_sync_database_pool_acquire_seconds_bucket",
            "reader_sync_database_query_seconds_bucket",
        }:
            continue
        labels = dict(pairs)
        labels.pop("le", None)
        if name in {
            "reader_sync_request_queue_wait_seconds_bucket",
            "reader_sync_request_handler_duration_seconds_bucket",
        } and labels.get("route") and labels.get("class"):
            groups.add((labels["route"], labels["class"], labels.get("lane")))
        if name in {
            "reader_sync_database_pool_acquire_seconds_bucket",
            "reader_sync_database_query_seconds_bucket",
        } and labels.get("operation") and not labels.get("route"):
            database_operations.add(labels["operation"])
    paths = []
    # A route/class can legitimately have both an older unlabelled series and
    # a current lane-labelled series during a rolling service restart. Python
    # cannot order ``None`` and ``str`` tuple members directly, so normalize
    # only the sort key while preserving the original optional lane value.
    for route, request_class, lane in sorted(
        groups, key=lambda row: (row[0], row[1], row[2] or "")
    ):
        labels = {"route": route, "class": request_class}
        if lane is not None:
            labels["lane"] = lane
        queue_labels = {**labels, "outcome": "acquired"}
        row = {
            "route": route,
            "class": request_class,
            "queueWaitP99UpperBoundMs": histogram_p99_upper_millis(
                before_samples, after_samples, "reader_sync_request_queue_wait_seconds_bucket", queue_labels),
            "handlerP99UpperBoundMs": histogram_p99_upper_millis(
                before_samples, after_samples, "reader_sync_request_handler_duration_seconds_bucket", labels),
        }
        if lane is not None:
            row["lane"] = lane
        row["queueRejections"] = counter_delta_for_labels(
            before_samples,
            after_samples,
            "reader_sync_request_queue_rejections_total",
            labels,
        )
        acquire = histogram_p99_upper_millis(
            before_samples, after_samples, "reader_sync_database_pool_acquire_seconds_bucket", labels)
        if acquire is not None:
            row["databasePoolAcquireP99UpperBoundMs"] = acquire
        paths.append(row)
    operations = []
    for operation in sorted(database_operations):
        labels = {"operation": operation}
        operations.append({
            "operation": operation,
            "databasePoolAcquireP99UpperBoundMs": histogram_p99_upper_millis(
                before_samples, after_samples,
                "reader_sync_database_pool_acquire_seconds_bucket", labels),
            "databaseQueryP99UpperBoundMs": histogram_p99_upper_millis(
                before_samples, after_samples,
                "reader_sync_database_query_seconds_bucket", labels),
        })
    pool_values = []
    for key, value in maxima.items():
        name, pairs = key
        if name in {"reader_sync_database_pool_size", "reader_sync_database_pool_idle"}:
            pool_values.append((name, value))
    pool = {}
    if pool_values:
        pool["sizeMax"] = max(value for name, value in pool_values if name == "reader_sync_database_pool_size") if any(name == "reader_sync_database_pool_size" for name, _ in pool_values) else None
        idle_values = [value for name, value in pool_values if name == "reader_sync_database_pool_idle"]
        pool["idleMin"] = min(idle_values) if idle_values else None
    return {
        "available": True,
        "reason": None,
        "paths": paths,
        "databaseOperations": operations,
        "databasePool": pool,
        "apiErrors": counter_breakdown(
            before_samples, after_samples, "reader_sync_api_errors_total", ("code",)),
        "busySources": counter_breakdown(
            before_samples, after_samples, "reader_sync_busy_rejections_total", ("source",)),
        "databaseFailures": counter_breakdown(
            before_samples, after_samples, "reader_sync_database_failures_total",
            ("operation", "phase")),
        "queueRejectionReasons": counter_breakdown(
            before_samples, after_samples, "reader_sync_request_queue_rejections_total",
            ("reason",)),
    }


def percent(current, previous, elapsed):
    return round(100 * ((current - previous) / max(elapsed, 0.001)) /
                 os.sysconf("SC_CLK_TCK"), 2)


def summarize(samples):
    if not samples:
        return {}

    def values(key):
        return [sample[key] for sample in samples]

    summary = {
        "samples": len(samples),
        "hostCpuMeanPercent": round(statistics.mean(values("hostCpuPercent")), 2),
        "hostCpuMaxPercent": round(max(values("hostCpuPercent")), 2),
        "serviceCpuMeanPercent": round(statistics.mean(values("serviceCpuPercent")), 2),
        "serviceCpuMaxPercent": round(max(values("serviceCpuPercent")), 2),
        "serviceRssMaxKiB": max(values("serviceRssKiB")),
        "postgresCpuMeanPercent": round(statistics.mean(values("postgresCpuPercent")), 2),
        "postgresCpuMaxPercent": round(max(values("postgresCpuPercent")), 2),
        "postgresAggregateRssMaxKiB": max(values("postgresAggregateRssKiB")),
        "postgresProcessMax": max(values("postgresProcesses")),
        "memAvailableMinKiB": min(values("memAvailableKiB")),
        "load1Max": round(max(values("load1")), 2),
    }
    pss_values = [sample["postgresPssKiB"] for sample in samples
                  if sample["postgresPssKiB"] is not None]
    if pss_values:
        summary["postgresPssMaxKiB"] = max(pss_values)
    summary["postgresPssAvailableSamples"] = len(pss_values)
    return summary


def save_report(path, report):
    """Atomically retain aggregate hardware samples during a probe."""
    temporary = f"{path}.partial-{os.getpid()}"
    with open(temporary, "w", encoding="utf-8") as destination:
        json.dump(report, destination, separators=(",", ":"))
    os.replace(temporary, path)


def stage_name(elapsed, stages):
    boundary = 0
    for name, seconds in stages:
        boundary += seconds
        if elapsed < boundary:
            return name
    return "after"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--service-pid", required=True, type=int)
    parser.add_argument("--postgres-database", required=True)
    parser.add_argument("--metrics-url", required=True)
    parser.add_argument("--seconds", required=True, type=int)
    parser.add_argument("--output", required=True)
    parser.add_argument("--stage-seconds", type=int,
                        help="must match capacity-probe --stage-seconds")
    parser.add_argument("--single-stage", action="store_true",
                        help="record one explicitly non-capacity workload")
    parser.add_argument("--single-stage-name", default="bulk-transfer")
    args = parser.parse_args()
    if not (1 <= args.seconds <= 1_800):
        raise SystemExit("seconds must be between 1 and 1800")
    if not os.path.isabs(args.output) or os.path.exists(args.output):
        raise SystemExit("output must be a new absolute path")
    if os.path.normpath(args.output) != args.output:
        raise SystemExit("output path must be normalized")
    if args.stage_seconds is not None and not (30 <= args.stage_seconds <= 300):
        raise SystemExit("stage-seconds must be between 30 and 300")
    if args.single_stage:
        if args.stage_seconds is not None:
            raise SystemExit("single-stage monitoring must not set stage-seconds")
        if not re.fullmatch(r"[a-z0-9-]{1,48}", args.single_stage_name):
            raise SystemExit("single-stage-name must be a safe metric label")
        stages = ((args.single_stage_name, args.seconds),)
    else:
        stages = (STAGES if args.stage_seconds is None else
                  tuple((name, args.stage_seconds) for name, _seconds in STAGES))
    if args.seconds != sum(seconds for _name, seconds in stages):
        raise SystemExit("seconds must exactly match the selected stage schedule")
    if not TEST_DATABASE.fullmatch(args.postgres_database):
        raise SystemExit("postgres database is not an approved disposable test database")
    if not LOOPBACK_METRICS.fullmatch(args.metrics_url):
        raise SystemExit("metrics URL must be a loopback /metrics endpoint")

    started = time.monotonic()
    total, idle = cpu_totals()
    _, service_ticks = process_usage(args.service_pid)
    _, _, _, postgres_ticks = postgres_usage()
    previous = (started, total, idle, service_ticks, postgres_ticks)
    samples = []
    postgres_before = postgres_snapshot(args.postgres_database)
    service_metrics_before = metrics_snapshot(args.metrics_url)
    service_metrics_by_stage = {
        stage_name(0, stages): {
            "before": service_metrics_before,
            "after": service_metrics_before,
            "maxima": dict(service_metrics_before.get("samples", {})),
        }
    }
    report = {
        "complete": False,
        "hardware": {"overall": {}, "byStage": {}},
        "postgres": postgres_report(postgres_before, postgres_before),
        "metricDefinitions": {
            "postgresPssKiB": "sum of PostgreSQL process PSS; shared mappings are apportioned",
            "postgresAggregateRssKiB": "sum of PostgreSQL process RSS; shared mappings are counted more than once",
        },
    }
    while time.monotonic() - started < args.seconds:
        time.sleep(1)
        now = time.monotonic()
        current_stage = stage_name(now - started, stages)
        service_metrics = metrics_snapshot(args.metrics_url)
        stage_metrics = service_metrics_by_stage.setdefault(
            current_stage,
            {"before": service_metrics, "after": service_metrics, "maxima": {}},
        )
        stage_metrics["after"] = service_metrics
        for key, value in service_metrics.get("samples", {}).items():
            if key[0] in {"reader_sync_active_requests", "reader_sync_queued_requests",
                          "reader_sync_database_pool_size", "reader_sync_database_pool_idle"}:
                previous_value = stage_metrics["maxima"].get(key)
                if previous_value is None:
                    stage_metrics["maxima"][key] = value
                elif key[0] == "reader_sync_database_pool_idle":
                    stage_metrics["maxima"][key] = min(previous_value, value)
                else:
                    stage_metrics["maxima"][key] = max(previous_value, value)
        total, idle = cpu_totals()
        service_rss, service_ticks = process_usage(args.service_pid)
        postgres_count, postgres_rss, postgres_pss, postgres_ticks = postgres_usage()
        last_wall, last_total, last_idle, last_service, last_postgres = previous
        elapsed = max(now - last_wall, 0.001)
        samples.append({
            "stage": current_stage,
            "hostCpuPercent": round(100 * (1 - ((idle - last_idle) /
                                               max(total - last_total, 1))), 2),
            "serviceCpuPercent": max(0, percent(service_ticks, last_service, elapsed)),
            "serviceRssKiB": service_rss,
            "postgresCpuPercent": max(0, percent(postgres_ticks, last_postgres, elapsed)),
            "postgresAggregateRssKiB": postgres_rss,
            "postgresPssKiB": postgres_pss,
            "postgresProcesses": postgres_count,
            "memAvailableKiB": mem_available_kib(),
            "load1": round(os.getloadavg()[0], 2),
        })
        previous = (now, total, idle, service_ticks, postgres_ticks)
        report["elapsedSeconds"] = round(now - started, 2)
        report["hardware"] = {
            "overall": summarize(samples),
            "byStage": {
                name: summarize([sample for sample in samples if sample["stage"] == name])
                for name, _seconds in stages
            },
        }
        report["serviceMetrics"] = {
            "byStage": {
                name: stage_service_metrics(
                    row["before"], row["after"], row["maxima"])
                for name, row in service_metrics_by_stage.items()
            },
            "quantileMethod": "Prometheus histogram bucket upper bounds; null means no samples or +Inf bucket",
        }
        save_report(args.output, report)
    report["elapsedSeconds"] = round(time.monotonic() - started, 2)
    report["complete"] = True
    postgres_after = postgres_snapshot(args.postgres_database)
    report["postgres"] = postgres_report(postgres_before, postgres_after)
    report["serviceMetrics"] = {
        "byStage": {
            name: stage_service_metrics(row["before"], row["after"], row["maxima"])
            for name, row in service_metrics_by_stage.items()
        },
        "quantileMethod": "Prometheus histogram bucket upper bounds; null means no samples or +Inf bucket",
    }
    save_report(args.output, report)


if __name__ == "__main__":
    main()
