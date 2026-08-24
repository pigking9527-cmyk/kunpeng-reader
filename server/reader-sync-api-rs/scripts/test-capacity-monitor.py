#!/usr/bin/env python3
"""Offline checks for capacity-monitor.py's safe aggregate report contract."""

import importlib.util
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("capacity-monitor.py")
SPEC = importlib.util.spec_from_file_location("capacity_monitor", SCRIPT)
assert SPEC and SPEC.loader
monitor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(monitor)


def sample(**overrides):
    row = {
        "hostCpuPercent": 1.0,
        "serviceCpuPercent": 2.0,
        "serviceRssKiB": 3,
        "postgresCpuPercent": 4.0,
        "postgresAggregateRssKiB": 5,
        "postgresPssKiB": 6,
        "postgresProcesses": 2,
        "memAvailableKiB": 7,
        "load1": 0.1,
    }
    row.update(overrides)
    return row


summary = monitor.summarize([sample(), sample(postgresPssKiB=None)])
assert summary["postgresPssMaxKiB"] == 6
assert summary["postgresPssAvailableSamples"] == 1
assert summary["postgresAggregateRssMaxKiB"] == 5
assert "postgresRssMaxKiB" not in summary

# PostgreSQL backends are short-lived. A PID can vanish after `/proc` is
# enumerated and Linux can report that race as ProcessLookupError rather than
# FileNotFoundError. Resource sampling must skip it instead of terminating the
# entire 20-minute monitor.
with patch("builtins.open", side_effect=ProcessLookupError()):
    assert monitor.process_usage("gone") == (0, 0)
    assert monitor.process_pss_kib("gone") is None
with (
    patch.object(monitor.os, "listdir", return_value=["123"]),
    patch("builtins.open", side_effect=ProcessLookupError()),
):
    assert monitor.postgres_usage() == (0, 0, 0, 0)

before = {
    "available": True,
    "connections": {"total": 1},
    "waitEvents": {"lock": 0},
    "statements": {
        "available": True,
        "aggregate": {"calls": 2, "totalExecMs": 3.5},
        "categories": {
            "entity": {"calls": 1, "totalExecMs": 1.0},
            "other": {"calls": 1, "totalExecMs": 2.5},
        },
    },
}
after = {
    "available": True,
    "connections": {"total": 2},
    "waitEvents": {"lock": 1},
    "statements": {
        "available": True,
        "aggregate": {"calls": 5, "totalExecMs": 7.0},
        "categories": {
            "entity": {"calls": 2, "totalExecMs": 2.5},
            "other": {"calls": 3, "totalExecMs": 4.5},
        },
    },
}
report = monitor.postgres_report(before, after)
assert report["scope"] == "disposable-test-database"
assert report["statementDelta"] == {
    "available": True,
    "reason": None,
    "aggregate": {"calls": 3, "totalExecMs": 3.5},
    "categories": {
        "entity": {"calls": 1, "totalExecMs": 1.5},
        "other": {"calls": 2, "totalExecMs": 2.0},
    },
}
assert "database" not in report
assert "query" not in report

unavailable = monitor.postgres_report(
    {"statements": {"available": False, "aggregate": None}},
    {"statements": {"available": False, "aggregate": None}},
)
assert unavailable["statementDelta"] == {
    "available": False,
    "reason": "pg_stat_statements_unavailable",
    "aggregate": None,
    "categories": None,
}
assert monitor.counter_delta({"calls": 10}, {"calls": 2}) is None
assert monitor.category_counter_delta(
    {"entity": {"calls": 2}}, {"entity": {"calls": 1}}) is None
assert monitor.category_counter_delta(
    {"entity": {"calls": 1}}, {"other": {"calls": 2}}) is None


def metric(name, labels, value):
    return (name, tuple(sorted(labels.items()))), value


before_metrics = dict([
    metric("reader_sync_request_queue_wait_seconds_bucket", {"route": "/v1/sync/pull", "class": "read", "outcome": "acquired", "le": "0.05"}, 10),
    metric("reader_sync_request_queue_wait_seconds_bucket", {"route": "/v1/sync/pull", "class": "read", "outcome": "acquired", "le": "+Inf"}, 10),
    metric("reader_sync_request_handler_duration_seconds_bucket", {"route": "/v1/sync/pull", "class": "read", "le": "0.1"}, 10),
    metric("reader_sync_request_handler_duration_seconds_bucket", {"route": "/v1/sync/pull", "class": "read", "le": "+Inf"}, 10),
    metric("reader_sync_api_errors_total", {"code": "SERVER_BUSY"}, 2),
    metric("reader_sync_busy_rejections_total", {"source": "admission_refill"}, 1),
    metric("reader_sync_database_failures_total", {"operation": "auth", "phase": "acquire"}, 1),
    metric("reader_sync_request_queue_rejections_total", {
        "route": "/v1/sync/push", "class": "write", "lane": "write", "reason": "queue_timeout"}, 2),
])
after_metrics = dict([
    metric("reader_sync_request_queue_wait_seconds_bucket", {"route": "/v1/sync/pull", "class": "read", "outcome": "acquired", "le": "0.05"}, 19),
    metric("reader_sync_request_queue_wait_seconds_bucket", {"route": "/v1/sync/pull", "class": "read", "outcome": "acquired", "le": "+Inf"}, 20),
    metric("reader_sync_request_handler_duration_seconds_bucket", {"route": "/v1/sync/pull", "class": "read", "le": "0.1"}, 20),
    metric("reader_sync_request_handler_duration_seconds_bucket", {"route": "/v1/sync/pull", "class": "read", "le": "+Inf"}, 20),
    metric("reader_sync_api_errors_total", {"code": "SERVER_BUSY"}, 5),
    metric("reader_sync_api_errors_total", {"code": "DATABASE_UNAVAILABLE"}, 4),
    metric("reader_sync_busy_rejections_total", {"source": "admission_refill"}, 3),
    metric("reader_sync_database_failures_total", {"operation": "auth", "phase": "acquire"}, 3),
    metric("reader_sync_database_failures_total", {"operation": "admission", "phase": "query"}, 4),
    metric("reader_sync_request_queue_rejections_total", {
        "route": "/v1/sync/push", "class": "write", "lane": "write", "reason": "queue_timeout"}, 5),
    metric("reader_sync_request_queue_rejections_total", {
        "route": "/v1/sync/push", "class": "write", "lane": "write", "reason": "queue_full"}, 4),
])
stage_metrics = monitor.stage_service_metrics(
    {"available": True, "samples": before_metrics},
    {"available": True, "samples": after_metrics},
    {},
)
assert stage_metrics["available"] is True
assert stage_metrics["paths"] == [{
    "route": "/v1/sync/pull",
    "class": "read",
    "queueWaitP99UpperBoundMs": None,
    "handlerP99UpperBoundMs": 100.0,
    "queueRejections": 0,
}]
assert stage_metrics["databaseOperations"] == []
assert stage_metrics["apiErrors"] == [
    {"code": "DATABASE_UNAVAILABLE", "count": 4},
    {"code": "SERVER_BUSY", "count": 3},
]
assert stage_metrics["busySources"] == [
    {"source": "admission_refill", "count": 2},
]
assert stage_metrics["databaseFailures"] == [
    {"operation": "admission", "phase": "query", "count": 4},
    {"operation": "auth", "phase": "acquire", "count": 2},
]
assert stage_metrics["queueRejectionReasons"] == [
    {"reason": "queue_full", "count": 4},
    {"reason": "queue_timeout", "count": 3},
]

# A rolling restart can leave an unlabelled route series next to the newer
# lane-labelled series. The monitor must aggregate both instead of crashing
# while Python tries to compare ``None`` with a string during sorting.
mixed_lane_before = dict(before_metrics)
mixed_lane_before.update(dict([
    metric("reader_sync_request_handler_duration_seconds_bucket", {
        "route": "/v1/sync/pull", "class": "read", "lane": "read", "le": "0.1"}, 10),
    metric("reader_sync_request_handler_duration_seconds_bucket", {
        "route": "/v1/sync/pull", "class": "read", "lane": "read", "le": "+Inf"}, 10),
]))
mixed_lane_after = dict(after_metrics)
mixed_lane_after.update(dict([
    metric("reader_sync_request_handler_duration_seconds_bucket", {
        "route": "/v1/sync/pull", "class": "read", "lane": "read", "le": "0.1"}, 20),
    metric("reader_sync_request_handler_duration_seconds_bucket", {
        "route": "/v1/sync/pull", "class": "read", "lane": "read", "le": "+Inf"}, 20),
]))
mixed_lane_metrics = monitor.stage_service_metrics(
    {"available": True, "samples": mixed_lane_before},
    {"available": True, "samples": mixed_lane_after},
    {},
)
assert [(row.get("lane"), row["route"]) for row in mixed_lane_metrics["paths"]] == [
    (None, "/v1/sync/pull"),
    ("read", "/v1/sync/pull"),
]
auth_before = dict([
    metric("reader_sync_database_pool_acquire_seconds_bucket", {"operation": "auth", "le": "0.01"}, 1),
    metric("reader_sync_database_pool_acquire_seconds_bucket", {"operation": "auth", "le": "+Inf"}, 1),
    metric("reader_sync_database_query_seconds_bucket", {"operation": "auth", "le": "0.02"}, 1),
    metric("reader_sync_database_query_seconds_bucket", {"operation": "auth", "le": "+Inf"}, 1),
])
auth_after = dict([
    metric("reader_sync_database_pool_acquire_seconds_bucket", {"operation": "auth", "le": "0.01"}, 11),
    metric("reader_sync_database_pool_acquire_seconds_bucket", {"operation": "auth", "le": "+Inf"}, 11),
    metric("reader_sync_database_query_seconds_bucket", {"operation": "auth", "le": "0.02"}, 11),
    metric("reader_sync_database_query_seconds_bucket", {"operation": "auth", "le": "+Inf"}, 11),
])
auth_metrics = monitor.stage_service_metrics(
    {"available": True, "samples": auth_before},
    {"available": True, "samples": auth_after},
    {},
)
assert auth_metrics["databaseOperations"] == [{
    "operation": "auth",
    "databasePoolAcquireP99UpperBoundMs": 10.0,
    "databaseQueryP99UpperBoundMs": 20.0,
}]
assert monitor.parse_prometheus_labels('route="/v1/sync/pull",class="read",le="0.05"') == {
    "route": "/v1/sync/pull", "class": "read", "le": "0.05",
}
assert monitor.parse_prometheus_labels(
    'code="SERVER_BUSY",source="request_queue",operation="auth",phase="query"') == {
    "code": "SERVER_BUSY", "source": "request_queue", "operation": "auth", "phase": "query",
}
assert monitor.parse_prometheus_labels('identity="not-allowed"') is None
assert monitor.LOOPBACK_METRICS.fullmatch("http://127.0.0.1:8790/metrics")
assert monitor.LOOPBACK_METRICS.fullmatch("https://127.0.0.1:8790/metrics")
assert monitor.LOOPBACK_METRICS.fullmatch("https://localhost:8790/metrics")
assert not monitor.LOOPBACK_METRICS.fullmatch("https://example.com/metrics")
assert monitor.loopback_metrics_ssl_context("http://127.0.0.1:8790/metrics") is None
tls_context = monitor.loopback_metrics_ssl_context("https://127.0.0.1:8790/metrics")
assert tls_context.check_hostname is False
assert tls_context.verify_mode == monitor.ssl.CERT_NONE
try:
    monitor.loopback_metrics_ssl_context("https://example.com/metrics")
except ValueError:
    pass
else:
    raise AssertionError("external HTTPS metrics URL was not rejected")

# The monitor may inspect pg_stat_statements internally, but the report query
# must never project query text or a query identifier into its JSON result.
assert "queryid" not in monitor.STATEMENTS_CATEGORIZED_SQL.lower()
assert "json_build_object('query'" not in monitor.STATEMENTS_CATEGORIZED_SQL.lower()
for table in (
    "account_data_generations",
    "auth_sessions_v4",
    "account_daily_usage_v4",
    "account_storage_usage_v5",
    "rate_limit_buckets_v4",
):
    assert table in monitor.STATEMENTS_CATEGORIZED_SQL

try:
    monitor.psql_json("not_a_test_database", "SELECT 1")
except ValueError:
    pass
else:
    raise AssertionError("non-test database was not rejected before psql")

print("capacity monitor self-test passed")
