#!/usr/bin/env bash
# Smoke test of a running Brain: healthz, whoami (REST), start_here (MCP streamable HTTP).
#   deploy/smoke.sh <url> <token>
#   deploy/smoke.sh https://brain.example.com "$BRAIN_TOKEN"
# Needs curl. The token is sent only as an Authorization header to <url>. Exit 0 = all checks passed.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <url> <token>" >&2
  exit 2
fi
URL="${1%/}"
TOKEN="$2"
FAILED=0
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

check() { # name, expected-status, grep-pattern, curl args...
  local name="$1" want="$2" pattern="$3"
  shift 3
  local code
  code="$(curl -sS -o "$TMP" -w '%{http_code}' --max-time 20 "$@" || echo 000)"
  if [ "$code" = "$want" ] && grep -q -- "$pattern" "$TMP"; then
    echo "ok   $name ($code)"
  else
    echo "FAIL $name: HTTP $code, body: $(head -c 300 "$TMP")" >&2
    FAILED=1
  fi
}

check healthz 200 '"ok":true' "$URL/healthz"

check whoami 200 '"ok":true' -X POST "$URL/api/v1/ops/whoami" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'

check "unauthenticated is refused" 401 'unauthenticated' -X POST "$URL/api/v1/ops/whoami" \
  -H 'Content-Type: application/json' -d '{}'

MCP_HEADERS=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')

check "mcp initialize" 200 '"serverInfo"' -X POST "$URL/mcp/v1" "${MCP_HEADERS[@]}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"brain-smoke","version":"1"}}}'

check "mcp start_here" 200 '"result"' -X POST "$URL/mcp/v1" "${MCP_HEADERS[@]}" -H 'MCP-Protocol-Version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"start_here","arguments":{}}}'
if grep -q '"isError":true' "$TMP"; then
  echo "FAIL mcp start_here returned isError: $(head -c 300 "$TMP")" >&2
  FAILED=1
fi

if [ "$FAILED" -ne 0 ]; then
  echo "smoke: FAILED" >&2
  exit 1
fi
echo "smoke: ok"
