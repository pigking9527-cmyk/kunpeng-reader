#!/usr/bin/env bash
# Parses the runtime configuration only. It never opens PostgreSQL or binds a socket.
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
service_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)

exec cargo +1.97.1 run --quiet --locked --manifest-path "$service_dir/Cargo.toml" --bin config_check -- --offline
