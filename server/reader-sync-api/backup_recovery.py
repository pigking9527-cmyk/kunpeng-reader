"""Create a verified compressed reader-sync SQLite recovery snapshot.

The script writes only to an explicitly supplied destination. Uploading that
folder to OSS/COS is deployment configuration and intentionally stays outside
the public repository.
"""

import argparse
import datetime as dt
import gzip
import hashlib
import os
from pathlib import Path
import re
import sqlite3
import tempfile

SNAPSHOT_RE = re.compile(r"^reader-sync-(\d{8})-(\d{6})\.db\.gz$")


def _sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _fsync_file(path):
    with path.open("r+b") as stream:
        os.fsync(stream.fileno())


def _atomic_text(path, text):
    temporary = path.with_name(path.name + ".partial")
    temporary.write_text(text, encoding="ascii")
    _fsync_file(temporary)
    os.replace(temporary, path)


def _snapshot_time(path):
    match = SNAPSHOT_RE.match(path.name)
    if not match:
        return None
    try:
        return dt.datetime.strptime("".join(match.groups()), "%Y%m%d%H%M%S").replace(
            tzinfo=dt.timezone.utc
        )
    except ValueError:
        return None


def rotate(destination, keep_daily=7, keep_weekly=4, keep_monthly=12):
    snapshots = []
    for path in Path(destination).glob("reader-sync-*.db.gz"):
        timestamp = _snapshot_time(path)
        if timestamp is not None:
            snapshots.append((timestamp, path))
    snapshots.sort(reverse=True)
    keep = {path for _, path in snapshots[: max(0, keep_daily)]}

    weekly = {}
    monthly = {}
    for timestamp, path in snapshots:
        iso = timestamp.isocalendar()
        weekly.setdefault((iso.year, iso.week), path)
        monthly.setdefault((timestamp.year, timestamp.month), path)
    keep.update(list(weekly.values())[: max(0, keep_weekly)])
    keep.update(list(monthly.values())[: max(0, keep_monthly)])

    removed = 0
    root = Path(destination).resolve()
    for _, path in snapshots:
        if path in keep:
            continue
        resolved = path.resolve()
        if resolved.parent != root:
            raise RuntimeError("refusing to remove a snapshot outside the destination")
        resolved.unlink(missing_ok=True)
        resolved.with_name(resolved.name + ".sha256").unlink(missing_ok=True)
        removed += 1
    return removed


def create_snapshot(database, destination, now=None, keep_daily=7, keep_weekly=4, keep_monthly=12):
    database = Path(database).resolve()
    destination = Path(destination).resolve()
    if not database.is_file():
        raise FileNotFoundError(f"sync database not found: {database}")
    destination.mkdir(parents=True, exist_ok=True)
    now = now or dt.datetime.now(dt.timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=dt.timezone.utc)
    name = now.astimezone(dt.timezone.utc).strftime("reader-sync-%Y%m%d-%H%M%S.db.gz")
    final_path = destination / name
    partial_path = final_path.with_name(final_path.name + ".partial")

    handle, temporary_name = tempfile.mkstemp(prefix="reader-sync-snapshot-", suffix=".db", dir=destination)
    os.close(handle)
    temporary_db = Path(temporary_name)
    try:
        source = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True, timeout=30)
        target = sqlite3.connect(temporary_db, timeout=30)
        try:
            source.backup(target)
            check = target.execute("PRAGMA quick_check").fetchone()[0]
            if check != "ok":
                raise RuntimeError(f"snapshot quick_check failed: {check}")
            target.commit()
        finally:
            target.close()
            source.close()

        with temporary_db.open("rb") as source_stream, partial_path.open("wb") as raw_output:
            with gzip.GzipFile(fileobj=raw_output, mode="wb", compresslevel=6, mtime=0) as compressed:
                for block in iter(lambda: source_stream.read(1024 * 1024), b""):
                    compressed.write(block)
            raw_output.flush()
            os.fsync(raw_output.fileno())
        os.replace(partial_path, final_path)
        checksum = _sha256(final_path)
        _atomic_text(
            final_path.with_name(final_path.name + ".sha256"),
            f"{checksum}  {final_path.name}\n",
        )
        rotate(destination, keep_daily, keep_weekly, keep_monthly)
        return {
            "path": str(final_path),
            "sha256": checksum,
            "bytes": final_path.stat().st_size,
        }
    finally:
        temporary_db.unlink(missing_ok=True)
        partial_path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--keep-daily", type=int, default=7)
    parser.add_argument("--keep-weekly", type=int, default=4)
    parser.add_argument("--keep-monthly", type=int, default=12)
    args = parser.parse_args()
    result = create_snapshot(
        args.database,
        args.destination,
        keep_daily=args.keep_daily,
        keep_weekly=args.keep_weekly,
        keep_monthly=args.keep_monthly,
    )
    print(f"snapshot={result['path']}")
    print(f"sha256={result['sha256']}")
    print(f"bytes={result['bytes']}")


if __name__ == "__main__":
    main()