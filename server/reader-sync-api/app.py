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

import recovery
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

DEFAULT_DB_PATH = Path(__file__).resolve().parent / "data" / "entities.db"
DB_PATH = os.environ.get("SYNC_DB_PATH", str(DEFAULT_DB_PATH))
ASSET_DIR = Path(os.environ.get("SYNC_ASSET_DIR", str(Path(DB_PATH).parent / "assets")))
DEFAULT_UPDATE_MANIFEST_PATH = Path(__file__).resolve().parent / "updates.json"
UPDATE_MANIFEST_PATH = Path(os.environ.get("UPDATE_MANIFEST_PATH", str(DEFAULT_UPDATE_MANIFEST_PATH)))
LEGACY_TOKEN = os.environ.get("SYNC_TOKEN", "")
HOST = os.environ.get("SYNC_HOST", "127.0.0.1")
PORT = int(os.environ.get("SYNC_PORT", "8787"))
DEFAULT_USER_ID = "default"
DEFAULT_USERNAME = "default"
MAX_BODY_BYTES = 16 * 1024 * 1024
MAX_ENTITIES = 5000
MAX_ENTITY_JSON_BYTES = 1024 * 1024
MAX_READER_PALETTE_JSON_BYTES = 15 * 1024 * 1024
MAX_READER_PALETTE_IMAGE_BYTES = 10 * 1024 * 1024
MAX_READER_PALETTES = 10
MAX_READER_BACKGROUND_ASSET_BYTES = 10 * 1024 * 1024
MAX_READER_BACKGROUND_ASSETS = 10
ASSET_CHUNK_BYTES = 1024 * 1024
ASSET_MIME_TYPES = frozenset(("image/png", "image/jpeg", "image/webp", "image/gif"))
MAX_AI_HISTORY_JSON_BYTES = 4 * 1024 * 1024
MAX_AI_HISTORY_LIVE_ENTRIES = 100
MAX_AI_HISTORY_TOMBSTONES = 200
MAX_USER_ENTITIES = 50_000
MAX_USER_JSON_BYTES = 150 * 1024 * 1024
MAX_USERS = 10_000
MAX_TOKENS_PER_USER = 5
TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000
MAX_CONCURRENT_REQUESTS = 32
MAX_IGNORED_DETAILS = 100
DEFAULT_ACCOUNT_STORAGE_LIMIT_BYTES = 25 * 1024 * 1024
LEGACY_ACCOUNT_STORAGE_LIMIT_BYTES = 100 * 1024 * 1024
MAX_ACCOUNT_DAILY_WRITE_BYTES = 10 * 1024 * 1024
MAX_ACCOUNT_DAILY_ENTITY_WRITES = 3_000
RATE_LIMIT_HMAC_KEY = os.environ.get("RATE_LIMIT_HMAC_KEY", "").encode("utf-8")
SECURITY_ALERT_TO = os.environ.get("SECURITY_ALERT_TO", "").strip()
SECURITY_ALERT_WINDOW_MS = 15 * 60 * 1000
SUPPORTED_ENTITY_KINDS = frozenset((
    "book_state_v2", "reading_progress_v1", "reading_data_v1", "reading_statistics_v1",
    "model_book_tags_v1", "user_book_tags_v1", "book_collections_v1", "booklist_v1", "vocab", "reading_bucket_v2",
    "ai_reader_config_v1", "translation_config_v1", "ai_reader_history_v1", "ai_reader_history_entry_v2", "secret_bundle_v1",
    "reader_palette_v1", "reader_palette_order_v1", "app_settings_v1",
))
# Inventory intentionally excludes private configuration/history entities, but
# must cover every entity type included by the desktop client's all_sync_entities.
INVENTORY_ENTITY_KINDS = frozenset((
    "reading_progress_v1", "reading_data_v1", "reading_statistics_v1",
    "model_book_tags_v1", "user_book_tags_v1", "book_collections_v1", "booklist_v1", "vocab", "reading_bucket_v2",
    "ai_reader_history_entry_v2", "reader_palette_v1", "reader_palette_order_v1", "app_settings_v1",
))
FEEDBACK_TO = os.environ.get("FEEDBACK_TO", "pigking9527@gmail.com").strip()
FEEDBACK_SMTP_HOST = os.environ.get("FEEDBACK_SMTP_HOST", "").strip()
FEEDBACK_SMTP_PORT = int(os.environ.get("FEEDBACK_SMTP_PORT", "465"))
FEEDBACK_SMTP_USER = os.environ.get("FEEDBACK_SMTP_USER", "").strip()
FEEDBACK_SMTP_PASSWORD = os.environ.get("FEEDBACK_SMTP_PASSWORD", "")
FEEDBACK_SMTP_FROM = os.environ.get("FEEDBACK_SMTP_FROM", FEEDBACK_SMTP_USER).strip()
FEEDBACK_SMTP_SSL = os.environ.get("FEEDBACK_SMTP_SSL", "1") != "0"
FEEDBACK_SMTP_STARTTLS = os.environ.get("FEEDBACK_SMTP_STARTTLS", "0") == "1"
ACCOUNT_SMTP_HOST = os.environ.get("ACCOUNT_SMTP_HOST", "").strip()
ACCOUNT_SMTP_PORT = int(os.environ.get("ACCOUNT_SMTP_PORT", "465"))
ACCOUNT_SMTP_USER = os.environ.get("ACCOUNT_SMTP_USER", "").strip()
ACCOUNT_SMTP_PASSWORD = os.environ.get("ACCOUNT_SMTP_PASSWORD", "")
ACCOUNT_SMTP_FROM = os.environ.get("ACCOUNT_SMTP_FROM", ACCOUNT_SMTP_USER).strip()
ACCOUNT_SMTP_SSL = os.environ.get("ACCOUNT_SMTP_SSL", "1") != "0"
ACCOUNT_SMTP_STARTTLS = os.environ.get("ACCOUNT_SMTP_STARTTLS", "0") == "1"
ACCOUNT_CODE_TTL_MS = 15 * 60 * 1000
ACCOUNT_CODE_ATTEMPTS = 8
MAX_FEEDBACK_TEXT_CHARS = 20_000
MAX_FEEDBACK_IMAGES = 3
MAX_FEEDBACK_IMAGE_BYTES = 1024 * 1024
MAX_FEEDBACK_ATTACHMENTS = 1
MAX_FEEDBACK_JSON_BYTES = 256 * 1024
MAX_FEEDBACK_ROWS = 2_000
MAX_UPDATE_NOTES_CHARS = 40_000
# Only these values are recognized as legacy Android Unix epoch seconds.
# Keep test/protocol sentinel values such as 100 unchanged rather than guessing.
LEGACY_ENTITY_EPOCH_SECONDS_MIN = 946_684_800  # 2000-01-01T00:00:00Z
LEGACY_ENTITY_EPOCH_SECONDS_MAX = 4_102_444_800  # 2100-01-01T00:00:00Z


def _clean_update_text(value, limit=MAX_UPDATE_NOTES_CHARS):
    return str(value or "").strip()[:limit]


def load_update_manifest():
    """Read the public release metadata only; a missing/bad file never affects sync."""
    try:
        raw = json.loads(UPDATE_MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return {"schema_version": 1, "latest": "", "releases": {}}
    if not isinstance(raw, dict):
        return {"schema_version": 1, "latest": "", "releases": {}}
    releases = raw.get("releases")
    if not isinstance(releases, dict):
        releases = {}
    cleaned = {}
    for version, item in releases.items():
        version = _clean_update_text(version, 64).lstrip("vV")
        if not version or not isinstance(item, dict):
            continue
        cleaned[version] = {
            "version": version,
            "android_version": _clean_update_text(item.get("android_version"), 64).lstrip("vV"),
            "release_notes": _clean_update_text(item.get("release_notes")),
            "url": _clean_update_text(item.get("url"), 2048),
            "published_at": _clean_update_text(item.get("published_at"), 64),
        }
    latest = _clean_update_text(raw.get("latest"), 64).lstrip("vV")
    if latest not in cleaned:
        latest = ""
    return {"schema_version": 1, "latest": latest, "releases": cleaned}


def public_update_entry(version):
    manifest = load_update_manifest()
    entry = manifest["releases"].get(str(version or "").strip().lstrip("vV"))
    if not entry:
        return None
    return {"ok": True, "schema_version": manifest["schema_version"], **entry}


class RateLimiter:
    """Token buckets backed by SQLite in production and memory in unit tests.

    SQLite's BEGIN IMMEDIATE makes each refill-and-consume operation atomic for
    every API worker using this database.  A deployment with several hosts must
    point every worker at the same central database (or replace this adapter
    with Redis); separate SQLite files cannot coordinate across hosts.
    """

    def __init__(self, max_buckets=8192, stale_after=3600, persistent=False):
        self.max_buckets = max_buckets
        self.stale_after = stale_after
        self.persistent = persistent
        self.buckets = {}
        self.lock = threading.Lock()

    def allow(self, scope, key, capacity, period_seconds):
        if self.persistent:
            return self._allow_persistent(scope, key, capacity, period_seconds)
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

    def _bucket_key(self, scope, key):
        # The database is an audit/rate-control store, not a raw IP log.
        secret = RATE_LIMIT_HMAC_KEY or b"reader-sync-rate-limit-v1"
        text = f"{scope}\0{key}".encode("utf-8", "replace")
        return hmac.new(secret, text, hashlib.sha256).hexdigest()

    def _allow_persistent(self, scope, key, capacity, period_seconds):
        now = now_ms()
        bucket_key = self._bucket_key(scope, key)
        conn = connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT tokens,last_seen_at FROM rate_limit_buckets WHERE scope=? AND bucket_key=?",
                (scope, bucket_key),
            ).fetchone()
            tokens = float(row["tokens"]) if row else float(capacity)
            last_seen = int(row["last_seen_at"]) if row else now
            refill = max(0, now - last_seen) * (float(capacity) / (period_seconds * 1000.0))
            tokens = min(float(capacity), tokens + refill)
            allowed = tokens >= 1.0
            retry_after = 0
            if allowed:
                tokens -= 1.0
            else:
                retry_after = max(1, int((1.0 - tokens) / (float(capacity) / period_seconds)) + 1)
            conn.execute(
                "INSERT INTO rate_limit_buckets(scope,bucket_key,tokens,last_seen_at) VALUES(?,?,?,?) "
                "ON CONFLICT(scope,bucket_key) DO UPDATE SET tokens=excluded.tokens,last_seen_at=excluded.last_seen_at",
                (scope, bucket_key, tokens, now),
            )
            if secrets.randbelow(256) == 0:
                conn.execute("DELETE FROM rate_limit_buckets WHERE last_seen_at<?", (now - self.stale_after * 1000,))
            conn.commit()
            return allowed, retry_after
        except sqlite3.Error:
            conn.rollback()
            # Fail closed when the shared limiter is unavailable.
            return False, 5
        finally:
            conn.close()


RATE_LIMITER = RateLimiter(persistent=True)
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


def hash_one_time_code(code):
    return hashlib.sha256(str(code).encode("utf-8")).hexdigest()


def new_one_time_code():
    return f"{secrets.randbelow(1_000_000):06d}"


def normalize_email(value):
    email = str(value or "").strip().casefold()
    if len(email) > 254 or "@" not in email or email.count("@") != 1:
        return ""
    local, domain = email.rsplit("@", 1)
    if not local or not domain or "." not in domain or any(ch.isspace() for ch in email):
        return ""
    return email


def mask_email(email):
    local, _, domain = str(email or "").partition("@")
    if not local or not domain:
        return ""
    return f"{local[:1]}***@{domain}"


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
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS account_emails (
                user_id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                verified_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS account_codes (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                purpose TEXT NOT NULL,
                email TEXT NOT NULL,
                code_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                used_at INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_account_codes_lookup "
            "ON account_codes(user_id,purpose,email,expires_at)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS secret_bundle_epochs (
                user_id TEXT PRIMARY KEY,
                epoch INTEGER NOT NULL DEFAULT 1,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )
        record_migration(conn, 8)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS account_data_generations (
                user_id TEXT PRIMARY KEY,
                generation INTEGER NOT NULL DEFAULT 1,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )
        record_migration(conn, 9)
        feedback_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(feedback)").fetchall()
        }
        if "attachments_json" not in feedback_columns:
            conn.execute(
                "ALTER TABLE feedback ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'"
            )
        record_migration(conn, 10)
        recovery_pending = conn.execute(
            "SELECT 1 FROM schema_migrations WHERE version=11"
        ).fetchone() is None
        recovery.initialize(conn, seed_existing=recovery_pending, recorded_at=now_ms())
        record_migration(conn, 11)
        user_columns = {row[1] for row in conn.execute("PRAGMA table_info(users)").fetchall()}
        if "sync_verified_at" not in user_columns:
            conn.execute("ALTER TABLE users ADD COLUMN sync_verified_at INTEGER NOT NULL DEFAULT 0")
            conn.execute("UPDATE users SET sync_verified_at=created_at WHERE sync_verified_at=0")
        if "disabled_at" not in user_columns:
            conn.execute("ALTER TABLE users ADD COLUMN disabled_at INTEGER NOT NULL DEFAULT 0")
        if "disabled_reason" not in user_columns:
            conn.execute("ALTER TABLE users ADD COLUMN disabled_reason TEXT NOT NULL DEFAULT ''")
        conn.execute("CREATE TABLE IF NOT EXISTS account_usage (user_id TEXT PRIMARY KEY, storage_limit_bytes INTEGER NOT NULL, daily_window_at INTEGER NOT NULL DEFAULT 0, daily_written_bytes INTEGER NOT NULL DEFAULT 0, daily_entity_writes INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id))")
        conn.execute("INSERT OR IGNORE INTO account_usage(user_id,storage_limit_bytes,updated_at) SELECT id,?,? FROM users", (LEGACY_ACCOUNT_STORAGE_LIMIT_BYTES, now_ms()))
        conn.execute("CREATE TABLE IF NOT EXISTS rate_limit_buckets (scope TEXT NOT NULL, bucket_key TEXT NOT NULL, tokens REAL NOT NULL, last_seen_at INTEGER NOT NULL, PRIMARY KEY(scope,bucket_key))")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_seen ON rate_limit_buckets(last_seen_at)")
        conn.execute("CREATE TABLE IF NOT EXISTS security_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at INTEGER NOT NULL, event TEXT NOT NULL, severity TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', detail_json TEXT NOT NULL DEFAULT '{}')")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_security_audit_time ON security_audit(occurred_at DESC)")
        conn.execute("CREATE TABLE IF NOT EXISTS security_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at INTEGER NOT NULL, event TEXT NOT NULL, severity TEXT NOT NULL, subject TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1, notified_at INTEGER NOT NULL DEFAULT 0, detail_json TEXT NOT NULL DEFAULT '{}')")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_security_alerts_pending ON security_alerts(notified_at,occurred_at)")
        record_migration(conn, 12)
        # Binary reader backgrounds are account assets. They never travel in
        # entity JSON, pull responses, reader URLs, or injected CSS.
        conn.execute("CREATE TABLE IF NOT EXISTS reader_assets (user_id TEXT NOT NULL, asset_id TEXT NOT NULL, sha256 TEXT NOT NULL, mime TEXT NOT NULL, byte_size INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id,asset_id), FOREIGN KEY(user_id) REFERENCES users(id))")
        conn.execute("CREATE TABLE IF NOT EXISTS reader_asset_uploads (user_id TEXT NOT NULL, asset_id TEXT NOT NULL, sha256 TEXT NOT NULL, mime TEXT NOT NULL, total_bytes INTEGER NOT NULL, received_bytes INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id,asset_id), FOREIGN KEY(user_id) REFERENCES users(id))")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_reader_assets_user_created ON reader_assets(user_id,created_at)")
        record_migration(conn, 13)


def next_server_stamp(conn):
    current = now_ms()
    conn.execute(
        "UPDATE sync_clock SET value=CASE WHEN value>=? THEN value+1 ELSE ? END WHERE id=1",
        (current, current),
    )
    return conn.execute("SELECT value FROM sync_clock WHERE id=1").fetchone()[0]


def row_to_user(row):
    return {"id": row["id"], "username": row["username"], "sync_enabled": bool(row["sync_verified_at"]) and not bool(row["disabled_at"])}


def user_by_token(conn, token):
    if not token:
        return None
    cutoff = now_ms() - TOKEN_TTL_MS
    conn.execute("DELETE FROM tokens WHERE created_at<?", (cutoff,))
    row = conn.execute(
        """
        SELECT users.id,users.username,users.sync_verified_at,users.disabled_at,users.disabled_reason FROM tokens
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
        # Existing server databases are deliberately not rewritten in this
        # rollout.  Normalize legacy rows at the API boundary instead.
        "updated_at": normalize_entity_epoch_ms(row["updated_at"]),
        "deleted_at": normalize_entity_epoch_ms(row["deleted_at"]),
        "device_id": row["device_id"],
        "sync_version": row["sync_version"],
        "server_updated_at": row["server_updated_at"],
    }


def inventory_rows(conn, user_id):
    placeholders = ",".join("?" for _ in INVENTORY_ENTITY_KINDS)
    return conn.execute(
        f"""
        SELECT kind,id,json,updated_at,deleted_at,device_id,sync_version,server_updated_at
        FROM entities
        WHERE user_id=? AND kind IN ({placeholders})
        ORDER BY kind,id
        """,
        (user_id, *sorted(INVENTORY_ENTITY_KINDS)),
    ).fetchall()


def utc_day_window(now=None):
    current = int(now or now_ms())
    return current - (current % (24 * 60 * 60 * 1000))


def ensure_account_usage(conn, user_id, legacy=False):
    limit = LEGACY_ACCOUNT_STORAGE_LIMIT_BYTES if legacy else DEFAULT_ACCOUNT_STORAGE_LIMIT_BYTES
    conn.execute(
        "INSERT OR IGNORE INTO account_usage(user_id,storage_limit_bytes,updated_at) VALUES(?,?,?)",
        (user_id, limit, now_ms()),
    )
    return conn.execute("SELECT * FROM account_usage WHERE user_id=?", (user_id,)).fetchone()


def account_storage_bytes(conn, user_id):
    active = conn.execute(
        "SELECT COALESCE(SUM(LENGTH(json)),0) FROM entities WHERE user_id=?", (user_id,)
    ).fetchone()[0]
    history = conn.execute(
        "SELECT COALESCE(SUM(LENGTH(payload_zlib)),0) FROM entity_history WHERE user_id=?", (user_id,)
    ).fetchone()[0]
    assets = conn.execute(
        "SELECT COALESCE(SUM(byte_size),0) FROM reader_assets WHERE user_id=?", (user_id,)
    ).fetchone()[0] if table_exists(conn, "reader_assets") else 0
    return int(active or 0) + int(history or 0) + int(assets or 0)


def asset_file(user_id, asset_id, partial=False):
    suffix = ".part" if partial else ""
    return ASSET_DIR / user_id / f"{asset_id}{suffix}"


def valid_asset_id(value):
    return isinstance(value, str) and len(value) == 64 and all(ch in "0123456789abcdef" for ch in value.lower())


def remove_user_assets(conn, user_id):
    rows = conn.execute("SELECT asset_id FROM reader_assets WHERE user_id=?", (user_id,)).fetchall()
    uploads = conn.execute("SELECT asset_id FROM reader_asset_uploads WHERE user_id=?", (user_id,)).fetchall()
    for row in [*rows, *uploads]:
        for partial in (False, True):
            try:
                asset_file(user_id, row["asset_id"], partial).unlink(missing_ok=True)
            except OSError:
                pass
    conn.execute("DELETE FROM reader_assets WHERE user_id=?", (user_id,))
    conn.execute("DELETE FROM reader_asset_uploads WHERE user_id=?", (user_id,))


def garbage_collect_unreferenced_assets(conn, user_id):
    """Remove binary assets no current palette or retained recovery revision references."""
    referenced = set()
    rows = conn.execute(
        "SELECT json FROM entities WHERE user_id=? AND kind=?",
        (user_id, "reader_palette_v1"),
    ).fetchall()
    history_rows = conn.execute(
        "SELECT payload_zlib,payload_bytes,payload_sha256 FROM entity_history WHERE user_id=? AND kind=?",
        (user_id, "reader_palette_v1"),
    ).fetchall()
    for row in [*rows, *history_rows]:
        try:
            text = row["json"] if "json" in row.keys() else recovery.decode_payload(row)
            payload = json.loads(text)
            asset_id = str(payload.get("backgroundAssetId", "") or "").lower()
            if valid_asset_id(asset_id):
                referenced.add(asset_id)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError, zlib.error):
            # A corrupt retained revision is handled by recovery; never use it
            # as a reason to delete a potentially still-needed asset.
            return []
    candidates = conn.execute(
        "SELECT asset_id FROM reader_assets WHERE user_id=?",
        (user_id,),
    ).fetchall()
    removed = [str(row["asset_id"]) for row in candidates if str(row["asset_id"]) not in referenced]
    if removed:
        conn.executemany(
            "DELETE FROM reader_assets WHERE user_id=? AND asset_id=?",
            [(user_id, asset_id) for asset_id in removed],
        )
    return removed


def delete_asset_files(user_id, asset_ids):
    for asset_id in asset_ids:
        for partial in (False, True):
            try:
                asset_file(user_id, asset_id, partial).unlink(missing_ok=True)
            except OSError:
                pass


def refresh_daily_usage(conn, user_id, current_at=None):
    current_at = int(current_at or now_ms())
    usage = ensure_account_usage(conn, user_id)
    window = utc_day_window(current_at)
    if int(usage["daily_window_at"]) != window:
        conn.execute(
            "UPDATE account_usage SET daily_window_at=?,daily_written_bytes=0,daily_entity_writes=0,updated_at=? WHERE user_id=?",
            (window, current_at, user_id),
        )
        usage = conn.execute("SELECT * FROM account_usage WHERE user_id=?", (user_id,)).fetchone()
    return usage


def account_usage_summary(conn, user_id):
    """Return only the caller's aggregate quota counters, never entity details."""
    usage = refresh_daily_usage(conn, user_id)
    storage_bytes = account_storage_bytes(conn, user_id)
    daily_written_bytes = int(usage["daily_written_bytes"])
    daily_entity_writes = int(usage["daily_entity_writes"])
    daily_window_at = int(usage["daily_window_at"])
    return {
        "ok": True,
        "schema_version": 3,
        "storageBytes": storage_bytes,
        "storageLimitBytes": int(usage["storage_limit_bytes"]),
        "dailyWrittenBytes": daily_written_bytes,
        "dailyWriteLimitBytes": MAX_ACCOUNT_DAILY_WRITE_BYTES,
        "dailyEntityWrites": daily_entity_writes,
        "dailyEntityWriteLimit": MAX_ACCOUNT_DAILY_ENTITY_WRITES,
        "dailyWindowAt": daily_window_at,
        "dailyResetAt": daily_window_at + 24 * 60 * 60 * 1000,
    }


def security_subject(value):
    secret = RATE_LIMIT_HMAC_KEY or b"reader-sync-audit-v1"
    return hmac.new(secret, str(value).encode("utf-8", "replace"), hashlib.sha256).hexdigest()[:24]


def audit_security(conn, event, severity="info", user_id="", subject="", detail=None):
    occurred_at = now_ms()
    detail_json = json.dumps(detail or {}, ensure_ascii=False, separators=(",", ":"))[:2048]
    conn.execute(
        "INSERT INTO security_audit(occurred_at,event,severity,user_id,subject,detail_json) VALUES(?,?,?,?,?,?)",
        (occurred_at, str(event)[:96], str(severity)[:16], str(user_id)[:64], str(subject)[:96], detail_json),
    )
    if severity in ("warning", "critical"):
        conn.execute(
            "INSERT INTO security_alerts(occurred_at,event,severity,subject,detail_json) VALUES(?,?,?,?,?)",
            (occurred_at, str(event)[:96], str(severity)[:16], str(subject)[:96], detail_json),
        )

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
        digest.update(int(row["sync_version"]).to_bytes(8, "big", signed=True))
        for field in ("updated_at", "deleted_at"):
            digest.update(
                normalize_entity_epoch_ms(row[field]).to_bytes(8, "big", signed=True)
            )
        revision = max(revision, safe_int(row["server_updated_at"]))
    return {
        "entity_count": len(rows),
        "inventory_digest": digest.hexdigest(),
        "revision": str(revision),
    }


def manifest_meta_equal(left, right):
    return (
        str(left["device_id"] or "") == str(right["device_id"] or "")
        and safe_int(left["sync_version"]) == safe_int(right["sync_version"])
        and normalize_entity_epoch_ms(left["updated_at"])
        == normalize_entity_epoch_ms(right["updated_at"])
        and normalize_entity_epoch_ms(left["deleted_at"])
        == normalize_entity_epoch_ms(right["deleted_at"])
    )


def safe_int(value, default=0):
    try:
        return int(value or default)
    except (TypeError, ValueError):
        return default


def normalize_entity_epoch_ms(value):
    """Normalize only realistic legacy epoch-seconds entity metadata to ms."""
    stamp = safe_int(value)
    if LEGACY_ENTITY_EPOCH_SECONDS_MIN <= stamp <= LEGACY_ENTITY_EPOCH_SECONDS_MAX:
        return stamp * 1000
    return stamp


def is_newer(incoming, existing):
    if existing is None:
        return True
    incoming_updated = normalize_entity_epoch_ms(incoming.get("updated_at"))
    incoming_version = safe_int(incoming.get("sync_version"))
    existing_updated = normalize_entity_epoch_ms(existing["updated_at"])
    if incoming_updated > existing_updated:
        return True
    if incoming_updated == existing_updated:
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


def ai_history_retention_is_valid(payload):
    if not isinstance(payload, dict): return False
    entries = payload.get("entries", [])
    if not isinstance(entries, list): return False
    live = sum(1 for entry in entries if isinstance(entry, dict) and not (entry.get("deletedAt") or entry.get("deleted_at")))
    tombstones = sum(1 for entry in entries if isinstance(entry, dict) and (entry.get("deletedAt") or entry.get("deleted_at")))
    return len(entries) == live + tombstones and live <= MAX_AI_HISTORY_LIVE_ENTRIES and tombstones <= MAX_AI_HISTORY_TOMBSTONES

def ai_history_entry_scope(entity_id, payload):
    if not isinstance(payload, dict) or payload.get("version") != 2:
        return None
    scope = payload.get("scope")
    entry = payload.get("entry")
    if scope not in ("reader", "library") or not isinstance(entry, dict):
        return None
    entry_id = entry.get("id")
    if not isinstance(entry_id, str) or not entry_id or len(entry_id) > 160:
        return None
    if scope == "reader":
        content_id = payload.get("contentId")
        if not isinstance(content_id, str) or len(content_id) != 64 or any(ch not in "0123456789abcdefABCDEF" for ch in content_id):
            return None
        if entity_id != f"reader:{content_id}:{entry_id}":
            return None
    elif entity_id != f"library:{entry_id}":
        return None
    # These payloads are sync projections. Never let a client smuggle book
    # excerpts, machine-local IDs or paths through an otherwise valid entry.
    forbidden_entry_fields = {"bookId", "book_id", "path", "filePath", "excerpt"}
    if forbidden_entry_fields.intersection(entry):
        return None
    sources = entry.get("sources", [])
    if not isinstance(sources, list) or len(sources) > 20:
        return None
    forbidden_source_fields = {"excerpt", "bookId", "book_id", "path", "filePath", "text", "content"}
    if any(not isinstance(source, dict) or forbidden_source_fields.intersection(source) for source in sources):
        return None
    return scope

def history_entry_live_count(conn, user_id, scope, excluding_id=None):
    prefix = "reader:%" if scope == "reader" else "library:%"
    sql = "SELECT COUNT(*) FROM entities WHERE user_id=? AND kind='ai_reader_history_entry_v2' AND deleted_at=0 AND id LIKE ?"
    values = [user_id, prefix]
    if excluding_id:
        sql += " AND id<>?"
        values.append(excluding_id)
    return int(conn.execute(sql, values).fetchone()[0])

def prune_history_entry_tombstones(conn, user_id, scope, keep):
    prefix = "reader:%" if scope == "reader" else "library:%"
    rows = conn.execute(
        "SELECT id FROM entities WHERE user_id=? AND kind='ai_reader_history_entry_v2' AND deleted_at<>0 AND id LIKE ? ORDER BY deleted_at DESC, server_updated_at DESC",
        (user_id, prefix),
    ).fetchall()
    for row in rows[keep:]:
        conn.execute(
            "DELETE FROM entities WHERE user_id=? AND kind='ai_reader_history_entry_v2' AND id=?",
            (user_id, row["id"]),
        )
def reader_palette_payload_is_valid(kind, payload):
    if not isinstance(payload, dict):
        return False
    if kind == "reader_palette_order_v1":
        order = payload.get("order", [])
        return (payload.get("version") == 1 and isinstance(order, list)
                and len(order) <= 13 and all(isinstance(item, str) and 0 < len(item) <= 80 for item in order)
                and len(set(order)) == len(order))
    required = ("id", "name", "background", "text", "link", "selection", "footnote", "border", "theme")
    if payload.get("version") != 1 or any(not isinstance(payload.get(key), str) or not payload.get(key) for key in required):
        return False
    if not str(payload["id"]).startswith("custom-") or len(str(payload["id"])) > 80 or len(str(payload["name"])) > 96:
        return False
    if payload["theme"] not in ("light", "dark", "sepia"):
        return False
    colors = ("background", "text", "link", "selection", "footnote", "border")
    if any(len(payload[key]) not in (4, 7) or not payload[key].startswith("#") or any(ch not in "0123456789abcdefABCDEF" for ch in payload[key][1:]) for key in colors):
        return False
    # v1 compatibility: legacy clients may still send a data URL. New clients
    # write only the immutable binary asset reference below.
    image = payload.get("backgroundImage", "")
    if not isinstance(image, str) or len(image) > MAX_READER_PALETTE_JSON_BYTES:
        return False
    if image:
        header, separator, encoded = image.partition(",")
        if not separator or header not in ("data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64", "data:image/gif;base64"):
            return False
        try:
            if len(base64.b64decode(encoded, validate=True)) > MAX_READER_PALETTE_IMAGE_BYTES:
                return False
        except (ValueError, TypeError):
            return False
    asset_id = payload.get("backgroundAssetId", "")
    if not asset_id:
        return True
    return (valid_asset_id(asset_id)
            and payload.get("backgroundAssetSha256") == asset_id
            and payload.get("backgroundAssetMime") in ASSET_MIME_TYPES
            and isinstance(payload.get("backgroundAssetBytes"), int)
            and 0 < payload["backgroundAssetBytes"] <= MAX_READER_BACKGROUND_ASSET_BYTES)

def app_settings_payload_is_valid(payload):
    if not isinstance(payload, dict) or type(payload.get("version")) is not int or payload.get("version") != 1:
        return False
    if not isinstance(payload.get("showReaderJumpBack"), bool):
        return False
    if payload.get("readerJumpBackDismissMode") not in ("pages", "time"):
        return False
    limits = (
        ("readerJumpBackDismissSeconds", 1, 600),
        ("readerJumpBackDismissPages", 1, 100),
        ("readerJumpBackSizeLevel", 1, 10),
    )
    if not all(type(payload.get(key)) is int and low <= payload[key] <= high for key, low, high in limits):
        return False
    if "readerJumpBackIconSizePx" in payload and (
        type(payload["readerJumpBackIconSizePx"]) is not int or not 30 <= payload["readerJumpBackIconSizePx"] <= 160
    ):
        return False

    def unique_text_list(value, maximum, text_limit):
        return (isinstance(value, list)
                and len(value) <= maximum
                and len(set(value)) == len(value)
                and all(isinstance(item, str) and 0 < len(item) <= text_limit
                        and not any(ord(char) < 32 or ord(char) == 127 for char in item)
                        for item in value))

    news_keys = ("newsSourceIds", "newsTiebaBars", "newsEnabledTiebaBars")
    if any(key in payload for key in news_keys):
        if not all(key in payload for key in news_keys):
            return False
        if not unique_text_list(payload["newsSourceIds"], 24, 64) or not payload["newsSourceIds"]:
            return False
        if not unique_text_list(payload["newsTiebaBars"], 8, 48):
            return False
        if not unique_text_list(payload["newsEnabledTiebaBars"], 8, 48):
            return False
        if not set(payload["newsEnabledTiebaBars"]).issubset(payload["newsTiebaBars"]):
            return False

    if "libraryAnswerLength" in payload and payload["libraryAnswerLength"] not in ("short", "medium", "long"):
        return False
    if "libraryHistorySyncMode" in payload and payload["libraryHistorySyncMode"] not in ("off", "recent", "manual"):
        return False
    if "libraryAnswerFontSize" in payload and (type(payload["libraryAnswerFontSize"]) is not int or not 14 <= payload["libraryAnswerFontSize"] <= 22):
        return False
    if "libraryLongContextEnabled" in payload and type(payload["libraryLongContextEnabled"]) is not bool:
        return False
    toolbar_item_ids = {"account", "search", "stats", "library", "news", "filter", "settings", "menu"}
    legacy_toolbar_item_ids = toolbar_item_ids - {"account"}
    if "toolbarIconSizePx" in payload and (
        type(payload["toolbarIconSizePx"]) is not int or not 28 <= payload["toolbarIconSizePx"] <= 52
    ):
        return False
    if "toolbarItemOrder" in payload:
        order = payload["toolbarItemOrder"]
        if not (isinstance(order, list) and len(order) in (len(legacy_toolbar_item_ids), len(toolbar_item_ids))
                and all(isinstance(item, str) for item in order)
                and len(set(order)) == len(order) and set(order) in (legacy_toolbar_item_ids, toolbar_item_ids)):
            return False
    if "toolbarHiddenItems" in payload:
        hidden = payload["toolbarHiddenItems"]
        if not (isinstance(hidden, list) and len(hidden) < len(toolbar_item_ids)
                and all(isinstance(item, str) for item in hidden)
                and len(set(hidden)) == len(hidden)
                and set(hidden).issubset(toolbar_item_ids - {"settings"})):
            return False
    return True


def record_ignored(details, detail):
    if len(details) < MAX_IGNORED_DETAILS:
        details.append(detail)


def feedback_mail_configured():
    return bool(FEEDBACK_TO and FEEDBACK_SMTP_HOST and FEEDBACK_SMTP_FROM)


def account_mail_configured():
    # Security mail intentionally does not inherit feedback's SMTP variables.
    # A feedback relay is not proof that the account-recovery channel is ready.
    return bool(ACCOUNT_SMTP_HOST and ACCOUNT_SMTP_FROM)


def send_account_email(recipient, subject, text):
    if not account_mail_configured():
        raise RuntimeError("ACCOUNT_EMAIL_NOT_CONFIGURED")
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = ACCOUNT_SMTP_FROM
    message["To"] = recipient
    message.set_content(text)
    smtp_cls = smtplib.SMTP_SSL if ACCOUNT_SMTP_SSL else smtplib.SMTP
    with smtp_cls(ACCOUNT_SMTP_HOST, ACCOUNT_SMTP_PORT, timeout=20) as smtp:
        if not ACCOUNT_SMTP_SSL and ACCOUNT_SMTP_STARTTLS:
            smtp.starttls()
        if ACCOUNT_SMTP_USER:
            smtp.login(ACCOUNT_SMTP_USER, ACCOUNT_SMTP_PASSWORD)
        smtp.send_message(message)


def issue_account_code(conn, user_id, purpose, email):
    now = now_ms()
    code = new_one_time_code()
    with conn:
        conn.execute(
            "DELETE FROM account_codes WHERE user_id=? AND purpose=? AND email=?",
            (user_id, purpose, email),
        )
        conn.execute(
            """
            INSERT INTO account_codes(
                id,user_id,purpose,email,code_hash,created_at,expires_at
            ) VALUES(?,?,?,?,?,?,?)
            """,
            (
                str(uuid.uuid4()), user_id, purpose, email, hash_one_time_code(code), now,
                now + ACCOUNT_CODE_TTL_MS,
            ),
        )
    return code


def consume_account_code(conn, user_id, purpose, email, code):
    row = conn.execute(
        """
        SELECT id,code_hash,expires_at,attempts,used_at FROM account_codes
        WHERE user_id=? AND purpose=? AND email=?
        ORDER BY created_at DESC LIMIT 1
        """,
        (user_id, purpose, email),
    ).fetchone()
    if not row or row["used_at"] or row["expires_at"] < now_ms():
        return False
    if row["attempts"] >= ACCOUNT_CODE_ATTEMPTS:
        return False
    if not hmac.compare_digest(row["code_hash"], hash_one_time_code(code)):
        with conn:
            conn.execute("UPDATE account_codes SET attempts=attempts+1 WHERE id=?", (row["id"],))
        return False
    with conn:
        conn.execute("UPDATE account_codes SET used_at=? WHERE id=?", (now_ms(), row["id"]))
    return True


def secret_bundle_epoch(conn, user_id):
    row = conn.execute(
        "SELECT epoch FROM secret_bundle_epochs WHERE user_id=?", (user_id,)
    ).fetchone()
    if row:
        return int(row["epoch"])
    with conn:
        conn.execute(
            "INSERT OR IGNORE INTO secret_bundle_epochs(user_id,epoch,updated_at) VALUES(?,?,?)",
            (user_id, 1, now_ms()),
        )
    return 1


def reset_secret_bundle_epoch(conn, user_id):
    current = secret_bundle_epoch(conn, user_id)
    next_epoch = current + 1
    now = now_ms()
    with conn:
        conn.execute(
            "UPDATE secret_bundle_epochs SET epoch=?,updated_at=? WHERE user_id=?",
            (next_epoch, now, user_id),
        )
        existing = conn.execute(
            "SELECT sync_version FROM entities WHERE user_id=? AND kind='secret_bundle_v1' AND id='default'",
            (user_id,),
        ).fetchone()
        version = int(existing["sync_version"]) + 1 if existing else 1
        stamp = next_server_stamp(conn)
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
            (user_id, "secret_bundle_v1", "default", "{}", now, now,
             "server-secret-reset", version, stamp),
        )
    return next_epoch


def account_data_generation(conn, user_id):
    row = conn.execute(
        "SELECT generation FROM account_data_generations WHERE user_id=?", (user_id,)
    ).fetchone()
    return max(1, safe_int(row["generation"] if row else 1, 1))


def request_data_generation(body):
    if not isinstance(body, dict):
        return 1
    value = body.get("data_generation", body.get("dataGeneration", 1))
    return max(1, safe_int(value, 1))


def reset_account_sync_data(conn, user_id):
    generation = account_data_generation(conn, user_id) + 1
    with conn:
        conn.execute("DELETE FROM entity_history WHERE user_id=?", (user_id,))
        conn.execute("DELETE FROM recovery_accounts WHERE user_id=?", (user_id,))
        conn.execute("DELETE FROM entities WHERE user_id=?", (user_id,))
        remove_user_assets(conn, user_id)
        conn.execute("DELETE FROM secret_bundle_epochs WHERE user_id=?", (user_id,))
        conn.execute("UPDATE account_usage SET daily_written_bytes=0,daily_entity_writes=0,updated_at=? WHERE user_id=?", (now_ms(), user_id))
        audit_security(conn, "sync_data_reset", "info", user_id)
        conn.execute(
            "INSERT INTO account_data_generations(user_id,generation,updated_at) VALUES(?,?,?) "
            "ON CONFLICT(user_id) DO UPDATE SET generation=excluded.generation,updated_at=excluded.updated_at",
            (user_id, generation, now_ms()),
        )
        conn.execute("DELETE FROM tokens WHERE user_id=?", (user_id,))
    return generation


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


def decode_feedback_attachment(item):
    if not isinstance(item, dict):
        raise ValueError("INVALID_FEEDBACK_ATTACHMENT")
    name = str(item.get("name", "") or "feedback.json")[:160]
    mime = str(item.get("mime", "") or "")
    if mime != "application/json" or not name.lower().endswith(".json"):
        raise ValueError("INVALID_FEEDBACK_ATTACHMENT_TYPE")
    try:
        raw = base64.b64decode(str(item.get("data", "") or ""), validate=True)
    except (ValueError, TypeError):
        raise ValueError("INVALID_FEEDBACK_ATTACHMENT_DATA") from None
    if not raw or len(raw) > MAX_FEEDBACK_JSON_BYTES:
        raise ValueError("FEEDBACK_ATTACHMENT_TOO_LARGE")
    try:
        json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("INVALID_FEEDBACK_ATTACHMENT_DATA") from None
    return {"name": name, "mime": mime, "data": str(item.get("data", "") or "")}, raw


def normalize_feedback(body):
    if not isinstance(body, dict):
        raise ValueError("INVALID_FEEDBACK")
    kind = str(body.get("kind", "") or "")
    if kind not in ("bug", "feature"):
        raise ValueError("INVALID_FEEDBACK_KIND")
    text = str(body.get("text", "") or "").strip()
    images = body.get("images", [])
    attachments = body.get("attachments", [])
    if not isinstance(images, list) or len(images) > MAX_FEEDBACK_IMAGES:
        raise ValueError("TOO_MANY_FEEDBACK_IMAGES")
    if not isinstance(attachments, list) or len(attachments) > MAX_FEEDBACK_ATTACHMENTS:
        raise ValueError("TOO_MANY_FEEDBACK_ATTACHMENTS")
    if kind != "bug" and attachments:
        raise ValueError("FEEDBACK_ATTACHMENTS_REQUIRE_BUG")
    if not text and not images and not attachments:
        raise ValueError("EMPTY_FEEDBACK")
    if len(text) > MAX_FEEDBACK_TEXT_CHARS:
        raise ValueError("FEEDBACK_TEXT_TOO_LONG")
    normalized_images = []
    for item in images:
        normalized, _ = decode_feedback_image(item)
        normalized_images.append(normalized)
    normalized_attachments = []
    for item in attachments:
        normalized, _ = decode_feedback_attachment(item)
        normalized_attachments.append(normalized)
    return {
        "kind": kind,
        "text": text,
        "images": normalized_images,
        "attachments": normalized_attachments,
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
                feedback.get("text", "") or "（仅提交了附件）",
            )
        )
    )
    for item in feedback.get("images", []):
        _, raw = decode_feedback_image(item)
        subtype = item["mime"].split("/", 1)[1]
        message.add_attachment(raw, maintype="image", subtype=subtype, filename=item["name"])
    for item in feedback.get("attachments", []):
        _, raw = decode_feedback_attachment(item)
        message.add_attachment(raw, maintype="application", subtype="json", filename=item["name"])
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
        "attachments": json.loads(row["attachments_json"]),
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
    server_version = "ReaderSyncAPI/0.9"

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
            if bool(user["disabled_at"]):
                with conn:
                    audit_security(conn, "disabled_account_access", "warning", user["id"], security_subject(self.client_ip()))
                conn.close()
                self.send_error_code(403, "ACCOUNT_DISABLED", "账号已被限制，请联系支持")
                return None, None
            return conn, user
        conn.close()
        self.send_error_code(401, "UNAUTHORIZED")
        return None, None

    def require_sync_user(self):
        conn, user = self.require_user()
        if not user:
            return None, None
        if not bool(user["sync_verified_at"]):
            with conn:
                audit_security(conn, "sync_before_email_verification", "info", user["id"], security_subject(self.client_ip()))
            conn.close()
            self.send_error_code(403, "EMAIL_VERIFICATION_REQUIRED", "请先在账户安全中绑定并验证邮箱后再同步")
            return None, None
        return conn, user

    def send_bytes(self, status, payload, mime, extra_headers=None):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(len(payload)))
        for name, value in (extra_headers or {}).items():
            self.send_header(name, str(value))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def read_binary(self, maximum):
        length = safe_int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > maximum:
            raise PayloadTooLarge()
        return self.rfile.read(length)

    def asset_generation_is_current(self, conn, user_id):
        requested = max(1, safe_int(self.headers.get("X-Data-Generation", "1"), 1))
        return requested == account_data_generation(conn, user_id)

    def handle_asset_get(self, asset_id):
        conn, user = self.require_sync_user()
        if not user:
            return
        if not self.allow_rate("asset_download_user", user["id"], 60, 60):
            conn.close()
            return
        row = conn.execute("SELECT mime,byte_size FROM reader_assets WHERE user_id=? AND asset_id=?", (user["id"], asset_id)).fetchone()
        path = asset_file(user["id"], asset_id)
        if not row or not path.is_file():
            conn.close()
            self.send_error_code(404, "ASSET_NOT_FOUND")
            return
        total = int(row["byte_size"])
        start, end = 0, total - 1
        raw_range = self.headers.get("Range", "")
        if raw_range.startswith("bytes="):
            try:
                left, right = raw_range[6:].split("-", 1)
                start = int(left) if left else max(0, total - int(right))
                end = int(right) if right else total - 1
                if start < 0 or start >= total or end < start:
                    raise ValueError()
                end = min(end, total - 1)
            except ValueError:
                conn.close()
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{total}")
                self.end_headers()
                return
        with path.open("rb") as handle:
            handle.seek(start)
            payload = handle.read(end - start + 1)
        conn.close()
        headers = {"Content-Range": f"bytes {start}-{end}/{total}"} if raw_range else None
        self.send_bytes(206 if raw_range else 200, payload, row["mime"], headers)

    def handle_asset_init(self):
        conn, user = self.require_sync_user()
        if not user:
            return
        if not self.allow_rate("asset_upload_user", user["id"], 30, 60):
            conn.close()
            return
        try:
            body = self.read_json()
        except (PayloadTooLarge, json.JSONDecodeError, UnicodeDecodeError):
            conn.close()
            self.send_error_code(400, "INVALID_ASSET_INIT")
            return
        asset_id = str(body.get("asset_id", body.get("assetId", ""))).lower()
        sha256 = str(body.get("sha256", "")).lower()
        mime = str(body.get("mime", ""))
        size = safe_int(body.get("byte_size", body.get("byteSize", 0)))
        if not valid_asset_id(asset_id) or asset_id != sha256 or mime not in ASSET_MIME_TYPES or size <= 0 or size > MAX_READER_BACKGROUND_ASSET_BYTES:
            conn.close()
            self.send_error_code(400, "INVALID_ASSET_METADATA")
            return
        if request_data_generation(body) != account_data_generation(conn, user["id"]):
            conn.close()
            self.send_error_code(409, "DATA_GENERATION_MISMATCH")
            return
        existing = conn.execute("SELECT byte_size,mime FROM reader_assets WHERE user_id=? AND asset_id=?", (user["id"], asset_id)).fetchone()
        if existing:
            conn.close()
            self.send_json(200, {"ok": True, "complete": True, "assetId": asset_id, "byteSize": int(existing["byte_size"]), "mime": existing["mime"]})
            return
        usage = refresh_daily_usage(conn, user["id"])
        asset_count = conn.execute("SELECT COUNT(*) FROM reader_assets WHERE user_id=?", (user["id"],)).fetchone()[0]
        if asset_count >= MAX_READER_BACKGROUND_ASSETS or account_storage_bytes(conn, user["id"]) + size > int(usage["storage_limit_bytes"]) or int(usage["daily_written_bytes"]) + size > MAX_ACCOUNT_DAILY_WRITE_BYTES:
            conn.close()
            self.send_error_code(409, "QUOTA_EXCEEDED")
            return
        upload = conn.execute("SELECT received_bytes,total_bytes,mime,sha256 FROM reader_asset_uploads WHERE user_id=? AND asset_id=?", (user["id"], asset_id)).fetchone()
        if not upload or int(upload["total_bytes"]) != size or upload["mime"] != mime or upload["sha256"] != sha256:
            asset_file(user["id"], asset_id, True).unlink(missing_ok=True)
            with conn:
                conn.execute("INSERT INTO reader_asset_uploads(user_id,asset_id,sha256,mime,total_bytes,received_bytes,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,asset_id) DO UPDATE SET sha256=excluded.sha256,mime=excluded.mime,total_bytes=excluded.total_bytes,received_bytes=0,updated_at=excluded.updated_at", (user["id"], asset_id, sha256, mime, size, 0, now_ms()))
            received = 0
        else:
            received = int(upload["received_bytes"])
        conn.close()
        self.send_json(200, {"ok": True, "complete": False, "assetId": asset_id, "receivedBytes": received, "chunkBytes": ASSET_CHUNK_BYTES})

    def handle_asset_put(self, asset_id):
        conn, user = self.require_sync_user()
        if not user:
            return
        if not self.allow_rate("asset_upload_user", user["id"], 30, 60):
            conn.close()
            return
        upload = conn.execute("SELECT * FROM reader_asset_uploads WHERE user_id=? AND asset_id=?", (user["id"], asset_id)).fetchone()
        if not upload or not self.asset_generation_is_current(conn, user["id"]):
            conn.close()
            self.send_error_code(409, "ASSET_UPLOAD_NOT_INITIALIZED")
            return
        try:
            content_range = self.headers.get("Content-Range", "")
            prefix, total_text = content_range.split("/", 1)
            _, positions = prefix.split(" ", 1)
            start_text, end_text = positions.split("-", 1)
            start, end, total = int(start_text), int(end_text), int(total_text)
            chunk = self.read_binary(ASSET_CHUNK_BYTES)
        except (ValueError, PayloadTooLarge):
            conn.close()
            self.send_error_code(400, "INVALID_CONTENT_RANGE")
            return
        expected = int(upload["received_bytes"])
        if total != int(upload["total_bytes"]) or start != expected or end != start + len(chunk) - 1 or end >= total:
            conn.close()
            self.send_error_code(409, "ASSET_OFFSET_MISMATCH", retry_after=1)
            return
        partial = asset_file(user["id"], asset_id, True)
        partial.parent.mkdir(parents=True, exist_ok=True)
        with partial.open("ab") as handle:
            handle.write(chunk)
        received = end + 1
        if received < total:
            with conn:
                conn.execute("UPDATE reader_asset_uploads SET received_bytes=?,updated_at=? WHERE user_id=? AND asset_id=?", (received, now_ms(), user["id"], asset_id))
            conn.close()
            self.send_json(200, {"ok": True, "complete": False, "receivedBytes": received})
            return
        digest = hashlib.sha256(partial.read_bytes()).hexdigest()
        if digest != upload["sha256"]:
            partial.unlink(missing_ok=True)
            with conn:
                conn.execute("DELETE FROM reader_asset_uploads WHERE user_id=? AND asset_id=?", (user["id"], asset_id))
            conn.close()
            self.send_error_code(400, "ASSET_HASH_MISMATCH")
            return
        final = asset_file(user["id"], asset_id)
        final.parent.mkdir(parents=True, exist_ok=True)
        partial.replace(final)
        with conn:
            conn.execute("INSERT INTO reader_assets(user_id,asset_id,sha256,mime,byte_size,created_at) VALUES(?,?,?,?,?,?)", (user["id"], asset_id, digest, upload["mime"], total, now_ms()))
            conn.execute("DELETE FROM reader_asset_uploads WHERE user_id=? AND asset_id=?", (user["id"], asset_id))
            conn.execute("UPDATE account_usage SET daily_written_bytes=daily_written_bytes+?,updated_at=? WHERE user_id=?", (total, now_ms(), user["id"]))
        conn.close()
        self.send_json(200, {"ok": True, "complete": True, "assetId": asset_id, "sha256": digest, "byteSize": total})

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
                        "api_version": "0.9",
                        "server_time": now_ms(),
                        "service": "reader-sync",
                    },
                )
                return
            if parsed.path == "/updates/latest":
                if not self.allow_rate("updates_ip", self.client_ip(), 60, 60):
                    return
                entry = public_update_entry(load_update_manifest()["latest"])
                if not entry:
                    self.send_error_code(503, "UPDATE_MANIFEST_UNAVAILABLE")
                    return
                self.send_json(200, entry)
                return
            if parsed.path == "/updates/notes":
                if not self.allow_rate("updates_ip", self.client_ip(), 60, 60):
                    return
                tag = (parse_qs(parsed.query).get("tag") or [""])[0]
                entry = public_update_entry(tag)
                if not entry:
                    self.send_error_code(404, "RELEASE_NOT_FOUND")
                    return
                self.send_json(200, entry)
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
                        "data_generation": account_data_generation(conn, user["id"]),
                    },
                )
                conn.close()
                return
            if parsed.path == "/auth/security":
                self.handle_auth_security()
                return
            if parsed.path == "/auth/usage":
                self.handle_auth_usage()
                return
            if parsed.path == "/sync/pull":
                self.handle_pull(parsed)
                return
            if parsed.path == "/sync/inventory":
                self.handle_inventory()
                return
            if parsed.path == "/sync/secret-state":
                self.handle_secret_state()
                return
            if parsed.path == "/sync/recovery/status":
                self.handle_recovery_status()
                return
            if parsed.path.startswith("/sync/assets/"):
                asset_id = parsed.path.rsplit("/", 1)[-1].lower()
                if valid_asset_id(asset_id):
                    self.handle_asset_get(asset_id)
                    return
            self.send_error_code(404, "NOT_FOUND")
        finally:
            REQUEST_SLOTS.release()

    def handle_pull(self, parsed):
        conn, user = self.require_sync_user()
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
            ORDER BY server_updated_at ASC LIMIT ?
            """,
            (user["id"], cursor, limit),
        ).fetchall()
        next_cursor = rows[-1]["server_updated_at"] if rows else cursor
        has_more = conn.execute(
            "SELECT 1 FROM entities WHERE user_id=? AND server_updated_at>? LIMIT 1",
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
                "data_generation": account_data_generation(conn, user["id"]),
            },
        )
        conn.close()

    def handle_inventory(self):
        conn, user = self.require_sync_user()
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
                "data_generation": account_data_generation(conn, user["id"]),
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
            elif parsed.path == "/auth/email/start":
                self.handle_email_start()
            elif parsed.path == "/auth/email/confirm":
                self.handle_email_confirm()
            elif parsed.path == "/auth/email/rebind/old/start":
                self.handle_email_rebind_old_start()
            elif parsed.path == "/auth/email/rebind/old/confirm":
                self.handle_email_rebind_old_confirm()
            elif parsed.path == "/auth/email/rebind/new/start":
                self.handle_email_rebind_new_start()
            elif parsed.path == "/auth/email/rebind/new/confirm":
                self.handle_email_rebind_new_confirm()
            elif parsed.path == "/auth/password/change":
                self.handle_password_change()
            elif parsed.path == "/auth/password/reset/request":
                self.handle_password_reset_request()
            elif parsed.path == "/auth/password/reset/confirm":
                self.handle_password_reset_confirm()
            elif parsed.path in ("/auth/logout", "/auth/revoke"):
                self.handle_logout()
            elif parsed.path == "/auth/account/delete":
                self.handle_account_delete()
            elif parsed.path == "/sync/push":
                self.handle_push()
            elif parsed.path == "/sync/reconcile":
                self.handle_reconcile()
            elif parsed.path == "/sync/secret-state/reset":
                self.handle_secret_state_reset()
            elif parsed.path == "/sync/data/reset":
                self.handle_sync_data_reset()
            elif parsed.path == "/sync/recovery/restore":
                self.handle_recovery_restore()
            elif parsed.path == "/sync/assets/init":
                self.handle_asset_init()
            elif parsed.path == "/feedback":
                self.handle_feedback()
            else:
                self.send_error_code(404, "NOT_FOUND")
        finally:
            REQUEST_SLOTS.release()

    def do_PUT(self):
        if not self.begin_request():
            return
        try:
            parsed = urlparse(self.path)
            if parsed.path.startswith("/sync/assets/"):
                asset_id = parsed.path.rsplit("/", 1)[-1].lower()
                if valid_asset_id(asset_id):
                    self.handle_asset_put(asset_id)
                    return
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
                    id,kind,text,images_json,attachments_json,app_version,platform,client_ip,created_at
                ) VALUES(?,?,?,?,?,?,?,?,?)
                """,
                (
                    feedback_id,
                    feedback["kind"],
                    feedback["text"],
                    json.dumps(feedback["images"], ensure_ascii=False, separators=(",", ":")),
                    json.dumps(feedback["attachments"], ensure_ascii=False, separators=(",", ":")),
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
                "acceptedAttachments": len(feedback["attachments"]),
                "message": (
                    "反馈已提交并发送，谢谢。"
                    if emailed
                    else "反馈已安全收件；邮件通知暂时排队。"
                ),
            },
        )

    def handle_reconcile(self):
        conn, user = self.require_sync_user()
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
        generation = account_data_generation(conn, user["id"])
        if generation > 1 and request_data_generation(body) != generation:
            self.send_error_code(
                409,
                "DATA_GENERATION_MISMATCH",
                "云端数据已清除；请先清除此设备数据并重新登录",
            )
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
                "updated_at": normalize_entity_epoch_ms(item.get("updated_at")),
                "deleted_at": normalize_entity_epoch_ms(item.get("deleted_at")),
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
                "data_generation": generation,
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
                ensure_account_usage(conn, user_id)
                audit_security(conn, "account_registered", "info", user_id, security_subject(self.client_ip()))
                token = issue_token(conn, user_id)
        except sqlite3.IntegrityError:
            self.send_error_code(409, "USERNAME_EXISTS")
            conn.close()
            return
        self.send_json(
            200,
            {
                "ok": True,
                "token": token,
                "user": {"id": user_id, "username": username, "sync_enabled": False},
                "sync_enabled": False,
                "data_generation": 1,
            },
        )
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
            "SELECT id,username,password_hash,disabled_at,disabled_reason,sync_verified_at FROM users WHERE username=?", (username,)
        ).fetchone()
        if not user or not verify_password(password, user["password_hash"]):
            self.send_error_code(401, "INVALID_CREDENTIALS")
            conn.close()
            return
        if bool(user["disabled_at"]):
            with conn:
                audit_security(conn, "disabled_account_login", "warning", user["id"], security_subject(self.client_ip()))
            self.send_error_code(403, "ACCOUNT_DISABLED", "账号已被限制，请联系支持")
            conn.close()
            return
        with conn:
            token = issue_token(conn, user["id"])
        self.send_json(
            200,
            {
                "ok": True,
                "token": token,
                "user": {"id": user["id"], "username": user["username"], "sync_enabled": bool(user["sync_verified_at"])},
                "sync_enabled": bool(user["sync_verified_at"]),
                "data_generation": account_data_generation(conn, user["id"]),
            },
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

    def handle_sync_data_reset(self):
        conn, user = self.require_sync_user()
        if not user:
            return
        if not self.allow_rate("sync_data_reset_user", user["id"], 3, 3600):
            conn.close()
            return
        body = self.read_auth_body()
        if body is None:
            conn.close()
            return
        password = str(body.get("password", "") or "")
        row = conn.execute(
            "SELECT password_hash FROM users WHERE id=?", (user["id"],)
        ).fetchone()
        if not row or not verify_password(password, row["password_hash"]):
            self.send_error_code(401, "INVALID_CREDENTIALS", "登录密码不正确")
            conn.close()
            return
        generation = reset_account_sync_data(conn, user["id"])
        conn.close()
        self.send_json(
            200,
            {
                "ok": True,
                "data_generation": generation,
                "tokens_revoked": True,
            },
        )

    def handle_recovery_status(self):
        conn, user = self.require_sync_user()
        if not user:
            return
        if not self.allow_rate("sync_recovery_user", user["id"], 12, 60):
            conn.close()
            return
        current_at = now_ms()
        with conn:
            recovery.prune_history(conn, user["id"], current_at)
        payload = recovery.status(conn, user["id"], current_at)
        self.send_json(
            200,
            {
                "ok": True,
                "server_time": current_at,
                "data_generation": account_data_generation(conn, user["id"]),
                **payload,
            },
        )
        conn.close()

    def handle_recovery_restore(self):
        conn, user = self.require_sync_user()
        if not user:
            return
        if not self.allow_rate("sync_recovery_restore_user", user["id"], 3, 3600):
            conn.close()
            return
        body = self.read_auth_body()
        if body is None:
            conn.close()
            return
        if body.get("confirm") is not True:
            self.send_error_code(400, "RECOVERY_CONFIRMATION_REQUIRED")
            conn.close()
            return
        generation = account_data_generation(conn, user["id"])
        if request_data_generation(body) != generation:
            self.send_error_code(409, "DATA_GENERATION_MISMATCH")
            conn.close()
            return
        password = str(body.get("password", "") or "")
        password_row = conn.execute(
            "SELECT password_hash FROM users WHERE id=?", (user["id"],)
        ).fetchone()
        if not password_row or not verify_password(password, password_row["password_hash"]):
            self.send_error_code(401, "INVALID_CREDENTIALS", "登录密码不正确")
            conn.close()
            return
        target_at = safe_int(body.get("target_at", body.get("targetAt")))
        try:
            with conn:
                conn.execute("BEGIN IMMEDIATE")
                result = recovery.restore_account(conn, user["id"], target_at, now_ms())
                generation += 1
                conn.execute(
                    "INSERT INTO account_data_generations(user_id,generation,updated_at) "
                    "VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET "
                    "generation=excluded.generation,updated_at=excluded.updated_at",
                    (user["id"], generation, result["restored_at"]),
                )
                conn.execute("DELETE FROM tokens WHERE user_id=?", (user["id"],))
        except ValueError as error:
            code = str(error)
            status_code = 404 if code == "RECOVERY_UNAVAILABLE" else 409
            self.send_error_code(status_code, code)
            conn.close()
            return
        self.send_json(
            200,
            {
                "ok": True,
                "data_generation": generation,
                "tokens_revoked": True,
                **result,
            },
        )
        conn.close()

    def handle_account_delete(self):
        conn, user = self.require_user()
        if not user:
            return
        if not self.allow_rate("account_delete_user", user["id"], 3, 3600):
            conn.close()
            return
        body = self.read_auth_body()
        if body is None:
            conn.close()
            return
        password = str(body.get("password", "") or "")
        confirmation = str(body.get("username", "") or "").strip()
        row = conn.execute(
            "SELECT username,password_hash FROM users WHERE id=?", (user["id"],)
        ).fetchone()
        if not row or not verify_password(password, row["password_hash"]):
            self.send_error_code(401, "INVALID_CREDENTIALS", "登录密码不正确")
            conn.close()
            return
        if confirmation != row["username"]:
            self.send_error_code(
                400,
                "ACCOUNT_CONFIRMATION_MISMATCH",
                "请输入完整账号名确认删除",
            )
            conn.close()
            return
        with conn:
            conn.execute("DELETE FROM entity_history WHERE user_id=?", (user["id"],))
            conn.execute("DELETE FROM recovery_accounts WHERE user_id=?", (user["id"],))
            conn.execute("DELETE FROM entities WHERE user_id=?", (user["id"],))
            remove_user_assets(conn, user["id"])
            conn.execute("DELETE FROM tokens WHERE user_id=?", (user["id"],))
            conn.execute("DELETE FROM account_codes WHERE user_id=?", (user["id"],))
            conn.execute("DELETE FROM account_emails WHERE user_id=?", (user["id"],))
            conn.execute("DELETE FROM secret_bundle_epochs WHERE user_id=?", (user["id"],))
            conn.execute("DELETE FROM account_data_generations WHERE user_id=?", (user["id"],))
            conn.execute("DELETE FROM account_usage WHERE user_id=?", (user["id"],))
            audit_security(conn, "account_deleted", "info", user["id"])
            conn.execute("DELETE FROM users WHERE id=?", (user["id"],))
        conn.close()
        self.send_json(200, {"ok": True, "account_deleted": True})

    def handle_auth_security(self):
        conn, user = self.require_user()
        if not user:
            return
        row = conn.execute(
            "SELECT email FROM account_emails WHERE user_id=?", (user["id"],)
        ).fetchone()
        self.send_json(
            200,
            {
                "ok": True,
                "emailBound": bool(row),
                "email": mask_email(row["email"]) if row else "",
                "recoveryAvailable": bool(row) and account_mail_configured(),
                "mailConfigured": account_mail_configured(),
                "syncEnabled": bool(user["sync_verified_at"]),
            },
        )
        conn.close()

    def handle_auth_usage(self):
        conn, user = self.require_user()
        if not user:
            return
        with conn:
            response = account_usage_summary(conn, user["id"])
        conn.close()
        self.send_json(200, response)

    def handle_email_start(self):
        conn, user = self.require_user()
        if not user:
            return
        if not self.allow_rate("account_email_user", user["id"], 4, 3600):
            conn.close()
            return
        body = self.read_auth_body()
        if body is None:
            conn.close()
            return
        email = normalize_email(body.get("email"))
        if not email:
            self.send_error_code(400, "INVALID_EMAIL", "请输入有效邮箱地址")
            conn.close()
            return
        if not account_mail_configured():
            self.send_error_code(503, "ACCOUNT_EMAIL_NOT_CONFIGURED", "账户安全邮件尚未配置")
            conn.close()
            return
        existing = conn.execute(
            "SELECT email FROM account_emails WHERE user_id=?", (user["id"],)
        ).fetchone()
        if existing:
            self.send_error_code(
                409,
                "EMAIL_ALREADY_BOUND",
                "已绑定验证邮箱；请先验证旧邮箱再更换新邮箱",
            )
            conn.close()
            return
        owner = conn.execute(
            "SELECT user_id FROM account_emails WHERE email=?", (email,)
        ).fetchone()
        if owner and owner["user_id"] != user["id"]:
            self.send_error_code(409, "EMAIL_ALREADY_BOUND")
            conn.close()
            return
        code = issue_account_code(conn, user["id"], "bind_email", email)
        try:
            send_account_email(
                email,
                "鲲鹏阅读器：验证绑定邮箱",
                f"你的邮箱验证码是：{code}\n\n验证码 15 分钟内有效，请勿转发给他人。",
            )
        except Exception:
            self.send_error_code(503, "ACCOUNT_EMAIL_DELIVERY_FAILED", "验证码邮件暂时无法发送")
            conn.close()
            return
        self.send_json(200, {"ok": True, "message": "验证码已发送"})
        conn.close()

    def handle_email_confirm(self):
        conn, user = self.require_user()
        if not user:
            return
        body = self.read_auth_body()
        if body is None:
            conn.close()
            return
        email = normalize_email(body.get("email"))
        code = str(body.get("code", "") or "").strip()
        existing = conn.execute(
            "SELECT email FROM account_emails WHERE user_id=?", (user["id"],)
        ).fetchone()
        if existing:
            self.send_error_code(
                409,
                "EMAIL_ALREADY_BOUND",
                "已绑定验证邮箱；请先验证旧邮箱再更换新邮箱",
            )
            conn.close()
            return
        if not email or not code or not consume_account_code(conn, user["id"], "bind_email", email, code):
            self.send_error_code(400, "INVALID_OR_EXPIRED_CODE")
            conn.close()
            return
        try:
            with conn:
                conn.execute(
                    "INSERT INTO account_emails(user_id,email,verified_at) VALUES(?,?,?) "
                    "ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,verified_at=excluded.verified_at",
                    (user["id"], email, now_ms()),
                )
                conn.execute("UPDATE users SET sync_verified_at=? WHERE id=?", (now_ms(), user["id"]))
                audit_security(conn, "email_verified_for_sync", "info", user["id"], security_subject(email))
        except sqlite3.IntegrityError:
            self.send_error_code(409, "EMAIL_ALREADY_BOUND")
            conn.close()
            return
        self.send_json(200, {"ok": True, "email": mask_email(email)})
        conn.close()

    def handle_email_rebind_old_start(self):
        conn, user = self.require_user()
        if not user:
            return
        if not self.allow_rate("account_rebind_user", user["id"], 4, 3600):
            conn.close()
            return
        if not account_mail_configured():
            self.send_error_code(503, "ACCOUNT_EMAIL_NOT_CONFIGURED", "账户安全邮件尚未配置")
            conn.close()
            return
        existing = conn.execute(
            "SELECT email FROM account_emails WHERE user_id=?", (user["id"],)
        ).fetchone()
        if not existing:
            self.send_error_code(400, "EMAIL_NOT_BOUND", "当前账号尚未绑定验证邮箱")
            conn.close()
            return
        email = existing["email"]
        code = issue_account_code(conn, user["id"], "rebind_old", email)
        try:
            send_account_email(
                email,
                "鲲鹏阅读器：验证更换绑定邮箱",
                f"你正在更换鲲鹏阅读器的绑定邮箱。旧邮箱验证码是：{code}\n\n"
                "验证码 15 分钟内有效。若不是你本人操作，请修改登录密码。",
            )
        except Exception:
            self.send_error_code(503, "ACCOUNT_EMAIL_DELIVERY_FAILED", "验证码邮件暂时无法发送")
            conn.close()
            return
        self.send_json(200, {"ok": True, "email": mask_email(email)})
        conn.close()

    def handle_email_rebind_old_confirm(self):
        conn, user = self.require_user()
        if not user:
            return
        body = self.read_auth_body()
        if body is None:
            conn.close()
            return
        existing = conn.execute(
            "SELECT email FROM account_emails WHERE user_id=?", (user["id"],)
        ).fetchone()
        code = str(body.get("code", "") or "").strip()
        if not existing or not code or not consume_account_code(
            conn, user["id"], "rebind_old", existing["email"], code
        ):
            self.send_error_code(400, "INVALID_OR_EXPIRED_CODE")
            conn.close()
            return
        # This short-lived one-time credential proves control of the old mailbox.
        # It is returned only over the authenticated TLS session and is consumed
        # before a new-mail verification message is sent.
        grant = issue_account_code(conn, user["id"], "rebind_grant", existing["email"])
        self.send_json(200, {"ok": True, "rebindGrant": grant})
        conn.close()

    def handle_email_rebind_new_start(self):
        conn, user = self.require_user()
        if not user:
            return
        if not self.allow_rate("account_rebind_user", user["id"], 4, 3600):
            conn.close()
            return
        body = self.read_auth_body()
        if body is None:
            conn.close()
            return
        if not account_mail_configured():
            self.send_error_code(503, "ACCOUNT_EMAIL_NOT_CONFIGURED", "账户安全邮件尚未配置")
            conn.close()
            return
        existing = conn.execute(
            "SELECT email FROM account_emails WHERE user_id=?", (user["id"],)
        ).fetchone()
        email = normalize_email(body.get("email"))
        grant = str(body.get("rebindGrant", "") or "").strip()
        if not existing or not email or not grant:
            self.send_error_code(400, "INVALID_REBIND_REQUEST", "请先验证旧邮箱并输入新邮箱")
            conn.close()
            return
        if email == existing["email"]:
            self.send_error_code(400, "EMAIL_UNCHANGED", "新邮箱不能与当前绑定邮箱相同")
            conn.close()
            return
        owner = conn.execute(
            "SELECT user_id FROM account_emails WHERE email=?", (email,)
        ).fetchone()
        if owner:
            self.send_error_code(409, "EMAIL_ALREADY_BOUND")
            conn.close()
            return
        if not consume_account_code(conn, user["id"], "rebind_grant", existing["email"], grant):
            self.send_error_code(400, "INVALID_OR_EXPIRED_REBIND_GRANT", "旧邮箱验证已失效，请重新验证")
            conn.close()
            return
        code = issue_account_code(conn, user["id"], "rebind_new", email)
        try:
            send_account_email(
                email,
                "鲲鹏阅读器：确认新的绑定邮箱",
                f"你正在将鲲鹏阅读器的绑定邮箱更换为此邮箱。验证码是：{code}\n\n"
                "验证码 15 分钟内有效。若不是你本人操作，请忽略此邮件。",
            )
        except Exception:
            self.send_error_code(503, "ACCOUNT_EMAIL_DELIVERY_FAILED", "验证码邮件暂时无法发送")
            conn.close()
            return
        self.send_json(200, {"ok": True, "message": "验证码已发送到新邮箱"})
        conn.close()

    def handle_email_rebind_new_confirm(self):
        conn, user = self.require_user()
        if not user:
            return
        body = self.read_auth_body()
        if body is None:
            conn.close()
            return
        email = normalize_email(body.get("email"))
        code = str(body.get("code", "") or "").strip()
        if not email or not code or not consume_account_code(conn, user["id"], "rebind_new", email, code):
            self.send_error_code(400, "INVALID_OR_EXPIRED_CODE")
            conn.close()
            return
        try:
            with conn:
                conn.execute(
                    "UPDATE account_emails SET email=?,verified_at=? WHERE user_id=?",
                    (email, now_ms(), user["id"]),
                )
        except sqlite3.IntegrityError:
            self.send_error_code(409, "EMAIL_ALREADY_BOUND")
            conn.close()
            return
        self.send_json(200, {"ok": True, "email": mask_email(email)})
        conn.close()

    def handle_password_change(self):
        token = self.bearer_token()
        conn, user = self.require_user()
        if not user:
            return
        if not self.allow_rate("password_change_user", user["id"], 5, 3600):
            conn.close()
            return
        body = self.read_auth_body()
        if body is None:
            conn.close()
            return
        current = str(body.get("currentPassword", "") or "")
        new_password = str(body.get("newPassword", "") or "")
        if len(new_password) < 8:
            self.send_error_code(400, "WEAK_PASSWORD", "新密码至少需要 8 个字符")
            conn.close()
            return
        row = conn.execute("SELECT password_hash FROM users WHERE id=?", (user["id"],)).fetchone()
        if not row or not verify_password(current, row["password_hash"]):
            self.send_error_code(401, "INVALID_CREDENTIALS")
            conn.close()
            return
        with conn:
            conn.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(new_password), user["id"]))
            conn.execute("DELETE FROM tokens WHERE user_id=? AND token<>?", (user["id"], token))
        self.send_json(200, {"ok": True, "message": "登录密码已修改，其他设备已退出登录"})
        conn.close()

    def handle_password_reset_request(self):
        if not self.allow_rate("password_reset_ip", self.client_ip(), 4, 3600):
            return
        body = self.read_auth_body()
        if body is None:
            return
        username = str(body.get("username", "") or "").strip()
        email = normalize_email(body.get("email"))
        # Always return the same result to avoid exposing whether an account or
        # binding exists. The actual code is sent only on an exact match.
        if not account_mail_configured() or not email:
            self.send_json(200, {"ok": True, "message": "若账号已绑定该邮箱，验证码将发送至邮箱"})
            return
        conn = connect()
        row = conn.execute(
            """
            SELECT users.id FROM users JOIN account_emails ON account_emails.user_id=users.id
            WHERE users.username=? AND account_emails.email=?
            """,
            (username, email),
        ).fetchone()
        if row:
            if not self.allow_rate("password_reset_user", row["id"], 4, 3600):
                conn.close()
                return
            code = issue_account_code(conn, row["id"], "reset_password", email)
            try:
                send_account_email(
                    email,
                    "鲲鹏阅读器：重置登录密码",
                    f"你的密码重置验证码是：{code}\n\n验证码 15 分钟内有效；若不是你本人操作，请忽略此邮件。",
                )
            except Exception:
                # Do not turn mail transport state into account enumeration.
                pass
        conn.close()
        self.send_json(200, {"ok": True, "message": "若账号已绑定该邮箱，验证码将发送至邮箱"})

    def handle_password_reset_confirm(self):
        if not self.allow_rate("password_reset_confirm_ip", self.client_ip(), 8, 3600):
            return
        body = self.read_auth_body()
        if body is None:
            return
        username = str(body.get("username", "") or "").strip()
        code = str(body.get("code", "") or "").strip()
        new_password = str(body.get("newPassword", "") or "")
        if len(new_password) < 8:
            self.send_error_code(400, "WEAK_PASSWORD", "新密码至少需要 8 个字符")
            return
        conn = connect()
        row = conn.execute(
            """
            SELECT users.id,users.username,account_emails.email FROM users
            JOIN account_emails ON account_emails.user_id=users.id WHERE users.username=?
            """,
            (username,),
        ).fetchone()
        if not row or not consume_account_code(conn, row["id"], "reset_password", row["email"], code):
            self.send_error_code(400, "INVALID_OR_EXPIRED_CODE")
            conn.close()
            return
        with conn:
            conn.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(new_password), row["id"]))
            conn.execute("DELETE FROM tokens WHERE user_id=?", (row["id"],))
            token = issue_token(conn, row["id"])
        self.send_json(200, {"ok": True, "token": token, "user": {"id": row["id"], "username": row["username"]}})
        conn.close()

    def handle_secret_state(self):
        conn, user = self.require_sync_user()
        if not user:
            return
        self.send_json(200, {"ok": True, "secretBundleEpoch": secret_bundle_epoch(conn, user["id"])})
        conn.close()

    def handle_secret_state_reset(self):
        conn, user = self.require_sync_user()
        if not user:
            return
        if not self.allow_rate("secret_reset_user", user["id"], 4, 3600):
            conn.close()
            return
        epoch = reset_secret_bundle_epoch(conn, user["id"])
        self.send_json(200, {"ok": True, "secretBundleEpoch": epoch})
        conn.close()

    def handle_push(self):
        conn, user = self.require_sync_user()
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
        generation = account_data_generation(conn, user["id"])
        if generation > 1 and request_data_generation(body) != generation:
            self.send_error_code(
                409,
                "DATA_GENERATION_MISMATCH",
                "云端数据已清除；请先清除此设备数据并重新登录",
            )
            conn.close()
            return
        schema_version = safe_int(body.get("schema_version"), 1)
        if schema_version > 3:
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
        stale_assets = []
        with conn:
            self.begin_push_transaction(conn)
            recovery.prune_history(conn, user["id"], now_ms())
            account_usage = refresh_daily_usage(conn, user["id"])
            account_storage = account_storage_bytes(conn, user["id"])
            daily_write_delta = 0
            daily_entity_delta = 0
            quota_rejected = False
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
                if schema_version >= 3 and kind in ("book_state_v2", "ai_reader_history_v1"):
                    ignored_count += 1
                    rejected_count += 1
                    record_ignored(ignored, {"kind": kind, "id": entity_id, "error": "LEGACY_ENTITY_DISALLOWED"})
                    dispositions.append(
                        {**input_identity, "status": "rejected", "error": "LEGACY_ENTITY_DISALLOWED"}
                    )
                    continue
                payload = entity.get("json", entity.get("data", {}))
                payload_text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
                payload_bytes = len(payload_text.encode("utf-8"))
                payload_limit = (
                    MAX_AI_HISTORY_JSON_BYTES if kind in ("ai_reader_history_v1", "ai_reader_history_entry_v2")
                    else MAX_READER_PALETTE_JSON_BYTES if kind in ("reader_palette_v1", "reader_palette_order_v1")
                    else MAX_ENTITY_JSON_BYTES
                )
                if payload_bytes > payload_limit:
                    ignored_count += 1
                    rejected_count += 1
                    record_ignored(ignored, {"kind": kind, "id": entity_id, "error": "PAYLOAD_TOO_LARGE"})
                    dispositions.append(
                        {**input_identity, "status": "rejected", "error": "PAYLOAD_TOO_LARGE"}
                    )
                    continue
                if kind in ("reader_palette_v1", "reader_palette_order_v1") and not reader_palette_payload_is_valid(kind, payload):
                    ignored_count += 1
                    rejected_count += 1
                    record_ignored(ignored, {"kind": kind, "id": entity_id, "error": "INVALID_PALETTE"})
                    dispositions.append({**input_identity, "status": "rejected", "error": "INVALID_PALETTE"})
                    continue
                if kind == "app_settings_v1" and (entity_id != "default" or not app_settings_payload_is_valid(payload)):
                    ignored_count += 1
                    rejected_count += 1
                    record_ignored(ignored, {"kind": kind, "id": entity_id, "error": "INVALID_APP_SETTINGS"})
                    dispositions.append({**input_identity, "status": "rejected", "error": "INVALID_APP_SETTINGS"})
                    continue
                if kind == "ai_reader_history_v1" and not ai_history_retention_is_valid(payload):
                    ignored_count += 1
                    rejected_count += 1
                    record_ignored(ignored, {"kind": kind, "id": entity_id, "error": "HISTORY_RETENTION_LIMIT"})
                    dispositions.append({**input_identity, "status": "rejected", "error": "HISTORY_RETENTION_LIMIT"})
                    continue
                history_scope = None
                if kind == "ai_reader_history_entry_v2":
                    history_scope = ai_history_entry_scope(entity_id, payload)
                    if history_scope is None:
                        ignored_count += 1
                        rejected_count += 1
                        record_ignored(ignored, {"kind": kind, "id": entity_id, "error": "INVALID_HISTORY_ENTRY"})
                        dispositions.append({**input_identity, "status": "rejected", "error": "INVALID_HISTORY_ENTRY"})
                        continue
                normalized = {
                    "kind": kind,
                    "id": entity_id,
                    "json": payload,
                    "updated_at": normalize_entity_epoch_ms(entity.get("updated_at")),
                    "deleted_at": normalize_entity_epoch_ms(entity.get("deleted_at")),
                    "device_id": str(entity.get("device_id", default_device_id) or "")[:128],
                    "sync_version": safe_int(entity.get("sync_version")),
                }
                existing = conn.execute(
                    "SELECT kind,id,json,updated_at,deleted_at,device_id,sync_version,"
                    "server_updated_at,LENGTH(json) AS json_bytes "
                    "FROM entities WHERE user_id=? AND kind=? AND id=?",
                    (user["id"], kind, entity_id),
                ).fetchone()
                if kind == "reader_palette_v1" and not normalized["deleted_at"] and (existing is None or existing["deleted_at"]):
                    palette_count = conn.execute(
                        "SELECT COUNT(*) FROM entities WHERE user_id=? AND kind=? AND deleted_at=0",
                        (user["id"], "reader_palette_v1"),
                    ).fetchone()[0]
                    if palette_count >= MAX_READER_PALETTES:
                        ignored_count += 1
                        rejected_count += 1
                        record_ignored(ignored, {"kind": kind, "id": entity_id, "error": "PALETTE_LIMIT"})
                        dispositions.append({**input_identity, "status": "rejected", "error": "PALETTE_LIMIT"})
                        continue
                if kind == "secret_bundle_v1" and not normalized["deleted_at"]:
                    # Version 1 secret envelopes had no epoch. Treat them as the
                    # initial epoch so existing encrypted bundles keep working
                    # until their owner explicitly revokes them.
                    payload_epoch = safe_int(payload.get("epoch"), 1) if isinstance(payload, dict) else 0
                    current_epoch = secret_bundle_epoch(conn, user["id"])
                    if payload_epoch != current_epoch:
                        ignored_count += 1
                        record_ignored(ignored, {"kind": kind, "id": entity_id, "error": "SECRET_EPOCH_MISMATCH"})
                        # Treat an obsolete encrypted package as an authoritative
                        # conflict, not an acknowledged rejection. New clients
                        # therefore install the reset tombstone and never retry
                        # a stale offline secret bundle forever.
                        dispositions.append({**input_identity, "status": "conflict", "error": "SECRET_EPOCH_MISMATCH"})
                        if existing:
                            authoritative_entities.append(row_to_entity(existing))
                        continue
                if not is_newer(normalized, existing):
                    ignored_count += 1
                    record_ignored(ignored, {"kind": kind, "id": entity_id, "reason": "CONFLICT_IGNORED"})
                    dispositions.append({**input_identity, "status": "conflict"})
                    authoritative_entities.append(row_to_entity(existing))
                    continue
                if kind == "ai_reader_history_entry_v2":
                    existing_is_live = existing is not None and not int(existing["deleted_at"])
                    if not normalized["deleted_at"] and not existing_is_live:
                        if history_entry_live_count(conn, user["id"], history_scope) >= MAX_AI_HISTORY_LIVE_ENTRIES:
                            ignored_count += 1
                            rejected_count += 1
                            record_ignored(ignored, {"kind": kind, "id": entity_id, "error": "HISTORY_RETENTION_LIMIT"})
                            dispositions.append({**input_identity, "status": "rejected", "error": "HISTORY_RETENTION_LIMIT"})
                            continue
                    elif normalized["deleted_at"] and existing_is_live:
                        # Keep the live manifest bounded. The oldest tombstone
                        # is intentionally allowed to expire once it has been
                        # retained to the documented limit.
                        prune_history_entry_tombstones(
                            conn, user["id"], history_scope,
                            MAX_AI_HISTORY_TOMBSTONES - 1,
                        )
                existing_bytes = int(existing["json_bytes"]) if existing else 0
                entity_delta = 0 if existing else 1
                byte_delta = payload_bytes - existing_bytes
                history_bytes = 0 if kind in recovery.NON_RECOVERABLE_KINDS else len(recovery._encode_payload(payload_text)[0])
                usage_over_limit = (
                    account_storage + byte_delta + history_bytes > int(account_usage["storage_limit_bytes"])
                    or int(account_usage["daily_written_bytes"]) + daily_write_delta + payload_bytes + history_bytes > MAX_ACCOUNT_DAILY_WRITE_BYTES
                    or int(account_usage["daily_entity_writes"]) + daily_entity_delta + 1 > MAX_ACCOUNT_DAILY_ENTITY_WRITES
                )
                if (
                    user_entity_count + entity_delta > MAX_USER_ENTITIES
                    or user_json_bytes + byte_delta > MAX_USER_JSON_BYTES
                    or usage_over_limit
                ):
                    ignored_count += 1
                    rejected_count += 1
                    record_ignored(ignored, {"kind": kind, "id": entity_id, "error": "QUOTA_EXCEEDED"})
                    dispositions.append(
                        {**input_identity, "status": "rejected", "error": "QUOTA_EXCEEDED"}
                    )
                    quota_rejected = True
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
                recovery.record_entity(
                    conn,
                    user["id"],
                    kind,
                    entity_id,
                    payload_text,
                    normalized["updated_at"],
                    normalized["deleted_at"],
                    normalized["device_id"],
                    normalized["sync_version"],
                    normalized["server_updated_at"],
                    "sync",
                )
                user_entity_count += entity_delta
                user_json_bytes += byte_delta
                account_storage += byte_delta + history_bytes
                daily_write_delta += payload_bytes + history_bytes
                daily_entity_delta += 1
                accepted.append(normalized)
                dispositions.append({**input_identity, "status": "accepted"})
            if accepted:
                recovery.prune_history(conn, user["id"], now_ms())
                conn.execute(
                    "UPDATE account_usage SET daily_written_bytes=daily_written_bytes+?,daily_entity_writes=daily_entity_writes+?,updated_at=? WHERE user_id=?",
                    (daily_write_delta, daily_entity_delta, now_ms(), user["id"]),
                )
            if accepted:
                stale_assets = garbage_collect_unreferenced_assets(conn, user["id"])
            if quota_rejected:
                audit_security(conn, "account_quota_exceeded", "warning", user["id"], security_subject(self.client_ip()), {"accepted": len(accepted)})
        delete_asset_files(user["id"], stale_assets)
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
                "schema_version": 3,
                "server_time": now_ms(),
                "data_generation": generation,
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
