"""Delta-compressed, entity-level recovery history for reader sync data.

Every entity starts with a complete zlib-compressed snapshot. Later revisions
store a JSON-pointer delta only when that delta is smaller than another
snapshot. The chain is periodically rebased at the retention boundary, so
recovery remains bounded and a retained history row never depends on a deleted
pre-window predecessor.
"""

import copy
import hashlib
import json
import time
import zlib

HISTORY_SCHEMA_VERSION = 2
HISTORY_RETENTION_DAYS = 90
HISTORY_RETENTION_MS = HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000
HISTORY_COMPRESSION_LEVEL = 6
MAX_RESTORE_ENTITIES = 50_000
SNAPSHOT = "snapshot"
PATCH = "patch"
PATCH_FORMAT = "kunpeng-json-pointer-ops-v1"
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


def _canonical_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _encode_payload(text):
    raw = str(text).encode("utf-8")
    return zlib.compress(raw, HISTORY_COMPRESSION_LEVEL), len(raw), hashlib.sha256(raw).hexdigest()


def decode_payload(row):
    """Decode and verify the stored representation (snapshot or patch)."""
    compressed = bytes(_row_value(row, "payload_zlib", b""))
    expected_bytes = int(_row_value(row, "payload_bytes", 0))
    expected_hash = str(_row_value(row, "payload_sha256", ""))
    raw = zlib.decompress(compressed)
    if len(raw) != expected_bytes or hashlib.sha256(raw).hexdigest() != expected_hash:
        raise ValueError("RECOVERY_HISTORY_CORRUPT")
    text = raw.decode("utf-8")
    json.loads(text)
    return text


def _escape_pointer_token(token):
    return str(token).replace("~", "~0").replace("/", "~1")


def _unescape_pointer_token(token):
    return str(token).replace("~1", "/").replace("~0", "~")


def _build_patch_ops(previous, current, path=""):
    if previous == current:
        return []
    if isinstance(previous, dict) and isinstance(current, dict):
        operations = []
        for key in sorted(set(previous) | set(current)):
            child_path = f"{path}/{_escape_pointer_token(key)}"
            if key not in current:
                operations.append(["remove", child_path])
            elif key not in previous:
                operations.append(["set", child_path, current[key]])
            else:
                operations.extend(_build_patch_ops(previous[key], current[key], child_path))
        return operations
    # Arrays and scalars are atomic. Unlike RFC 7396, this preserves a real
    # JSON null value without reserving it as a deletion sentinel.
    return [["set", path, current]]


def _pointer_parts(path):
    if not isinstance(path, str) or (path and not path.startswith("/")):
        raise ValueError("RECOVERY_HISTORY_CORRUPT")
    return [] if not path else [_unescape_pointer_token(part) for part in path[1:].split("/")]


def _apply_patch(previous_text, patch_text):
    try:
        document = json.loads(previous_text)
        patch = json.loads(patch_text)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise ValueError("RECOVERY_HISTORY_CORRUPT") from error
    if not isinstance(patch, dict) or patch.get("format") != PATCH_FORMAT or not isinstance(patch.get("ops"), list):
        raise ValueError("RECOVERY_HISTORY_CORRUPT")
    document = copy.deepcopy(document)
    for operation in patch["ops"]:
        if not isinstance(operation, list) or len(operation) not in (2, 3) or operation[0] not in ("set", "remove"):
            raise ValueError("RECOVERY_HISTORY_CORRUPT")
        kind, path = operation[0], operation[1]
        if kind == "set" and len(operation) != 3:
            raise ValueError("RECOVERY_HISTORY_CORRUPT")
        if kind == "remove" and len(operation) != 2:
            raise ValueError("RECOVERY_HISTORY_CORRUPT")
        parts = _pointer_parts(path)
        if not parts:
            if kind != "set":
                raise ValueError("RECOVERY_HISTORY_CORRUPT")
            document = copy.deepcopy(operation[2])
            continue
        target = document
        for part in parts[:-1]:
            if not isinstance(target, dict) or part not in target:
                raise ValueError("RECOVERY_HISTORY_CORRUPT")
            target = target[part]
        if not isinstance(target, dict):
            raise ValueError("RECOVERY_HISTORY_CORRUPT")
        if kind == "set":
            target[parts[-1]] = copy.deepcopy(operation[2])
        elif parts[-1] not in target:
            raise ValueError("RECOVERY_HISTORY_CORRUPT")
        else:
            del target[parts[-1]]
    return _canonical_json(document)


def _state_text_for_row(previous_text, row):
    payload_text = decode_payload(row)
    payload_kind = str(_row_value(row, "payload_kind", SNAPSHOT) or SNAPSHOT)
    if payload_kind == SNAPSHOT:
        state_text = payload_text
    elif payload_kind == PATCH:
        if previous_text is None:
            raise ValueError("RECOVERY_HISTORY_CORRUPT")
        state_text = _apply_patch(previous_text, payload_text)
    else:
        raise ValueError("RECOVERY_HISTORY_CORRUPT")
    expected_bytes = int(_row_value(row, "state_bytes", 0)) or int(_row_value(row, "payload_bytes", 0))
    expected_hash = str(_row_value(row, "state_sha256", "") or _row_value(row, "payload_sha256", ""))
    encoded = state_text.encode("utf-8")
    if len(encoded) != expected_bytes or hashlib.sha256(encoded).hexdigest() != expected_hash:
        raise ValueError("RECOVERY_HISTORY_CORRUPT")
    return state_text


def _last_history_row(conn, user_id, kind, entity_id):
    return conn.execute(
        "SELECT sequence FROM entity_history WHERE user_id=? AND kind=? AND entity_id=? ORDER BY sequence DESC LIMIT 1",
        (user_id, kind, entity_id),
    ).fetchone()


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
            payload_kind TEXT NOT NULL DEFAULT 'snapshot',
            base_sequence INTEGER NOT NULL DEFAULT 0,
            state_bytes INTEGER NOT NULL DEFAULT 0,
            state_sha256 TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER NOT NULL DEFAULT 0,
            device_id TEXT NOT NULL DEFAULT '',
            sync_version INTEGER NOT NULL DEFAULT 0,
            recorded_at INTEGER NOT NULL,
            source TEXT NOT NULL,
            UNIQUE(user_id,kind,entity_id,recorded_at,source),
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_entity_history_user_recorded ON entity_history(user_id,recorded_at,sequence)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_entity_history_entity_recorded ON entity_history(user_id,kind,entity_id,recorded_at DESC,sequence DESC)")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS recovery_accounts (
            user_id TEXT PRIMARY KEY, enabled_at INTEGER NOT NULL, last_pruned_at INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY(user_id) REFERENCES users(id))"""
    )
    if not seed_existing:
        return 0
    recorded_at = int(recorded_at or _now_ms())
    for user in conn.execute("SELECT id FROM users").fetchall():
        conn.execute("INSERT OR IGNORE INTO recovery_accounts(user_id,enabled_at,last_pruned_at) VALUES(?,?,0)", (user["id"], recorded_at))
    inserted = 0
    rows = conn.execute("SELECT user_id,kind,id,json,updated_at,deleted_at,device_id,sync_version FROM entities ORDER BY user_id,kind,id").fetchall()
    for row in rows:
        inserted += record_entity(conn, row["user_id"], row["kind"], row["id"], row["json"], row["updated_at"], row["deleted_at"], row["device_id"], row["sync_version"], recorded_at, "baseline")
    return inserted


def upgrade_history_schema(conn):
    """Upgrade v1 full snapshots in place; old rows remain valid snapshots."""
    columns = {row[1] for row in conn.execute("PRAGMA table_info(entity_history)").fetchall()}
    additions = (
        ("payload_kind", "TEXT NOT NULL DEFAULT 'snapshot'"),
        ("base_sequence", "INTEGER NOT NULL DEFAULT 0"),
        ("state_bytes", "INTEGER NOT NULL DEFAULT 0"),
        ("state_sha256", "TEXT NOT NULL DEFAULT ''"),
    )
    for name, declaration in additions:
        if name not in columns:
            conn.execute(f"ALTER TABLE entity_history ADD COLUMN {name} {declaration}")
    conn.execute(
        """UPDATE entity_history SET payload_kind='snapshot',base_sequence=0,
           state_bytes=payload_bytes,state_sha256=payload_sha256
           WHERE payload_kind='' OR state_bytes=0 OR state_sha256=''"""
    )


def ensure_account(conn, user_id, enabled_at=None):
    conn.execute("INSERT OR IGNORE INTO recovery_accounts(user_id,enabled_at,last_pruned_at) VALUES(?,?,0)", (user_id, int(enabled_at or _now_ms())))


def record_entity(conn, user_id, kind, entity_id, json_text, updated_at, deleted_at, device_id, sync_version, recorded_at, source="sync", previous_json_text=None):
    if kind in NON_RECOVERABLE_KINDS:
        return 0
    try:
        state_text = _canonical_json(json.loads(json_text))
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise ValueError("RECOVERY_HISTORY_CORRUPT") from error
    recorded_at = int(recorded_at)
    ensure_account(conn, user_id, recorded_at)
    snapshot_zlib, snapshot_bytes, snapshot_hash = _encode_payload(state_text)
    payload_kind, payload_zlib, payload_bytes, payload_hash, base_sequence = SNAPSHOT, snapshot_zlib, snapshot_bytes, snapshot_hash, 0
    prior = _last_history_row(conn, user_id, kind, entity_id)
    if previous_json_text is not None and prior is not None:
        try:
            operations = _build_patch_ops(json.loads(previous_json_text), json.loads(state_text))
            patch_text = _canonical_json({"format": PATCH_FORMAT, "ops": operations})
            patch_zlib, patch_bytes, patch_hash = _encode_payload(patch_text)
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            raise ValueError("RECOVERY_HISTORY_CORRUPT") from error
        if len(patch_zlib) < len(snapshot_zlib) and patch_bytes < snapshot_bytes:
            payload_kind, payload_zlib, payload_bytes, payload_hash = PATCH, patch_zlib, patch_bytes, patch_hash
            base_sequence = int(prior["sequence"])
    cursor = conn.execute(
        """INSERT OR IGNORE INTO entity_history(
            user_id,kind,entity_id,payload_zlib,payload_bytes,payload_sha256,payload_kind,base_sequence,state_bytes,state_sha256,
            updated_at,deleted_at,device_id,sync_version,recorded_at,source
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (user_id, kind, entity_id, payload_zlib, payload_bytes, payload_hash, payload_kind, base_sequence, snapshot_bytes, snapshot_hash,
         int(updated_at), int(deleted_at), str(device_id or ""), int(sync_version), recorded_at, str(source or "sync")[:32]),
    )
    return max(0, int(cursor.rowcount))


def _states_at(conn, user_id, target_at=None, only_key=None):
    clauses, values = ["user_id=?"], [user_id]
    if target_at is not None:
        clauses.append("recorded_at<=?")
        values.append(int(target_at))
    if only_key is not None:
        clauses.extend(("kind=?", "entity_id=?"))
        values.extend(only_key)
    rows = conn.execute(
        "SELECT * FROM entity_history WHERE " + " AND ".join(clauses) + " ORDER BY kind,entity_id,recorded_at,sequence",
        values,
    ).fetchall()
    states = {}
    for row in rows:
        key = (row["kind"], row["entity_id"])
        previous = states[key]["json"] if key in states else None
        states[key] = {"json": _state_text_for_row(previous, row), "row": row}
    return states


def prune_history(conn, user_id, current_at=None):
    current_at = int(current_at or _now_ms())
    cutoff = current_at - HISTORY_RETENTION_MS
    anchors = conn.execute(
        """SELECT kind,entity_id,MAX(sequence) AS sequence FROM entity_history
           WHERE user_id=? AND recorded_at<? GROUP BY kind,entity_id""",
        (user_id, cutoff),
    ).fetchall()
    # Rebase every pre-window anchor into a full snapshot before old ancestors
    # disappear. Window records continue from this retained anchor.
    for anchor in anchors:
        key = (anchor["kind"], anchor["entity_id"])
        state = _states_at(conn, user_id, only_key=key).get(key)
        if not state:
            raise ValueError("RECOVERY_HISTORY_CORRUPT")
        # Limit reconstruction to the selected anchor rather than later rows.
        rows = conn.execute("SELECT * FROM entity_history WHERE user_id=? AND kind=? AND entity_id=? AND sequence<=? ORDER BY recorded_at,sequence", (user_id, key[0], key[1], anchor["sequence"])).fetchall()
        text = None
        for row in rows:
            text = _state_text_for_row(text, row)
        encoded, size, digest = _encode_payload(text)
        conn.execute("UPDATE entity_history SET payload_zlib=?,payload_bytes=?,payload_sha256=?,payload_kind=?,base_sequence=0,state_bytes=?,state_sha256=? WHERE sequence=?", (encoded, size, digest, SNAPSHOT, size, digest, anchor["sequence"]))
    if anchors:
        conn.execute("DELETE FROM entity_history WHERE user_id=? AND recorded_at<? AND sequence NOT IN (" + ",".join("?" for _ in anchors) + ")", (user_id, cutoff, *(int(row["sequence"]) for row in anchors)))
    conn.execute("UPDATE recovery_accounts SET last_pruned_at=? WHERE user_id=?", (current_at, user_id))
    return len(anchors)


def status(conn, user_id, current_at=None):
    current_at = int(current_at or _now_ms())
    account = conn.execute("SELECT enabled_at,last_pruned_at FROM recovery_accounts WHERE user_id=?", (user_id,)).fetchone()
    summary = conn.execute(
        """SELECT COUNT(*) AS version_count,MIN(recorded_at) AS first_version_at,MAX(recorded_at) AS latest_version_at,
           COALESCE(SUM(LENGTH(payload_zlib)),0) AS compressed_bytes,COALESCE(SUM(payload_bytes),0) AS uncompressed_bytes,
           COALESCE(SUM(state_bytes),0) AS state_bytes FROM entity_history WHERE user_id=?""", (user_id,)
    ).fetchone()
    enabled_at = int(account["enabled_at"]) if account else 0
    return {"schema_version": HISTORY_SCHEMA_VERSION, "retention_days": HISTORY_RETENTION_DAYS,
            "available": bool(account and int(summary["version_count"]) > 0), "enabled_at": enabled_at,
            "restorable_from": max(enabled_at, current_at - HISTORY_RETENTION_MS) if enabled_at else 0,
            "latest_version_at": int(summary["latest_version_at"] or 0), "version_count": int(summary["version_count"]),
            "compressed_bytes": int(summary["compressed_bytes"]), "uncompressed_bytes": int(summary["uncompressed_bytes"]),
            "state_bytes": int(summary["state_bytes"]), "last_pruned_at": int(account["last_pruned_at"] or 0) if account else 0}


def _next_server_stamp(conn, current_at):
    conn.execute("UPDATE sync_clock SET value=CASE WHEN value>=? THEN value+1 ELSE ? END WHERE id=1", (current_at, current_at))
    return int(conn.execute("SELECT value FROM sync_clock WHERE id=1").fetchone()[0])


def restore_account(conn, user_id, target_at, operation_at=None):
    operation_at, target_at = int(operation_at or _now_ms()), int(target_at)
    recovery_status = status(conn, user_id, operation_at)
    if not recovery_status["available"]:
        raise ValueError("RECOVERY_UNAVAILABLE")
    if target_at < recovery_status["restorable_from"] or target_at > operation_at:
        raise ValueError("RECOVERY_TARGET_OUT_OF_RANGE")
    historical = _states_at(conn, user_id, target_at)
    if len(historical) > MAX_RESTORE_ENTITIES:
        raise ValueError("RECOVERY_ENTITY_LIMIT")
    current_rows = conn.execute("SELECT kind,id,json,updated_at,deleted_at,device_id,sync_version FROM entities WHERE user_id=?", (user_id,)).fetchall()
    current = {(row["kind"], row["id"]): row for row in current_rows}
    restored_count = tombstoned_count = 0
    for key, item in historical.items():
        row, payload_text = item["row"], item["json"]
        existing = current.get(key)
        sync_version = max(int(_row_value(existing, "sync_version", 0)), int(row["sync_version"])) + 1
        stamp, deleted_at = _next_server_stamp(conn, operation_at), 0
        if int(row["deleted_at"]) > 0:
            deleted_at = stamp
        conn.execute("""INSERT INTO entities(user_id,kind,id,json,updated_at,deleted_at,device_id,sync_version,server_updated_at)
                        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,kind,id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at,device_id=excluded.device_id,sync_version=excluded.sync_version,server_updated_at=excluded.server_updated_at""",
                     (user_id, key[0], key[1], payload_text, stamp, deleted_at, "server-recovery", sync_version, stamp))
        record_entity(conn, user_id, key[0], key[1], payload_text, stamp, deleted_at, "server-recovery", sync_version, stamp, "restore", existing["json"] if existing else None)
        restored_count += 1
    for key, row in current.items():
        if key in historical or key[0] in NON_RECOVERABLE_KINDS:
            continue
        stamp, sync_version = _next_server_stamp(conn, operation_at), int(row["sync_version"]) + 1
        conn.execute("UPDATE entities SET json='{}',updated_at=?,deleted_at=?,device_id=?,sync_version=?,server_updated_at=? WHERE user_id=? AND kind=? AND id=?", (stamp, stamp, "server-recovery", sync_version, stamp, user_id, key[0], key[1]))
        record_entity(conn, user_id, key[0], key[1], "{}", stamp, stamp, "server-recovery", sync_version, stamp, "restore", row["json"])
        tombstoned_count += 1
    prune_history(conn, user_id, operation_at)
    return {"target_at": target_at, "restored_at": operation_at, "restored_entities": restored_count, "tombstoned_entities": tombstoned_count}
