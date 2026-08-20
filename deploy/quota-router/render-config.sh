#!/usr/bin/env bash
# Render Switchyard TOML (and an omp models snippet) from bind/url params.
# Switchyard does not interpolate env in base_url — only api_key_env.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
GATEWAY_BIND="${OMP_AUTH_GATEWAY_BIND:-127.0.0.1:4010}"
SWITCHYARD_BIND="${SWITCHYARD_BIND:-127.0.0.1:4001}"
OMP_MUX_URL="${OMP_MUX_URL:-http://${GATEWAY_BIND}/v1}"
# Prefer XDG_RUNTIME_DIR only when it already exists and is writable
# (WSL often sets it to /run/user/$UID which is missing).
if [[ -n "${OMP_QUOTA_RENDER_DIR:-}" ]]; then
	OUT_DIR="$OMP_QUOTA_RENDER_DIR"
elif [[ -n "${XDG_RUNTIME_DIR:-}" && -d "${XDG_RUNTIME_DIR}" && -w "${XDG_RUNTIME_DIR}" ]]; then
	OUT_DIR="${XDG_RUNTIME_DIR}/omp-quota-router"
else
	OUT_DIR="${TMPDIR:-/tmp}/omp-quota-router-$UID"
fi

usage() {
	cat <<EOF
Usage: $(basename "$0") [--gateway-bind HOST:PORT] [--switchyard-bind HOST:PORT] [--mux-url URL] [--out-dir DIR]

Switchyard cannot read env vars in base_url. This writes a concrete routes.toml.

Defaults:
  --gateway-bind     ${GATEWAY_BIND}   (or OMP_AUTH_GATEWAY_BIND)
  --switchyard-bind  ${SWITCHYARD_BIND}   (or SWITCHYARD_BIND)
  --mux-url          ${OMP_MUX_URL}   (or OMP_MUX_URL)
  --out-dir          ${OUT_DIR}

Prints the rendered routes.toml path on stdout.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--gateway-bind)
		GATEWAY_BIND="$2"
		OMP_MUX_URL="${OMP_MUX_URL:-http://${GATEWAY_BIND}/v1}"
		shift 2
		;;
	--switchyard-bind)
		SWITCHYARD_BIND="$2"
		shift 2
		;;
	--mux-url)
		OMP_MUX_URL="$2"
		shift 2
		;;
	--out-dir)
		OUT_DIR="$2"
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

mkdir -p "$OUT_DIR"
export OMP_MUX_URL
# ${VAR} only — no other expansion. envsubst if present, else python.
if command -v envsubst >/dev/null 2>&1; then
	envsubst '${OMP_MUX_URL}' <"$DIR/routes.toml.tmpl" >"$OUT_DIR/routes.toml"
else
	python3 - "$DIR/routes.toml.tmpl" "$OUT_DIR/routes.toml" <<'PY'
import os, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
open(dst, "w", encoding="utf-8").write(text.replace("${OMP_MUX_URL}", os.environ["OMP_MUX_URL"]))
PY
fi

cat >"$OUT_DIR/models.snippet.yml" <<EOF
# Generated. Point omp custom providers at this mux / switchyard pair.
# Gateway (mux/cheap, mux/capable): ${OMP_MUX_URL}
# Switchyard (fleet, ship): http://${SWITCHYARD_BIND}/v1
providers:
  mux:
    baseUrl: ${OMP_MUX_URL}
    api: openai-completions
    apiKey: OMP_AUTH_GATEWAY_TOKEN
    authHeader: true
    models:
      - id: cheap
        name: Quota mux (cheap / Flash)
        input: [text, image]
        contextWindow: 1000000
        maxTokens: 32000
      - id: capable
        name: Quota mux (capable / sub seat)
        input: [text, image]
        contextWindow: 1000000
        maxTokens: 128000
      - id: vision
        name: Quota mux (vision)
        input: [text, image]
        contextWindow: 262144
        maxTokens: 131072
  switchyard:
    baseUrl: http://${SWITCHYARD_BIND}/v1
    api: openai-completions
    apiKey: OMP_AUTH_GATEWAY_TOKEN
    authHeader: true
    models:
      - id: fleet
        name: Switchyard fleet (cheap-first)
        input: [text, image]
        contextWindow: 1000000
        maxTokens: 32000
      - id: ship
        name: Switchyard ship (escalate)
        input: [text, image]
        contextWindow: 1000000
        maxTokens: 128000
EOF

# so start.sh can split host/port
printf '%s\n' "$SWITCHYARD_BIND" >"$OUT_DIR/switchyard.bind"
printf '%s\n' "$GATEWAY_BIND" >"$OUT_DIR/gateway.bind"
printf '%s\n' "$OMP_MUX_URL" >"$OUT_DIR/mux.url"

echo "$OUT_DIR/routes.toml"
