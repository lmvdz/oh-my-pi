#!/usr/bin/env bash
# Boot this clone's mux stack: broker (if down) → 17.3.7 gateway → optional Switchyard.
#
# This script is the entrypoint. It does NOT use PATH `omp` (likely 17.1.8,
# no mux/cheap|capable). The gateway must be this repo's coding-agent CLI.
#
# Parameters (flags or env):
#   --gateway-bind HOST:PORT     OMP_AUTH_GATEWAY_BIND   default 127.0.0.1:4010
#   --switchyard-bind HOST:PORT  SWITCHYARD_BIND         default 127.0.0.1:4001
#   --mux-url URL                OMP_MUX_URL             default http://$gateway/v1
#   --broker-url URL             OMP_AUTH_BROKER_URL     default http://127.0.0.1:8765
#   --routing-log PATH           SWITCHYARD_ROUTING_LOG  default $HOME/.omp/switchyard-routing.jsonl
#   --with-switchyard            also exec switchyard-server in front of the mux
#   --replace                    kill whatever is already bound to gateway/switchyard
#   --replace-broker             also replace the broker (needed for OpenRouter credits)
#   --no-broker-start            fail if the broker is down instead of starting it
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
OMP_CLI="${OMP_QUOTA_CLI:-$ROOT/packages/coding-agent/scripts/omp}"
BROKER_URL="${OMP_AUTH_BROKER_URL:-http://127.0.0.1:8765}"
GATEWAY_BIND="${OMP_AUTH_GATEWAY_BIND:-127.0.0.1:4010}"
SWITCHYARD_BIND="${SWITCHYARD_BIND:-127.0.0.1:4001}"
OMP_MUX_URL="${OMP_MUX_URL:-}"
TOKEN_FILE="${OMP_AUTH_BROKER_TOKEN_FILE:-$HOME/.omp/auth-broker.token}"
GATEWAY_TOKEN_FILE="${OMP_AUTH_GATEWAY_TOKEN_FILE:-$HOME/.omp/auth-gateway.token}"
ROUTING_LOG="${SWITCHYARD_ROUTING_LOG:-$HOME/.omp/switchyard-routing.jsonl}"
WITH_SWITCHYARD=0
REPLACE=0
REPLACE_BROKER=0
START_BROKER=1
RENDER_ARGS=()
STARTED_PIDS=()

usage() {
	sed -n '2,15p' "$0"
	echo "Usage: $(basename "$0") [--with-switchyard] [--replace] [--replace-broker] [--no-broker-start]"
	echo "         [--gateway-bind H:P] [--switchyard-bind H:P] [--mux-url URL] [--broker-url URL] [--routing-log PATH]"
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--with-switchyard)
		WITH_SWITCHYARD=1
		shift
		;;
	--replace)
		REPLACE=1
		shift
		;;
	--replace-broker)
		REPLACE_BROKER=1
		shift
		;;
	--no-broker-start)
		START_BROKER=0
		shift
		;;
	--gateway-bind)
		GATEWAY_BIND="$2"
		RENDER_ARGS+=(--gateway-bind "$2")
		shift 2
		;;
	--switchyard-bind)
		SWITCHYARD_BIND="$2"
		RENDER_ARGS+=(--switchyard-bind "$2")
		shift 2
		;;
	--mux-url)
		OMP_MUX_URL="$2"
		RENDER_ARGS+=(--mux-url "$2")
		shift 2
		;;
	--broker-url)
		BROKER_URL="$2"
		shift 2
		;;
	--routing-log)
		ROUTING_LOG="$2"
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "unknown arg: $1" >&2
		usage >&2
		exit 1
		;;
	esac
done

need_cmd() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "missing: $1" >&2
		exit 1
	fi
}

need_file() {
	if [[ ! -x "$1" ]]; then
		echo "missing executable: $1" >&2
		exit 1
	fi
}

omp_cli() {
	"$OMP_CLI" "$@"
}

port_of() {
	local spec="$1"
	spec="${spec#http://}"
	spec="${spec#https://}"
	printf '%s\n' "${spec##*:}"
}

host_of() {
	local spec="$1"
	spec="${spec#http://}"
	spec="${spec#https://}"
	printf '%s\n' "${spec%:*}"
}

pids_listening() {
	local port="$1"
	if command -v ss >/dev/null 2>&1; then
		ss -ltnp "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u
	elif command -v lsof >/dev/null 2>&1; then
		lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
	fi
}

wait_port_free() {
	local port="$1"
	local i
	for i in $(seq 1 50); do
		if [[ -z "$(pids_listening "$port")" ]]; then
			return 0
		fi
		sleep 0.1
	done
	echo "port $port still in use: $(pids_listening "$port" | tr '\n' ' ')" >&2
	return 1
}

kill_port() {
	local port="$1" label="$2"
	local pids
	pids="$(pids_listening "$port" | tr '\n' ' ')"
	pids="${pids%% }"
	if [[ -z "$pids" ]]; then
		return 0
	fi
	echo "replace: stopping $label on :$port (pids $pids)"
	# shellcheck disable=SC2086
	kill $pids 2>/dev/null || true
	sleep 0.2
	local leftover
	leftover="$(pids_listening "$port" | tr '\n' ' ')"
	if [[ -n "${leftover%% }" ]]; then
		# shellcheck disable=SC2086
		kill -9 $leftover 2>/dev/null || true
	fi
	wait_port_free "$port"
}

refuse_if_bound() {
	local bind="$1" label="$2"
	local port pids health
	port="$(port_of "$bind")"
	pids="$(pids_listening "$port" | tr '\n' ' ')"
	pids="${pids%% }"
	if [[ -z "$pids" ]]; then
		return 0
	fi
	health="$(curl -fsS --max-time 1 "http://$bind/healthz" 2>/dev/null || true)"
	echo "$label already bound at $bind (pids $pids)" >&2
	if [[ -n "$health" ]]; then
		echo "  healthz: $health" >&2
	fi
	echo "this script must own the mux gateway (this clone's 17.3.7 CLI)." >&2
	echo "stop those pids, or re-run with --replace" >&2
	exit 1
}

wait_http() {
	local url="$1"
	local i
	for i in $(seq 1 50); do
		if curl -fsS --max-time 1 "$url" >/dev/null 2>&1; then
			return 0
		fi
		sleep 0.1
	done
	return 1
}

need_cmd bun
need_cmd curl
need_file "$OMP_CLI"

OMP_VERSION="$(omp_cli --version 2>/dev/null | head -n 1 || true)"
if [[ "$OMP_VERSION" != *17.3.* && "$OMP_VERSION" != *17.4.* && "$OMP_VERSION" != *17.5.* ]]; then
	echo "clone CLI is not 17.3+ (got ${OMP_VERSION:-empty}). mux will be missing." >&2
	echo "expected: $OMP_CLI" >&2
	exit 1
fi

echo "omp     $OMP_CLI  ($OMP_VERSION)"

started_broker=0
cleanup() {
	local pid
	for pid in "${STARTED_PIDS[@]+"${STARTED_PIDS[@]}"}"; do
		kill "$pid" 2>/dev/null || true
	done
}
trap cleanup EXIT

if [[ "$REPLACE" -eq 1 ]]; then
	kill_port "$(port_of "$GATEWAY_BIND")" "gateway"
	if [[ "$WITH_SWITCHYARD" -eq 1 ]]; then
		kill_port "$(port_of "$SWITCHYARD_BIND")" "switchyard"
	fi
else
	refuse_if_bound "$GATEWAY_BIND" "gateway"
	if [[ "$WITH_SWITCHYARD" -eq 1 ]]; then
		refuse_if_bound "$SWITCHYARD_BIND" "switchyard"
	fi
fi

broker_health="$(curl -fsS --max-time 1 "$BROKER_URL/v1/healthz" 2>/dev/null || true)"
broker_ok=0
if [[ -n "$broker_health" ]]; then
	broker_ok=1
fi
# Usage probes (OpenRouter credits included) run inside the broker. A 17.1.8
# vault will never emit them — replace it with this clone's CLI.
if [[ "$broker_ok" -eq 1 && "$REPLACE_BROKER" -eq 0 ]]; then
	if ! printf '%s' "$broker_health" | grep -q '17\.3\|17\.4\|17\.5'; then
		echo "broker  $BROKER_URL  $broker_health  (too old for OpenRouter credits; replacing)"
		REPLACE_BROKER=1
	fi
fi
if [[ "$REPLACE_BROKER" -eq 1 ]]; then
	broker_bind="${BROKER_URL#http://}"
	broker_bind="${broker_bind#https://}"
	kill_port "$(port_of "$broker_bind")" "broker"
	broker_ok=0
fi
if [[ "$broker_ok" -eq 0 ]]; then
	if [[ "$START_BROKER" -eq 0 ]]; then
		echo "broker is not up at $BROKER_URL" >&2
		echo "re-run without --no-broker-start, or: $OMP_CLI auth-broker serve" >&2
		exit 1
	fi
	echo "broker  $BROKER_URL  starting ($OMP_VERSION)"
	omp_cli auth-broker serve &
	STARTED_PIDS+=("$!")
	started_broker=1
	if ! wait_http "$BROKER_URL/v1/healthz"; then
		echo "broker failed to become healthy at $BROKER_URL" >&2
		exit 1
	fi
fi

if [[ ! -f "$TOKEN_FILE" ]]; then
	echo "No broker token at $TOKEN_FILE after broker start" >&2
	exit 1
fi

export OMP_AUTH_BROKER_URL="$BROKER_URL"
export OMP_AUTH_BROKER_TOKEN
OMP_AUTH_BROKER_TOKEN="$(tr -d '[:space:]' <"$TOKEN_FILE")"
export OMP_AUTH_GATEWAY_BIND="$GATEWAY_BIND"
export OMP_ROUTING_LOG_PATH="${ROUTING_LOG}"
export SWITCHYARD_BIND
if [[ -n "$OMP_MUX_URL" ]]; then
	export OMP_MUX_URL
fi

# Gateway inbound auth is ~/.omp/auth-gateway.token (ensureToken), not the
# broker token. Switchyard's api_key_env must match that file or it 401s.
if [[ ! -s "$GATEWAY_TOKEN_FILE" ]]; then
	omp_cli auth-gateway token >/dev/null
fi
if [[ ! -s "$GATEWAY_TOKEN_FILE" ]]; then
	echo "failed to create $GATEWAY_TOKEN_FILE" >&2
	exit 1
fi
export OMP_AUTH_GATEWAY_TOKEN
OMP_AUTH_GATEWAY_TOKEN="$(tr -d '[:space:]' <"$GATEWAY_TOKEN_FILE")"

echo "broker  $BROKER_URL  ok"
echo "gateway $GATEWAY_BIND  mux/cheap + mux/capable  ($OMP_VERSION)"

omp_cli auth-gateway serve --bind="$GATEWAY_BIND" &
STARTED_PIDS+=("$!")
gw_pid="${STARTED_PIDS[-1]}"

if ! wait_http "http://$GATEWAY_BIND/healthz"; then
	echo "gateway failed to become healthy at $GATEWAY_BIND" >&2
	exit 1
fi

gw_health="$(curl -fsS --max-time 2 "http://$GATEWAY_BIND/healthz")"
if ! printf '%s' "$gw_health" | grep -q '17\.3\|17\.4\|17\.5'; then
	echo "gateway came up without 17.3+ in healthz: $gw_health" >&2
	echo "mux is not in this process. start.sh must use $OMP_CLI, not PATH omp." >&2
	exit 1
fi

mux_json="$(curl -fsS --max-time 2 -H "Authorization: Bearer $OMP_AUTH_GATEWAY_TOKEN" "http://$GATEWAY_BIND/v1/mux" || true)"
if ! printf '%s' "$mux_json" | grep -q 'mux/cheap'; then
	echo "GET /v1/mux failed — this is not the quota-router gateway." >&2
	echo "healthz: $gw_health" >&2
	echo "mux: ${mux_json:-empty}" >&2
	exit 1
fi
echo "mux     http://$GATEWAY_BIND/v1/mux  ok"

if [[ "$WITH_SWITCHYARD" -eq 1 ]]; then
	need_cmd switchyard-server
	routes="$("$DIR/render-config.sh" "${RENDER_ARGS[@]}")"
	sy_host="$(host_of "$SWITCHYARD_BIND")"
	sy_port="$(port_of "$SWITCHYARD_BIND")"
	echo "switchyard ${sy_host}:${sy_port}  mux=${OMP_MUX_URL:-http://${GATEWAY_BIND}/v1}"
	echo "rendered $routes"
	# switchyard is the remaining foreground process
	trap 'kill "$gw_pid" 2>/dev/null || true; if [[ "$started_broker" -eq 1 ]]; then kill "${STARTED_PIDS[0]}" 2>/dev/null || true; fi' EXIT
	exec switchyard-server --config "$routes" --host "$sy_host" --port "$sy_port" --routing-log-file "$ROUTING_LOG"
fi

# Gateway is the remaining foreground process. Drop the EXIT trap so we
# do not kill it the moment exec replaces us — but we *are* exec'ing it,
# so the backgrounded serve must be reaped first? No: exec replaces this
# shell, the background bun stays. Clear the trap so EXIT does not fire
# a kill on the child we want to keep.
trap - EXIT
# We already have a live gateway child. Wait on it so Ctrl-C stops the stack
# we started (broker only if we started it).
if [[ "$started_broker" -eq 1 ]]; then
	trap 'kill "$gw_pid" 2>/dev/null || true; kill "${STARTED_PIDS[0]}" 2>/dev/null || true' EXIT INT TERM
else
	trap 'kill "$gw_pid" 2>/dev/null || true' EXIT INT TERM
fi
wait "$gw_pid"
