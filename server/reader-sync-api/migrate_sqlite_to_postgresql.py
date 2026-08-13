#!/usr/bin/env python3
"""One-shot, stop-write migration from reader-sync SQLite to PostgreSQL."""

import argparse
import hashlib
import json
import os
import sqlite3


TABLES = (
    "schema_migrations",
    "users",
    "tokens",
    "entities",
    "sync_clock",
    "feedback",
    "account_emails",
    "account_codes",
    "secret_bundle_epochs",
    "account_data_generations",
    "entity_history",
    "recovery_accounts",
    "account_usage",
    "rate_limit_buckets",
    "security_audit",
    "security_alerts",
    "reader_assets",
    "reader_asset_uploads",
)


def update_text(hasher, value):
    raw = str(value).encode("utf-8")
    hasher.update(len(raw).to_bytes(4, "big"))
    hasher.update(raw)


def inventory_digest(rows):
    hasher = hashlib.sha256()
    count = 0
    normalized = [tuple(row) for row in rows]
    normalized.sort(key=lambda row: tuple(str(value).encode("utf-8") for value in row[:3]))
    for row in normalized:
        count += 1
        for value in row:
            update_text(hasher, value)
    return count, hasher.hexdigest()


def sqlite_columns(conn, table):
    return [row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sqlite", required=True)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--postgres-url", default=os.environ.get("SYNC_DATABASE_URL", ""))
    args = parser.parse_args()
    if not args.postgres_url:
        raise SystemExit("PostgreSQL URL is required")
    try:
        import psycopg
    except ImportError as error:
        raise SystemExit("psycopg is required") from error

    source = sqlite3.connect(f"file:{args.sqlite}?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    if source.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise SystemExit("SQLite quick_check failed")
    target = psycopg.connect(args.postgres_url)
    try:
        with target.transaction():
            target.execute("DROP SCHEMA public CASCADE")
            target.execute("CREATE SCHEMA public")
            target.execute(open(args.schema, encoding="utf-8").read(), prepare=False)
            target.execute("ALTER TABLE entities DISABLE TRIGGER entities_storage_delta")
            target.execute("ALTER TABLE entity_history DISABLE TRIGGER history_storage_delta")
            target.execute("ALTER TABLE reader_assets DISABLE TRIGGER assets_storage_delta")
            for table in TABLES:
                columns = sqlite_columns(source, table)
                if not columns:
                    continue
                placeholders = ",".join("%s" for _ in columns)
                names = ",".join(f'"{name}"' for name in columns)
                statement = f'INSERT INTO "{table}" ({names}) VALUES ({placeholders})'
                rows = source.execute(f'SELECT {names} FROM "{table}"').fetchall()
                if rows:
                    with target.cursor() as cursor:
                        cursor.executemany(statement, [tuple(row) for row in rows])
            target.execute("ALTER TABLE entities ENABLE TRIGGER entities_storage_delta")
            target.execute("ALTER TABLE entity_history ENABLE TRIGGER history_storage_delta")
            target.execute("ALTER TABLE reader_assets ENABLE TRIGGER assets_storage_delta")
            for table, column, sequence in (
                ("entity_history", "sequence", "entity_history_sequence_seq"),
                ("security_audit", "id", "security_audit_id_seq"),
                ("security_alerts", "id", "security_alerts_id_seq"),
            ):
                target.execute(
                    f"SELECT setval(%s, GREATEST(COALESCE(MAX({column}),0),1), COALESCE(MAX({column}),0)>0) FROM {table}",
                    (sequence,),
                )

        source_counts = {
            table: source.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            for table in TABLES
        }
        target_counts = {
            table: target.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            for table in TABLES
        }
        source_inventory = inventory_digest(
            source.execute(
                "SELECT user_id,kind,id,updated_at,deleted_at,device_id,sync_version,server_updated_at FROM entities"
            )
        )
        target_inventory = inventory_digest(
            target.execute(
                "SELECT user_id,kind,id,updated_at,deleted_at,device_id,sync_version,server_updated_at FROM entities"
            )
        )
        if source_counts != target_counts or source_inventory != target_inventory:
            print(
                json.dumps(
                    {
                        "sourceCounts": source_counts,
                        "targetCounts": target_counts,
                        "sourceInventory": source_inventory,
                        "targetInventory": target_inventory,
                    },
                    separators=(",", ":"),
                    sort_keys=True,
                )
            )
            raise SystemExit("source/target verification failed")
        target.execute("ANALYZE")
        target.commit()
        print(
            json.dumps(
                {
                    "ok": True,
                    "tables": len(TABLES),
                    "rows": sum(source_counts.values()),
                    "entities": source_inventory[0],
                    "inventoryDigest": source_inventory[1],
                },
                separators=(",", ":"),
            )
        )
    finally:
        source.close()
        target.close()


if __name__ == "__main__":
    main()
