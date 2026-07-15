import sqlite3
import unittest

import app


class ReaderSyncApiTests(unittest.TestCase):
    def test_rate_limiter_refuses_excess_requests(self):
        limiter = app.RateLimiter()
        self.assertEqual(limiter.allow("login", "127.0.0.1", 2, 60), (True, 0))
        self.assertEqual(limiter.allow("login", "127.0.0.1", 2, 60), (True, 0))
        allowed, retry_after = limiter.allow("login", "127.0.0.1", 2, 60)
        self.assertFalse(allowed)
        self.assertGreaterEqual(retry_after, 1)

    def test_token_issue_is_capped_per_user(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        app.migrate(conn)
        with conn:
            conn.execute(
                "INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)",
                ("test-user", "test-user", "not-used", app.now_ms()),
            )
            for _ in range(app.MAX_TOKENS_PER_USER + 2):
                app.issue_token(conn, "test-user")
        count = conn.execute(
            "SELECT COUNT(*) FROM tokens WHERE user_id=?", ("test-user",)
        ).fetchone()[0]
        self.assertEqual(count, app.MAX_TOKENS_PER_USER)

    def test_migration_removes_nonportable_legacy_entities(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        app.migrate(conn)
        with conn:
            conn.execute(
                "INSERT INTO entities(user_id,kind,id,json,updated_at,deleted_at,device_id,"
                "sync_version,server_updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                ("default", "book", "1", "{}", 1, 0, "old", 1, 1),
            )
            conn.execute(
                "INSERT INTO entities(user_id,kind,id,json,updated_at,deleted_at,device_id,"
                "sync_version,server_updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                ("default", "vocab", "zh:词", "{}", 1, 0, "new", 1, 2),
            )
        app.migrate(conn)
        kinds = {row[0] for row in conn.execute("SELECT kind FROM entities")}
        self.assertEqual(kinds, {"vocab"})
        self.assertIn(6, {row[0] for row in conn.execute("SELECT version FROM schema_migrations")})

    def test_supported_entity_kinds_are_portable_v2_only(self):
        self.assertEqual(
            app.SUPPORTED_ENTITY_KINDS,
            {"book_state_v2", "vocab", "reading_bucket_v2"},
        )
        self.assertNotIn("book", app.SUPPORTED_ENTITY_KINDS)
        self.assertNotIn("reading_bucket", app.SUPPORTED_ENTITY_KINDS)

    def test_ignored_details_are_bounded(self):
        details = []
        for i in range(app.MAX_IGNORED_DETAILS + 10):
            app.record_ignored(details, {"id": i})
        self.assertEqual(len(details), app.MAX_IGNORED_DETAILS)



if __name__ == "__main__":
    unittest.main()
