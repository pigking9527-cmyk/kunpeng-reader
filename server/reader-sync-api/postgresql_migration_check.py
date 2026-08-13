#!/usr/bin/env python3
"""Produce content-free SQLite cutover invariants for PostgreSQL comparison."""

import argparse
import hashlib
import json
import sqlite3


def update_text(hasher, value):
    raw = str(value).encode("utf-8")
    hasher.update(len(raw).to_bytes(4, "big"))
    hasher.update(raw)


def inventory(conn):
    hasher = hashlib.sha256()
    count = 0
    rows = conn.execute(
        "SELECT user_id,kind,id,updated_at,deleted_at,device_id,sync_version,server_updated_at FROM entities ORDER BY user_id,kind,id"
    )
    for row in rows:
        count += 1
        for value in row:
            update_text(hasher, value)
    return count, hasher.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    args = parser.parse_args()
    conn = sqlite3.connect(f"file:{args.database}?mode=ro", uri=True)
    count, digest = inventory(conn)
    output = {"quickCheck": conn.execute("PRAGMA quick_check").fetchone()[0], "entities": count, "inventoryDigest": digest}
    for table in (
        "users",
        "tokens",
        "entity_history",
        "account_usage",
        "account_emails",
        "account_codes",
        "secret_bundle_epochs",
        "account_data_generations",
        "recovery_accounts",
        "feedback",
        "rate_limit_buckets",
        "security_audit",
        "security_alerts",
        "reader_assets",
        "reader_asset_uploads",
    ):
        try:
            output[table] = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        except sqlite3.Error:
            output[table] = None
    try:
        output["plainTokens"] = conn.execute(
            "SELECT COUNT(*) FROM tokens WHERE token NOT LIKE 'hmac:%'"
        ).fetchone()[0]
        expected_storage = conn.execute(
            """SELECT COALESCE((SELECT SUM(length(json)) FROM entities),0)
                    + COALESCE((SELECT SUM(length(payload_zlib)) FROM entity_history),0)
                    + COALESCE((SELECT SUM(byte_size) FROM reader_assets),0)"""
        ).fetchone()[0]
        ledger_storage = conn.execute(
            "SELECT COALESCE(SUM(storage_bytes),0) FROM account_usage"
        ).fetchone()[0]
        output["storageLedgerMatches"] = expected_storage == ledger_storage
    except sqlite3.Error:
        output["plainTokens"] = None
        output["storageLedgerMatches"] = None
    conn.close()
    print(json.dumps(output, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
