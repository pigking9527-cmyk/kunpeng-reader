#!/usr/bin/env python3
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import smtplib
import sqlite3
import threading
import time
import uuid
from email.message import EmailMessage
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
FEEDBACK_TO = os.environ.get("FEEDBACK_TO", "pigking9527@gmail.com").strip()
FEEDBACK_SMTP_HOST = os.environ.get("FEEDBACK_SMTP_HOST", "").strip()
FEEDBACK_SMTP_PORT = int(os.environ.get("FEEDBACK_SMTP_PORT", "465"))
FEEDBACK_SMTP_USER = os.environ.get("FEEDBACK_SMTP_USER", "").strip()
FEEDBACK_SMTP_PASSWORD = os.environ.get("FEEDBACK_SMTP_PASSWORD", "")
FEEDBACK_SMTP_FROM = os.environ.get("FEEDBACK_SMTP_FROM", FEEDBACK_SMTP_USER).strip()
FEEDBACK_SMTP_SSL = os.environ.get("FEEDBACK_SMTP_SSL", "1") != "0"
FEEDBACK_SMTP_STARTTLS = os.environ.get("FEEDBACK_SMTP_STARTTLS", "0") == "1"
MAX_FEEDBACK_TEXT_CHARS = 20_000
MAX_FEEDBACK_IMAGES = 3
MAX_FEEDBACK_IMAGE_BYTES = 1024 * 1024
MAX_FEEDBACK_ROWS = 2_000


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
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS feedback (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                text TEXT NOT NULL,
                images_json TEXT NOT NULL,
                app_version TEXT NOT NULL,
                platform TEXT NOT NULL,
                client_ip TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                emailed_at INTEGER NOT NULL DEFAULT 0,
                mail_error TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_feedback_email_queue "
            "ON feedback(emailed_at,created_at)"
        )
        record_migration(conn, 7)


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


def inventory_rows(conn, user_id):
    return conn.execute(
        """
        SELECT kind,id,json,updated_at,deleted_at,device_id,sync_version,server_updated_at
        FROM entities
        WHERE user_id=? AND kind IN ('book_state_v2','vocab','reading_bucket_v2')
        ORDER BY kind,id
        """,
        (user_id,),
    ).fetchall()


def inventory_summary(rows):
    """Hash the exact portable entity versions held by one account.

    The desktop client uses the same length-prefixed binary representation.
    JSON is deliberately excluded: an exact device/version/timestamp identifies
    immutable payload content in the sync protocol, while excluding it keeps
    this check cheap enough to run after every normal incremental sync.
    """
    digest = hashlib.sha256()
    revision = 0
    for row in rows:
        for field in ("kind", "id", "device_id"):
            raw = str(row[field] or "").encode("utf-8")
            digest.update(len(raw).to_bytes(4, "big"))
            digest.update(raw)
        for field in ("sync_version", "updated_at", "deleted_at"):
            digest.update(int(row[field]).to_bytes(8, "big", signed=True))
        revision = max(revision, safe_int(row["server_updated_at"]))
    return {
        "entity_count": len(rows),
        "inventory_digest": digest.hexdigest(),
        "revision": str(revision),
    }


def manifest_meta_equal(left, right):
    return all(
        str(left[field] or "") == str(right[field] or "")
        if field == "device_id"
        else safe_int(left[field]) == safe_int(right[field])
        for field in ("device_id", "sync_version", "updated_at", "deleted_at")
    )


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
        existing_version = int(existing["sync_version"])
        if incoming_version != existing_version:
            return incoming_version > existing_version
        # Millisecond clocks and offline edits can produce an exact timestamp
        # and version tie.  Use the same stable device-id tiebreaker as the
        # desktop client so arrival order cannot leave clients diverged.
        incoming_device = str(incoming.get("device_id", "") or "")
        existing_device = str(existing["device_id"] or "")
        return incoming_device > existing_device
    return False


def record_ignored(details, detail):
    if len(details) < MAX_IGNORED_DETAILS:
        details.append(detail)


def feedback_mail_configured():
    return bool(FEEDBACK_TO and FEEDBACK_SMTP_HOST and FEEDBACK_SMTP_FROM)


def decode_feedback_image(item):
    if not isinstance(item, dict):
        raise ValueError("INVALID_FEEDBACK_IMAGE")
    name = str(item.get("name", "") or "feedback-image.jpg")[:160]
    mime = str(item.get("mime", "") or "")
    if mime not in ("image/jpeg", "image/png", "image/webp"):
        raise ValueError("INVALID_FEEDBACK_IMAGE_TYPE")
    try:
        raw = base64.b64decode(str(item.get("data", "") or ""), validate=True)
    except (ValueError, TypeError):
        raise ValueError("INVALID_FEEDBACK_IMAGE_DATA") from None
    if not raw or len(raw) > MAX_FEEDBACK_IMAGE_BYTES:
        raise ValueError("FEEDBACK_IMAGE_TOO_LARGE")
    valid_magic = (
        mime == "image/jpeg" and raw.startswith(b"\xff\xd8\xff")
        or mime == "image/png" and raw.startswith(b"\x89PNG\r\n\x1a\n")
        or mime == "image/webp" and raw.startswith(b"RIFF") and raw[8:12] == b"WEBP"
    )
    if not valid_magic:
        raise ValueError("INVALID_FEEDBACK_IMAGE_DATA")
    return {"name": name, "mime": mime, "data": str(item.get("data", "") or "")}, raw


def normalize_feedback(body):
    if not isinstance(body, dict):
        raise ValueError("INVALID_FEEDBACK")
    kind = str(body.get("kind", "") or "")
    if kind not in ("bug", "feature"):
        raise ValueError("INVALID_FEEDBACK_KIND")
    text = str(body.get("text", "") or "").strip()
    images = body.get("images", [])
    if not isinstance(images, list) or len(images) > MAX_FEEDBACK_IMAGES:
        raise ValueError("TOO_MANY_FEEDBACK_IMAGES")
    if not text and not images:
        raise ValueError("EMPTY_FEEDBACK")
    if len(text) > MAX_FEEDBACK_TEXT_CHARS:
        raise ValueError("FEEDBACK_TEXT_TOO_LONG")
    normalized_images = []
    for item in images:
        normalized, _ = decode_feedback_image(item)
        normalized_images.append(normalized)
    return {
        "kind": kind,
        "text": text,
        "images": normalized_images,
        "app_version": str(body.get("appVersion", "") or "")[:64],
        "platform": str(body.get("platform", "") or "")[:1000],
    }


def send_feedback_email(feedback):
    if not feedback_mail_configured():
        raise RuntimeError("SMTP_NOT_CONFIGURED")
    labels = {"bug": "Bug", "feature": "功能提议"}
    message = EmailMessage()
    message["Subject"] = f"[鲲鹏阅读器 {labels.get(feedback['kind'], '反馈')}] {feedback['id']}"
    message["From"] = FEEDBACK_SMTP_FROM
    message["To"] = FEEDBACK_TO
    message.set_content(
        "\n".join(
            (
                f"反馈编号：{feedback['id']}",
                f"类型：{labels.get(feedback['kind'], feedback['kind'])}",
                f"应用版本：{feedback.get('app_version', '') or '未知'}",
                f"客户端：{feedback.get('platform', '') or '未知'}",
                f"提交时间：{feedback.get('created_at', 0)}",
                "",
                feedback.get("text", "") or "（仅提交了图片）",
            )
        )
    )
    for item in feedback.get("images", []):
        _, raw = decode_feedback_image(item)
        subtype = item["mime"].split("/", 1)[1]
        message.add_attachment(raw, maintype="image", subtype=subtype, filename=item["name"])
    smtp_cls = smtplib.SMTP_SSL if FEEDBACK_SMTP_SSL else smtplib.SMTP
    with smtp_cls(FEEDBACK_SMTP_HOST, FEEDBACK_SMTP_PORT, timeout=20) as smtp:
        if not FEEDBACK_SMTP_SSL and FEEDBACK_SMTP_STARTTLS:
            smtp.starttls()
        if FEEDBACK_SMTP_USER:
            smtp.login(FEEDBACK_SMTP_USER, FEEDBACK_SMTP_PASSWORD)
        smtp.send_message(message)


def deliver_feedback_row(conn, row):
    feedback = {
        "id": row["id"],
        "kind": row["kind"],
        "text": row["text"],
        "images": json.loads(row["images_json"]),
        "app_version": row["app_version"],
        "platform": row["platform"],
        "created_at": row["created_at"],
    }
    try:
        send_feedback_email(feedback)
    except Exception as error:
        with conn:
            conn.execute(
                "UPDATE feedback SET mail_error=? WHERE id=?",
                (str(error)[:1000], row["id"]),
            )
        return False
    with conn:
        conn.execute(
            "UPDATE feedback SET emailed_at=?,mail_error='' WHERE id=?",
            (now_ms(), row["id"]),
        )
    return True


def deliver_pending_feedback(limit=20):
    if not feedback_mail_configured():
        return 0
    conn = connect()
    rows = conn.execute(
        "SELECT * FROM feedback WHERE emailed_at=0 ORDER BY created_at ASC LIMIT ?",
        (limit,),
    ).fetchall()
    delivered = sum(1 for row in rows if deliver_feedback_row(conn, row))
    conn.close()
    return delivered


class PayloadTooLarge(Exception):
    pass


class Handler(BaseHTTPRequestHandler):
    server_version = "ReaderSyncAPI/0.7"

    def begin_push_transaction(self, conn):
        # `with conn` only commits/rolls back an already-open transaction; it
        # does not acquire a write lock on entry.  Take the write reservation
        # before reading usage or the current entity so concurrent requests
        # cannot both decide against the same stale row and let the later
        # writer overwrite the deterministic conflict winner.
        conn.execute("BEGIN IMMEDIATE")

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
                    {
                        "ok": True,
                        "schema_version": 2,
                        "api_version": "0.7",
                        "server_time": now_ms(),
                        "service": "reader-sync",
                    },
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
            if parsed.path == "/sync/inventory":
                self.handle_inventory()
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

    def handle_inventory(self):
        conn, user = self.require_user()
        if not user:
            return
        if not self.allow_rate("sync_user", user["id"], 30, 60):
            conn.close()
            return
        rows = inventory_rows(conn, user["id"])
        self.send_json(
            200,
            {
                "ok": True,
                "schema_version": 2,
                "server_time": now_ms(),
                **inventory_summary(rows),
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
            elif parsed.path == "/sync/reconcile":
                self.handle_reconcile()
            elif parsed.path == "/feedback":
                self.handle_feedback()
            else:
                self.send_error_code(404, "NOT_FOUND")
        finally:
            REQUEST_SLOTS.release()

    def handle_feedback(self):
        client_ip = self.client_ip()
        if not self.allow_rate("feedback_ip_hour", client_ip, 3, 3600):
            return
        if not self.allow_rate("feedback_ip_day", client_ip, 8, 24 * 3600):
            return
        if not self.allow_rate("feedback_global_hour", "all", 100, 3600):
            return
        try:
            body = self.read_json()
            feedback = normalize_feedback(body)
        except PayloadTooLarge:
            self.send_error_code(413, "PAYLOAD_TOO_LARGE", "反馈内容超过大小限制")
            return
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_error_code(400, "INVALID_JSON")
            return
        except ValueError as error:
            self.send_error_code(400, str(error), "反馈内容格式不正确")
            return
        feedback_id = str(uuid.uuid4())
        created_at = now_ms()
        conn = connect()
        row_count = conn.execute("SELECT COUNT(*) FROM feedback").fetchone()[0]
        if row_count >= MAX_FEEDBACK_ROWS:
            with conn:
                conn.execute(
                    "DELETE FROM feedback WHERE id IN "
                    "(SELECT id FROM feedback WHERE emailed_at>0 ORDER BY created_at ASC LIMIT 200)"
                )
            row_count = conn.execute("SELECT COUNT(*) FROM feedback").fetchone()[0]
        if row_count >= MAX_FEEDBACK_ROWS:
            conn.close()
            self.send_error_code(503, "FEEDBACK_CAPACITY", "反馈箱暂时已满，请稍后再试")
            return
        with conn:
            conn.execute(
                """
                INSERT INTO feedback(
                    id,kind,text,images_json,app_version,platform,client_ip,created_at
                ) VALUES(?,?,?,?,?,?,?,?)
                """,
                (
                    feedback_id,
                    feedback["kind"],
                    feedback["text"],
                    json.dumps(feedback["images"], ensure_ascii=False, separators=(",", ":")),
                    feedback["app_version"],
                    feedback["platform"],
                    client_ip,
                    created_at,
                ),
            )
        row = conn.execute("SELECT * FROM feedback WHERE id=?", (feedback_id,)).fetchone()
        emailed = deliver_feedback_row(conn, row) if feedback_mail_configured() else False
        conn.close()
        self.send_json(
            200,
            {
                "ok": True,
                "id": feedback_id,
                "emailed": emailed,
                "message": (
                    "反馈已提交并发送，谢谢。"
                    if emailed
                    else "反馈已安全收件；邮件通知暂时排队。"
                ),
            },
        )

    def handle_reconcile(self):
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
        manifest = body.get("manifest")
        if not isinstance(manifest, list):
            self.send_error_code(400, "MANIFEST_MUST_BE_ARRAY")
            conn.close()
            return
        if len(manifest) > MAX_USER_ENTITIES:
            self.send_error_code(413, "TOO_MANY_ENTITIES")
            conn.close()
            return

        local_by_key = {}
        for item in manifest:
            if not isinstance(item, dict):
                self.send_error_code(400, "MANIFEST_ENTRY_MUST_BE_OBJECT")
                conn.close()
                return
            kind = str(item.get("kind", "") or "")
            entity_id = str(item.get("id", "") or "")
            if (
                kind not in SUPPORTED_ENTITY_KINDS
                or not entity_id
                or len(kind) > 128
                or len(entity_id) > 512
            ):
                self.send_error_code(400, "INVALID_MANIFEST_ID")
                conn.close()
                return
            key = (kind, entity_id)
            if key in local_by_key:
                self.send_error_code(400, "DUPLICATE_MANIFEST_ID")
                conn.close()
                return
            local_by_key[key] = {
                "kind": kind,
                "id": entity_id,
                "updated_at": safe_int(item.get("updated_at")),
                "deleted_at": safe_int(item.get("deleted_at")),
                "device_id": str(item.get("device_id", "") or "")[:128],
                "sync_version": safe_int(item.get("sync_version")),
            }

        rows = inventory_rows(conn, user["id"])
        server_by_key = {(row["kind"], row["id"]): row for row in rows}
        upload = []
        authoritative = []
        for key in sorted(set(local_by_key) | set(server_by_key)):
            local = local_by_key.get(key)
            server = server_by_key.get(key)
            if server is None:
                upload.append({"kind": key[0], "id": key[1]})
            elif local is None:
                authoritative.append(row_to_entity(server))
            elif manifest_meta_equal(local, server):
                continue
            elif is_newer(local, server):
                upload.append({"kind": key[0], "id": key[1]})
            else:
                authoritative.append(row_to_entity(server))

        self.send_json(
            200,
            {
                "ok": True,
                "schema_version": 2,
                "server_time": now_ms(),
                **inventory_summary(rows),
                "upload": upload,
                "entities": authoritative,
            },
        )
        conn.close()

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
        capabilities = body.get("capabilities")
        supports_dispositions = isinstance(capabilities, list) and "push_dispositions_v1" in capabilities
        accepted, ignored = [], []
        dispositions = []
        authoritative_entities = []
        ignored_count = 0
        rejected_count = 0
        with conn:
            self.begin_push_transaction(conn)
            usage = conn.execute(
                "SELECT COUNT(*) AS entity_count, COALESCE(SUM(LENGTH(json)),0) AS json_bytes "
                "FROM entities WHERE user_id=?",
                (user["id"],),
            ).fetchone()
            user_entity_count = int(usage["entity_count"])
            user_json_bytes = int(usage["json_bytes"])
            for entity in entities:
                if not isinstance(entity, dict):
                    ignored_count += 1
                    rejected_count += 1
                    record_ignored(ignored, {"error": "ENTITY_MUST_BE_OBJECT"})
                    dispositions.append({"status": "rejected", "error": "ENTITY_MUST_BE_OBJECT"})
                    continue
                kind = str(entity.get("kind", "") or "")
                entity_id = str(entity.get("id", "") or "")
                input_identity = {
                    "kind": kind[:128],
                    "id": entity_id[:512],
                    "device_id": str(entity.get("device_id", default_device_id) or "")[:128],
                    "sync_version": safe_int(entity.get("sync_version")),
                }
                if not kind or not entity_id or len(kind) > 128 or len(entity_id) > 512:
                    ignored_count += 1
                    rejected_count += 1
                    record_ignored(
                        ignored,
                        {"kind": kind[:128], "id": entity_id[:512], "error": "INVALID_ID"},
                    )
                    dispositions.append(
                        {**input_identity, "status": "rejected", "error": "INVALID_ID"}
                    )
                    continue
                if kind not in SUPPORTED_ENTITY_KINDS:
                    ignored_count += 1
                    rejected_count += 1
                    record_ignored(
                        ignored,
                        {"kind": kind[:128], "id": entity_id[:512], "error": "UNSUPPORTED_KIND"},
                    )
                    dispositions.append(
                        {**input_identity, "status": "rejected", "error": "UNSUPPORTED_KIND"}
                    )
                    continue
                payload = entity.get("json", entity.get("data", {}))
                payload_text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
                payload_bytes = len(payload_text.encode("utf-8"))
                if payload_bytes > MAX_ENTITY_JSON_BYTES:
                    ignored_count += 1
                    rejected_count += 1
                    record_ignored(ignored, {"kind": kind, "id": entity_id, "error": "PAYLOAD_TOO_LARGE"})
                    dispositions.append(
                        {**input_identity, "status": "rejected", "error": "PAYLOAD_TOO_LARGE"}
                    )
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
                    "SELECT kind,id,json,updated_at,deleted_at,device_id,sync_version,"
                    "server_updated_at,LENGTH(json) AS json_bytes "
                    "FROM entities WHERE user_id=? AND kind=? AND id=?",
                    (user["id"], kind, entity_id),
                ).fetchone()
                if not is_newer(normalized, existing):
                    ignored_count += 1
                    record_ignored(ignored, {"kind": kind, "id": entity_id, "reason": "CONFLICT_IGNORED"})
                    dispositions.append({**input_identity, "status": "conflict"})
                    authoritative_entities.append(row_to_entity(existing))
                    continue
                existing_bytes = int(existing["json_bytes"]) if existing else 0
                entity_delta = 0 if existing else 1
                byte_delta = payload_bytes - existing_bytes
                if (
                    user_entity_count + entity_delta > MAX_USER_ENTITIES
                    or user_json_bytes + byte_delta > MAX_USER_JSON_BYTES
                ):
                    ignored_count += 1
                    rejected_count += 1
                    record_ignored(ignored, {"kind": kind, "id": entity_id, "error": "QUOTA_EXCEEDED"})
                    dispositions.append(
                        {**input_identity, "status": "rejected", "error": "QUOTA_EXCEEDED"}
                    )
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
                dispositions.append({**input_identity, "status": "accepted"})
        response_cursor = max(
            [safe_int(item.get("server_updated_at")) for item in accepted] or [0]
        )
        # Older desktop builds clear an entire batch after any HTTP 200 because
        # they cannot identify individual rejects.  Refuse a mixed/invalid
        # response for those clients so quota or validation failures remain
        # dirty and retryable. Accepted rows are idempotent on the next attempt.
        if rejected_count and not supports_dispositions:
            self.send_error_code(409, "PUSH_DISPOSITIONS_REQUIRED")
            conn.close()
            return
        self.send_json(
            200,
            {
                "ok": True,
                "schema_version": 2,
                "server_time": now_ms(),
                "next_cursor": str(response_cursor),
                # Conflict rows are returned immediately so the client can
                # acknowledge its exact losing version and install the
                # authoritative server row in one local SQLite transaction.
                "entities": authoritative_entities,
                "dispositions": dispositions,
                "accepted": len(accepted),
                "accepted_count": len(accepted),
                "ignored_count": ignored_count,
                "ignored": ignored,
            },
        )
        conn.close()


if __name__ == "__main__":
    connect().close()
    delivered = deliver_pending_feedback()
    if delivered:
        print(f"Delivered {delivered} queued feedback messages", flush=True)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Reader sync API listening on http://{HOST}:{PORT}", flush=True)
    httpd.serve_forever()
