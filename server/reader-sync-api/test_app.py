import json
import sqlite3
import tempfile
import threading
import unittest
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

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
        conn.close()

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
        conn.close()

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

    def test_exact_conflict_tie_converges_by_device_id(self):
        existing_a = {
            "updated_at": 100,
            "sync_version": 3,
            "device_id": "device-a",
        }
        existing_b = {
            "updated_at": 100,
            "sync_version": 3,
            "device_id": "device-b",
        }
        incoming_a = dict(existing_a)
        incoming_b = dict(existing_b)

        self.assertTrue(app.is_newer(incoming_b, existing_a))
        self.assertFalse(app.is_newer(incoming_a, existing_b))
        self.assertFalse(app.is_newer(incoming_a, existing_a))

    def test_timestamp_tie_still_prefers_higher_sync_version_first(self):
        existing = {
            "updated_at": 100,
            "sync_version": 3,
            "device_id": "device-z",
        }
        incoming = {
            "updated_at": 100,
            "sync_version": 4,
            "device_id": "device-a",
        }
        self.assertTrue(app.is_newer(incoming, existing))

    def test_duplicate_delivery_is_idempotently_ignored(self):
        entity = {
            "updated_at": 100,
            "sync_version": 4,
            "device_id": "device-a",
        }
        self.assertFalse(app.is_newer(dict(entity), entity))


class ReaderSyncHttpIntegrationTests(unittest.TestCase):
    USER_ID = "integration-user"
    TOKEN = "integration-test-token"

    @classmethod
    def setUpClass(cls):
        cls.original_db_path = app.DB_PATH
        cls.temp_dir = tempfile.TemporaryDirectory(prefix="reader-sync-http-")
        app.DB_PATH = f"{cls.temp_dir.name}/entities.db"
        app.RATE_LIMITER = app.RateLimiter()
        conn = app.connect()
        with conn:
            conn.execute(
                "INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)",
                (cls.USER_ID, cls.USER_ID, "not-used", app.now_ms()),
            )
            conn.execute(
                "INSERT INTO tokens(token,user_id,created_at,last_used_at) VALUES(?,?,?,?)",
                (cls.TOKEN, cls.USER_ID, app.now_ms(), app.now_ms()),
            )
        conn.close()

        class QuietHandler(app.Handler):
            push_transaction_barrier = None

            def log_message(self, _format, *_args):
                pass

            def begin_push_transaction(self, conn):
                barrier = type(self).push_transaction_barrier
                if barrier is not None:
                    barrier.wait(timeout=5)
                super().begin_push_transaction(conn)

        cls.handler_class = QuietHandler
        cls.server = app.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join(timeout=3)
        app.DB_PATH = cls.original_db_path
        cls.temp_dir.cleanup()

    def setUp(self):
        app.RATE_LIMITER = app.RateLimiter()
        conn = app.connect()
        with conn:
            conn.execute("DELETE FROM entities WHERE user_id=?", (self.USER_ID,))
            conn.execute("UPDATE sync_clock SET value=0 WHERE id=1")
        conn.close()

    def request_json(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.TOKEN}",
                "Content-Type": "application/json",
            },
        )
        with self.opener.open(request, timeout=3) as response:
            self.assertEqual(response.status, 200)
            return json.loads(response.read().decode("utf-8"))

    def push(self, entities, device_id="device-a"):
        return self.request_json(
            "POST",
            "/sync/push",
            {
                "schema_version": 2,
                "device_id": device_id,
                "capabilities": ["push_dispositions_v1"],
                "entities": entities,
            },
        )

    @staticmethod
    def entity(entity_id, device_id="device-a", value="value", updated_at=100, version=1):
        return {
            "kind": "vocab",
            "id": entity_id,
            "json": {"value": value},
            "updated_at": updated_at,
            "deleted_at": 0,
            "device_id": device_id,
            "sync_version": version,
        }

    def test_push_pull_and_duplicate_delivery_are_idempotent(self):
        entity = self.entity("zh:幂等")
        first = self.push([entity])
        duplicate = self.push([entity])
        pulled = self.request_json("GET", "/sync/pull?cursor=0&limit=100")

        self.assertEqual(first["accepted_count"], 1)
        self.assertEqual(duplicate["accepted_count"], 0)
        self.assertEqual(duplicate["ignored_count"], 1)
        self.assertEqual(first["dispositions"][0]["status"], "accepted")
        self.assertEqual(duplicate["dispositions"][0]["status"], "conflict")
        self.assertEqual(duplicate["entities"][0]["id"], "zh:幂等")
        self.assertEqual([item["id"] for item in pulled["entities"]], ["zh:幂等"])
        self.assertEqual(pulled["entities"][0]["json"], {"value": "value"})

    def test_health_exposes_deployable_api_version(self):
        health = self.request_json("GET", "/health")
        self.assertTrue(health["ok"])
        self.assertEqual(health["schema_version"], 2)
        self.assertEqual(health["api_version"], "0.5")

    def test_exact_conflict_tie_is_independent_of_arrival_order(self):
        lower = self.entity("zh:冲突", "device-a", "a", 100, 3)
        higher = self.entity("zh:冲突", "device-b", "b", 100, 3)

        self.push([lower], "device-a")
        self.push([higher], "device-b")
        forward = self.request_json("GET", "/sync/pull?cursor=0&limit=100")

        self.setUp()
        self.push([higher], "device-b")
        reverse_result = self.push([lower], "device-a")
        reverse = self.request_json("GET", "/sync/pull?cursor=0&limit=100")

        self.assertEqual(forward["entities"][0]["json"], {"value": "b"})
        self.assertEqual(reverse_result["accepted_count"], 0)
        self.assertEqual(reverse_result["dispositions"][0]["status"], "conflict")
        self.assertEqual(reverse_result["entities"][0]["json"], {"value": "b"})
        self.assertEqual(reverse["entities"][0]["json"], {"value": "b"})

    def test_concurrent_exact_ties_always_keep_larger_device_id(self):
        expected_ids = []
        try:
            for index in range(12):
                entity_id = f"zh:并发冲突-{index}"
                expected_ids.append(entity_id)
                lower = self.entity(entity_id, "device-a", "a", 100, 3)
                higher = self.entity(entity_id, "device-b", "b", 100, 3)
                self.handler_class.push_transaction_barrier = threading.Barrier(2)

                with ThreadPoolExecutor(max_workers=2) as executor:
                    lower_result = executor.submit(self.push, [lower], "device-a")
                    higher_result = executor.submit(self.push, [higher], "device-b")
                    lower_result.result(timeout=8)
                    higher_result.result(timeout=8)
        finally:
            self.handler_class.push_transaction_barrier = None

        pulled = self.request_json("GET", "/sync/pull?cursor=0&limit=100")
        by_id = {item["id"]: item for item in pulled["entities"]}
        for entity_id in expected_ids:
            self.assertEqual(by_id[entity_id]["device_id"], "device-b")
            self.assertEqual(by_id[entity_id]["json"], {"value": "b"})

    def test_rejected_entity_is_not_acknowledged_as_a_conflict(self):
        oversized = self.entity("zh:过大")
        oversized["json"] = {"value": "x" * (app.MAX_ENTITY_JSON_BYTES + 1)}

        response = self.push([oversized])

        self.assertEqual(response["accepted_count"], 0)
        self.assertEqual(response["ignored_count"], 1)
        self.assertEqual(response["entities"], [])
        self.assertEqual(response["dispositions"][0]["status"], "rejected")
        self.assertEqual(response["dispositions"][0]["error"], "PAYLOAD_TOO_LARGE")

    def test_legacy_client_gets_non_success_for_unidentifiable_reject(self):
        oversized = self.entity("zh:旧客户端过大")
        oversized["json"] = {"value": "x" * (app.MAX_ENTITY_JSON_BYTES + 1)}
        data = json.dumps(
            {"schema_version": 2, "device_id": "legacy", "entities": [oversized]}
        ).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + "/sync/push",
            data=data,
            method="POST",
            headers={
                "Authorization": f"Bearer {self.TOKEN}",
                "Content-Type": "application/json",
            },
        )

        with self.assertRaises(urllib.error.HTTPError) as raised:
            self.opener.open(request, timeout=3)
        self.assertEqual(raised.exception.code, 409)

    def test_pull_pagination_cursor_strictly_advances(self):
        self.push([self.entity(f"zh:{index}") for index in range(3)])
        cursor = "0"
        seen = []
        for _ in range(3):
            page = self.request_json(
                "GET",
                "/sync/pull?" + urllib.parse.urlencode({"cursor": cursor, "limit": 1}),
            )
            self.assertGreater(int(page["next_cursor"]), int(cursor))
            self.assertEqual(len(page["entities"]), 1)
            seen.append(page["entities"][0]["id"])
            cursor = page["next_cursor"]
        final_page = self.request_json(
            "GET", "/sync/pull?" + urllib.parse.urlencode({"cursor": cursor, "limit": 1})
        )
        self.assertEqual(final_page["entities"], [])
        self.assertEqual(final_page["next_cursor"], cursor)
        self.assertEqual(len(set(seen)), 3)



if __name__ == "__main__":
    unittest.main()
