#!/usr/bin/env python3
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import sqlite3
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

DEFAULT_DB_PATH = Path(__file__).resolve().parent / "data" / "entities.db"
DB_PATH = os.environ.get("SYNC_DB_PATH", str(DEFAULT_DB_PATH))
LEGACY_TOKEN = os.environ.get("SYNC_TOKEN", "")
HOST = os.environ.get("SYNC_HOST", "127.0.0.1")
PORT = int(os.environ.get("SYNC_PORT", "8787"))
DEFAULT_USER_ID = "default"
DEFAULT_USERNAME = "default"
MAX_BODY_BYTES = 5 * 1024 * 1024
MAX_ENTITIES = 5000
MAX_ENTITY_JSON_BYTES = 1024 * 1024
MAX_USER_ENTITIES = 50_000
MAX_USER_JSON_BYTES = 100 * 1024 * 1024
MAX_USERS = 10_000
MAX_TOKENS_PER_USER = 5
TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000
MAX_CONCURRENT_REQUESTS = 32
MAX_IGNORED_DETAILS = 100
SUPPORTED_ENTITY_KINDS = frozenset(("book_state_v2", "vocab", "reading_bucket_v2"))


class RateLimiter:
    """Small bounded in-memory token bucket limiter for one API process."""

    def __init__(self, max_buckets=8192, stale_after=3600):
        self.max_buckets = max_buckets
        self.stale_after = stale_after
        self.buckets = {}
        self.lock = threading.Lock()

    def allow(self, scope, key, capacity, period_seconds):
        now = time.monotonic()
        bucket_key = (scope, key)
        with self.lock:
            tokens, last_seen = self.buckets.get(bucket_key, (float(capacity), now))
            refill = (now - last_seen) * (float(capacity) / period_seconds)
            tokens = min(float(capacity), tokens + refill)
            if tokens < 1:
                retry_after = max(1, int((1 - tokens) / (float(capacity) / period_seconds)) + 1)
                self.buckets[bucket_key] = (tokens, now)
                return False, retry_after
            self.buckets[bucket_key] = (tokens - 1, now)
            if len(self.buckets) > self.max_buckets:
                cutoff = now - self.stale_after
                self.buckets = {
                    item_key: item for item_key, item in self.buckets.items() if item[1] >= cutoff
                }
            return True, 0


RATE_LIMITER = RateLimiter()
REQUEST_SLOTS = threading.BoundedSemaphore(MAX_CONCURRENT_REQUESTS)


def now_ms():
    return int(time.time() * 1000)


def b64e(raw):
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def b64d(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def hash_password(password):
    salt = secrets.token_bytes(16)
    n, r, p = 16384, 8, 1
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=32)
    return f"scrypt${n}${r}${p}${b64e(salt)}${b64e(digest)}"


def verify_password(password, stored):
    try:
        scheme, n, r, p, salt, digest = stored.split("$", 5)
        if scheme != "scrypt":
            return False
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=b64d(salt),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=32,
        )
        return hmac.compare_digest(b64d(digest), actual)
    except Exception:
        return False


def new_token():
    return secrets.token_urlsafe(48)


def connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    migrate(conn)
    return conn


def has_column(conn, table, column):
    return any(row["name"] == column for row in conn.execute(f"PRAGMA table_info({table})"))


def table_exists(conn, table):
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone() is not None


def create_entities_table(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS entities (
            user_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            id TEXT NOT NULL,
            json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER NOT NULL DEFAULT 0,
            device_id TEXT NOT NULL DEFAULT '',
            sync_version INTEGER NOT NULL DEFAULT 0,
            server_updated_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, kind, id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
        """
    )


def record_migration(conn, version):
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)",
        (version, now_ms()),
    )


def migrate(conn):
    with conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations "
            "(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tokens (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                last_used_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )
        # Avoid the old behavior of running an expensive scrypt hash on every request.
        if conn.execute("SELECT 1 FROM users WHERE id=?", (DEFAULT_USER_ID,)).fetchone() is None:
            default_password = secrets.token_urlsafe(24)
            conn.execute(
                "INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)",
                (DEFAULT_USER_ID, DEFAULT_USERNAME, hash_password(default_password), now_ms()),
            )
        if LEGACY_TOKEN:
            conn.execute(
                "INSERT OR IGNORE INTO tokens(token,user_id,created_at,last_used_at) VALUES(?,?,?,?)",
                (LEGACY_TOKEN, DEFAULT_USER_ID, now_ms(), now_ms()),
            )
        if table_exists(conn, "entities") and not has_column(conn, "entities", "user_id"):
            conn.execute("ALTER TABLE entities RENAME TO entities_legacy")
            create_entities_table(conn)
            conn.execute(
                """
                INSERT OR REPLACE INTO entities(
                    user_id,kind,id,json,updated_at,deleted_at,device_id,sync_version,server_updated_at
                )
                SELECT ?,kind,id,json,updated_at,deleted_at,device_id,sync_version,server_updated_at
                FROM entities_legacy
                """,
                (DEFAULT_USER_ID,),
            )
            conn.execute("DROP TABLE entities_legacy")
        else:
            create_entities_table(conn)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_entities_user_server_updated_at "
            "ON entities(user_id,server_updated_at)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_tokens_user_last_used_at "
            "ON tokens(user_id,last_used_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_tokens_created_at ON tokens(created_at)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sync_clock(id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL)"
        )
        maximum = conn.execute(
            "SELECT COALESCE(MAX(server_updated_at),0) FROM entities"
        ).fetchone()[0]
        conn.execute("INSERT OR IGNORE INTO sync_clock(id,value) VALUES(1,?)", (maximum,))
        record_migration(conn, 1)
        record_migration(conn, 2)
        record_migration(conn, 3)
        record_migration(conn, 4)
        # Password recovery is intentionally not enabled until a verified email
        # delivery channel is configured. Remove the retired support-code table.
        conn.execute("DROP TABLE IF EXISTS password_reset_codes")
        record_migration(conn, 5)
        # V2 portable entities replace machine-local book paths and v1 reading buckets.
        placeholders = ",".join("?" for _ in SUPPORTED_ENTITY_KINDS)
        conn.execute(
            f"DELETE FROM entities WHERE kind NOT IN ({placeholders})",
            tuple(sorted(SUPPORTED_ENTITY_KINDS)),
        )
        record_migration(conn, 6)


def next_server_stamp(conn):
    current = now_ms()
    conn.execute(
        "UPDATE sync_clock SET value=CASE WHEN value>=? THEN value+1 ELSE ? END WHERE id=1",
        (current, current),
    )
    return conn.execute("SELECT value FROM sync_clock WHERE id=1").fetchone()[0]


def row_to_user(row):
    return {"id": row["id"], "username": row["username"]}


def user_by_token(conn, token):
    if not token:
        return None
    cutoff = now_ms() - TOKEN_TTL_MS
    conn.execute("DELETE FROM tokens WHERE created_at<?", (cutoff,))
    row = conn.execute(
        """
        SELECT users.id,users.username FROM tokens
        JOIN users ON users.id=tokens.user_id
        WHERE tokens.token=? AND tokens.created_at>=?
        """,
        (token, cutoff),
    ).fetchone()
    if row:
        conn.execute("UPDATE tokens SET last_used_at=? WHERE token=?", (now_ms(), token))
    conn.commit()
    return row


def issue_token(conn, user_id):
    now = now_ms()
    token = new_token()
    conn.execute("DELETE FROM tokens WHERE created_at<?", (now - TOKEN_TTL_MS,))
    conn.execute(
        "INSERT INTO tokens(token,user_id,created_at,last_used_at) VALUES(?,?,?,?)",
        (token, user_id, now, now),
    )
    conn.execute(
        """
        DELETE FROM tokens
        WHERE user_id=? AND token IN (
            SELECT token FROM tokens WHERE user_id=?
            ORDER BY last_used_at DESC, created_at DESC
            LIMIT -1 OFFSET ?
        )
        """,
        (user_id, user_id, MAX_TOKENS_PER_USER),
    )
    return token


def row_to_entity(row):
    try:
        payload = json.loads(row["json"])
    except json.JSONDecodeError:
        payload = row["json"]
    return {
        "kind": row["kind"],
        "id": row["id"],
        "json": payload,
        "updated_at": row["updated_at"],
        "deleted_at": row["deleted_at"],
        "device_id": row["device_id"],
        "sync_version": row["sync_version"],
        "server_updated_at": row["server_updated_at"],
    }


def safe_int(value, default=0):
    try:
        return int(value or default)
    except (TypeError, ValueError):
        return default


def is_newer(incoming, existing):
    if existing is None:
        return True
    incoming_updated = safe_int(incoming.get("updated_at"))
    incoming_version = safe_int(incoming.get("sync_version"))
    if incoming_updated > int(existing["updated_at"]):
        return True
    if incoming_updated == int(existing["updated_at"]):
        return incoming_version > int(existing["sync_version"])
    return False


def record_ignored(details, detail):
    if len(details) < MAX_IGNORED_DETAILS:
        details.append(detail)


class PayloadTooLarge(Exception):
    pass


class Handler(BaseHTTPRequestHandler):
    server_version = "ReaderSyncAPI/0.3"

    def log_message(self, fmt, *args):
        print(
            "%s - - [%s] %s" % (self.address_string(), self.log_date_time_string(), fmt % args),
            flush=True,
        )

    def send_json(self, status, payload, extra_headers=None):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (extra_headers or {}).items():
            self.send_header(name, str(value))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_error_code(self, status, code, message=None, retry_after=None):
        payload = {"ok": False, "error": code, "code": code}
        if message:
            payload["message"] = message
        headers = {"Retry-After": retry_after} if retry_after else None
        self.send_json(status, payload, headers)

    def client_ip(self):
        peer = self.client_address[0]
        if peer in ("127.0.0.1", "::1"):
            forwarded = self.headers.get("X-Forwarded-For", "").split(",", 1)[0].strip()
            if forwarded:
                try:
                    return str(ipaddress.ip_address(forwarded))
                except ValueError:
                    pass
        return peer

    def allow_rate(self, scope, key, capacity, period_seconds):
        allowed, retry_after = RATE_LIMITER.allow(scope, key, capacity, period_seconds)
        if not allowed:
            self.send_error_code(429, "RATE_LIMITED", "请求过于频繁，请稍后重试", retry_after)
        return allowed

    def begin_request(self):
        if not REQUEST_SLOTS.acquire(blocking=False):
            self.send_error_code(503, "SERVER_BUSY", "服务器繁忙，请稍后重试", 2)
            return False
        if not self.allow_rate("request_ip", self.client_ip(), 120, 60):
            REQUEST_SLOTS.release()
            return False
        return True

    def read_json(self):
        length = safe_int(self.headers.get("Content-Length", "0"))
        if length > MAX_BODY_BYTES:
            raise PayloadTooLarge()
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def bearer_token(self):
        auth = self.headers.get("Authorization", "")
        return auth[7:].strip() if auth.startswith("Bearer ") else ""

    def current_user(self):
        conn = connect()
        return conn, user_by_token(conn, self.bearer_token())

    def require_user(self):
        conn, user = self.current_user()
        if user:
            return conn, user
        conn.close()
        self.send_error_code(401, "UNAUTHORIZED")
        return None, None

    def do_GET(self):
        if not self.begin_request():
            return
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/health":
                if not self.allow_rate("health_ip", self.client_ip(), 60, 60):
                    return
                self.send_json(
                    200,
                    {"ok": True, "schema_version": 2, "server_time": now_ms(), "service": "reader-sync"},
                )
                return
            if parsed.path == "/auth/me":
                conn, user = self.require_user()
                if not user:
                    return
                self.send_json(
                    200,
                    {
                        "ok": True,
                        "schema_version": 2,
                        "server_time": now_ms(),
                        "id": user["id"],
                        "username": user["username"],
                        "user": row_to_user(user),
                    },
                )
                conn.close()
                return
            if parsed.path == "/sync/pull":
                self.handle_pull(parsed)
                return
            self.send_error_code(404, "NOT_FOUND")
        finally:
            REQUEST_SLOTS.release()

    def handle_pull(self, parsed):
        conn, user = self.require_user()
        if not user:
            return
        if not self.allow_rate("sync_user", user["id"], 30, 60):
            conn.close()
            return
        params = parse_qs(parsed.query)
        raw_cursor = (params.get("cursor") or params.get("since") or ["0"])[0]
        cursor = max(0, safe_int(raw_cursor))
        limit = min(max(safe_int((params.get("limit") or ["1000"])[0], 1000), 1), MAX_ENTITIES)
        rows = conn.execute(
            """
            SELECT kind,id,json,updated_at,deleted_at,device_id,sync_version,server_updated_at
            FROM entities
            WHERE user_id=? AND server_updated_at>?
              AND kind IN ('book_state_v2','vocab','reading_bucket_v2')
            ORDER BY server_updated_at ASC LIMIT ?
            """,
            (user["id"], cursor, limit),
        ).fetchall()
        next_cursor = rows[-1]["server_updated_at"] if rows else cursor
        has_more = conn.execute(
            "SELECT 1 FROM entities WHERE user_id=? AND server_updated_at>? "
            "AND kind IN ('book_state_v2','vocab','reading_bucket_v2') LIMIT 1",
            (user["id"], next_cursor),
        ).fetchone() is not None
        self.send_json(
            200,
            {
                "ok": True,
                "schema_version": 2,
                "server_time": now_ms(),
                "cursor": str(cursor),
                "next_cursor": str(next_cursor),
                "has_more": has_more,
                "entities": [row_to_entity(row) for row in rows],
            },
        )
        conn.close()

    def do_POST(self):
        if not self.begin_request():
            return
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/auth/register":
                self.handle_register()
            elif parsed.path == "/auth/login":
                self.handle_login()
            elif parsed.path in ("/auth/logout", "/auth/revoke"):
                self.handle_logout()
            elif parsed.path == "/sync/push":
                self.handle_push()
            else:
                self.send_error_code(404, "NOT_FOUND")
        finally:
            REQUEST_SLOTS.release()

    def read_auth_body(self):
        try:
            return self.read_json()
        except PayloadTooLarge:
            self.send_error_code(413, "PAYLOAD_TOO_LARGE")
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_error_code(400, "INVALID_JSON")
        return None

    def handle_register(self):
        if not self.allow_rate("register_ip", self.client_ip(), 5, 3600):
            return
        body = self.read_auth_body()
        if body is None:
            return
        username = str(body.get("username", "") or "").strip()
        password = str(body.get("password", "") or "")
        if not 3 <= len(username) <= 64:
            self.send_error_code(400, "INVALID_USERNAME", "账号长度必须为 3 到 64 个字符")
            return
        if len(password) < 8:
            self.send_error_code(400, "WEAK_PASSWORD", "密码至少需要 8 个字符")
            return
        conn = connect()
        user_count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        if user_count >= MAX_USERS:
            conn.close()
            self.send_error_code(503, "ACCOUNT_CAPACITY", "当前注册容量已满，请稍后再试")
            return
        try:
            with conn:
                user_id = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)",
                    (user_id, username, hash_password(password), now_ms()),
                )
                token = issue_token(conn, user_id)
        except sqlite3.IntegrityError:
            self.send_error_code(409, "USERNAME_EXISTS")
            conn.close()
            return
        self.send_json(200, {"ok": True, "token": token, "user": {"id": user_id, "username": username}})
        conn.close()

    def handle_login(self):
        if not self.allow_rate("login_ip", self.client_ip(), 8, 60):
            return
        body = self.read_auth_body()
        if body is None:
            return
        username = str(body.get("username", "") or "").strip()
        password = str(body.get("password", "") or "")
        if not self.allow_rate("login_username", username.casefold() or "<empty>", 5, 900):
            return
        conn = connect()
        user = conn.execute(
            "SELECT id,username,password_hash FROM users WHERE username=?", (username,)
        ).fetchone()
        if not user or not verify_password(password, user["password_hash"]):
            self.send_error_code(401, "INVALID_CREDENTIALS")
            conn.close()
            return
        with conn:
            token = issue_token(conn, user["id"])
        self.send_json(
            200,
            {"ok": True, "token": token, "user": {"id": user["id"], "username": user["username"]}},
        )
        conn.close()

    def handle_logout(self):
        token = self.bearer_token()
        conn, user = self.require_user()
        if not user:
            return
        with conn:
            conn.execute("DELETE FROM tokens WHERE token=?", (token,))
        conn.close()
        self.send_json(200, {"ok": True})

    def handle_push(self):
        conn, user = self.require_user()
        if not user:
            return
        if not self.allow_rate("sync_user", user["id"], 30, 60):
            conn.close()
            return
        try:
            body = self.read_json()
        except PayloadTooLarge:
            self.send_error_code(413, "PAYLOAD_TOO_LARGE")
            conn.close()
            return
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_error_code(400, "INVALID_JSON")
            conn.close()
            return
        schema_version = safe_int(body.get("schema_version"), 1)
        if schema_version > 2:
            self.send_error_code(409, "SCHEMA_UNSUPPORTED")
            conn.close()
            return
        entities = body.get("entities")
        if not isinstance(entities, list):
            self.send_error_code(400, "ENTITIES_MUST_BE_ARRAY")
            conn.close()
            return
        if len(entities) > MAX_ENTITIES:
            self.send_error_code(413, "TOO_MANY_ENTITIES")
            conn.close()
            return
        default_device_id = str(body.get("device_id", "") or "")[:128]
        accepted, ignored = [], []
        ignored_count = 0
        usage = conn.execute(
            "SELECT COUNT(*) AS entity_count, COALESCE(SUM(LENGTH(json)),0) AS json_bytes "
            "FROM entities WHERE user_id=?",
            (user["id"],),
        ).fetchone()
        user_entity_count = int(usage["entity_count"])
        user_json_bytes = int(usage["json_bytes"])
        with conn:
            for entity in entities:
                if not isinstance(entity, dict):
                    ignored_count += 1
                    record_ignored(ignored, {"error": "ENTITY_MUST_BE_OBJECT"})
                    continue
                kind = str(entity.get("kind", "") or "")
                entity_id = str(entity.get("id", "") or "")
                if not kind or not entity_id or len(kind) > 128 or len(entity_id) > 512:
                    ignored_count += 1
                    record_ignored(
                        ignored,
                        {"kind": kind[:128], "id": entity_id[:512], "error": "INVALID_ID"},
                    )
                    continue
                if kind not in SUPPORTED_ENTITY_KINDS:
                    ignored_count += 1
                    record_ignored(
                        ignored,
                        {"kind": kind[:128], "id": entity_id[:512], "error": "UNSUPPORTED_KIND"},
                    )
                    continue
                payload = entity.get("json", entity.get("data", {}))
                payload_text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
                payload_bytes = len(payload_text.encode("utf-8"))
                if payload_bytes > MAX_ENTITY_JSON_BYTES:
                    ignored_count += 1
                    record_ignored(ignored, {"kind": kind, "id": entity_id, "error": "PAYLOAD_TOO_LARGE"})
                    continue
                normalized = {
                    "kind": kind,
                    "id": entity_id,
                    "json": payload,
                    "updated_at": safe_int(entity.get("updated_at")),
                    "deleted_at": safe_int(entity.get("deleted_at")),
                    "device_id": str(entity.get("device_id", default_device_id) or "")[:128],
                    "sync_version": safe_int(entity.get("sync_version")),
                }
                existing = conn.execute(
                    "SELECT updated_at,sync_version,LENGTH(json) AS json_bytes "
                    "FROM entities WHERE user_id=? AND kind=? AND id=?",
                    (user["id"], kind, entity_id),
                ).fetchone()
                if not is_newer(normalized, existing):
                    ignored_count += 1
                    record_ignored(ignored, {"kind": kind, "id": entity_id, "reason": "CONFLICT_IGNORED"})
                    continue
                existing_bytes = int(existing["json_bytes"]) if existing else 0
                entity_delta = 0 if existing else 1
                byte_delta = payload_bytes - existing_bytes
                if (
                    user_entity_count + entity_delta > MAX_USER_ENTITIES
                    or user_json_bytes + byte_delta > MAX_USER_JSON_BYTES
                ):
                    ignored_count += 1
                    record_ignored(ignored, {"kind": kind, "id": entity_id, "error": "QUOTA_EXCEEDED"})
                    continue
                normalized["server_updated_at"] = next_server_stamp(conn)
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
                        user["id"], kind, entity_id, payload_text, normalized["updated_at"],
                        normalized["deleted_at"], normalized["device_id"],
                        normalized["sync_version"], normalized["server_updated_at"],
                    ),
                )
                user_entity_count += entity_delta
                user_json_bytes += byte_delta
                accepted.append(normalized)
        response_cursor = max(
            [safe_int(item.get("server_updated_at")) for item in accepted] or [0]
        )
        self.send_json(
            200,
            {
                "ok": True,
                "schema_version": 2,
                "server_time": now_ms(),
                "next_cursor": str(response_cursor),
                "entities": [],
                "accepted": len(accepted),
                "accepted_count": len(accepted),
                "ignored_count": ignored_count,
                "ignored": ignored,
            },
        )
        conn.close()


if __name__ == "__main__":
    connect().close()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Reader sync API listening on http://{HOST}:{PORT}", flush=True)
    httpd.serve_forever()
