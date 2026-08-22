#!/usr/bin/env python3
"""Converts k6 aggregate JSON into the stable capacity report shape.

The input is k6's summary export.  No token, URL, request body, account ID,
or filesystem path is copied to the report.
"""

import argparse
import json
import os
import re


STAGES = (
    ("baseline", 5, 60), ("elevated", 75, 180), ("peak", 150, 180),
    ("stress-200", 200, 210), ("stress-250", 250, 60),
    ("stress-300", 300, 60), ("stress-350", 350, 60),
    ("stress-400", 400, 60), ("stress-450", 450, 90),
    ("stress-500", 500, 150), ("recovery", 25, 90),
)
ACCOUNT_POOL_MINIMUM = 2048
ACCOUNT_REQUEST_GUARD_PER_MINUTE = 50
ACCOUNT_REQUEST_TRANSITION_MAXIMUM = 101
PUSH_SHARE_NUMERATOR = 5
WORKLOAD_SLOTS = 20
GENERATED_ENTITY_MAX_BYTES = 1024
DAILY_ENTITY_QUOTA = 10_000
DAILY_BYTE_QUOTA = 25 * 1024 * 1024
INDEPENDENT_WORKLOAD_SEED = 0x6D2B79F5
INDEPENDENT_STAGE_START_SPREAD_MS = 1000
TAGGED_METRIC = re.compile(r"^(?P<name>[^{}]+)(?:\{(?P<tags>.*)\})?$")


def parse_metric(name):
    match = TAGGED_METRIC.match(name)
    if not match:
        return name, {}
    tags = {}
    for part in (match.group("tags") or "").split(","):
        if ":" in part:
            key, value = part.split(":", 1)
            tags[key.strip()] = value.strip()
    return match.group("name"), tags


def metric_values(metric):
    if not isinstance(metric, dict):
        return {}
    # k6 1.x nested summary values under `values`; k6 2.x writes the same
    # aggregates directly on the metric object.
    nested = metric.get("values")
    return nested if isinstance(nested, dict) else metric


def number(values, key):
    value = values.get(key, 0)
    return round(float(value), 2) if isinstance(value, (int, float)) else 0.0


def completed_requests(statuses):
    """Counts transport-complete responses, excluding k6 status zero."""
    return sum(
        count for status, count in statuses.items()
        if status.isdecimal() and int(status) >= 100
    )


def successful_requests(statuses):
    """Counts successful HTTP responses as the useful sync throughput."""
    return sum(
        count for status, count in statuses.items()
        if status.isdecimal() and 200 <= int(status) < 300
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--summary", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--stage-seconds", type=int)
    parser.add_argument("--single-stage-name")
    parser.add_argument("--single-stage-concurrency", type=int)
    parser.add_argument(
        "--execution-model",
        choices=("batch-controller", "independent-vus"),
        default="independent-vus",
    )
    parser.add_argument("--account-pool-size", type=int)
    parser.add_argument(
        "--profile",
        choices=("catchup", "cursor-zero-replay"),
        default="catchup",
    )
    args = parser.parse_args()
    if not os.path.isabs(args.summary) or not os.path.isabs(args.output):
        raise SystemExit("summary and output paths must be absolute")
    if args.stage_seconds is not None and not (30 <= args.stage_seconds <= 300):
        raise SystemExit("stage-seconds must be between 30 and 300")
    single_stage = args.single_stage_name is not None or args.single_stage_concurrency is not None
    if single_stage:
        if (
            args.stage_seconds is None
            or not re.fullmatch(r"[a-z0-9-]{1,48}", args.single_stage_name or "")
            or not 1 <= (args.single_stage_concurrency or 0) <= 500
        ):
            raise SystemExit("single-stage requires a safe name, 1..500 concurrency, and stage-seconds")
    independent_vus = args.execution_model == "independent-vus"
    if independent_vus and (args.account_pool_size or 0) < ACCOUNT_POOL_MINIMUM:
        raise SystemExit("independent-vus requires a 2048+ account pool")
    with open(args.summary, encoding="utf-8") as source:
        metrics = json.load(source).get("metrics", {})
    stages = (
        ((args.single_stage_name, args.single_stage_concurrency, args.stage_seconds),)
        if single_stage
        else tuple(
            (name, concurrency, args.stage_seconds if args.stage_seconds else seconds)
            for name, concurrency, seconds in STAGES
        )
    )
    adversarial_replay = args.profile == "cursor-zero-replay"
    non_capacity_smoke = single_stage
    capacity_rehearsal = args.stage_seconds is not None and not single_stage
    workload_class = (
        "adversarial" if adversarial_replay else
        "non-capacity-diagnostic" if independent_vus and non_capacity_smoke else
        "non-capacity-burst" if not independent_vus else
        "capacity-rehearsal" if capacity_rehearsal else "capacity"
    )
    total_planned_seconds = sum(row[2] for row in stages)
    guarded_pushes_per_account = sum(
        (
            (
                (seconds * ACCOUNT_REQUEST_GUARD_PER_MINUTE + 59) // 60 + 1
                + WORKLOAD_SLOTS - 1
            )
            // WORKLOAD_SLOTS
        )
        * PUSH_SHARE_NUMERATOR
        for _name, _concurrency, seconds in stages
    )
    output = {
        "complete": True,
        "profile": args.profile,
        "executionModel": args.execution_model,
        "concurrencyUnit": (
            "active-independent-k6-vus" if independent_vus else "http-in-flight"
        ),
        "workloadClass": workload_class,
        "measurementComplete": False,
        "capacityConclusionEligible": False,
        "capacityConclusionNote": (
            "cursor-zero-replay repeatedly reads cursor=0 and is an adversarial replay, not a normal capacity conclusion"
            if adversarial_replay
            else "single-stage independent VUs are a diagnostic only, not the fixed capacity schedule"
            if independent_vus and non_capacity_smoke
            else "the batch-controller burst model has a global batch barrier and cannot support a capacity conclusion"
            if not independent_vus
            else "shortened fixed stages are a rehearsal; only the fixed 20-minute schedule can support a capacity conclusion"
            if capacity_rehearsal
            else "fixed independent VUs have no global batch barrier and each account advances its own cursor"
        ),
        "totalPlannedSeconds": total_planned_seconds,
        "stages": [],
    }
    if independent_vus:
        output["accountPoolSize"] = args.account_pool_size
        output["executorConfiguredVus"] = max(row[1] for row in stages)
        output["maxStageActiveVus"] = max(row[1] for row in stages)
        output["loadGuards"] = {
            "targetRequestsPerAccountPerMinute": ACCOUNT_REQUEST_GUARD_PER_MINUTE,
            "maxRequestsPerAccountPerMinuteIncludingStageTransition": (
                ACCOUNT_REQUEST_TRANSITION_MAXIMUM
            ),
            "pushShareNumerator": PUSH_SHARE_NUMERATOR,
            "workloadSlots": WORKLOAD_SLOTS,
            "maxGeneratedEntityBytes": GENERATED_ENTITY_MAX_BYTES,
            "maxPushAttemptsPerAccount": guarded_pushes_per_account,
            "dailyAcceptedEntityQuota": DAILY_ENTITY_QUOTA,
            "maxGeneratedAcceptedBytesPerAccount": (
                guarded_pushes_per_account * GENERATED_ENTITY_MAX_BYTES
            ),
            "dailyAcceptedByteQuota": DAILY_BYTE_QUOTA,
            "workloadScheduleVersion": "hashed-phase-v1",
            "workloadSeed": INDEPENDENT_WORKLOAD_SEED,
            "stageStartSpreadMs": INDEPENDENT_STAGE_START_SPREAD_MS,
            "gracefulStopSeconds": 3,
        }
    else:
        output["k6ControllerVus"] = 1
    for stage, concurrency, seconds in stages:
        statuses, operations, no_response = {}, {}, 0
        issued_requests, accounts_exercised = 0, 0
        issued_requests_metric_present = False
        shard_claims = {}
        latency = {}
        successful_latency = {}
        for metric_name, metric in metrics.items():
            base, tags = parse_metric(metric_name)
            values = metric_values(metric)
            if tags.get("stage") != stage:
                continue
            metric_profile = tags.get("profile")
            if metric_profile is not None and metric_profile != args.profile:
                raise SystemExit(
                    f"summary profile mismatch for {stage}: {metric_profile} != {args.profile}"
                )
            metric_execution_model = tags.get("executionModel")
            if (
                metric_execution_model is not None
                and metric_execution_model != args.execution_model
            ):
                raise SystemExit(
                    f"summary execution model mismatch for {stage}: "
                    f"{metric_execution_model} != {args.execution_model}"
                )
            if base == "sync_stage_duration":
                latency = values
            elif base == "sync_successful_stage_duration":
                successful_latency = values
            elif base == "sync_responses":
                count = int(values.get("count", 0))
                status = tags.get("status", "unknown")
                operation = tags.get("operation", "unknown")
                statuses[status] = statuses.get(status, 0) + count
                operations[operation] = operations.get(operation, 0) + count
            elif base == "sync_no_response":
                no_response += int(values.get("count", 0))
            elif base == "sync_requests_started":
                issued_requests_metric_present = True
                issued_requests += int(values.get("count", 0))
            elif base == "sync_accounts_exercised":
                accounts_exercised += int(values.get("count", 0))
            elif base == "sync_shard_claims":
                shard = tags.get("shard", "")
                if shard.isdecimal():
                    shard_claims[int(shard)] = (
                        shard_claims.get(int(shard), 0) + int(values.get("count", 0))
                    )
        completed = completed_requests(statuses)
        successful = successful_requests(statuses)
        responses_recorded = sum(statuses.values())
        if issued_requests == 0:
            issued_requests = responses_recorded
        stage_cutoff = max(0, issued_requests - responses_recorded)
        request_accounting_complete = (
            issued_requests == responses_recorded
            and (not independent_vus or issued_requests_metric_present)
        )
        account_coverage_complete = (
            not independent_vus
            or accounts_exercised >= args.account_pool_size
        )
        shard_claims_valid = (
            not independent_vus
            or shard_claims == {shard: 1 for shard in range(concurrency)}
        )
        stage_output = {
            "name": stage,
            "profile": args.profile,
            "executionModel": args.execution_model,
            "workloadClass": output["workloadClass"],
            "capacityConclusionEligible": False,
            "concurrency": concurrency,
            "plannedSeconds": seconds,
            "issuedRequests": issued_requests,
            "issuedRequestsPerSecond": round(issued_requests / seconds, 2),
            "requests": responses_recorded,
            "responsesRecordedPerSecond": round(responses_recorded / seconds, 2),
            "measurementComplete": (
                responses_recorded > 0
                and request_accounting_complete
                and account_coverage_complete
                and shard_claims_valid
            ),
            "completedRequests": completed,
            "completedRequestsPerSecond": round(completed / seconds, 2),
            "successfulRequests": successful,
            "successfulRequestsPerSecond": round(successful / seconds, 2),
            "byOperation": operations,
            "statuses": statuses,
            "noResponse": no_response,
            "stageCutoff": stage_cutoff,
            "requestAccountingComplete": request_accounting_complete,
            "p50Ms": number(latency, "med"),
            "p95Ms": number(latency, "p(95)"),
            "p99Ms": number(latency, "p(99)"),
            "successfulP50Ms": number(successful_latency, "med"),
            "successfulP95Ms": number(successful_latency, "p(95)"),
            "successfulP99Ms": number(successful_latency, "p(99)"),
        }
        if independent_vus:
            stage_output["executorConfiguredVus"] = output["executorConfiguredVus"]
            stage_output["activeVus"] = concurrency
            stage_output["httpInFlightUpperBound"] = concurrency
            stage_output["accountPoolSize"] = args.account_pool_size
            stage_output["accountsExercised"] = accounts_exercised
            stage_output["accountCoverageComplete"] = account_coverage_complete
            stage_output["shardsClaimed"] = len(shard_claims)
            stage_output["shardClaimsValid"] = shard_claims_valid
        else:
            stage_output["httpInFlightConcurrency"] = concurrency
            stage_output["k6ControllerVus"] = output["k6ControllerVus"]
        output["stages"].append(stage_output)
    output["measurementComplete"] = all(
        stage["measurementComplete"] for stage in output["stages"]
    )
    output["capacityConclusionEligible"] = (
        output["measurementComplete"]
        and not adversarial_replay
        and not non_capacity_smoke
        and independent_vus
        and not capacity_rehearsal
    )
    if not output["measurementComplete"]:
        output["capacityConclusionNote"] = (
            "one or more fixed load phases had an unrecorded started request, "
            "lacked responses, or failed account/shard coverage gates; "
            "this is not a capacity result"
        )
    for stage in output["stages"]:
        stage["capacityConclusionEligible"] = (
            stage["measurementComplete"]
            and not adversarial_replay
            and not non_capacity_smoke
            and independent_vus
            and not capacity_rehearsal
        )
    temporary = f"{args.output}.partial-{os.getpid()}"
    with open(temporary, "w", encoding="utf-8") as destination:
        json.dump(output, destination, separators=(",", ":"))
    os.replace(temporary, args.output)


if __name__ == "__main__":
    main()
