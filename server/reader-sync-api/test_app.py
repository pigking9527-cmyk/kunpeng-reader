import base64
import json
import sqlite3
import tempfile
import threading
import unittest
import urllib.parse
import urllib.error
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

    def test_persistent_rate_limiter_is_shared_by_workers(self):
        old_db_path = app.DB_PATH
        with tempfile.TemporaryDirectory(prefix="reader-sync-rate-") as temp_dir:
            app.DB_PATH = f"{temp_dir}/entities.db"
            try:
                left = app.RateLimiter(persistent=True)
                right = app.RateLimiter(persistent=True)
                self.assertEqual(left.allow("shared", "same-ip", 1, 60), (True, 0))
                allowed, retry_after = right.allow("shared", "same-ip", 1, 60)
                self.assertFalse(allowed)
                self.assertGreaterEqual(retry_after, 1)
            finally:
                app.DB_PATH = old_db_path
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

    def test_legacy_seconds_are_normalized_on_read_without_storage_rewrite(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        app.migrate(conn)
        with conn:
            conn.execute(
                "INSERT INTO entities(user_id,kind,id,json,updated_at,deleted_at,device_id,"
                "sync_version,server_updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    "default", "vocab", "legacy-seconds", "{}", 1_785_673_800,
                    1_785_673_801, "legacy-android", 1, 77,
                ),
            )
        legacy = conn.execute(
            "SELECT kind,id,json,updated_at,deleted_at,device_id,sync_version,server_updated_at "
            "FROM entities WHERE id='legacy-seconds'"
        ).fetchone()
        response = app.row_to_entity(legacy)
        self.assertEqual(response["updated_at"], 1_785_673_800_000)
        self.assertEqual(response["deleted_at"], 1_785_673_801_000)
        self.assertEqual(response["server_updated_at"], 77)
        self.assertEqual(legacy["updated_at"], 1_785_673_800)
        self.assertEqual(legacy["deleted_at"], 1_785_673_801)
        conn.close()

    def test_supported_entity_kinds_are_portable_v2_only(self):
        self.assertEqual(
            app.SUPPORTED_ENTITY_KINDS,
            {"book_state_v2", "model_book_tags_v1", "user_book_tags_v1", "book_collections_v1", "vocab", "reading_bucket_v2", "ai_reader_config_v1", "translation_config_v1", "ai_reader_history_v1", "secret_bundle_v1", "reader_palette_v1", "reader_palette_order_v1", "app_settings_v1"},
        )
        self.assertNotIn("book", app.SUPPORTED_ENTITY_KINDS)
        self.assertNotIn("reading_bucket", app.SUPPORTED_ENTITY_KINDS)
        self.assertEqual(
            app.INVENTORY_ENTITY_KINDS,
            {"book_state_v2", "model_book_tags_v1", "user_book_tags_v1", "book_collections_v1", "vocab", "reading_bucket_v2", "reader_palette_v1", "reader_palette_order_v1", "app_settings_v1"},
        )

    def test_reader_palette_validation_limits_images_and_order(self):
        palette = {
            "version": 1, "id": "custom-one", "name": "同步主题",
            "background": "#ffffff", "text": "#111111", "link": "#246ed4",
            "selection": "#f7dc82", "footnote": "#eef7ef", "border": "#6f8f7d",
            "theme": "light", "backgroundImage": "data:image/png;base64,aGVsbG8=",
        }
        self.assertTrue(app.reader_palette_payload_is_valid("reader_palette_v1", palette))
        palette["backgroundImage"] = "data:text/plain;base64,aGVsbG8="
        self.assertFalse(app.reader_palette_payload_is_valid("reader_palette_v1", palette))
        self.assertTrue(app.reader_palette_payload_is_valid("reader_palette_order_v1", {"version": 1, "order": ["light", "custom-one"]}))
        self.assertFalse(app.reader_palette_payload_is_valid("reader_palette_order_v1", {"version": 1, "order": ["custom-one", "custom-one"]}))
    def test_app_settings_validation_accepts_known_bounds_and_unknown_fields(self):
        settings = {
            "version": 1,
            "showReaderJumpBack": True,
            "readerJumpBackDismissMode": "pages",
            "readerJumpBackDismissSeconds": 30,
            "readerJumpBackDismissPages": 3,
            "readerJumpBackSizeLevel": 10,
            "readerJumpBackIconSizePx": 160,
            "newsSourceIds": ["weibo", "tieba"],
            "newsTiebaBars": ["阅读"],
            "newsEnabledTiebaBars": ["阅读"],
            "libraryAnswerLength": "medium",
            "libraryHistorySyncMode": "manual",
            "libraryAnswerFontSize": 18,
            "libraryLongContextEnabled": True,
            "futureDesktopSetting": "preserve-me",
        }
        self.assertTrue(app.app_settings_payload_is_valid(settings))
        legacy = dict(settings)
        legacy.pop("readerJumpBackIconSizePx")
        self.assertTrue(app.app_settings_payload_is_valid(legacy))
        for key, bad_value in (
            ("readerJumpBackDismissMode", "never"),
            ("readerJumpBackDismissSeconds", 0),
            ("readerJumpBackDismissPages", 101),
            ("readerJumpBackSizeLevel", 11),
            ("readerJumpBackIconSizePx", 161),
            ("showReaderJumpBack", 1),
            ("newsSourceIds", []),
            ("libraryAnswerLength", "unbounded"),
            ("libraryHistorySyncMode", "always"),
            ("libraryAnswerFontSize", 23),
            ("libraryLongContextEnabled", 1),
        ):
            invalid = dict(settings)
            invalid[key] = bad_value
            self.assertFalse(app.app_settings_payload_is_valid(invalid), key)


    def test_secret_epoch_reset_invalidates_old_bundle_generation(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        app.migrate(conn)
        with conn:
            conn.execute(
                "INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)",
                ("epoch-user", "epoch-user", "not-used", app.now_ms()),
            )
        self.assertEqual(app.secret_bundle_epoch(conn, "epoch-user"), 1)
        self.assertEqual(app.reset_secret_bundle_epoch(conn, "epoch-user"), 2)
        tombstone = conn.execute(
            "SELECT deleted_at FROM entities WHERE user_id=? AND kind=? AND id=?",
            ("epoch-user", "secret_bundle_v1", "default"),
        ).fetchone()
        self.assertGreater(tombstone["deleted_at"], 0)
        conn.close()

    def test_recovery_history_is_compressed_complete_json_and_keeps_one_anchor(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        app.migrate(conn)
        with conn:
            conn.execute(
                "INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)",
                ("history-user", "history-user", "not-used", app.now_ms()),
            )
            payload = json.dumps(
                {"notes": "重复内容" * 2000}, ensure_ascii=False, separators=(",", ":")
            )
            base = app.now_ms() - app.recovery.HISTORY_RETENTION_MS - 10_000
            for offset in (0, 1_000):
                app.recovery.record_entity(
                    conn,
                    "history-user",
                    "vocab",
                    "zh:历史",
                    payload,
                    base + offset,
                    0,
                    "device-a",
                    offset + 1,
                    base + offset,
                )
            recent = app.now_ms()
            app.recovery.record_entity(
                conn,
                "history-user",
                "vocab",
                "zh:历史",
                payload,
                recent,
                0,
                "device-a",
                3,
                recent,
            )
            app.recovery.prune_history(conn, "history-user", recent)
        rows = conn.execute(
            "SELECT * FROM entity_history WHERE user_id=? ORDER BY recorded_at",
            ("history-user",),
        ).fetchall()
        self.assertEqual(len(rows), 2)
        self.assertLess(rows[0]["payload_zlib"].__len__(), rows[0]["payload_bytes"])
        self.assertEqual(app.recovery.decode_payload(rows[0]), payload)
        self.assertEqual(
            app.recovery.record_entity(
                conn,
                "history-user",
                "secret_bundle_v1",
                "default",
                "{}",
                recent,
                0,
                "device-a",
                1,
                recent,
            ),
            0,
        )
        conn.close()

    def test_recovery_migration_seeds_existing_entities_once(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        app.migrate(conn)
        with conn:
            conn.execute(
                "INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)",
                ("seed-user", "seed-user", "not-used", app.now_ms()),
            )
            conn.execute(
                "INSERT INTO entities(user_id,kind,id,json,updated_at,deleted_at,device_id,"
                "sync_version,server_updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                ("seed-user", "vocab", "zh:种子", '{"value":"种子"}', 10, 0, "old", 1, 10),
            )
            conn.execute("DELETE FROM schema_migrations WHERE version=11")
            conn.execute("DROP TABLE entity_history")
            conn.execute("DROP TABLE recovery_accounts")
        app.migrate(conn)
        self.assertEqual(
            conn.execute(
                "SELECT COUNT(*) FROM entity_history WHERE user_id=?",
                ("seed-user",),
            ).fetchone()[0],
            1,
        )
        app.migrate(conn)
        self.assertEqual(
            conn.execute(
                "SELECT COUNT(*) FROM entity_history WHERE user_id=?",
                ("seed-user",),
            ).fetchone()[0],
            1,
        )
        conn.close()

    def test_feedback_migration_and_text_payload(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        app.migrate(conn)
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        versions = {
            row[0] for row in conn.execute("SELECT version FROM schema_migrations")
        }
        self.assertIn("feedback", tables)
        self.assertIn(7, versions)
        self.assertIn(10, versions)
        feedback_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(feedback)")
        }
        self.assertIn("attachments_json", feedback_columns)
        normalized = app.normalize_feedback(
            {
                "kind": "feature",
                "text": "希望增加阅读计划",
                "images": [],
                "appVersion": "1.9.5",
                "platform": "test",
            }
        )
        self.assertEqual(normalized["kind"], "feature")
        self.assertEqual(normalized["text"], "希望增加阅读计划")
        self.assertEqual(normalized["attachments"], [])
        conn.close()

    def test_feedback_rejects_oversized_or_fake_images(self):
        fake = base64.b64encode(b"not-a-jpeg").decode("ascii")
        with self.assertRaisesRegex(ValueError, "INVALID_FEEDBACK_IMAGE_DATA"):
            app.normalize_feedback(
                {
                    "kind": "bug",
                    "text": "图片异常",
                    "images": [{"name": "x.jpg", "mime": "image/jpeg", "data": fake}],
                }
            )
        oversized = base64.b64encode(
            b"\xff\xd8\xff" + b"x" * app.MAX_FEEDBACK_IMAGE_BYTES
        ).decode("ascii")
        with self.assertRaisesRegex(ValueError, "FEEDBACK_IMAGE_TOO_LARGE"):
            app.normalize_feedback(
                {
                    "kind": "bug",
                    "text": "图片异常",
                    "images": [{"name": "x.jpg", "mime": "image/jpeg", "data": oversized}],
                }
            )

    def test_feedback_accepts_one_bounded_json_attachment(self):
        attachment = base64.b64encode(b'{"events":[]}').decode("ascii")
        normalized = app.normalize_feedback(
            {
                "kind": "bug",
                "text": "翻页异常",
                "images": [],
                "attachments": [
                    {"name": "bug-state.json", "mime": "application/json", "data": attachment}
                ],
            }
        )
        self.assertEqual(normalized["attachments"][0]["name"], "bug-state.json")
        with self.assertRaisesRegex(ValueError, "FEEDBACK_ATTACHMENTS_REQUIRE_BUG"):
            app.normalize_feedback(
                {
                    "kind": "feature",
                    "text": "功能建议",
                    "attachments": [
                        {"name": "bug-state.json", "mime": "application/json", "data": attachment}
                    ],
                }
            )
        oversized = base64.b64encode(b"{" + b" " * app.MAX_FEEDBACK_JSON_BYTES).decode("ascii")
        with self.assertRaisesRegex(ValueError, "FEEDBACK_ATTACHMENT_TOO_LARGE"):
            app.normalize_feedback(
                {
                    "kind": "bug",
                    "text": "翻页异常",
                    "attachments": [
                        {"name": "large.json", "mime": "application/json", "data": oversized}
                    ],
                }
            )

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

    def test_entity_clock_normalizer_preserves_synthetic_timestamps(self):
        self.assertEqual(app.normalize_entity_epoch_ms(100), 100)
        self.assertEqual(app.normalize_entity_epoch_ms(1_785_673_800), 1_785_673_800_000)
        self.assertEqual(app.normalize_entity_epoch_ms(1_785_673_800_000), 1_785_673_800_000)
        legacy_existing = {
            "updated_at": 1_785_673_800,
            "sync_version": 2,
            "device_id": "legacy-android",
        }
        same_canonical = {
            "updated_at": 1_785_673_800_000,
            "sync_version": 2,
            "device_id": "legacy-android",
        }
        newer_canonical = {**same_canonical, "updated_at": 1_785_673_801_000}
        self.assertFalse(app.is_newer(same_canonical, legacy_existing))
        self.assertTrue(app.is_newer(newer_canonical, legacy_existing))


class ReaderSyncHttpIntegrationTests(unittest.TestCase):
    USER_ID = "integration-user"
    TOKEN = "integration-test-token"
    PASSWORD = "integration-password"

    @classmethod
    def setUpClass(cls):
        cls.original_db_path = app.DB_PATH
        cls.original_update_manifest_path = app.UPDATE_MANIFEST_PATH
        cls.original_asset_dir = app.ASSET_DIR
        cls.temp_dir = tempfile.TemporaryDirectory(prefix="reader-sync-http-")
        app.DB_PATH = f"{cls.temp_dir.name}/entities.db"
        app.UPDATE_MANIFEST_PATH = app.Path(cls.temp_dir.name) / "updates.json"
        app.ASSET_DIR = app.Path(cls.temp_dir.name) / "assets"
        app.UPDATE_MANIFEST_PATH.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "latest": "1.9.5",
                    "releases": {
                        "1.9.5": {
                            "android_version": "0.1.0",
                            "release_notes": "服务器更新说明",
                            "url": "https://example.com/v1.9.5",
                            "published_at": "2026-07-27",
                        }
                    },
                }
            ),
            encoding="utf-8",
        )
        app.RATE_LIMITER = app.RateLimiter()
        cls.PASSWORD_HASH = app.hash_password(cls.PASSWORD)
        conn = app.connect()
        with conn:
            conn.execute(
                "INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)",
                (cls.USER_ID, cls.USER_ID, cls.PASSWORD_HASH, app.now_ms()),
            )
            conn.execute(
                "INSERT INTO tokens(token,user_id,created_at,last_used_at) VALUES(?,?,?,?)",
                (cls.TOKEN, cls.USER_ID, app.now_ms(), app.now_ms()),
            )
        conn.execute("UPDATE users SET sync_verified_at=created_at WHERE id=?", (cls.USER_ID,))
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
        app.UPDATE_MANIFEST_PATH = cls.original_update_manifest_path
        app.ASSET_DIR = cls.original_asset_dir
        cls.temp_dir.cleanup()

    def setUp(self):
        app.RATE_LIMITER = app.RateLimiter()
        conn = app.connect()
        with conn:
            conn.execute(
                "INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash",
                (self.USER_ID, self.USER_ID, self.PASSWORD_HASH, app.now_ms()),
            )
            conn.execute("DELETE FROM tokens WHERE user_id=?", (self.USER_ID,))
            conn.execute(
                "INSERT INTO tokens(token,user_id,created_at,last_used_at) VALUES(?,?,?,?)",
                (self.TOKEN, self.USER_ID, app.now_ms(), app.now_ms()),
            )
            conn.execute("DELETE FROM entity_history WHERE user_id=?", (self.USER_ID,))
            conn.execute("DELETE FROM recovery_accounts WHERE user_id=?", (self.USER_ID,))
            conn.execute("DELETE FROM entities WHERE user_id=?", (self.USER_ID,))
            app.remove_user_assets(conn, self.USER_ID)
            conn.execute("DELETE FROM secret_bundle_epochs WHERE user_id=?", (self.USER_ID,))
            conn.execute("DELETE FROM account_data_generations WHERE user_id=?", (self.USER_ID,))
            conn.execute("DELETE FROM account_codes WHERE user_id=?", (self.USER_ID,))
            conn.execute("DELETE FROM account_emails WHERE user_id=?", (self.USER_ID,))
            conn.execute("UPDATE users SET sync_verified_at=created_at,disabled_at=0,disabled_reason='' WHERE id=?", (self.USER_ID,))
            conn.execute("DELETE FROM account_usage WHERE user_id=?", (self.USER_ID,))
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

    def request_error_json(self, method, path, body=None):
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
        with self.assertRaises(urllib.error.HTTPError) as raised:
            self.opener.open(request, timeout=3)
        return raised.exception.code, json.loads(raised.exception.read().decode("utf-8"))

    def request_bytes(self, method, path, data=None, headers=None):
        request = urllib.request.Request(
            self.base_url + path, data=data, method=method,
            headers={"Authorization": f"Bearer {self.TOKEN}"},
        )
        for name, value in (headers or {}).items():
            request.add_header(name, value)
        with self.opener.open(request, timeout=3) as response:
            return response.status, dict(response.headers), response.read()

    def request_public_json(self, path):
        request = urllib.request.Request(self.base_url + path, method="GET")
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

    def test_sync_requires_verified_email_for_new_account(self):
        conn = app.connect()
        with conn:
            conn.execute("UPDATE users SET sync_verified_at=0 WHERE id=?", (self.USER_ID,))
        conn.close()
        status, payload = self.request_error_json("POST", "/sync/push", {
            "schema_version": 2, "device_id": "test", "entities": []
        })
        self.assertEqual(status, 403)
        self.assertEqual(payload["error"], "EMAIL_VERIFICATION_REQUIRED")

    def test_reader_background_asset_is_resumable_hash_checked_and_range_downloadable(self):
        raw = b"reader-background-asset" * 70000
        digest = app.hashlib.sha256(raw).hexdigest()
        init = self.request_json("POST", "/sync/assets/init", {
            "assetId": digest, "sha256": digest, "mime": "image/png", "byteSize": len(raw), "data_generation": 1,
        })
        self.assertFalse(init["complete"])
        midpoint = 1024 * 1024
        first = raw[:midpoint]
        status, _, body = self.request_bytes("PUT", f"/sync/assets/{digest}", first, {
            "Content-Type": "image/png", "X-Data-Generation": "1", "Content-Range": f"bytes 0-{len(first)-1}/{len(raw)}",
        })
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["receivedBytes"], len(first))
        rest = raw[midpoint:]
        status, _, body = self.request_bytes("PUT", f"/sync/assets/{digest}", rest, {
            "Content-Type": "image/png", "X-Data-Generation": "1", "Content-Range": f"bytes {midpoint}-{len(raw)-1}/{len(raw)}",
        })
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["complete"])
        status, headers, downloaded = self.request_bytes("GET", f"/sync/assets/{digest}", headers={"Range": "bytes=7-23"})
        self.assertEqual(status, 206)
        self.assertEqual(headers["Content-Range"], f"bytes 7-23/{len(raw)}")
        self.assertEqual(downloaded, raw[7:24])

    def test_storage_and_daily_write_quota_include_recovery_history(self):
        conn = app.connect()
        with conn:
            app.ensure_account_usage(conn, self.USER_ID)
            conn.execute("UPDATE account_usage SET storage_limit_bytes=1,daily_written_bytes=0,daily_entity_writes=0 WHERE user_id=?", (self.USER_ID,))
        conn.close()
        response = self.push([self.entity("quota", value="payload" * 100)])
        self.assertEqual(response["accepted_count"], 0)
        self.assertEqual(response["dispositions"][0]["error"], "QUOTA_EXCEEDED")
        conn = app.connect()
        alert = conn.execute("SELECT event FROM security_audit WHERE user_id=? ORDER BY id DESC LIMIT 1", (self.USER_ID,)).fetchone()
        conn.close()
        self.assertEqual(alert["event"], "account_quota_exceeded")
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

    def test_push_normalizes_legacy_epoch_seconds_and_preserves_milliseconds(self):
        legacy = self.entity(
            "clock-legacy-seconds", value="legacy", updated_at=1_785_673_800, version=2
        )
        legacy["deleted_at"] = 1_785_673_801
        canonical = self.entity(
            "clock-canonical-milliseconds", value="canonical", updated_at=1_785_673_802_345, version=3
        )

        response = self.push([legacy, canonical])
        self.assertEqual(response["accepted_count"], 2)
        self.assertEqual(response["entities"], [])

        pulled = self.request_json("GET", "/sync/pull?cursor=0&limit=100")
        entities = {item["id"]: item for item in pulled["entities"]}
        self.assertEqual(entities["clock-legacy-seconds"]["updated_at"], 1_785_673_800_000)
        self.assertEqual(entities["clock-legacy-seconds"]["deleted_at"], 1_785_673_801_000)
        self.assertEqual(entities["clock-canonical-milliseconds"]["updated_at"], 1_785_673_802_345)

    def test_reconcile_normalizes_legacy_epoch_seconds_manifest(self):
        canonical = self.entity(
            "clock-manifest-seconds", value="server", updated_at=1_785_673_800_000, version=2
        )
        self.push([canonical])
        legacy_manifest = [{
            "kind": canonical["kind"],
            "id": canonical["id"],
            "updated_at": 1_785_673_800,
            "deleted_at": 0,
            "device_id": canonical["device_id"],
            "sync_version": canonical["sync_version"],
        }]

        response = self.request_json(
            "POST", "/sync/reconcile", {"schema_version": 2, "manifest": legacy_manifest}
        )
        self.assertEqual(response["upload"], [])
        self.assertEqual(response["entities"], [])

    def test_recovery_records_only_accepted_changes_and_restores_a_timepoint(self):
        first = self.entity("zh:可恢复", value="第一版", updated_at=100, version=1)
        second = self.entity("zh:可恢复", value="错误覆盖", updated_at=200, version=2)
        later = self.entity("zh:稍后创建", value="稍后", updated_at=300, version=1)
        self.push([first])
        conn = app.connect()
        target_at = conn.execute(
            "SELECT recorded_at FROM entity_history WHERE user_id=? AND entity_id=?",
            (self.USER_ID, first["id"]),
        ).fetchone()[0]
        conn.close()
        self.push([second])
        self.push([second])
        self.push([later])

        recovery_status = self.request_json("GET", "/sync/recovery/status")
        self.assertTrue(recovery_status["available"])
        self.assertEqual(recovery_status["retention_days"], 90)
        self.assertEqual(recovery_status["version_count"], 3)
        self.assertLess(
            recovery_status["compressed_bytes"], recovery_status["uncompressed_bytes"] + 256
        )

        restored = self.request_json(
            "POST",
            "/sync/recovery/restore",
            {
                "password": self.PASSWORD,
                "confirm": True,
                "target_at": target_at,
                "data_generation": 1,
            },
        )
        self.assertTrue(restored["tokens_revoked"])
        self.assertEqual(restored["data_generation"], 2)
        self.assertEqual(restored["restored_entities"], 1)
        self.assertEqual(restored["tombstoned_entities"], 1)

        conn = app.connect()
        recovered = conn.execute(
            "SELECT json,deleted_at,device_id FROM entities WHERE user_id=? AND kind=? AND id=?",
            (self.USER_ID, first["kind"], first["id"]),
        ).fetchone()
        created_later = conn.execute(
            "SELECT deleted_at FROM entities WHERE user_id=? AND kind=? AND id=?",
            (self.USER_ID, later["kind"], later["id"]),
        ).fetchone()
        self.assertEqual(json.loads(recovered["json"])["value"], "第一版")
        self.assertEqual(recovered["deleted_at"], 0)
        self.assertEqual(recovered["device_id"], "server-recovery")
        self.assertGreater(created_later["deleted_at"], 0)
        self.assertEqual(
            conn.execute(
                "SELECT COUNT(*) FROM tokens WHERE user_id=?", (self.USER_ID,)
            ).fetchone()[0],
            0,
        )
        self.assertEqual(
            conn.execute(
                "SELECT COUNT(*) FROM entity_history WHERE user_id=? AND source='restore'",
                (self.USER_ID,),
            ).fetchone()[0],
            2,
        )
        conn.close()

    def test_health_exposes_deployable_api_version(self):
        health = self.request_json("GET", "/health")
        self.assertTrue(health["ok"])
        self.assertEqual(health["schema_version"], 2)
        self.assertEqual(health["api_version"], "0.9")

    def test_sync_data_reset_revokes_tokens_and_rejects_stale_generation(self):
        self.push([self.entity("zh:将被清除")])
        conn = app.connect()
        with conn:
            app.secret_bundle_epoch(conn, self.USER_ID)
        conn.close()
        reset = self.request_json(
            "POST", "/sync/data/reset", {"password": self.PASSWORD}
        )
        self.assertEqual(reset["data_generation"], 2)
        self.assertTrue(reset["tokens_revoked"])

        conn = app.connect()
        self.assertEqual(
            conn.execute(
                "SELECT COUNT(*) FROM entities WHERE user_id=?", (self.USER_ID,)
            ).fetchone()[0],
            0,
        )
        self.assertEqual(
            conn.execute(
                "SELECT COUNT(*) FROM tokens WHERE user_id=?", (self.USER_ID,)
            ).fetchone()[0],
            0,
        )
        self.assertEqual(
            conn.execute(
                "SELECT COUNT(*) FROM secret_bundle_epochs WHERE user_id=?",
                (self.USER_ID,),
            ).fetchone()[0],
            0,
        )
        self.assertEqual(
            conn.execute(
                "SELECT COUNT(*) FROM entity_history WHERE user_id=?", (self.USER_ID,)
            ).fetchone()[0],
            0,
        )
        with conn:
            conn.execute(
                "INSERT INTO tokens(token,user_id,created_at,last_used_at) VALUES(?,?,?,?)",
                (self.TOKEN, self.USER_ID, app.now_ms(), app.now_ms()),
            )
        conn.close()

        stale_body = {
            "schema_version": 2,
            "device_id": "old-device",
            "data_generation": 1,
            "entities": [self.entity("zh:不应复活", "old-device")],
        }
        code, payload = self.request_error_json("POST", "/sync/push", stale_body)
        self.assertEqual(code, 409)
        self.assertEqual(payload["error"], "DATA_GENERATION_MISMATCH")

        stale_body["data_generation"] = 2
        current = self.request_json("POST", "/sync/push", stale_body)
        self.assertEqual(current["accepted_count"], 1)
        self.assertEqual(current["data_generation"], 2)

    def test_account_delete_removes_account_and_all_dependents(self):
        self.push([self.entity("zh:删除账号")])
        conn = app.connect()
        with conn:
            conn.execute(
                "INSERT INTO account_emails(user_id,email,verified_at) VALUES(?,?,?)",
                (self.USER_ID, "delete-fixture@example.com", app.now_ms()),
            )
            app.secret_bundle_epoch(conn, self.USER_ID)
            conn.execute(
                "INSERT INTO account_data_generations(user_id,generation,updated_at) VALUES(?,?,?)",
                (self.USER_ID, 3, app.now_ms()),
            )
        conn.close()
        result = self.request_json(
            "POST",
            "/auth/account/delete",
            {"password": self.PASSWORD, "username": self.USER_ID},
        )
        self.assertTrue(result["account_deleted"])

        conn = app.connect()
        for table in (
            "users",
            "tokens",
            "entities",
            "entity_history",
            "recovery_accounts",
            "account_emails",
            "account_codes",
            "secret_bundle_epochs",
            "account_data_generations",
        ):
            self.assertEqual(
                conn.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE "
                    + ("id=?" if table == "users" else "user_id=?"),
                    (self.USER_ID,),
                ).fetchone()[0],
                0,
            )
        conn.close()

    def test_public_update_manifest_exposes_latest_and_versioned_notes(self):
        latest = self.request_public_json("/updates/latest")
        notes = self.request_public_json("/updates/notes?tag=v1.9.5")
        self.assertEqual(latest["version"], "1.9.5")
        self.assertEqual(latest["android_version"], "0.1.0")
        self.assertEqual(latest["release_notes"], "服务器更新说明")
        self.assertEqual(notes["version"], "1.9.5")
        self.assertEqual(notes["android_version"], "0.1.0")
        self.assertEqual(notes["url"], "https://example.com/v1.9.5")

    def test_rebinding_email_requires_old_then_new_mailbox_proof(self):
        conn = app.connect()
        with conn:
            conn.execute(
                "INSERT INTO account_emails(user_id,email,verified_at) VALUES(?,?,?)",
                (self.USER_ID, "old@example.com", app.now_ms()),
            )
            old_legacy_code = app.issue_account_code(
                conn, self.USER_ID, "bind_email", "new@example.com"
            )
        conn.close()

        sent = []
        old_mail_configured = app.account_mail_configured
        old_send_mail = app.send_account_email
        app.account_mail_configured = lambda: True
        app.send_account_email = lambda recipient, _subject, text: sent.append((recipient, text))
        try:
            code, payload = self.request_error_json(
                "POST", "/auth/email/confirm", {"email": "new@example.com", "code": old_legacy_code}
            )
            self.assertEqual(code, 409)
            self.assertEqual(payload["error"], "EMAIL_ALREADY_BOUND")

            self.request_json("POST", "/auth/email/rebind/old/start", {})
            self.assertEqual(sent[-1][0], "old@example.com")
            old_code = sent[-1][1].split("：", 1)[1].split("\n", 1)[0]
            grant = self.request_json(
                "POST", "/auth/email/rebind/old/confirm", {"code": old_code}
            )["rebindGrant"]
            self.request_json(
                "POST", "/auth/email/rebind/new/start",
                {"email": "new@example.com", "rebindGrant": grant},
            )
            self.assertEqual(sent[-1][0], "new@example.com")
            new_code = sent[-1][1].split("：", 1)[1].split("\n", 1)[0]
            self.request_json(
                "POST", "/auth/email/rebind/new/confirm",
                {"email": "new@example.com", "code": new_code},
            )
        finally:
            app.account_mail_configured = old_mail_configured
            app.send_account_email = old_send_mail

        conn = app.connect()
        row = conn.execute(
            "SELECT email FROM account_emails WHERE user_id=?", (self.USER_ID,)
        ).fetchone()
        conn.close()
        self.assertEqual(row["email"], "new@example.com")

    def test_inventory_digest_changes_when_server_loses_an_acknowledged_entity(self):
        first = self.entity("zh:仍在")
        missing = self.entity("zh:被回退")
        self.push([first, missing])
        before = self.request_json("GET", "/sync/inventory")

        conn = app.connect()
        with conn:
            conn.execute(
                "DELETE FROM entities WHERE user_id=? AND kind=? AND id=?",
                (self.USER_ID, missing["kind"], missing["id"]),
            )
        conn.close()
        after = self.request_json("GET", "/sync/inventory")

        self.assertEqual(before["entity_count"], 2)
        self.assertEqual(after["entity_count"], 1)
        self.assertNotEqual(before["inventory_digest"], after["inventory_digest"])

    def test_inventory_and_reconcile_include_palette_and_app_settings(self):
        entities = [
            ("reader_palette_v1", "custom-one"),
            ("reader_palette_order_v1", "default"),
            ("app_settings_v1", "default"),
        ]
        conn = app.connect()
        with conn:
            for version, (kind, entity_id) in enumerate(entities, start=1):
                conn.execute(
                    "INSERT INTO entities(user_id,kind,id,json,updated_at,deleted_at,device_id,sync_version,server_updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                    (self.USER_ID, kind, entity_id, "{}", 100 + version, 0, "device-a", version, 100 + version),
                )
        conn.close()

        inventory = self.request_json("GET", "/sync/inventory")
        self.assertEqual(inventory["entity_count"], len(entities))
        manifest = [
            {"kind": kind, "id": entity_id, "updated_at": 100 + version, "deleted_at": 0, "device_id": "device-a", "sync_version": version}
            for version, (kind, entity_id) in enumerate(entities, start=1)
        ]
        reconcile = self.request_json(
            "POST", "/sync/reconcile", {"schema_version": 2, "manifest": manifest}
        )
        self.assertEqual(reconcile["entity_count"], len(entities))
        self.assertEqual(reconcile["upload"], [])
        self.assertEqual(reconcile["entities"], [])

    def test_reset_secret_state_returns_tombstone_for_stale_bundle(self):
        before = self.request_json("GET", "/sync/secret-state")
        self.assertEqual(before["secretBundleEpoch"], 1)
        reset = self.request_json("POST", "/sync/secret-state/reset", {})
        self.assertEqual(reset["secretBundleEpoch"], 2)
        stale = self.entity("default")
        stale["kind"] = "secret_bundle_v1"
        stale["json"] = {"version": 2, "epoch": 1, "ciphertext": "old"}
        response = self.push([stale])
        self.assertEqual(response["accepted_count"], 0)
        self.assertEqual(response["dispositions"][0]["status"], "conflict")
        self.assertEqual(response["dispositions"][0]["error"], "SECRET_EPOCH_MISMATCH")
        self.assertTrue(response["entities"][0]["deleted_at"])

    def test_reconcile_requests_only_missing_or_newer_local_entities(self):
        unchanged = self.entity("zh:相同", value="same", updated_at=100, version=1)
        server_newer = self.entity("zh:服务器新", value="server", updated_at=200, version=2)
        local_newer_server_copy = self.entity(
            "zh:本地新", value="old-server", updated_at=100, version=1
        )
        self.push([unchanged, server_newer, local_newer_server_copy])

        local_newer = self.entity("zh:本地新", value="new-local", updated_at=300, version=3)
        local_only = self.entity("zh:服务器缺失", value="local-only", updated_at=150, version=1)
        manifest = []
        for item in (unchanged, local_newer, local_only):
            manifest.append(
                {
                    key: item[key]
                    for key in (
                        "kind",
                        "id",
                        "updated_at",
                        "deleted_at",
                        "device_id",
                        "sync_version",
                    )
                }
            )

        response = self.request_json(
            "POST",
            "/sync/reconcile",
            {"schema_version": 2, "manifest": manifest},
        )

        self.assertEqual(
            {(item["kind"], item["id"]) for item in response["upload"]},
            {("vocab", "zh:本地新"), ("vocab", "zh:服务器缺失")},
        )
        self.assertEqual(
            {(item["kind"], item["id"]) for item in response["entities"]},
            {("vocab", "zh:服务器新")},
        )

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

    def test_ai_history_has_a_larger_but_still_bounded_payload_limit(self):
        history = self.entity("a" * 64)
        history["kind"] = "ai_reader_history_v1"
        history["json"] = {"value": "x" * (app.MAX_ENTITY_JSON_BYTES + 1)}

        accepted = self.push([history])

        self.assertEqual(accepted["accepted_count"], 1)
        oversized = self.entity("b" * 64)
        oversized["kind"] = "ai_reader_history_v1"
        oversized["json"] = {"value": "x" * (app.MAX_AI_HISTORY_JSON_BYTES + 1)}
        rejected = self.push([oversized])
        self.assertEqual(rejected["accepted_count"], 0)
        self.assertEqual(rejected["dispositions"][0]["error"], "PAYLOAD_TOO_LARGE")

    def test_ai_history_rejects_more_than_one_hundred_live_entries(self):
        history = self.entity("library-v1")
        history["kind"] = "ai_reader_history_v1"
        history["json"] = {
            "version": 1,
            "scope": "library",
            "entries": [{"id": f"history:{index}", "at": f"2026-08-{index:03}T00:00:00Z"} for index in range(app.MAX_AI_HISTORY_LIVE_ENTRIES + 1)],
        }

        rejected = self.push([history])

        self.assertEqual(rejected["accepted_count"], 0)
        self.assertEqual(rejected["dispositions"][0]["error"], "HISTORY_RETENTION_LIMIT")
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
