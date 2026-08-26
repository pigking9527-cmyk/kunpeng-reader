#!/usr/bin/env python3
"""Create or remove a guarded disposable account pool for capacity tests.

Only the running Linux dev-test service is an authority for the session HMAC
key and database target.  Plaintext tokens are written once to a new mode-0600
file; PostgreSQL receives only their domain-separated digests.  Standard output
contains aggregate JSON only, while all rejection messages are deliberately
free of service names, database details, paths, credentials, and tokens.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import hmac
import io
import json
import os
import posixpath
import re
import secrets
import stat
import subprocess
import sys
from dataclasses import dataclass
from typing import Callable, Iterable, Sequence
from urllib.parse import unquote, urlsplit


ACCOUNT_COUNT = 2048
SESSION_TOKEN_BYTES = 48
SESSION_TTL_MS = 24 * 60 * 60 * 1000
SESSION_TOKEN_DOMAIN = b"reader-sync/session-token/v4\0"
RATE_LIMIT_DOMAIN = b"reader-sync/rate-limit/v4\0"
RATE_LIMIT_SCOPE = b"authenticated_account_minute"
PASSWORD_SENTINEL = "capacity-fixture-no-password"
ADVISORY_LOCK_NAME = "kunpeng-capacity-fixture-seed-v1"

SERVICE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}\Z")
FIXTURE_ID = re.compile(r"[a-z0-9]{8,16}\Z")
TOKEN = re.compile(r"[0-9a-f]{96}\Z")
TARGET_FINGERPRINT = re.compile(r"[0-9a-f]{64}\Z")
TEST_DATABASE = re.compile(r"reader_sync_rust_test_[A-Za-z0-9_]+\Z")
SAFE_DATABASE_HOSTS = {None, "localhost", "127.0.0.1", "::1"}

SYSTEMCTL_CANDIDATES = ("/usr/bin/systemctl", "/bin/systemctl")
SUDO_CANDIDATES = ("/usr/bin/sudo", "/bin/sudo")
PSQL_CANDIDATES = ("/usr/bin/psql", "/usr/local/bin/psql")


class FixtureSeedError(RuntimeError):
    """A fail-closed rejection whose message is safe to show to an operator."""


@dataclass(frozen=True)
class DatabaseTarget:
    name: str
    port: int


@dataclass(frozen=True)
class ServiceEnvironment:
    token_hmac_key: bytes
    database: DatabaseTarget
    target_fingerprint: str


@dataclass(frozen=True)
class FixtureIdentity:
    ordinal: int
    user_id: str
    username: str
    username_key: str
    installation_id: str
    device_name: str
    rate_limit_digest_hex: str


@dataclass(frozen=True)
class SeedRow:
    identity: FixtureIdentity
    token: str
    session_digest_hex: str


SEED_REPORT_KEYS = frozenset(
    {
        "ok",
        "requestedAccountCount",
        "accountCount",
        "verifiedAccountCount",
        "disabledAccountCount",
        "sessionCount",
        "activeSessionCount",
        "distinctSessionDigestCount",
        "generationCount",
        "generationOneCount",
        "zeroCursorGenerationCount",
        "storageLedgerCount",
        "zeroStorageLedgerCount",
        "uniqueTokenCount",
        "tokenFileMode",
    }
)

CLEANUP_REPORT_KEYS = frozenset(
    {
        "ok",
        "requestedAccountCount",
        "deletedAccountCount",
        "deletedRateLimitBucketCount",
        "remainingAccountCount",
        "remainingSessionCount",
        "remainingGenerationCount",
        "remainingStorageLedgerCount",
        "remainingEntityCount",
        "remainingHistoryCount",
        "remainingPushReceiptCount",
        "remainingDailyUsageCount",
        "remainingAssetCount",
        "remainingRateLimitBucketCount",
    }
)


def validate_runtime(platform_name: str, effective_uid: int) -> None:
    """Reject every non-Linux or non-root execution before touching state."""
    if not platform_name.startswith("linux"):
        raise FixtureSeedError("remote fixture operations require Linux")
    if effective_uid != 0:
        raise FixtureSeedError("remote fixture operations require root")


def validate_service_name(value: str) -> str:
    """Accept only an explicitly named dev-test systemd unit."""
    lowered = value.lower()
    if (
        not SERVICE_NAME.fullmatch(value)
        or "dev-test" not in lowered
        or "prod" in lowered
        or "production" in lowered
    ):
        raise FixtureSeedError("service must be an explicitly named dev-test unit")
    return value


def validate_fixture_id(value: str) -> str:
    if not FIXTURE_ID.fullmatch(value):
        raise FixtureSeedError("fixture id must contain 8 to 16 lowercase letters or digits")
    return value


def validate_target_fingerprint(value: str) -> str:
    if not TARGET_FINGERPRINT.fullmatch(value):
        raise FixtureSeedError("expected target fingerprint is invalid")
    return value


def validate_token_output_path(value: str) -> str:
    """Validate a normalized POSIX absolute path without accessing it."""
    if (
        not value
        or len(value) > 4096
        or any(ord(character) < 32 for character in value)
        or not posixpath.isabs(value)
        or posixpath.normpath(value) != value
        or value == "/"
        or value.endswith("/")
    ):
        raise FixtureSeedError("token output must be a normalized absolute path")
    return value


def parse_database_target(database_url: str) -> DatabaseTarget:
    """Return only the guarded local database name and port from a secret URL."""
    try:
        parsed = urlsplit(database_url)
        hostname = parsed.hostname
        port = parsed.port or 5432
    except (TypeError, ValueError):
        raise FixtureSeedError("running service database configuration is invalid") from None
    if parsed.scheme not in {"postgres", "postgresql"} or parsed.fragment:
        raise FixtureSeedError("running service database configuration is invalid")
    if hostname is not None:
        hostname = hostname.lower()
    if hostname not in SAFE_DATABASE_HOSTS:
        raise FixtureSeedError("running service database must be local")
    if not 1 <= port <= 65535:
        raise FixtureSeedError("running service database configuration is invalid")
    raw_path = parsed.path[1:] if parsed.path.startswith("/") else parsed.path
    name = unquote(raw_path)
    if "/" in name or not TEST_DATABASE.fullmatch(name):
        raise FixtureSeedError("database is not an approved disposable test database")
    return DatabaseTarget(name=name, port=port)


def extract_service_environment(blob: bytes) -> ServiceEnvironment:
    """Extract just the two required values from a procfs environment blob."""
    required = {
        b"KUNPENG_SYNC_TOKEN_HMAC_KEY": [],
        b"KUNPENG_SYNC_DATABASE_URL": [],
    }
    for item in blob.split(b"\0"):
        if not item or b"=" not in item:
            continue
        name, value = item.split(b"=", 1)
        if name in required:
            required[name].append(value)
    if any(len(values) != 1 for values in required.values()):
        raise FixtureSeedError("running service environment is incomplete or ambiguous")
    key = required[b"KUNPENG_SYNC_TOKEN_HMAC_KEY"][0]
    if len(key) < 32:
        raise FixtureSeedError("running service HMAC key is invalid")
    database_url_bytes = required[b"KUNPENG_SYNC_DATABASE_URL"][0]
    try:
        database_url = database_url_bytes.decode("utf-8")
    except UnicodeDecodeError:
        raise FixtureSeedError("running service database configuration is invalid") from None
    return ServiceEnvironment(
        token_hmac_key=key,
        database=parse_database_target(database_url),
        target_fingerprint=hashlib.sha256(database_url_bytes + b"\0" + key).hexdigest(),
    )


def session_token_digest(key: bytes, token: str) -> bytes:
    if not TOKEN.fullmatch(token):
        raise FixtureSeedError("generated session token has an invalid shape")
    return hmac.new(
        key,
        SESSION_TOKEN_DOMAIN + token.encode("ascii"),
        hashlib.sha256,
    ).digest()


def rate_limit_subject_digest(key: bytes, user_id: str) -> bytes:
    message = RATE_LIMIT_DOMAIN + RATE_LIMIT_SCOPE + b"\0" + user_id.encode("ascii")
    return hmac.new(key, message, hashlib.sha256).digest()


def build_identities(fixture_id: str, key: bytes) -> list[FixtureIdentity]:
    """Build the exact, deterministic account manifest for one run."""
    validate_fixture_id(fixture_id)
    identities = []
    for ordinal in range(ACCOUNT_COUNT):
        user_id = f"cap-{fixture_id}-{ordinal:04d}"
        identities.append(
            FixtureIdentity(
                ordinal=ordinal,
                user_id=user_id,
                username=user_id,
                username_key=user_id,
                installation_id=user_id,
                device_name="capacity-fixture",
                rate_limit_digest_hex=rate_limit_subject_digest(key, user_id).hex(),
            )
        )
    if len({item.user_id for item in identities}) != ACCOUNT_COUNT:
        raise FixtureSeedError("fixture account identities are not unique")
    return identities


def build_seed_rows(
    identities: Sequence[FixtureIdentity],
    key: bytes,
    token_factory: Callable[[], str] | None = None,
) -> list[SeedRow]:
    """Generate unique opaque tokens and the database-only session digests."""
    if len(identities) != ACCOUNT_COUNT:
        raise FixtureSeedError("fixture manifest must contain exactly 2048 accounts")
    factory = token_factory or (lambda: secrets.token_hex(SESSION_TOKEN_BYTES))
    rows = []
    seen_tokens: set[str] = set()
    seen_digests: set[str] = set()
    for identity in identities:
        token = factory()
        digest = session_token_digest(key, token).hex()
        if token in seen_tokens or digest in seen_digests:
            raise FixtureSeedError("generated session credentials are not unique")
        seen_tokens.add(token)
        seen_digests.add(digest)
        rows.append(SeedRow(identity=identity, token=token, session_digest_hex=digest))
    if len(rows) != ACCOUNT_COUNT:
        raise FixtureSeedError("fixture token pool must contain exactly 2048 tokens")
    return rows


def token_file_payload(rows: Sequence[SeedRow]) -> bytes:
    if len(rows) != ACCOUNT_COUNT or len({row.token for row in rows}) != ACCOUNT_COUNT:
        raise FixtureSeedError("fixture token pool must contain 2048 unique tokens")
    return ("\n".join(row.token for row in rows) + "\n").encode("ascii")


def _csv_text(rows: Iterable[Sequence[object]]) -> str:
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerows(rows)
    return output.getvalue()


def seed_copy_csv(rows: Sequence[SeedRow]) -> str:
    """Render a COPY payload that intentionally excludes every plaintext token."""
    return _csv_text(
        (
            (
                row.identity.ordinal,
                row.identity.user_id,
                row.identity.username,
                row.identity.username_key,
                row.identity.installation_id,
                row.identity.device_name,
                row.session_digest_hex,
                row.identity.rate_limit_digest_hex,
            )
            for row in rows
        )
    )


def cleanup_copy_csv(identities: Sequence[FixtureIdentity]) -> str:
    return _csv_text(
        (
            (identity.ordinal, identity.user_id, identity.rate_limit_digest_hex)
            for identity in identities
        )
    )


def _database_guard_sql(required_tables: Sequence[str]) -> str:
    table_values = ",".join(f"'{table}'" for table in required_tables)
    return f"""
DO $capacity_fixture_guard$
DECLARE
    required_table text;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('{ADVISORY_LOCK_NAME}', 0));
    IF current_database() !~ '^reader_sync_rust_test_[A-Za-z0-9_]+$' THEN
        RAISE EXCEPTION 'disposable test database guard rejected';
    END IF;
    FOREACH required_table IN ARRAY ARRAY[{table_values}] LOOP
        IF to_regclass('public.' || required_table) IS NULL THEN
            RAISE EXCEPTION 'required migrated table is missing';
        END IF;
    END LOOP;
    IF (SELECT value FROM rust_service_metadata
        WHERE key='sync_protocol_version') IS DISTINCT FROM '5' THEN
        RAISE EXCEPTION 'sync protocol metadata guard rejected';
    END IF;
END
$capacity_fixture_guard$;
"""


def render_seed_sql(fixture_id: str, rows: Sequence[SeedRow]) -> str:
    """Build one fail-closed PostgreSQL transaction with digest-only input."""
    validate_fixture_id(fixture_id)
    if len(rows) != ACCOUNT_COUNT:
        raise FixtureSeedError("fixture manifest must contain exactly 2048 accounts")
    expected_pattern = f"^cap-{fixture_id}-[0-9]{{4}}$"
    required_tables = (
        "rust_service_metadata",
        "users",
        "auth_sessions_v4",
        "account_data_generations",
        "account_storage_usage_v5",
        "rate_limit_buckets_v4",
    )
    return f"""\
\\set ON_ERROR_STOP on
BEGIN;
{_database_guard_sql(required_tables)}
DO $capacity_fixture_trigger_guard$
BEGIN
    IF (SELECT COUNT(*) FROM pg_trigger
        WHERE tgrelid=to_regclass('public.users')
          AND tgname IN (
              'users_initialize_account_data_generation_v4',
              'users_initialize_account_storage_usage_v5'
          )
          AND tgenabled <> 'D') <> 2 THEN
        RAISE EXCEPTION 'required account initialization triggers are unavailable';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='account_data_generations'
          AND column_name='server_cursor'
    ) THEN
        RAISE EXCEPTION 'checkpoint cursor migration is unavailable';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='users'
          AND column_name='intelligence_feed_enabled'
    ) THEN
        RAISE EXCEPTION 'current users migration is unavailable';
    END IF;
END
$capacity_fixture_trigger_guard$;

CREATE TEMP TABLE capacity_fixture_seed (
    ordinal integer PRIMARY KEY CHECK (ordinal BETWEEN 0 AND {ACCOUNT_COUNT - 1}),
    user_id text NOT NULL UNIQUE,
    username text NOT NULL UNIQUE,
    username_key text NOT NULL UNIQUE,
    installation_id text NOT NULL UNIQUE,
    device_name text NOT NULL,
    token_digest_hex text NOT NULL UNIQUE CHECK (token_digest_hex ~ '^[0-9a-f]{{64}}$'),
    rate_limit_digest_hex text NOT NULL UNIQUE
        CHECK (rate_limit_digest_hex ~ '^[0-9a-f]{{64}}$')
);
COPY capacity_fixture_seed (
    ordinal,user_id,username,username_key,installation_id,device_name,
    token_digest_hex,rate_limit_digest_hex
) FROM STDIN WITH (FORMAT csv);
{seed_copy_csv(rows)}\\.

DO $capacity_fixture_input_guard$
BEGIN
    IF (SELECT COUNT(*) FROM capacity_fixture_seed) <> {ACCOUNT_COUNT}
       OR (SELECT COUNT(DISTINCT ordinal) FROM capacity_fixture_seed) <> {ACCOUNT_COUNT}
       OR (SELECT MIN(ordinal) FROM capacity_fixture_seed) <> 0
       OR (SELECT MAX(ordinal) FROM capacity_fixture_seed) <> {ACCOUNT_COUNT - 1}
       OR EXISTS (
           SELECT 1 FROM capacity_fixture_seed
           WHERE user_id !~ '{expected_pattern}'
              OR username<>user_id OR username_key<>user_id
              OR installation_id<>user_id OR device_name<>'capacity-fixture'
       ) THEN
        RAISE EXCEPTION 'fixture manifest shape guard rejected';
    END IF;
    IF EXISTS (
        SELECT 1 FROM users u JOIN capacity_fixture_seed s
          ON u.id=s.user_id OR u.username=s.username OR u.username_key=s.username_key
    ) OR EXISTS (
        SELECT 1 FROM auth_sessions_v4 a JOIN capacity_fixture_seed s
          ON a.token_digest=decode(s.token_digest_hex,'hex')
    ) OR EXISTS (
        SELECT 1 FROM rate_limit_buckets_v4 b JOIN capacity_fixture_seed s
          ON b.scope='authenticated_account_minute'
         AND b.subject_digest=decode(s.rate_limit_digest_hex,'hex')
    ) THEN
        RAISE EXCEPTION 'fixture identity already exists';
    END IF;
END
$capacity_fixture_input_guard$;

CREATE TEMP TABLE capacity_fixture_clock AS
SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms;

INSERT INTO users (
    id,username,username_key,password_hash,created_at,sync_verified_at,
    disabled_at,intelligence_feed_enabled
)
SELECT s.user_id,s.username,s.username_key,'{PASSWORD_SENTINEL}',c.now_ms,c.now_ms,0,false
FROM capacity_fixture_seed s CROSS JOIN capacity_fixture_clock c
ORDER BY s.ordinal;

INSERT INTO auth_sessions_v4 (
    token_digest,user_id,installation_id,device_name,created_at,last_used_at,
    expires_at,revoked_at
)
SELECT decode(s.token_digest_hex,'hex'),s.user_id,s.installation_id,s.device_name,
       c.now_ms,c.now_ms,c.now_ms+{SESSION_TTL_MS},0
FROM capacity_fixture_seed s CROSS JOIN capacity_fixture_clock c
ORDER BY s.ordinal;

DO $capacity_fixture_post_insert_guard$
BEGIN
    IF (SELECT COUNT(*) FROM users u JOIN capacity_fixture_seed s ON s.user_id=u.id)
           <> {ACCOUNT_COUNT}
       OR (SELECT COUNT(*) FROM auth_sessions_v4 a
           JOIN capacity_fixture_seed s ON a.user_id=s.user_id
           WHERE a.token_digest=decode(s.token_digest_hex,'hex')
             AND a.revoked_at=0
             AND a.expires_at>(SELECT now_ms FROM capacity_fixture_clock))
           <> {ACCOUNT_COUNT}
       OR (SELECT COUNT(*) FROM account_data_generations g
           JOIN capacity_fixture_seed s ON g.user_id=s.user_id
           WHERE g.generation=1 AND g.server_cursor=0) <> {ACCOUNT_COUNT}
       OR (SELECT COUNT(*) FROM account_storage_usage_v5 l
           JOIN capacity_fixture_seed s ON l.user_id=s.user_id
           WHERE l.entity_bytes=0 AND l.asset_bytes=0)
           <> {ACCOUNT_COUNT} THEN
        RAISE EXCEPTION 'fixture aggregate validation failed';
    END IF;
END
$capacity_fixture_post_insert_guard$;

CREATE TEMP TABLE capacity_fixture_report AS
SELECT json_build_object(
    'ok',true,
    'requestedAccountCount',{ACCOUNT_COUNT},
    'accountCount',(SELECT COUNT(*) FROM users u
        JOIN capacity_fixture_seed s ON s.user_id=u.id),
    'verifiedAccountCount',(SELECT COUNT(*) FROM users u
        JOIN capacity_fixture_seed s ON s.user_id=u.id WHERE u.sync_verified_at>0),
    'disabledAccountCount',(SELECT COUNT(*) FROM users u
        JOIN capacity_fixture_seed s ON s.user_id=u.id WHERE u.disabled_at<>0),
    'sessionCount',(SELECT COUNT(*) FROM auth_sessions_v4 a
        JOIN capacity_fixture_seed s ON s.user_id=a.user_id),
    'activeSessionCount',(SELECT COUNT(*) FROM auth_sessions_v4 a
        JOIN capacity_fixture_seed s ON s.user_id=a.user_id
        WHERE a.revoked_at=0 AND a.expires_at>(SELECT now_ms FROM capacity_fixture_clock)),
    'distinctSessionDigestCount',(SELECT COUNT(DISTINCT a.token_digest)
        FROM auth_sessions_v4 a JOIN capacity_fixture_seed s ON s.user_id=a.user_id),
    'generationCount',(SELECT COUNT(*) FROM account_data_generations g
        JOIN capacity_fixture_seed s ON s.user_id=g.user_id),
    'generationOneCount',(SELECT COUNT(*) FROM account_data_generations g
        JOIN capacity_fixture_seed s ON s.user_id=g.user_id WHERE g.generation=1),
    'zeroCursorGenerationCount',(SELECT COUNT(*) FROM account_data_generations g
        JOIN capacity_fixture_seed s ON s.user_id=g.user_id WHERE g.server_cursor=0),
    'storageLedgerCount',(SELECT COUNT(*) FROM account_storage_usage_v5 l
        JOIN capacity_fixture_seed s ON s.user_id=l.user_id),
    'zeroStorageLedgerCount',(SELECT COUNT(*) FROM account_storage_usage_v5 l
        JOIN capacity_fixture_seed s ON s.user_id=l.user_id
        WHERE l.entity_bytes=0 AND l.asset_bytes=0)
) AS payload;
COMMIT;
SELECT payload::text FROM capacity_fixture_report;
"""


def render_cleanup_sql(
    fixture_id: str,
    identities: Sequence[FixtureIdentity],
    *,
    allow_absent: bool = False,
) -> str:
    """Build an exact-manifest cleanup transaction; no broad prefix delete."""
    validate_fixture_id(fixture_id)
    if len(identities) != ACCOUNT_COUNT:
        raise FixtureSeedError("fixture manifest must contain exactly 2048 accounts")
    expected_pattern = f"^cap-{fixture_id}-[0-9]{{4}}$"
    required_tables = (
        "rust_service_metadata",
        "users",
        "auth_sessions_v4",
        "account_data_generations",
        "account_storage_usage_v5",
        "rate_limit_buckets_v4",
        "sync_entities_v4",
        "sync_push_receipts_v4",
        "account_daily_usage_v4",
        "sync_assets_v4",
    )
    allow_absent_sql = "true" if allow_absent else "false"
    return f"""\
\\set ON_ERROR_STOP on
BEGIN;
{_database_guard_sql(required_tables)}
CREATE TEMP TABLE capacity_fixture_cleanup (
    ordinal integer PRIMARY KEY CHECK (ordinal BETWEEN 0 AND {ACCOUNT_COUNT - 1}),
    user_id text NOT NULL UNIQUE,
    rate_limit_digest_hex text NOT NULL UNIQUE
        CHECK (rate_limit_digest_hex ~ '^[0-9a-f]{{64}}$')
);
COPY capacity_fixture_cleanup (ordinal,user_id,rate_limit_digest_hex)
FROM STDIN WITH (FORMAT csv);
{cleanup_copy_csv(identities)}\\.

DO $capacity_fixture_cleanup_guard$
DECLARE
    candidate_count bigint;
    matching_count bigint;
BEGIN
    IF (SELECT COUNT(*) FROM capacity_fixture_cleanup) <> {ACCOUNT_COUNT}
       OR (SELECT COUNT(DISTINCT ordinal) FROM capacity_fixture_cleanup) <> {ACCOUNT_COUNT}
       OR (SELECT MIN(ordinal) FROM capacity_fixture_cleanup) <> 0
       OR (SELECT MAX(ordinal) FROM capacity_fixture_cleanup) <> {ACCOUNT_COUNT - 1}
       OR EXISTS (SELECT 1 FROM capacity_fixture_cleanup
                  WHERE user_id !~ '{expected_pattern}') THEN
        RAISE EXCEPTION 'cleanup manifest shape guard rejected';
    END IF;
    SELECT COUNT(DISTINCT u.id) INTO candidate_count
    FROM users u JOIN capacity_fixture_cleanup c
      ON u.id=c.user_id OR u.username=c.user_id OR u.username_key=c.user_id;
    SELECT COUNT(*) INTO matching_count
    FROM users u JOIN capacity_fixture_cleanup c ON c.user_id=u.id
    WHERE u.username=u.id AND u.username_key=u.id
      AND u.password_hash='{PASSWORD_SENTINEL}';
    IF {allow_absent_sql} AND candidate_count=0 AND matching_count=0 THEN
        NULL;
    ELSIF candidate_count<>{ACCOUNT_COUNT} OR matching_count<>{ACCOUNT_COUNT} THEN
        RAISE EXCEPTION 'cleanup target is absent or not an exact fixture pool';
    END IF;
END
$capacity_fixture_cleanup_guard$;

CREATE TEMP TABLE capacity_fixture_cleanup_counts (
    deleted_accounts bigint NOT NULL DEFAULT 0,
    deleted_rate_limit_buckets bigint NOT NULL DEFAULT 0
);
INSERT INTO capacity_fixture_cleanup_counts DEFAULT VALUES;

WITH deleted AS (
    DELETE FROM rate_limit_buckets_v4 b USING capacity_fixture_cleanup c
    WHERE b.scope='authenticated_account_minute'
      AND b.subject_digest=decode(c.rate_limit_digest_hex,'hex')
    RETURNING 1
)
UPDATE capacity_fixture_cleanup_counts
SET deleted_rate_limit_buckets=(SELECT COUNT(*) FROM deleted);

WITH deleted AS (
    DELETE FROM users u USING capacity_fixture_cleanup c
    WHERE u.id=c.user_id AND u.password_hash='{PASSWORD_SENTINEL}'
    RETURNING 1
)
UPDATE capacity_fixture_cleanup_counts
SET deleted_accounts=(SELECT COUNT(*) FROM deleted);

DO $capacity_fixture_cleanup_post_guard$
BEGIN
    IF ({allow_absent_sql} AND (SELECT deleted_accounts
                               FROM capacity_fixture_cleanup_counts)
                              NOT IN (0,{ACCOUNT_COUNT}))
       OR (NOT {allow_absent_sql} AND (SELECT deleted_accounts
                                      FROM capacity_fixture_cleanup_counts)
                                     <> {ACCOUNT_COUNT})
       OR EXISTS (SELECT 1 FROM users u
                  JOIN capacity_fixture_cleanup c ON c.user_id=u.id)
       OR EXISTS (SELECT 1 FROM auth_sessions_v4 a
                  JOIN capacity_fixture_cleanup c ON c.user_id=a.user_id)
       OR EXISTS (SELECT 1 FROM account_data_generations g
                  JOIN capacity_fixture_cleanup c ON c.user_id=g.user_id)
       OR EXISTS (SELECT 1 FROM account_storage_usage_v5 l
                  JOIN capacity_fixture_cleanup c ON c.user_id=l.user_id)
       OR EXISTS (SELECT 1 FROM rate_limit_buckets_v4 b
                  JOIN capacity_fixture_cleanup c
                    ON b.subject_digest=decode(c.rate_limit_digest_hex,'hex')
                  WHERE b.scope='authenticated_account_minute') THEN
        RAISE EXCEPTION 'fixture cleanup aggregate validation failed';
    END IF;
END
$capacity_fixture_cleanup_post_guard$;

CREATE TEMP TABLE capacity_fixture_cleanup_report AS
SELECT json_build_object(
    'ok',true,
    'requestedAccountCount',{ACCOUNT_COUNT},
    'deletedAccountCount',(SELECT deleted_accounts
        FROM capacity_fixture_cleanup_counts),
    'deletedRateLimitBucketCount',(SELECT deleted_rate_limit_buckets
        FROM capacity_fixture_cleanup_counts),
    'remainingAccountCount',(SELECT COUNT(*) FROM users u
        JOIN capacity_fixture_cleanup c ON c.user_id=u.id),
    'remainingSessionCount',(SELECT COUNT(*) FROM auth_sessions_v4 a
        JOIN capacity_fixture_cleanup c ON c.user_id=a.user_id),
    'remainingGenerationCount',(SELECT COUNT(*) FROM account_data_generations g
        JOIN capacity_fixture_cleanup c ON c.user_id=g.user_id),
    'remainingStorageLedgerCount',(SELECT COUNT(*) FROM account_storage_usage_v5 l
        JOIN capacity_fixture_cleanup c ON c.user_id=l.user_id),
    'remainingEntityCount',(SELECT COUNT(*) FROM sync_entities_v4 e
        JOIN capacity_fixture_cleanup c ON c.user_id=e.user_id),
    'remainingHistoryCount',0,
    'remainingPushReceiptCount',(SELECT COUNT(*) FROM sync_push_receipts_v4 r
        JOIN capacity_fixture_cleanup c ON c.user_id=r.user_id),
    'remainingDailyUsageCount',(SELECT COUNT(*) FROM account_daily_usage_v4 d
        JOIN capacity_fixture_cleanup c ON c.user_id=d.user_id),
    'remainingAssetCount',(SELECT COUNT(*) FROM sync_assets_v4 a
        JOIN capacity_fixture_cleanup c ON c.user_id=a.user_id),
    'remainingRateLimitBucketCount',(SELECT COUNT(*) FROM rate_limit_buckets_v4 b
        JOIN capacity_fixture_cleanup c
          ON b.subject_digest=decode(c.rate_limit_digest_hex,'hex')
        WHERE b.scope='authenticated_account_minute')
) AS payload;
COMMIT;
SELECT payload::text FROM capacity_fixture_cleanup_report;
"""


def validate_aggregate_report(report: object, allowed_keys: frozenset[str]) -> dict[str, object]:
    """Allow only fixed aggregate booleans and non-negative integer counters."""
    if not isinstance(report, dict) or set(report) != allowed_keys:
        raise FixtureSeedError("database aggregate report has an invalid shape")
    for key, value in report.items():
        if key == "ok":
            if value is not True:
                raise FixtureSeedError("database aggregate validation failed")
        elif isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise FixtureSeedError("database aggregate report has an invalid value")
    return report


def validate_seed_report(report: object) -> dict[str, object]:
    validated = validate_aggregate_report(report, SEED_REPORT_KEYS)
    exact_count_keys = SEED_REPORT_KEYS - {
        "ok",
        "disabledAccountCount",
        "tokenFileMode",
    }
    if any(validated[key] != ACCOUNT_COUNT for key in exact_count_keys):
        raise FixtureSeedError("database aggregate validation failed")
    if validated["disabledAccountCount"] != 0 or validated["tokenFileMode"] != 0o600:
        raise FixtureSeedError("database aggregate validation failed")
    return validated


def validate_cleanup_target_counts(
    candidate_count: int,
    matching_count: int,
    *,
    allow_absent: bool = False,
) -> None:
    """Mirror the SQL cleanup gate for offline rejection-path tests."""
    if allow_absent and candidate_count == 0 and matching_count == 0:
        return
    if candidate_count == ACCOUNT_COUNT and matching_count == ACCOUNT_COUNT:
        return
    raise FixtureSeedError("cleanup target is absent or not an exact fixture pool")


def validate_cleanup_report(
    report: object,
    *,
    allow_absent: bool = False,
) -> dict[str, object]:
    validated = validate_aggregate_report(report, CLEANUP_REPORT_KEYS)
    if validated["requestedAccountCount"] != ACCOUNT_COUNT:
        raise FixtureSeedError("database aggregate validation failed")
    allowed_deleted_counts = {ACCOUNT_COUNT, 0} if allow_absent else {ACCOUNT_COUNT}
    if validated["deletedAccountCount"] not in allowed_deleted_counts:
        raise FixtureSeedError("database aggregate validation failed")
    zero_keys = CLEANUP_REPORT_KEYS - {
        "ok",
        "requestedAccountCount",
        "deletedAccountCount",
        "deletedRateLimitBucketCount",
    }
    if any(validated[key] != 0 for key in zero_keys):
        raise FixtureSeedError("database aggregate validation failed")
    return validated


def _trusted_executable(candidates: Sequence[str], label: str) -> str:
    for candidate in candidates:
        try:
            details = os.stat(candidate)
        except OSError:
            continue
        if (
            stat.S_ISREG(details.st_mode)
            and details.st_uid == 0
            and details.st_mode & 0o022 == 0
            and os.access(candidate, os.X_OK)
        ):
            return candidate
    raise FixtureSeedError(f"trusted {label} executable is unavailable")


def _systemd_properties(service: str) -> dict[str, str]:
    systemctl = _trusted_executable(SYSTEMCTL_CANDIDATES, "systemctl")
    try:
        result = subprocess.run(
            [
                systemctl,
                "show",
                "--no-pager",
                "--property=LoadState,ActiveState,SubState,MainPID",
                service,
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=10,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"},
        )
    except (OSError, subprocess.SubprocessError):
        raise FixtureSeedError("dev-test service state is unavailable") from None
    if result.returncode != 0:
        raise FixtureSeedError("dev-test service state is unavailable")
    properties = {}
    for line in result.stdout.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            properties[key] = value
    return properties


def read_running_service_environment(service: str) -> ServiceEnvironment:
    """Read the effective environment of one stable, running dev-test PID."""
    validate_service_name(service)
    before = _systemd_properties(service)
    if (
        before.get("LoadState") != "loaded"
        or before.get("ActiveState") != "active"
        or before.get("SubState") != "running"
        or not before.get("MainPID", "").isdigit()
        or int(before["MainPID"]) <= 0
    ):
        raise FixtureSeedError("dev-test service is not running")
    pid = int(before["MainPID"])
    try:
        with open(f"/proc/{pid}/environ", "rb") as source:
            blob = source.read(1024 * 1024 + 1)
    except OSError:
        raise FixtureSeedError("running service environment is unavailable") from None
    if len(blob) > 1024 * 1024:
        raise FixtureSeedError("running service environment is invalid")
    after = _systemd_properties(service)
    if after.get("MainPID") != str(pid) or after.get("ActiveState") != "active":
        raise FixtureSeedError("dev-test service changed while reading its environment")
    return extract_service_environment(blob)


def _write_token_file(path: str, rows: Sequence[SeedRow]) -> None:
    payload = token_file_payload(rows)
    parent = posixpath.dirname(path)
    try:
        parent_details = os.stat(parent)
    except OSError:
        raise FixtureSeedError("token output parent is unavailable") from None
    if not stat.S_ISDIR(parent_details.st_mode):
        raise FixtureSeedError("token output parent is unavailable")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = None
    try:
        descriptor = os.open(path, flags, 0o600)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as destination:
            descriptor = None
            destination.write(payload)
            destination.flush()
            os.fsync(destination.fileno())
        details = os.stat(path, follow_symlinks=False)
        if (
            not stat.S_ISREG(details.st_mode)
            or stat.S_IMODE(details.st_mode) != 0o600
            or details.st_nlink != 1
        ):
            raise FixtureSeedError("token output permissions could not be secured")
    except FixtureSeedError:
        _unlink_token_file(path)
        raise
    except OSError:
        _unlink_token_file(path)
        raise FixtureSeedError("token output could not be created securely") from None
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass


def _unlink_token_file(path: str) -> None:
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError:
        pass


def _execute_psql(database: DatabaseTarget, sql: str) -> bytes:
    sudo = _trusted_executable(SUDO_CANDIDATES, "sudo")
    psql = _trusted_executable(PSQL_CANDIDATES, "psql")
    try:
        result = subprocess.run(
            [
                sudo,
                "-n",
                "-u",
                "postgres",
                "--",
                psql,
                "-X",
                "-qAt",
                "-v",
                "ON_ERROR_STOP=1",
                "-p",
                str(database.port),
                "-d",
                database.name,
            ],
            input=sql.encode("utf-8"),
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=30,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"},
        )
    except (OSError, subprocess.SubprocessError):
        raise FixtureSeedError("PostgreSQL fixture transaction did not complete") from None
    if result.returncode != 0:
        raise FixtureSeedError("PostgreSQL fixture transaction did not complete")
    return result.stdout


def _parse_psql_report(output: bytes) -> dict[str, object]:
    try:
        lines = [line for line in output.decode("utf-8").splitlines() if line.strip()]
        report = json.loads(lines[-1]) if len(lines) == 1 else None
    except (UnicodeDecodeError, json.JSONDecodeError):
        report = None
    if not isinstance(report, dict):
        raise FixtureSeedError("database aggregate report is unavailable")
    return report


def seed_fixture(
    service: str,
    fixture_id: str,
    token_output: str,
    *,
    expected_target_fingerprint: str,
) -> dict[str, object]:
    environment = read_running_service_environment(service)
    expected_target_fingerprint = validate_target_fingerprint(
        expected_target_fingerprint
    )
    if not hmac.compare_digest(
        environment.target_fingerprint, expected_target_fingerprint
    ):
        raise FixtureSeedError("running service target changed after recovery registration")
    identities = build_identities(fixture_id, environment.token_hmac_key)
    rows = build_seed_rows(identities, environment.token_hmac_key)
    _write_token_file(token_output, rows)
    try:
        output = _execute_psql(
            environment.database,
            render_seed_sql(fixture_id, rows),
        )
    except Exception:
        _unlink_token_file(token_output)
        raise
    try:
        report = _parse_psql_report(output)
        report["uniqueTokenCount"] = len({row.token for row in rows})
        report["tokenFileMode"] = 0o600
        return validate_seed_report(report)
    except FixtureSeedError:
        _best_effort_cleanup_committed_seed(environment, fixture_id, identities)
        _unlink_token_file(token_output)
        raise FixtureSeedError("committed fixture aggregate validation failed safely") from None


def _best_effort_cleanup_committed_seed(
    environment: ServiceEnvironment,
    fixture_id: str,
    identities: Sequence[FixtureIdentity],
) -> None:
    """Recover an uncertain committed seed without exposing cleanup details."""
    try:
        output = _execute_psql(
            environment.database,
            render_cleanup_sql(fixture_id, identities, allow_absent=True),
        )
        validate_cleanup_report(_parse_psql_report(output), allow_absent=True)
    except Exception:
        pass


def cleanup_fixture(
    service: str,
    fixture_id: str,
    *,
    allow_absent: bool = False,
    expected_target_fingerprint: str,
) -> dict[str, object]:
    environment = read_running_service_environment(service)
    expected_target_fingerprint = validate_target_fingerprint(
        expected_target_fingerprint
    )
    if not hmac.compare_digest(
        environment.target_fingerprint, expected_target_fingerprint
    ):
        raise FixtureSeedError("running service target changed after recovery registration")
    identities = build_identities(fixture_id, environment.token_hmac_key)
    output = _execute_psql(
        environment.database,
        render_cleanup_sql(fixture_id, identities, allow_absent=allow_absent),
    )
    return validate_cleanup_report(_parse_psql_report(output), allow_absent=allow_absent)


def _disable_core_dumps() -> None:
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except (ImportError, OSError, ValueError):
        raise FixtureSeedError("process core dumps could not be disabled") from None


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(
        description="Seed or clean a guarded disposable capacity account pool.",
        allow_abbrev=False,
    )
    actions = command.add_subparsers(dest="action", required=True)
    seed = actions.add_parser("seed", allow_abbrev=False)
    seed.add_argument("--service", required=True)
    seed.add_argument("--fixture-id", required=True)
    seed.add_argument("--token-output", required=True)
    seed.add_argument("--expected-target-fingerprint", required=True)
    cleanup = actions.add_parser("cleanup", allow_abbrev=False)
    cleanup.add_argument("--service", required=True)
    cleanup.add_argument("--fixture-id", required=True)
    cleanup.add_argument("--allow-absent", action="store_true")
    cleanup.add_argument("--expected-target-fingerprint", required=True)
    return command


def main(
    argv: Sequence[str] | None = None,
    *,
    platform_name: str | None = None,
    effective_uid: int | None = None,
) -> int:
    arguments = parser().parse_args(argv)
    actual_platform = sys.platform if platform_name is None else platform_name
    if effective_uid is None:
        actual_uid = os.geteuid() if hasattr(os, "geteuid") else -1
    else:
        actual_uid = effective_uid
    try:
        validate_runtime(actual_platform, actual_uid)
        _disable_core_dumps()
        os.umask(0o077)
        service = validate_service_name(arguments.service)
        fixture_id = validate_fixture_id(arguments.fixture_id)
        if arguments.action == "seed":
            token_output = validate_token_output_path(arguments.token_output)
            report = seed_fixture(
                service,
                fixture_id,
                token_output,
                expected_target_fingerprint=arguments.expected_target_fingerprint,
            )
        else:
            report = cleanup_fixture(
                service,
                fixture_id,
                allow_absent=arguments.allow_absent,
                expected_target_fingerprint=arguments.expected_target_fingerprint,
            )
        print(json.dumps(report, sort_keys=True, separators=(",", ":")))
        return 0
    except FixtureSeedError as error:
        print(f"capacity fixture operation rejected: {error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("capacity fixture operation interrupted", file=sys.stderr)
        return 130
    except Exception:
        print("capacity fixture operation failed safely", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
