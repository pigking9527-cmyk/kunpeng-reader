import datetime as dt
import gzip
import hashlib
from pathlib import Path
import sqlite3
import tempfile
import unittest

import backup_recovery


class BackupRecoveryTests(unittest.TestCase):
    def test_snapshot_is_consistent_compressed_and_checksummed(self):
        with tempfile.TemporaryDirectory(prefix="reader-sync-backup-") as root:
            root = Path(root)
            database = root / "entities.db"
            destination = root / "backups"
            conn = sqlite3.connect(database)
            conn.execute("CREATE TABLE entities(id TEXT PRIMARY KEY,json TEXT NOT NULL)")
            conn.execute("INSERT INTO entities(id,json) VALUES(?,?)", ("one", "重复" * 4000))
            conn.commit()
            conn.close()

            result = backup_recovery.create_snapshot(
                database,
                destination,
                now=dt.datetime(2026, 8, 8, 3, 0, tzinfo=dt.timezone.utc),
            )
            snapshot = Path(result["path"])
            self.assertTrue(snapshot.is_file())
            self.assertEqual(hashlib.sha256(snapshot.read_bytes()).hexdigest(), result["sha256"])
            self.assertIn(result["sha256"], Path(str(snapshot) + ".sha256").read_text())
            restored = root / "restored.db"
            restored.write_bytes(gzip.decompress(snapshot.read_bytes()))
            restored_conn = sqlite3.connect(restored)
            self.assertEqual(restored_conn.execute("PRAGMA quick_check").fetchone()[0], "ok")
            self.assertEqual(
                restored_conn.execute("SELECT json FROM entities WHERE id='one'").fetchone()[0],
                "重复" * 4000,
            )
            restored_conn.close()
            self.assertLess(snapshot.stat().st_size, database.stat().st_size)

    def test_rotation_keeps_recent_weekly_and_monthly_recovery_points(self):
        with tempfile.TemporaryDirectory(prefix="reader-sync-rotation-") as root:
            root = Path(root)
            start = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
            paths = []
            for index in range(120):
                timestamp = start + dt.timedelta(days=index)
                path = root / timestamp.strftime("reader-sync-%Y%m%d-%H%M%S.db.gz")
                path.write_bytes(b"snapshot")
                Path(str(path) + ".sha256").write_text("hash\n", encoding="ascii")
                paths.append(path)
            removed = backup_recovery.rotate(root, keep_daily=7, keep_weekly=4, keep_monthly=4)
            remaining = sorted(root.glob("reader-sync-*.db.gz"))
            self.assertGreater(removed, 0)
            self.assertIn(paths[-1], remaining)
            self.assertLessEqual(len(remaining), 15)
            self.assertTrue(all(Path(str(path) + ".sha256").exists() for path in remaining))
            self.assertFalse(Path(str(paths[0]) + ".sha256").exists())


if __name__ == "__main__":
    unittest.main()