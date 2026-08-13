#!/usr/bin/env python3
"""Create verified logical and physical PostgreSQL recovery snapshots."""

import argparse
import datetime as dt
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
from urllib.parse import unquote, urlsplit


SNAPSHOT_RE = re.compile(
    r"^reader-sync-postgresql-(\d{8})-(\d{6})\.(?:dump|base\.tar\.gz)$"
)
POSTGRES_BIN = Path(os.environ.get("POSTGRES_BIN", "/usr/lib/postgresql/18/bin"))


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_checksum(path):
    checksum = sha256(path)
    partial = path.with_name(path.name + ".sha256.partial")
    partial.write_text(f"{checksum}  {path.name}\n", encoding="ascii")
    with partial.open("r+b") as stream:
        os.fsync(stream.fileno())
    os.replace(partial, path.with_name(path.name + ".sha256"))
    return checksum


def snapshot_time(path):
    match = SNAPSHOT_RE.match(path.name)
    if not match:
        return None
    return dt.datetime.strptime("".join(match.groups()), "%Y%m%d%H%M%S").replace(
        tzinfo=dt.timezone.utc
    )


def rotate(destination, keep_daily, keep_weekly, keep_monthly):
    root = Path(destination).resolve()
    snapshots = []
    for path in root.glob("reader-sync-postgresql-*"):
        timestamp = snapshot_time(path)
        if timestamp is not None:
            snapshots.append((timestamp, path))
    snapshots.sort(reverse=True)
    keep = {path for _, path in snapshots[: max(0, keep_daily) * 2]}
    for period, count in (("weekly", keep_weekly), ("monthly", keep_monthly)):
        selected = {}
        for timestamp, path in snapshots:
            if period == "weekly":
                iso = timestamp.isocalendar()
                key = (iso.year, iso.week, path.suffix)
            else:
                key = (timestamp.year, timestamp.month, path.suffix)
            selected.setdefault(key, path)
        keep.update(list(selected.values())[: max(0, count) * 2])
    for _, path in snapshots:
        if path in keep:
            continue
        resolved = path.resolve()
        if resolved.parent != root:
            raise RuntimeError("refusing to remove a snapshot outside the destination")
        resolved.unlink(missing_ok=True)
        resolved.with_name(resolved.name + ".sha256").unlink(missing_ok=True)


def run(command, env=None):
    subprocess.run(command, check=True, env=env)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--postgres-url", default=os.environ.get("SYNC_DATABASE_URL", ""))
    parser.add_argument("--keep-daily", type=int, default=7)
    parser.add_argument("--keep-weekly", type=int, default=4)
    parser.add_argument("--keep-monthly", type=int, default=12)
    args = parser.parse_args()
    if not args.postgres_url:
        raise SystemExit("SYNC_DATABASE_URL is required")

    parsed = urlsplit(args.postgres_url)
    if parsed.scheme not in ("postgresql", "postgres") or not parsed.hostname:
        raise SystemExit("invalid PostgreSQL URL")
    database = parsed.path.lstrip("/")
    if not database or not parsed.username:
        raise SystemExit("PostgreSQL URL must include database and username")

    destination = Path(args.destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
    prefix = f"reader-sync-postgresql-{timestamp}"
    logical = destination / f"{prefix}.dump"
    logical_partial = destination / f"{prefix}.dump.partial"
    physical = destination / f"{prefix}.base.tar.gz"
    physical_partial = destination / f"{prefix}.base.tar.gz.partial"
    base_partial = destination / f".{prefix}.base.partial"
    environment = os.environ.copy()
    environment["PGPASSWORD"] = unquote(parsed.password or "")
    port = str(parsed.port or 5432)

    try:
        run(
            [
                str(POSTGRES_BIN / "pg_dump"),
                "--host",
                parsed.hostname,
                "--port",
                port,
                "--username",
                unquote(parsed.username),
                "--dbname",
                unquote(database),
                "--format=custom",
                "--compress=6",
                "--no-password",
                "--file",
                str(logical_partial),
            ],
            environment,
        )
        run([str(POSTGRES_BIN / "pg_restore"), "--list", str(logical_partial)])
        os.replace(logical_partial, logical)
        logical_checksum = atomic_checksum(logical)

        run(
            [
                str(POSTGRES_BIN / "pg_basebackup"),
                "--host",
                "/var/run/postgresql",
                "--port",
                port,
                "--username",
                "postgres",
                "--pgdata",
                str(base_partial),
                "--format=plain",
                "--wal-method=stream",
                "--checkpoint=fast",
                "--no-password",
            ]
        )
        run([str(POSTGRES_BIN / "pg_verifybackup"), str(base_partial)])
        with physical_partial.open("wb") as raw:
            with tarfile.open(fileobj=raw, mode="w:gz", compresslevel=6) as archive:
                archive.add(base_partial, arcname="postgresql-base")
            raw.flush()
            os.fsync(raw.fileno())
        os.replace(physical_partial, physical)
        physical_checksum = atomic_checksum(physical)
        rotate(destination, args.keep_daily, args.keep_weekly, args.keep_monthly)
        print(f"logical={logical}")
        print(f"logical_sha256={logical_checksum}")
        print(f"physical={physical}")
        print(f"physical_sha256={physical_checksum}")
    finally:
        logical_partial.unlink(missing_ok=True)
        physical_partial.unlink(missing_ok=True)
        shutil.rmtree(base_partial, ignore_errors=True)


if __name__ == "__main__":
    main()
