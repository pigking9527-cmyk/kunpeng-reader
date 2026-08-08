"""Compressed, entity-level recovery history for reader sync data.

Only entities that actually change get another history row. Each row contains a
complete compressed entity payload, so recovery never depends on replaying a
fragile field-level delta chain.
"""

import hashlib
import json
import time
import zlib

HISTORY_SCHEMA_VERSION = 1
HISTORY_RETENTION_DAYS = 90
HISTORY_RETENTION_MS = HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000
HISTORY_COMPRESSION_LEVEL = 6
MAX_RESTORE_ENTITIES = 50_000
# Rolling a revoked encrypted key envelope back into service is a security
# regression. Account credentials and secret epochs have their own lifecycle.
NON_RECOVERABLE_KINDS = frozenset(("secret_bundle_v1",))


def _now_ms():
    return int(time.time() * 1000)


def _row_value(row, name, default=0):
    try:
        value = row[name]
    except (KeyError, IndexError, TypeError):
        value = default
    return default if value is None else value


def _encode_payload(json_text):
    raw = str(json_text).encode("utf-8")
    return (
        zlib.compress(raw, HISTORY_COMPRESSION_LEVEL),
        len(raw),
        hashlib.sha256(raw).hexdigest(),
    )


def decode_payload(row):
    compressed = bytes(_row_value(row, "payload_zlib", b""))
    expected_bytes = int(_row_value(row, "payload_bytes", 0))
    expected_hash = str(_row_value(row, "payload_sha256", ""))
    raw = zlib.decompress(compressed)
    if len(raw) != expected_bytes or hashlib.sha256(raw).hexdigest() != expected_hash:
        raise ValueError("RECOVERY_HISTORY_CORRUPT")
    text = raw.decode("utf-8")
    json.loads(text)
    return text


def initialize(conn, seed_existing=False, recorded_at=None):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS entity_history (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            payload_zlib BLOB NOT NULL,
            payload_bytes INTEGER NOT NULL,
            payload_sha256 TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER NOT NULL DEFAULT 0,
            device_id TEXT NOT NULL DEFAULT '',
            sync_version INTEGER NOT NULL DEFAULT 0,
            recorded_at INTEGER NOT NULL,
            source TEXT NOT NULL,
            UNIQUE(user_id,kind,entity_id,recorded_at,source),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_entity_history_user_recorded "
        "ON entity_history(user_id,recorded_at,sequence)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_entity_history_entity_recorded "
        "ON entity_history(user_id,kind,entity_id,recorded_at DESC,sequence DESC)"
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS recovery_accounts (
            user_id TEXT PRIMARY KEY,
            enabled_at INTEGER NOT NULL,
            last_pruned_at INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )
    if not seed_existing:
        return 0
    recorded_at = int(recorded_at or _now_ms())
    users = conn.execute("SELECT id FROM users").fetchall()
    for user in users:
        conn.execute(
            "INSERT OR IGNORE INTO recovery_accounts(user_id,enabled_at,last_pruned_at) "
            "VALUES(?,?,0)",
            (user["id"], recorded_at),
        )
    rows = conn.execute(
        "SELECT user_id,kind,id,json,updated_at,deleted_at,device_id,sync_version "
        "FROM entities ORDER BY user_id,kind,id"
    ).fetchall()
    inserted = 0
    for row in rows:
        if row["kind"] in NON_RECOVERABLE_KINDS:
            continue
        inserted += record_entity(
            conn,
            row["user_id"],
            row["kind"],
            row["id"],
            row["json"],
            row["updated_at"],
            row["deleted_at"],
            row["device_id"],
            row["sync_version"],
            recorded_at,
            "baseline",
        )
    return inserted


def ensure_account(conn, user_id, enabled_at=None):
    enabled_at = int(enabled_at or _now_ms())
    conn.execute(
        "INSERT OR IGNORE INTO recovery_accounts(user_id,enabled_at,last_pruned_at) "
        "VALUES(?,?,0)",
        (user_id, enabled_at),
    )


def record_entity(
    conn,
    user_id,
    kind,
    entity_id,
    json_text,
    updated_at,
    deleted_at,
    device_id,
    sync_version,
    recorded_at,
    source="sync",
):
    if kind in NON_RECOVERABLE_KINDS:
        return 0
    recorded_at = int(recorded_at)
    ensure_account(conn, user_id, recorded_at)
    payload_zlib, payload_bytes, payload_sha256 = _encode_payload(json_text)
    cursor = conn.execute(
        """
        INSERT OR IGNORE INTO entity_history(
            user_id,kind,entity_id,payload_zlib,payload_bytes,payload_sha256,
            updated_at,deleted_at,device_id,sync_version,recorded_at,source
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            user_id,
            kind,
            entity_id,
            payload_zlib,
            payload_bytes,
            payload_sha256,
            int(updated_at),
            int(deleted_at),
            str(device_id or ""),
            int(sync_version),
            recorded_at,
            str(source or "sync")[:32],
        ),
    )
    return max(0, int(cursor.rowcount))


def prune_history(conn, user_id, current_at=None):
    current_at = int(current_at or _now_ms())
    cutoff = current_at - HISTORY_RETENTION_MS
    # Keep the newest pre-cutoff row for every entity as the reconstruction
    # anchor. All later rows remain available for the full rolling window.
    cursor = conn.execute(
        """
        DELETE FROM entity_history
        WHERE user_id=? AND recorded_at<? AND sequence NOT IN (
            SELECT MAX(sequence) FROM entity_history
            WHERE user_id=? AND recorded_at<?
            GROUP BY kind,entity_id
        )
        """,
        (user_id, cutoff, user_id, cutoff),
    )
    conn.execute(
        "UPDATE recovery_accounts SET last_pruned_at=? WHERE user_id=?",
        (current_at, user_id),
    )
    return max(0, int(cursor.rowcount))


def status(conn, user_id, current_at=None):
    current_at = int(current_at or _now_ms())
    account = conn.execute(
        "SELECT enabled_at,last_pruned_at FROM recovery_accounts WHERE user_id=?",
        (user_id,),
    ).fetchone()
    summary = conn.execute(
        """
        SELECT COUNT(*) AS version_count,MIN(recorded_at) AS first_version_at,
               MAX(recorded_at) AS latest_version_at,
               COALESCE(SUM(LENGTH(payload_zlib)),0) AS compressed_bytes,
               COALESCE(SUM(payload_bytes),0) AS uncompressed_bytes
        FROM entity_history WHERE user_id=?
        """,
        (user_id,),
    ).fetchone()
    enabled_at = int(account["enabled_at"]) if account else 0
    restorable_from = max(enabled_at, current_at - HISTORY_RETENTION_MS) if enabled_at else 0
    return {
        "schema_version": HISTORY_SCHEMA_VERSION,
        "retention_days": HISTORY_RETENTION_DAYS,
        "available": bool(account and int(summary["version_count"]) > 0),
        "enabled_at": enabled_at,
        "restorable_from": restorable_from,
        "latest_version_at": int(summary["latest_version_at"] or 0),
        "version_count": int(summary["version_count"] or 0),
        "compressed_bytes": int(summary["compressed_bytes"] or 0),
        "uncompressed_bytes": int(summary["uncompressed_bytes"] or 0),
        "last_pruned_at": int(account["last_pruned_at"] or 0) if account else 0,
    }


def _next_server_stamp(conn, current_at):
    conn.execute(
        "UPDATE sync_clock SET value=CASE WHEN value>=? THEN value+1 ELSE ? END WHERE id=1",
        (current_at, current_at),
    )
    return int(conn.execute("SELECT value FROM sync_clock WHERE id=1").fetchone()[0])


def restore_account(conn, user_id, target_at, operation_at=None):
    operation_at = int(operation_at or _now_ms())
    target_at = int(target_at)
    recovery_status = status(conn, user_id, operation_at)
    if not recovery_status["available"]:
        raise ValueError("RECOVERY_UNAVAILABLE")
    if target_at < recovery_status["restorable_from"] or target_at > operation_at:
        raise ValueError("RECOVERY_TARGET_OUT_OF_RANGE")

    historical = conn.execute(
        """
        SELECT * FROM (
            SELECT h.*,ROW_NUMBER() OVER (
                PARTITION BY kind,entity_id
                ORDER BY recorded_at DESC,sequence DESC
            ) AS recovery_rank
            FROM entity_history h
            WHERE user_id=? AND recorded_at<=?
        ) WHERE recovery_rank=1
        ORDER BY kind,entity_id
        """,
        (user_id, target_at),
    ).fetchall()
    if len(historical) > MAX_RESTORE_ENTITIES:
        raise ValueError("RECOVERY_ENTITY_LIMIT")

    current_rows = conn.execute(
        "SELECT kind,id,json,updated_at,deleted_at,device_id,sync_version "
        "FROM entities WHERE user_id=?",
        (user_id,),
    ).fetchall()
    current = {(row["kind"], row["id"]): row for row in current_rows}
    restored_keys = set()
    restored_count = 0
    tombstoned_count = 0

    for row in historical:
        key = (row["kind"], row["entity_id"])
        restored_keys.add(key)
        payload_text = decode_payload(row)
        existing = current.get(key)
        sync_version = max(
            int(_row_value(existing, "sync_version", 0)),
            int(row["sync_version"]),
        ) + 1
        stamp = _next_server_stamp(conn, operation_at)
        was_deleted = int(row["deleted_at"]) > 0
        deleted_at = stamp if was_deleted else 0
        conn.execute(
            """
            INSERT INTO entities(
                user_id,kind,id,json,updated_at,deleted_at,device_id,sync_version,server_updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?)
            ON CONFLICT(user_id,kind,id) DO UPDATE SET
                json=excluded.json,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at,
                device_id=excluded.device_id,sync_version=excluded.sync_version,
                server_updated_at=excluded.server_updated_at
            """,
            (
                user_id,
                row["kind"],
                row["entity_id"],
                payload_text,
                stamp,
                deleted_at,
                "server-recovery",
                sync_version,
                stamp,
            ),
        )
        record_entity(
            conn,
            user_id,
            row["kind"],
            row["entity_id"],
            payload_text,
            stamp,
            deleted_at,
            "server-recovery",
            sync_version,
            stamp,
            "restore",
        )
        restored_count += 1

    # An entity that did not exist at the selected time must become an explicit
    # tombstone; simply deleting its row would let an offline device resurrect it.
    for key, row in current.items():
        if key in restored_keys or key[0] in NON_RECOVERABLE_KINDS:
            continue
        stamp = _next_server_stamp(conn, operation_at)
        sync_version = int(row["sync_version"]) + 1
        conn.execute(
            """
            UPDATE entities SET json='{}',updated_at=?,deleted_at=?,device_id=?,
                                sync_version=?,server_updated_at=?
            WHERE user_id=? AND kind=? AND id=?
            """,
            (
                stamp,
                stamp,
                "server-recovery",
                sync_version,
                stamp,
                user_id,
                key[0],
                key[1],
            ),
        )
        record_entity(
            conn,
            user_id,
            key[0],
            key[1],
            "{}",
            stamp,
            stamp,
            "server-recovery",
            sync_version,
            stamp,
            "restore",
        )
        tombstoned_count += 1

    prune_history(conn, user_id, operation_at)
    return {
        "target_at": target_at,
        "restored_at": operation_at,
        "restored_entities": restored_count,
        "tombstoned_entities": tombstoned_count,
    }