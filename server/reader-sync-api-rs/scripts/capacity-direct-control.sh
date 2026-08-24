#!/usr/bin/env bash
# Temporarily expose one disposable dev-test service as source-restricted HTTPS.
#
# This helper is intentionally host-side and root-only. It never discovers or
# prints a public address, credential, database URL, environment-file path, or
# certificate path. The caller must still opt the k6 runner into an external
# target separately. Production service and Caddy state are read-only gates.
set -euo pipefail

STATE_ROOT=/var/lib/kunpeng-capacity-direct-control
TLS_ROOT=/run/kunpeng-capacity-direct-control-tls
LOCK_FILE=/run/lock/kunpeng-capacity-direct-control.lock

usage() {
  cat <<'EOF'
Usage:
  capacity-direct-control.sh prepare --service DEV_TEST_SERVICE [--production-service SERVICE]
  capacity-direct-control.sh status  --service DEV_TEST_SERVICE
  capacity-direct-control.sh cleanup --service DEV_TEST_SERVICE [--production-service SERVICE]
  capacity-direct-control.sh --self-test

prepare derives the test port and environment file from the running dev-test
service, derives the exact allowed source and certificate IP from
SSH_CONNECTION, installs temporary iptables/ip6tables gates, enables native
self-signed TLS only in the test environment, and restarts only that service.
cleanup restores the byte-for-byte environment backup before removing the
temporary firewall chains and TLS material. No address or secret is printed.
EOF
}

die() {
  printf '%s\n' "$1" >&2
  exit 2
}

validate_service_name() {
  local value=$1
  [[ "$value" =~ ^[A-Za-z0-9_.@-]*dev-test[A-Za-z0-9_.@-]*\.service$ ]] ||
    die 'service must be an explicit dev-test systemd service'
}

validate_production_service_name() {
  local value=$1
  [[ "$value" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] ||
    die 'production service name is invalid'
  [[ "$value" != *dev-test* && "$value" != *test* ]] ||
    die 'production service must not be a test service'
}

derive_production_service() {
  local value=$1
  local derived=${value/-dev-test/}
  [[ "$derived" != "$value" ]] || die 'cannot derive production service safely'
  validate_production_service_name "$derived"
  printf '%s\n' "$derived"
}

canonical_ip() {
  python3 -c 'import ipaddress,sys
raw=sys.stdin.read().strip()
try:
    value=ipaddress.ip_address(raw)
except ValueError:
    raise SystemExit(2)
print(f"{value.version} {value.compressed}")' 2>/dev/null
}

parse_ssh_connection() {
  local raw_client raw_client_port raw_server raw_server_port extra
  local parsed
  IFS=' ' read -r raw_client raw_client_port raw_server raw_server_port extra <<<"${SSH_CONNECTION:-}"
  [[ -n "$raw_client" && -n "$raw_client_port" && -n "$raw_server" &&
     -n "$raw_server_port" && -z "${extra:-}" ]] ||
    die 'prepare requires one valid SSH_CONNECTION tuple'
  [[ "$raw_client_port" =~ ^[0-9]{1,5}$ && "$raw_server_port" =~ ^[0-9]{1,5}$ ]] ||
    die 'SSH_CONNECTION contains an invalid port'
  ((10#$raw_client_port >= 1 && 10#$raw_client_port <= 65535 &&
    10#$raw_server_port >= 1 && 10#$raw_server_port <= 65535)) ||
    die 'SSH_CONNECTION contains an out-of-range port'

  parsed=$(printf '%s' "$raw_client" | canonical_ip) ||
    die 'SSH_CONNECTION contains an invalid source address'
  CLIENT_FAMILY=${parsed%% *}
  CLIENT_IP=${parsed#* }
  parsed=$(printf '%s' "$raw_server" | canonical_ip) ||
    die 'SSH_CONNECTION contains an invalid server address'
  SERVER_FAMILY=${parsed%% *}
  SERVER_IP=${parsed#* }
  [[ "$CLIENT_FAMILY" == 4 || "$CLIENT_FAMILY" == 6 ]] ||
    die 'SSH source family is unsupported'
  [[ "$SERVER_FAMILY" == 4 || "$SERVER_FAMILY" == 6 ]] ||
    die 'SSH server family is unsupported'
  [[ "$CLIENT_FAMILY" == "$SERVER_FAMILY" ]] ||
    die 'SSH source and server addresses must use one family'
}

service_hash() {
  printf '%s' "$1" | sha256sum | awk '{print substr($1,1,16)}'
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required host command is unavailable: $1"
}

require_root() {
  ((EUID == 0)) || die 'capacity direct control is root-only'
}

acquire_lock() {
  install -d -m 0755 -o root -g root -- "$(dirname -- "$LOCK_FILE")" >/dev/null 2>&1 ||
    die 'cannot prepare the direct-control lock directory'
  exec 9>"$LOCK_FILE"
  flock -x 9 || die 'cannot acquire the direct-control lock'
}

unit_exists() {
  systemctl cat "$1" >/dev/null 2>&1
}

active_pid() {
  local service=$1
  local pid
  [[ "$(systemctl is-active "$service" 2>/dev/null || true)" == active ]] || return 1
  pid=$(systemctl show "$service" -p MainPID --value 2>/dev/null || true)
  [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s\n' "$pid"
}

production_pid_matches() {
  local saved=$1
  local current=$2
  [[ "$saved" =~ ^[0-9]+$ && "$saved" -gt 1 && "$current" == "$saved" ]]
}

production_pid_unchanged() {
  local saved=$1
  local before=$2
  local after=$3
  production_pid_matches "$saved" "$before" &&
    production_pid_matches "$saved" "$after"
}

process_env_value() {
  local pid=$1
  local key=$2
  tr '\0' '\n' <"/proc/$pid/environ" | sed -n "s/^${key}=//p" | tail -n1
}

discover_test_env_file() {
  local service=$1
  local rendered candidate resolved
  local -a candidates=()
  rendered=$(systemctl show "$service" -p EnvironmentFiles --value 2>/dev/null) ||
    die 'cannot inspect the test service environment'
  mapfile -t candidates < <(printf '%s\n' "$rendered" | grep -oE '/[^ ;)]+' | sort -u)
  ((${#candidates[@]} == 1)) ||
    die 'test service must use exactly one discoverable environment file'
  candidate=${candidates[0]}
  [[ -f "$candidate" && ! -L "$candidate" ]] ||
    die 'test service environment must be one regular non-symlink file'
  resolved=$(realpath -e -- "$candidate") || die 'cannot resolve the test environment file'
  [[ "$resolved" == *dev* || "$resolved" == *test* ]] ||
    die 'refusing an environment file without a dev/test marker'
  [[ "$(stat -c %u -- "$resolved")" == 0 ]] ||
    die 'test environment file must be root-owned'
  local mode
  mode=$(stat -c %a -- "$resolved")
  (( (8#$mode & 0022) == 0 )) ||
    die 'test environment file must not be group/world writable'
  printf '%s\n' "$resolved"
}

database_is_disposable() {
  local pid=$1
  local url db_without_query db_name loopback
  url=$(process_env_value "$pid" KUNPENG_SYNC_DATABASE_URL)
  [[ "$url" == postgres://* || "$url" == postgresql://* ]] || return 1
  loopback=$(printf '%s' "$url" | python3 -c 'import sys,urllib.parse
value=urllib.parse.urlparse(sys.stdin.read())
print("yes" if value.hostname in {"127.0.0.1", "localhost", "::1"} else "no")' 2>/dev/null) || return 1
  [[ "$loopback" == yes ]] || return 1
  db_without_query=${url%%\?*}
  db_name=${db_without_query##*/}
  [[ "$db_name" =~ ^reader_sync_rust_test_[A-Za-z0-9_]+$ ]]
}

parse_bind() {
  local bind=$1
  local host
  if [[ "$bind" =~ ^\[([^]]+)\]:([0-9]{1,5})$ ]]; then
    host=${BASH_REMATCH[1]}
    DIRECT_PORT=${BASH_REMATCH[2]}
  elif [[ "$bind" =~ ^([^:]+):([0-9]{1,5})$ ]]; then
    host=${BASH_REMATCH[1]}
    DIRECT_PORT=${BASH_REMATCH[2]}
  else
    die 'test service bind is invalid'
  fi
  ((10#$DIRECT_PORT >= 1 && 10#$DIRECT_PORT <= 65535)) ||
    die 'test service port is out of range'
  case "$host" in
    127.0.0.1) ORIGINAL_BIND_FAMILY=4 ;;
    ::1) ORIGINAL_BIND_FAMILY=6 ;;
    localhost) ORIGINAL_BIND_FAMILY=4 ;;
    *) die 'prepare requires the test service to start on loopback' ;;
  esac
}

listener_scope_from_ss() {
  local pid=$1
  local port=$2
  local line address
  line=$(awk -v p=":$port" -v owner="pid=$pid," \
    '$4 ~ (p "$") && index($0,owner)>0 {print; exit}')
  [[ -n "$line" ]] || {
    printf '%s\n' none
    return
  }
  address=$(awk '{print $4}' <<<"$line")
  case "$address" in
    127.0.0.1:*|'[::1]':*) printf '%s\n' loopback ;;
    0.0.0.0:*|'[::]':*|\*:*) printf '%s\n' all-interfaces ;;
    *) printf '%s\n' specific-interface ;;
  esac
}

listener_scope() {
  local pid=$1
  local port=$2
  ss -ltnpH 2>/dev/null | listener_scope_from_ss "$pid" "$port"
}

validate_probe_endpoint() {
  case "$1" in
    /health|/ready|/metrics) ;;
    *) die 'local probe endpoint is not allowlisted' ;;
  esac
}

http_status() {
  local scheme=$1
  local port=$2
  local endpoint=$3
  local insecure=${4:-0}
  local family=${5:-4}
  local host=127.0.0.1
  validate_probe_endpoint "$endpoint"
  [[ "$family" == 6 ]] && host='[::1]'
  local -a args=(--silent --show-error --output /dev/null --max-time 4 --write-out '%{http_code}')
  args+=(--noproxy '*')
  ((insecure == 1)) && args+=(--insecure)
  curl "${args[@]}" "$scheme://$host:$port$endpoint" 2>/dev/null || true
}

local_endpoint_gate() {
  local scheme=$1
  local port=$2
  local insecure=$3
  local family=$4
  local endpoint
  for endpoint in /health /ready /metrics; do
    [[ "$(http_status "$scheme" "$port" "$endpoint" "$insecure" "$family")" == 200 ]] ||
      return 1
  done
}

wait_for_service_gate() {
  local service=$1
  local port=$2
  local expected_scope=$3
  local scheme=$4
  local insecure=$5
  local family=$6
  local attempt pid
  for ((attempt=0; attempt<40; attempt++)); do
    pid=$(active_pid "$service" 2>/dev/null || true)
    if [[ -n "$pid" && "$(listener_scope "$pid" "$port")" == "$expected_scope" ]] &&
       local_endpoint_gate "$scheme" "$port" "$insecure" "$family"; then
      printf '%s\n' "$pid"
      return 0
    fi
    sleep 0.25
  done
  pid=$(active_pid "$service" 2>/dev/null || true)
  if [[ -z "$pid" ]]; then
    printf '%s\n' 'service_gate_failure=inactive' >&2
  else
    local observed_scope
    observed_scope=$(listener_scope "$pid" "$port")
    if [[ "$observed_scope" != "$expected_scope" ]]; then
      printf 'service_gate_failure=listener_%s\n' "$observed_scope" >&2
    elif [[ "$scheme" == https ]] && local_endpoint_gate http "$port" 0 "$family"; then
      printf '%s\n' 'service_gate_failure=plain_http_after_tls_request' >&2
    else
      printf '%s\n' 'service_gate_failure=endpoint_readiness' >&2
    fi
  fi
  return 1
}

discover_caddy_config() {
  local rendered config
  [[ "$(systemctl is-active caddy.service 2>/dev/null || true)" == active ]] ||
    die 'Caddy must be active before direct preparation'
  rendered=$(systemctl show caddy.service -p ExecStart --value 2>/dev/null) ||
    die 'cannot inspect the active Caddy command'
  if [[ "$rendered" =~ --config=([^\ ;}]+) ]]; then
    config=${BASH_REMATCH[1]}
  elif [[ "$rendered" =~ --config[[:space:]]+([^\ ;}]+) ]]; then
    config=${BASH_REMATCH[1]}
  else
    die 'cannot discover the active Caddy configuration'
  fi
  [[ "$config" == /* && -f "$config" && ! -L "$config" ]] ||
    die 'active Caddy configuration is not one regular absolute file'
  printf '%s\n' "$config"
}

count_port_references() {
  local port=$1
  grep -Eoc "(:|\\\\u003a)$port([^0-9]|$)" || true
}

caddy_port_reference_count() {
  local port=$1
  local config adapted
  config=$(discover_caddy_config)
  adapted=$(caddy adapt --config "$config" 2>/dev/null) ||
    die 'active Caddy configuration cannot be adapted safely'
  printf '%s' "$adapted" | count_port_references "$port"
}

validate_service_separation() {
  local test_pid=$1
  local production_pid=$2
  local test_exe production_exe test_sha production_sha
  [[ "$test_pid" != "$production_pid" ]] ||
    die 'test and production services unexpectedly share one process'
  test_exe=$(readlink -f -- "/proc/$test_pid/exe" 2>/dev/null || true)
  production_exe=$(readlink -f -- "/proc/$production_pid/exe" 2>/dev/null || true)
  [[ -n "$test_exe" && -n "$production_exe" && "$test_exe" != "$production_exe" ]] ||
    die 'test and production services must use separate binary paths'
  test_sha=$(sha256sum -- "$test_exe" 2>/dev/null | awk '{print $1}')
  production_sha=$(sha256sum -- "$production_exe" 2>/dev/null | awk '{print $1}')
  [[ -n "$test_sha" && "$test_sha" == "$production_sha" ]] ||
    die 'test and production services must run byte-identical binaries'
}

write_state() {
  local destination=$1
  local temp
  temp=$(mktemp "${destination}.tmp.XXXXXX") || die 'cannot create direct-control state'
  chmod 0600 "$temp"
  {
    printf 'ST_SERVICE=%q\n' "$SERVICE"
    printf 'ST_PRODUCTION_SERVICE=%q\n' "$PRODUCTION_SERVICE"
    printf 'ST_PRODUCTION_PID=%q\n' "$PRODUCTION_PID"
    printf 'ST_ENV_FILE=%q\n' "$ENV_FILE"
    printf 'ST_ENV_BACKUP=%q\n' "$ENV_BACKUP"
    printf 'ST_ORIGINAL_ENV_SHA=%q\n' "$ORIGINAL_ENV_SHA"
    printf 'ST_DIRECT_ENV_SHA=%q\n' "${DIRECT_ENV_SHA:-}"
    printf 'ST_PORT=%q\n' "$DIRECT_PORT"
    printf 'ST_SOURCE_FAMILY=%q\n' "$CLIENT_FAMILY"
    printf 'ST_SERVER_FAMILY=%q\n' "$SERVER_FAMILY"
    printf 'ST_ORIGINAL_BIND_FAMILY=%q\n' "$ORIGINAL_BIND_FAMILY"
    printf 'ST_TLS_DIR=%q\n' "$TLS_DIR"
    printf 'ST_CERT_FILE=%q\n' "$CERT_FILE"
    printf 'ST_KEY_FILE=%q\n' "$KEY_FILE"
    printf 'ST_CHAIN4=%q\n' "$CHAIN4"
    printf 'ST_CHAIN6=%q\n' "$CHAIN6"
    printf 'ST_PHASE=%q\n' "$STATE_PHASE"
  } >"$temp"
  mv -f -- "$temp" "$destination" || die 'cannot publish direct-control state'
}

load_state() {
  local destination=$1
  [[ -f "$destination" && ! -L "$destination" ]] ||
    die 'direct-control state is missing or unsafe'
  [[ "$(stat -c %u -- "$destination")" == 0 ]] ||
    die 'direct-control state is not root-owned'
  local mode
  mode=$(stat -c %a -- "$destination")
  (( (8#$mode & 0077) == 0 )) || die 'direct-control state permissions are unsafe'
  # The file is generated by write_state in a root-only directory and contains
  # only shell-escaped validated values.
  # shellcheck disable=SC1090
  source "$destination"
  [[ "${ST_SERVICE:-}" == "$SERVICE" ]] || die 'direct-control state targets another service'
  [[ "${ST_PORT:-}" =~ ^[0-9]{1,5}$ ]] || die 'direct-control state has an invalid port'
  [[ "${ST_SOURCE_FAMILY:-}" == 4 || "${ST_SOURCE_FAMILY:-}" == 6 ]] ||
    die 'direct-control state has an invalid source family'
  [[ "${ST_SERVER_FAMILY:-}" == 4 || "${ST_SERVER_FAMILY:-}" == 6 ]] ||
    die 'direct-control state has an invalid server family'
  [[ "${ST_ORIGINAL_BIND_FAMILY:-}" == 4 || "${ST_ORIGINAL_BIND_FAMILY:-}" == 6 ]] ||
    die 'direct-control state has an invalid original bind family'
  [[ "${ST_CHAIN4:-}" =~ ^KPD4[A-F0-9]{12}$ &&
     "${ST_CHAIN6:-}" =~ ^KPD6[A-F0-9]{12}$ ]] ||
    die 'direct-control state has invalid firewall identifiers'
}

atomic_restore_file() {
  local backup=$1
  local destination=$2
  local temp
  [[ -f "$backup" && ! -L "$backup" ]] || return 1
  temp=$(mktemp "${destination}.restore.XXXXXX") || return 1
  cp -a -- "$backup" "$temp" >/dev/null 2>&1 || { rm -f -- "$temp"; return 1; }
  mv -f -- "$temp" "$destination" >/dev/null 2>&1
}

rewrite_test_environment() {
  local source=$1
  local destination=$2
  local public_bind=$3
  local certificate=$4
  local key=$5
  local temp
  temp=$(mktemp "${destination}.direct.XXXXXX") || die 'cannot create a test environment update'
  awk -v bind="$public_bind" -v cert="$certificate" -v key="$key" '
    /^KUNPENG_SYNC_BIND=/ { next }
    /^KUNPENG_SYNC_LISTEN_ADDR=/ { next }
    /^KUNPENG_SYNC_ALLOW_PUBLIC_BIND=/ { next }
    /^KUNPENG_SYNC_TLS_CERTIFICATE_PEM=/ { next }
    /^KUNPENG_SYNC_TLS_PRIVATE_KEY_PEM=/ { next }
    { print }
    END {
      print "KUNPENG_SYNC_BIND=" bind
      print "KUNPENG_SYNC_ALLOW_PUBLIC_BIND=1"
      print "KUNPENG_SYNC_TLS_CERTIFICATE_PEM=" cert
      print "KUNPENG_SYNC_TLS_PRIVATE_KEY_PEM=" key
    }
  ' "$source" >"$temp" || { rm -f -- "$temp"; die 'cannot rewrite the test environment'; }
  chmod --reference="$source" "$temp"
  chown --reference="$source" "$temp"
  mv -f -- "$temp" "$destination" || die 'cannot install the test environment update'
}

create_tls_material() {
  local service=$1
  local service_user service_group config
  service_user=$(systemctl show "$service" -p User --value 2>/dev/null || true)
  [[ -n "$service_user" ]] || service_user=root
  [[ "$service_user" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] ||
    die 'test service user is invalid'
  service_group=$(systemctl show "$service" -p Group --value 2>/dev/null || true)
  [[ -n "$service_group" ]] || service_group=$(id -gn "$service_user" 2>/dev/null)
  [[ "$service_group" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] ||
    die 'test service group is invalid'

  install -d -m 0711 -o root -g root -- "$TLS_ROOT" >/dev/null 2>&1 ||
    die 'cannot create temporary TLS root'
  [[ ! -e "$TLS_DIR" ]] || die 'temporary TLS state already exists'
  install -d -m 0750 -o "$service_user" -g "$service_group" -- "$TLS_DIR" >/dev/null 2>&1 ||
    die 'cannot create temporary TLS directory'
  config="$TLS_DIR/openssl.cnf"
  umask 077
  {
    printf '%s\n' '[req]'
    printf '%s\n' 'distinguished_name=subject'
    printf '%s\n' 'x509_extensions=extensions'
    printf '%s\n' 'prompt=no'
    printf '%s\n' '[subject]'
    printf '%s\n' 'CN=kunpeng-capacity-direct'
    printf '%s\n' '[extensions]'
    printf '%s\n' "subjectAltName=IP:$SERVER_IP"
    printf '%s\n' 'keyUsage=critical,digitalSignature,keyEncipherment'
    printf '%s\n' 'extendedKeyUsage=serverAuth'
  } >"$config"
  chown "$service_user:$service_group" "$config"
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
    -config "$config" -keyout "$KEY_FILE" -out "$CERT_FILE" >/dev/null 2>&1 ||
    die 'temporary TLS certificate generation failed'
  rm -f -- "$config"
  chown "$service_user:$service_group" "$KEY_FILE" "$CERT_FILE"
  chmod 0640 "$KEY_FILE"
  chmod 0644 "$CERT_FILE"
  openssl x509 -in "$CERT_FILE" -noout -checkend 60 >/dev/null 2>&1 ||
    die 'temporary TLS certificate validation failed'
}

firewall_chain_exists() {
  local binary=$1
  local chain=$2
  "$binary" -w 5 -nL "$chain" >/dev/null 2>&1
}

install_firewall() {
  if firewall_chain_exists iptables "$CHAIN4"; then
    die 'temporary IPv4 firewall chain already exists'
  fi
  if firewall_chain_exists ip6tables "$CHAIN6"; then
    die 'temporary IPv6 firewall chain already exists'
  fi

  iptables -w 5 -N "$CHAIN4" >/dev/null 2>&1 || die 'cannot create the IPv4 firewall chain'
  FW4_CREATED=1
  ip6tables -w 5 -N "$CHAIN6" >/dev/null 2>&1 || die 'cannot create the IPv6 firewall chain'
  FW6_CREATED=1

  iptables -w 5 -A "$CHAIN4" -i lo -p tcp -s 127.0.0.1/32 -d 127.0.0.1/32 \
    --dport "$DIRECT_PORT" -j ACCEPT >/dev/null 2>&1 ||
    die 'cannot preserve the exact IPv4 loopback monitor path'
  ip6tables -w 5 -A "$CHAIN6" -i lo -p tcp -s ::1/128 -d ::1/128 \
    --dport "$DIRECT_PORT" -j ACCEPT >/dev/null 2>&1 ||
    die 'cannot preserve the exact IPv6 loopback monitor path'

  if [[ "$CLIENT_FAMILY" == 4 ]]; then
    iptables -w 5 -A "$CHAIN4" -p tcp -s "$CLIENT_IP/32" --dport "$DIRECT_PORT" -j ACCEPT >/dev/null 2>&1 ||
      die 'cannot install the exact IPv4 source allowance'
  fi
  iptables -w 5 -A "$CHAIN4" -p tcp --dport "$DIRECT_PORT" -j DROP >/dev/null 2>&1 ||
    die 'cannot install the IPv4 fallback drop'

  if [[ "$CLIENT_FAMILY" == 6 ]]; then
    ip6tables -w 5 -A "$CHAIN6" -p tcp -s "$CLIENT_IP/128" --dport "$DIRECT_PORT" -j ACCEPT >/dev/null 2>&1 ||
      die 'cannot install the exact IPv6 source allowance'
  fi
  ip6tables -w 5 -A "$CHAIN6" -p tcp --dport "$DIRECT_PORT" -j DROP >/dev/null 2>&1 ||
    die 'cannot install the IPv6 fallback drop'

  iptables -w 5 -I INPUT 1 -p tcp --dport "$DIRECT_PORT" -j "$CHAIN4" >/dev/null 2>&1 ||
    die 'cannot attach the IPv4 firewall chain'
  FW4_JUMP=1
  ip6tables -w 5 -I INPUT 1 -p tcp --dport "$DIRECT_PORT" -j "$CHAIN6" >/dev/null 2>&1 ||
    die 'cannot attach the IPv6 firewall chain'
  FW6_JUMP=1
}

firewall_matches_current_source() {
  local family=$1
  local port=$2
  local chain4=$3
  local chain6=$4
  iptables -w 5 -C INPUT -p tcp --dport "$port" -j "$chain4" >/dev/null 2>&1 || return 1
  ip6tables -w 5 -C INPUT -p tcp --dport "$port" -j "$chain6" >/dev/null 2>&1 || return 1
  iptables -w 5 -C "$chain4" -p tcp --dport "$port" -j DROP >/dev/null 2>&1 || return 1
  ip6tables -w 5 -C "$chain6" -p tcp --dport "$port" -j DROP >/dev/null 2>&1 || return 1
  iptables -w 5 -C "$chain4" -i lo -p tcp -s 127.0.0.1/32 -d 127.0.0.1/32 --dport "$port" -j ACCEPT >/dev/null 2>&1 || return 1
  ip6tables -w 5 -C "$chain6" -i lo -p tcp -s ::1/128 -d ::1/128 --dport "$port" -j ACCEPT >/dev/null 2>&1 || return 1
  if [[ "$family" == 4 ]]; then
    iptables -w 5 -C "$chain4" -p tcp -s "$CLIENT_IP/32" --dport "$port" -j ACCEPT >/dev/null 2>&1 || return 1
    [[ $(iptables -w 5 -S "$chain4" 2>/dev/null | grep -c '^-A ') == 3 ]] || return 1
    [[ $(ip6tables -w 5 -S "$chain6" 2>/dev/null | grep -c '^-A ') == 2 ]] || return 1
  else
    ip6tables -w 5 -C "$chain6" -p tcp -s "$CLIENT_IP/128" --dport "$port" -j ACCEPT >/dev/null 2>&1 || return 1
    [[ $(ip6tables -w 5 -S "$chain6" 2>/dev/null | grep -c '^-A ') == 3 ]] || return 1
    [[ $(iptables -w 5 -S "$chain4" 2>/dev/null | grep -c '^-A ') == 2 ]] || return 1
  fi
}

remove_one_firewall() {
  local binary=$1
  local port=$2
  local chain=$3
  while "$binary" -w 5 -C INPUT -p tcp --dport "$port" -j "$chain" >/dev/null 2>&1; do
    "$binary" -w 5 -D INPUT -p tcp --dport "$port" -j "$chain" >/dev/null 2>&1 || return 1
  done
  if firewall_chain_exists "$binary" "$chain"; then
    "$binary" -w 5 -F "$chain" >/dev/null 2>&1 || return 1
    "$binary" -w 5 -X "$chain" >/dev/null 2>&1 || return 1
  fi
}

remove_firewall() {
  local port=$1
  local chain4=$2
  local chain6=$3
  remove_one_firewall iptables "$port" "$chain4" || return 1
  remove_one_firewall ip6tables "$port" "$chain6"
}

safe_remove_runtime() {
  local state_dir=$1
  local tls_dir=$2
  local hash=$3
  [[ "$state_dir" == "$STATE_ROOT/$hash" && "$tls_dir" == "$TLS_ROOT/$hash" ]] ||
    return 1
  rm -rf -- "$tls_dir" "$state_dir"
}

prepare_rollback() {
  local original_status=$1
  trap - EXIT
  set +e
  local restored=1
  if ((ENV_WRITTEN == 1)); then
    restored=0
    if atomic_restore_file "$ENV_BACKUP" "$ENV_FILE" &&
       systemctl restart "$SERVICE" >/dev/null 2>&1; then
      local restored_pid
      if restored_pid=$(wait_for_service_gate "$SERVICE" "$DIRECT_PORT" loopback http 0 "$ORIGINAL_BIND_FAMILY"); then
        restored=1
      fi
    fi
  fi
  if ((restored == 1)); then
    remove_firewall "$DIRECT_PORT" "$CHAIN4" "$CHAIN6" >/dev/null 2>&1 || true
    safe_remove_runtime "$STATE_DIR" "$TLS_DIR" "$SERVICE_HASH" >/dev/null 2>&1 || true
    printf '%s\n' 'prepare failed; the test service was rolled back' >&2
  else
    printf '%s\n' 'prepare failed; rollback is incomplete and the restrictive firewall remains installed' >&2
  fi
  exit "$original_status"
}

prepare_direct() {
  local test_pid bind public_bind caddy_refs state_temp
  test_pid=$(active_pid "$SERVICE") || die 'dev-test service must be active before preparation'
  PRODUCTION_PID=$(active_pid "$PRODUCTION_SERVICE") ||
    die 'production service must be active before preparation'
  validate_service_separation "$test_pid" "$PRODUCTION_PID"
  database_is_disposable "$test_pid" ||
    die 'dev-test service is not attached to a guarded disposable test database'
  ENV_FILE=$(discover_test_env_file "$SERVICE")
  bind=$(process_env_value "$test_pid" KUNPENG_SYNC_BIND)
  [[ -n "$bind" ]] || bind=$(process_env_value "$test_pid" KUNPENG_SYNC_LISTEN_ADDR)
  parse_bind "$bind"
  [[ "$(listener_scope "$test_pid" "$DIRECT_PORT")" == loopback ]] ||
    die 'dev-test listener is not currently loopback-only'
  local_endpoint_gate http "$DIRECT_PORT" 0 "$ORIGINAL_BIND_FAMILY" ||
    die 'dev-test HTTP health/readiness/metrics gate failed before preparation'
  [[ -z "$(process_env_value "$test_pid" KUNPENG_SYNC_TLS_CERTIFICATE_PEM)" &&
     -z "$(process_env_value "$test_pid" KUNPENG_SYNC_TLS_PRIVATE_KEY_PEM)" ]] ||
    die 'dev-test service already has TLS configured'

  caddy_refs=$(caddy_port_reference_count "$DIRECT_PORT")
  [[ "$caddy_refs" == 0 ]] || die 'Caddy already references the dev-test port'
  parse_ssh_connection

  SERVICE_HASH=$(service_hash "$SERVICE")
  SERVICE_HASH=${SERVICE_HASH^^}
  STATE_DIR="$STATE_ROOT/$SERVICE_HASH"
  STATE_FILE="$STATE_DIR/state.sh"
  ENV_BACKUP="$STATE_DIR/environment.backup"
  TLS_DIR="$TLS_ROOT/$SERVICE_HASH"
  CERT_FILE="$TLS_DIR/server-cert.pem"
  KEY_FILE="$TLS_DIR/server-key.pem"
  CHAIN4="KPD4${SERVICE_HASH:0:12}"
  CHAIN6="KPD6${SERVICE_HASH:0:12}"
  [[ ! -e "$STATE_DIR" ]] || die 'direct-control state already exists; cleanup is required first'
  install -d -m 0700 -o root -g root -- "$STATE_ROOT" >/dev/null 2>&1 ||
    die 'cannot create direct-control state root'
  install -d -m 0700 -o root -g root -- "$STATE_DIR" >/dev/null 2>&1 ||
    die 'cannot create direct-control state directory'
  FW4_CREATED=0
  FW6_CREATED=0
  FW4_JUMP=0
  FW6_JUMP=0
  ENV_WRITTEN=0
  trap 'prepare_rollback $?' EXIT
  cp -a -- "$ENV_FILE" "$ENV_BACKUP" >/dev/null 2>&1 ||
    die 'cannot back up the test environment'
  ORIGINAL_ENV_SHA=$(sha256sum -- "$ENV_FILE" | awk '{print $1}')
  DIRECT_ENV_SHA=''
  STATE_PHASE=preparing
  write_state "$STATE_FILE"

  create_tls_material "$SERVICE"
  install_firewall
  firewall_matches_current_source "$CLIENT_FAMILY" "$DIRECT_PORT" "$CHAIN4" "$CHAIN6" ||
    die 'temporary firewall verification failed'

  if [[ "$SERVER_FAMILY" == 4 ]]; then
    public_bind="0.0.0.0:$DIRECT_PORT"
  else
    public_bind="[::]:$DIRECT_PORT"
  fi
  [[ "$(sha256sum -- "$ENV_FILE" | awk '{print $1}')" == "$ORIGINAL_ENV_SHA" ]] ||
    die 'test environment changed during preparation'
  rewrite_test_environment "$ENV_FILE" "$ENV_FILE" "$public_bind" "$CERT_FILE" "$KEY_FILE"
  ENV_WRITTEN=1
  DIRECT_ENV_SHA=$(sha256sum -- "$ENV_FILE" | awk '{print $1}')
  STATE_PHASE=prepared
  write_state "$STATE_FILE"

  systemctl restart "$SERVICE" >/dev/null 2>&1 || die 'dev-test restart failed after TLS preparation'
  local direct_pid
  direct_pid=$(wait_for_service_gate "$SERVICE" "$DIRECT_PORT" all-interfaces https 1 "$SERVER_FAMILY") ||
    die 'dev-test service did not reach the temporary TLS readiness gate'
  database_is_disposable "$direct_pid" || die 'dev-test database gate changed after preparation'
  [[ "$(caddy_port_reference_count "$DIRECT_PORT")" == 0 ]] ||
    die 'Caddy began referencing the dev-test port during preparation'
  [[ "$(active_pid "$PRODUCTION_SERVICE" 2>/dev/null || true)" == "$PRODUCTION_PID" ]] ||
    die 'production service state changed during preparation'

  trap - EXIT
  printf '%s\n' 'direct_control=prepared'
  printf '%s\n' 'scheme=https'
  printf 'port=%s\n' "$DIRECT_PORT"
  printf 'source_family=ipv%s\n' "$CLIENT_FAMILY"
  printf '%s\n' 'production_unchanged=true'
  printf '%s\n' 'caddy_test_port_reference_count=0'
}

status_direct() {
  if [[ ! -f "$STATE_FILE" ]]; then
    printf '%s\n' 'direct_control=clean'
    return 0
  fi
  load_state "$STATE_FILE"
  [[ "${ST_PHASE:-}" == prepared ]] || die 'direct-control preparation is incomplete'
  DIRECT_PORT=$ST_PORT
  local pid caddy_refs source_match=false
  pid=$(active_pid "$SERVICE") || die 'prepared dev-test service is not active'
  [[ "$(listener_scope "$pid" "$DIRECT_PORT")" == all-interfaces ]] ||
    die 'prepared dev-test listener is not public'
  local_endpoint_gate https "$DIRECT_PORT" 1 "$ST_SERVER_FAMILY" ||
    die 'prepared dev-test TLS health/readiness/metrics gate failed'
  caddy_refs=$(caddy_port_reference_count "$DIRECT_PORT")
  [[ "$caddy_refs" == 0 ]] || die 'Caddy references the prepared dev-test port'
  if [[ -n "${SSH_CONNECTION:-}" ]]; then
    parse_ssh_connection
    if firewall_matches_current_source "$ST_SOURCE_FAMILY" "$DIRECT_PORT" "$ST_CHAIN4" "$ST_CHAIN6"; then
      source_match=true
    fi
  fi
  [[ "$source_match" == true ]] || die 'temporary firewall does not match the current SSH source'
  local production_pid
  production_pid=$(active_pid "$ST_PRODUCTION_SERVICE" 2>/dev/null || true)
  production_pid_matches "$ST_PRODUCTION_PID" "$production_pid" ||
    die 'production service PID changed after direct preparation'
  printf '%s\n' 'direct_control=prepared'
  printf '%s\n' 'scheme=https'
  printf 'port=%s\n' "$DIRECT_PORT"
  printf '%s\n' 'firewall_source_matches_current_ssh=true'
  printf '%s\n' 'caddy_test_port_reference_count=0'
  printf '%s\n' 'production_active=true'
  printf '%s\n' 'production_unchanged=true'
}

cleanup_direct() {
  [[ -f "$STATE_FILE" ]] || {
    printf '%s\n' 'direct_control=clean'
    return 0
  }
  load_state "$STATE_FILE"
  if [[ -n "$PRODUCTION_SERVICE_OPTION" && "$PRODUCTION_SERVICE_OPTION" != "$ST_PRODUCTION_SERVICE" ]]; then
    die 'cleanup production service does not match saved state'
  fi
  local production_pid_before production_active_before=true
  production_pid_before=$(active_pid "$ST_PRODUCTION_SERVICE" 2>/dev/null || true)
  [[ -n "$production_pid_before" ]] || production_active_before=false
  [[ -f "$ST_ENV_BACKUP" && ! -L "$ST_ENV_BACKUP" ]] ||
    die 'test environment backup is unavailable'
  [[ "$(sha256sum -- "$ST_ENV_BACKUP" | awk '{print $1}')" == "$ST_ORIGINAL_ENV_SHA" ]] ||
    die 'test environment backup integrity check failed'
  local current_sha
  current_sha=$(sha256sum -- "$ST_ENV_FILE" | awk '{print $1}')
  if [[ "$current_sha" != "$ST_DIRECT_ENV_SHA" && "$current_sha" != "$ST_ORIGINAL_ENV_SHA" ]]; then
    die 'test environment changed after preparation; cleanup refuses to overwrite it'
  fi
  if [[ "$current_sha" == "$ST_DIRECT_ENV_SHA" ]]; then
    atomic_restore_file "$ST_ENV_BACKUP" "$ST_ENV_FILE" ||
      die 'cannot restore the test environment backup'
  fi
  systemctl restart "$SERVICE" >/dev/null 2>&1 ||
    die 'dev-test restart failed during cleanup; restrictive firewall retained'
  local restored_pid
  restored_pid=$(wait_for_service_gate "$SERVICE" "$ST_PORT" loopback http 0 "$ST_ORIGINAL_BIND_FAMILY") ||
    die 'dev-test service did not reach the restored readiness gate; restrictive firewall retained'
  remove_firewall "$ST_PORT" "$ST_CHAIN4" "$ST_CHAIN6" ||
    die 'test service is restored but temporary firewall cleanup is incomplete'
  local caddy_refs
  caddy_refs=$(caddy_port_reference_count "$ST_PORT")
  local production_pid_after production_active_after=true production_unchanged=false
  production_pid_after=$(active_pid "$ST_PRODUCTION_SERVICE" 2>/dev/null || true)
  [[ -n "$production_pid_after" ]] || production_active_after=false
  if production_pid_unchanged "$ST_PRODUCTION_PID" "$production_pid_before" "$production_pid_after"; then
    production_unchanged=true
  fi
  SERVICE_HASH=$(service_hash "$SERVICE")
  SERVICE_HASH=${SERVICE_HASH^^}
  safe_remove_runtime "$STATE_DIR" "$ST_TLS_DIR" "$SERVICE_HASH" ||
    die 'refusing to remove unexpected direct-control paths'
  [[ "$caddy_refs" == 0 ]] || die 'cleanup completed but Caddy references the dev-test port'
  printf '%s\n' 'direct_control=clean'
  printf '%s\n' 'service_restored=true'
  printf 'production_active_before=%s\n' "$production_active_before"
  printf 'production_active_after=%s\n' "$production_active_after"
  printf 'production_unchanged=%s\n' "$production_unchanged"
  printf '%s\n' 'caddy_test_port_reference_count=0'
  [[ "$production_unchanged" == true ]] ||
    die 'cleanup completed safely, but production service PID changed'
}

self_test() {
  local parsed count
  validate_service_name 'reader-sync-dev-test.service'
  validate_production_service_name 'reader-sync.service'
  [[ "$(derive_production_service 'reader-sync-dev-test.service')" == reader-sync.service ]] ||
    die 'self-test failed: production derivation'
  if (validate_service_name 'reader-sync.service' >/dev/null 2>&1); then
    die 'self-test failed: production service accepted as dev-test'
  fi
  if (validate_service_name 'dev-test.service;touch_bad' >/dev/null 2>&1); then
    die 'self-test failed: unsafe service name accepted'
  fi
  parsed=$(printf '%s' '192.0.2.10' | canonical_ip)
  [[ "$parsed" == '4 192.0.2.10' ]] || die 'self-test failed: IPv4 canonicalization'
  parsed=$(printf '%s' '2001:db8::10' | canonical_ip)
  [[ "$parsed" == '6 2001:db8::10' ]] || die 'self-test failed: IPv6 canonicalization'
  if printf '%s' 'not-an-address' | canonical_ip >/dev/null 2>&1; then
    die 'self-test failed: invalid source address accepted'
  fi
  validate_probe_endpoint /health
  validate_probe_endpoint /ready
  validate_probe_endpoint /metrics
  if (validate_probe_endpoint /v1/sync >/dev/null 2>&1); then
    die 'self-test failed: non-probe endpoint accepted'
  fi
  production_pid_matches 42 42 || die 'self-test failed: matching production PID rejected'
  if production_pid_matches 42 43; then
    die 'self-test failed: changed production PID accepted'
  fi
  production_pid_unchanged 42 42 42 ||
    die 'self-test failed: unchanged production PID sequence rejected'
  if production_pid_unchanged 42 42 43; then
    die 'self-test failed: changed production PID sequence accepted'
  fi
  DIRECT_PORT=9443
  parse_bind '127.0.0.1:9443'
  [[ "$DIRECT_PORT" == 9443 && "$ORIGINAL_BIND_FAMILY" == 4 ]] ||
    die 'self-test failed: loopback bind parsing'
  parse_bind '[::1]:9443'
  [[ "$DIRECT_PORT" == 9443 && "$ORIGINAL_BIND_FAMILY" == 6 ]] ||
    die 'self-test failed: IPv6 loopback bind parsing'
  parsed=$(printf '%s\n' \
    'LISTEN 0 4096 0.0.0.0:9443 0.0.0.0:* users:(("other",pid=222,fd=3))' \
    'LISTEN 0 4096 127.0.0.1:9443 0.0.0.0:* users:(("test",pid=111,fd=4))' |
    listener_scope_from_ss 111 9443)
  [[ "$parsed" == loopback ]] ||
    die 'self-test failed: listener ownership collision filtering'
  if (parse_bind '0.0.0.0:9443' >/dev/null 2>&1); then
    die 'self-test failed: public initial bind accepted'
  fi
  count=$(printf '%s' '{"dial":"127.0.0.1:9443"}' | count_port_references 9443)
  [[ "$count" == 1 ]] || die 'self-test failed: Caddy port reference detection'
  count=$(printf '%s' '{"dial":"127.0.0.1:9444"}' | count_port_references 9443)
  [[ "$count" == 0 ]] || die 'self-test failed: unrelated Caddy port detection'
  printf '%s\n' 'self_test=passed'
}

ACTION=${1:-}
[[ -n "$ACTION" ]] || { usage >&2; exit 2; }
shift || true
if [[ "$ACTION" == --self-test ]]; then
  (($# == 0)) || { usage >&2; exit 2; }
  self_test
  exit 0
fi
case "$ACTION" in
  prepare|status|cleanup) ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

SERVICE=''
PRODUCTION_SERVICE_OPTION=''
while (($#)); do
  case "$1" in
    --service)
      (($# >= 2)) || { usage >&2; exit 2; }
      SERVICE=$2
      shift
      ;;
    --production-service)
      (($# >= 2)) || { usage >&2; exit 2; }
      PRODUCTION_SERVICE_OPTION=$2
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

[[ -n "$SERVICE" ]] || { usage >&2; exit 2; }
validate_service_name "$SERVICE"
if [[ -n "$PRODUCTION_SERVICE_OPTION" ]]; then
  validate_production_service_name "$PRODUCTION_SERVICE_OPTION"
fi
require_root
for command_name in systemctl python3 sha256sum stat realpath ss curl caddy openssl \
  iptables ip6tables flock awk sed grep install mktemp; do
  require_command "$command_name"
done
acquire_lock
unit_exists "$SERVICE" || die 'dev-test service unit is unavailable'

SERVICE_HASH=$(service_hash "$SERVICE")
SERVICE_HASH=${SERVICE_HASH^^}
STATE_DIR="$STATE_ROOT/$SERVICE_HASH"
STATE_FILE="$STATE_DIR/state.sh"

case "$ACTION" in
  prepare)
    PRODUCTION_SERVICE=${PRODUCTION_SERVICE_OPTION:-$(derive_production_service "$SERVICE")}
    validate_production_service_name "$PRODUCTION_SERVICE"
    unit_exists "$PRODUCTION_SERVICE" || die 'production service unit is unavailable'
    prepare_direct
    ;;
  status)
    status_direct
    ;;
  cleanup)
    cleanup_direct
    ;;
esac
