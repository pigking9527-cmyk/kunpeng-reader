#!/usr/bin/env python3
"""Local-only administration for reader sync security controls.

Run this on the API host.  It deliberately has no HTTP route: account bans and
raw audit detail stay behind SSH/systemd access.
"""
import argparse
import json
import sys

import app


def audit_rows(conn, since_hours, limit):
    cutoff = app.now_ms() - int(since_hours * 60 * 60 * 1000)
    return conn.execute(
        "SELECT occurred_at,event,severity,user_id,subject,detail_json FROM security_audit "
        "WHERE occurred_at>=? ORDER BY occurred_at DESC LIMIT ?", (cutoff, limit)
    ).fetchall()


def emit(rows):
    for row in rows:
        print(json.dumps(dict(row), ensure_ascii=False, separators=(",", ":")))


def main():
    parser = argparse.ArgumentParser(description="Reader Sync local security administration")
    parser.add_argument("--database", help="SQLite database path; normally supplied by SYNC_DB_PATH")
    sub = parser.add_subparsers(dest="command", required=True)
    ban = sub.add_parser("disable", help="Disable an account and revoke its tokens")
    ban.add_argument("username")
    ban.add_argument("--reason", required=True)
    enable = sub.add_parser("enable", help="Re-enable an account")
    enable.add_argument("username")
    audit = sub.add_parser("audit", help="Print recent security audit rows as JSONL")
    audit.add_argument("--since-hours", type=float, default=24)
    audit.add_argument("--limit", type=int, default=200)
    alerts = sub.add_parser("alerts", help="Print pending alerts; optionally email and acknowledge them")
    alerts.add_argument("--limit", type=int, default=100)
    alerts.add_argument("--notify", action="store_true")
    args = parser.parse_args()
    if args.database:
        app.DB_PATH = args.database
    conn = app.connect()
    try:
        if args.command in ("disable", "enable"):
            user = conn.execute("SELECT id FROM users WHERE username=?", (args.username,)).fetchone()
            if not user:
                print("ACCOUNT_NOT_FOUND", file=sys.stderr)
                return 2
            with conn:
                if args.command == "disable":
                    conn.execute(
                        "UPDATE users SET disabled_at=?,disabled_reason=? WHERE id=?",
                        (app.now_ms(), args.reason[:256], user["id"]),
                    )
                    conn.execute("DELETE FROM tokens WHERE user_id=?", (user["id"],))
                    app.audit_security(conn, "account_disabled", "warning", user["id"], detail={"reason": args.reason[:256]})
                else:
                    conn.execute("UPDATE users SET disabled_at=0,disabled_reason='' WHERE id=?", (user["id"],))
                    app.audit_security(conn, "account_enabled", "info", user["id"])
            print(json.dumps({"ok": True, "username": args.username, "disabled": args.command == "disable"}, ensure_ascii=False))
            return 0
        if args.command == "audit":
            emit(audit_rows(conn, args.since_hours, max(1, min(args.limit, 1000))))
            return 0
        rows = conn.execute(
            "SELECT id,occurred_at,event,severity,subject,count,detail_json FROM security_alerts "
            "WHERE notified_at=0 ORDER BY occurred_at ASC LIMIT ?", (max(1, min(args.limit, 500)),)
        ).fetchall()
        emit(rows)
        if args.notify and rows:
            if not app.SECURITY_ALERT_TO or not app.account_mail_configured():
                print("ALERT_DELIVERY_NOT_CONFIGURED", file=sys.stderr)
                return 3
            text = "\n".join(
                f"[{row['severity']}] {row['event']} subject={row['subject']} count={row['count']}" for row in rows
            )
            app.send_account_email(app.SECURITY_ALERT_TO, "Reader Sync security alert", text)
            with conn:
                conn.executemany("UPDATE security_alerts SET notified_at=? WHERE id=?", [(app.now_ms(), row["id"]) for row in rows])
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())