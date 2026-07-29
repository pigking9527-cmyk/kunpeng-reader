#!/usr/bin/env bash
# Configure the separate account-security mail channel from an already working
# feedback SMTP configuration. This script never prints credential values.
set -euo pipefail

feedback_env="${1:-/etc/reader-sync-api-feedback.env}"
account_env="${2:-/etc/reader-sync-api-account-mail.env}"
dropin_dir="/etc/systemd/system/reader-sync-api.service.d"

if [[ ! -r "$feedback_env" ]]; then
  echo "Feedback SMTP environment file is not readable." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$feedback_env"
set +a

umask 077
{
  printf 'ACCOUNT_SMTP_HOST=%s\n' "${FEEDBACK_SMTP_HOST:-}"
  printf 'ACCOUNT_SMTP_PORT=%s\n' "${FEEDBACK_SMTP_PORT:-465}"
  printf 'ACCOUNT_SMTP_USER=%s\n' "${FEEDBACK_SMTP_USER:-}"
  printf 'ACCOUNT_SMTP_PASSWORD=%s\n' "${FEEDBACK_SMTP_PASSWORD:-}"
  printf 'ACCOUNT_SMTP_FROM=%s\n' "${FEEDBACK_SMTP_FROM:-}"
  printf 'ACCOUNT_SMTP_SSL=%s\n' "${FEEDBACK_SMTP_SSL:-true}"
  printf 'ACCOUNT_SMTP_STARTTLS=%s\n' "${FEEDBACK_SMTP_STARTTLS:-false}"
} > "$account_env"

install -d -m 0755 "$dropin_dir"
printf '%s\n' '[Service]' "EnvironmentFile=$account_env" > "$dropin_dir/account-mail.conf"
systemctl daemon-reload
systemctl restart reader-sync-api
systemctl is-active --quiet reader-sync-api
printf 'Account-security mail configuration saved and service restarted.\n'
