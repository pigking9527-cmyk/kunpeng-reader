"""Database adapter for SQLite tests and PostgreSQL production.

The API was originally written against Python's sqlite3 connection surface.
This module keeps that small surface while translating the deliberately simple
SQL subset used by the service. PostgreSQL connections come from a bounded
pool; no request opens a new TCP connection.
"""

import os
import re
import sqlite3
import threading


POSTGRES_URL = os.environ.get("SYNC_DATABASE_URL", "").strip()
BACKEND = "postgresql" if POSTGRES_URL else "sqlite"


class DatabaseUnavailable(RuntimeError):
    pass


class HybridRow:
    def __init__(self, columns, values):
        self._columns = tuple(columns)
        self._values = tuple(values)
        self._mapping = dict(zip(self._columns, self._values))

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._values[key]
        return self._mapping[key]

    def __iter__(self):
        return iter(self._values)

    def keys(self):
        return self._mapping.keys()


class EmptyCursor:
    rowcount = 0

    def fetchone(self):
        return None

    def fetchall(self):
        return []

    def __iter__(self):
        return iter(())


def is_postgresql():
    return BACKEND == "postgresql"


def translate_sql(sql):
    """Translate the SQLite-compatible query subset used on request paths."""
    translated = str(sql)
    if translated.strip().upper() == "BEGIN IMMEDIATE":
        return ""
    translated = translated.replace("LIMIT -1 OFFSET ?", "OFFSET ?")
    translated = translated.replace("LENGTH(", "OCTET_LENGTH(")
    translated = re.sub(
        r"UPDATE\s+OR\s+REPLACE\s+tokens\s+SET",
        "UPDATE tokens SET",
        translated,
        flags=re.IGNORECASE,
    )
    if re.search(r"\bINSERT\s+OR\s+IGNORE\b", translated, re.IGNORECASE):
        translated = re.sub(
            r"\bINSERT\s+OR\s+IGNORE\b", "INSERT", translated, flags=re.IGNORECASE
        )
        translated = translated.rstrip().rstrip(";") + " ON CONFLICT DO NOTHING"
    translated = re.sub(r"\bMAX\(value,\s*\?\)", "GREATEST(value, ?)", translated)
    translated = translated.replace("?", "%s")
    return translated


_pool = None
_pool_lock = threading.Lock()


def _postgres_modules():
    try:
        import psycopg
        from psycopg_pool import ConnectionPool
    except ImportError as error:
        raise DatabaseUnavailable("PostgreSQL 驱动不可用") from error
    return psycopg, ConnectionPool


def postgres_error_types():
    if not is_postgresql():
        return (sqlite3.Error,)
    psycopg, _ = _postgres_modules()
    return (sqlite3.Error, psycopg.Error)


def postgres_integrity_error_types():
    if not is_postgresql():
        return (sqlite3.IntegrityError,)
    psycopg, _ = _postgres_modules()
    return (sqlite3.IntegrityError, psycopg.IntegrityError)


def _connection_pool():
    global _pool
    if _pool is not None:
        return _pool
    with _pool_lock:
        if _pool is None:
            _, pool_class = _postgres_modules()
            _pool = pool_class(
                conninfo=POSTGRES_URL,
                min_size=max(1, int(os.environ.get("SYNC_DB_POOL_MIN", "2"))),
                max_size=max(2, int(os.environ.get("SYNC_DB_POOL_MAX", "16"))),
                timeout=5,
                max_lifetime=3600,
                max_idle=300,
                open=True,
            )
    return _pool


class PostgresCursor:
    def __init__(self, cursor):
        self._cursor = cursor
        self.rowcount = cursor.rowcount
        self._columns = tuple(item.name for item in (cursor.description or ()))

    def _row(self, values):
        return None if values is None else HybridRow(self._columns, values)

    def fetchone(self):
        return self._row(self._cursor.fetchone())

    def fetchall(self):
        return [self._row(row) for row in self._cursor.fetchall()]

    def __iter__(self):
        for row in self._cursor:
            yield self._row(row)


class PostgresConnection:
    backend = "postgresql"

    def __init__(self):
        self._pool = _connection_pool()
        self._connection = self._pool.getconn(timeout=5)
        self._closed = False
        self._context_depth = 0

    def execute(self, sql, parameters=()):
        translated = translate_sql(sql)
        if not translated:
            return EmptyCursor()
        cursor = self._connection.execute(translated, tuple(parameters or ()))
        return PostgresCursor(cursor)

    def executemany(self, sql, parameters):
        translated = translate_sql(sql)
        cursor = self._connection.cursor()
        cursor.executemany(translated, parameters)
        return PostgresCursor(cursor)

    def commit(self):
        self._connection.commit()

    def rollback(self):
        self._connection.rollback()

    def close(self):
        if self._closed:
            return
        self._closed = True
        try:
            self._connection.rollback()
        except Exception:
            pass
        self._pool.putconn(self._connection)

    def transaction_lock(self, namespace, key):
        self.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(?,0))",
            (f"{namespace}:{key}",),
        )

    def __enter__(self):
        self._context_depth += 1
        return self

    def __exit__(self, exc_type, _exc, _traceback):
        self._context_depth = max(0, self._context_depth - 1)
        if self._context_depth == 0:
            if exc_type is None:
                self.commit()
            else:
                self.rollback()
        return False


def connect_postgresql():
    return PostgresConnection()
