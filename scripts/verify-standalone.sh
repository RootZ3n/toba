#!/usr/bin/env bash
# Toba standalone verification
# ================================
# Proves Toba runs standalone by exercising the public API surface.
# Exits non-zero on any failure.
#
# Usage:
#   ./scripts/verify-standalone.sh
#   TOBA_URL=http://127.0.0.1:18815 ./scripts/verify-standalone.sh
#
# Intentionally does not touch Peh. If Peh is running it is
# irrelevant; if it is stopped that is the strongest possible signal of
# independence.

set -uo pipefail   # no -e: we use a custom check helper

TOBA_URL="${TOBA_URL:-http://127.0.0.1:18815}"

pass=0; fail=0
# check NAME SHELL_EXPR — eval the expression; success = exit 0.
check() {
  local name="$1"; shift
  if eval "$*" >/dev/null 2>&1; then
    echo "  PASS  $name"
    pass=$((pass+1))
  else
    echo "  FAIL  $name"
    fail=$((fail+1))
  fi
}

echo "── Toba standalone verification ────────────────────────────────────"
echo "Target: $TOBA_URL"
echo ""

echo "[1] Service reachable"
check "GET /health returns ok=true"          '[ "$(curl -fsS '"$TOBA_URL"'/health | jq -r .ok)" = "true" ]'
check "GET /version reports service=toba"  '[ "$(curl -fsS '"$TOBA_URL"'/version | jq -r .service)" = "toba" ]'
check "GET /version reports v5+ schema"      '[ "$(curl -fsS '"$TOBA_URL"'/version | jq -r .schema_version)" -ge 5 ]'

echo ""
echo "[2] Standalone mode (no Peh required)"
status_json="$(curl -fsS "$TOBA_URL/status")"
export status_json
check "mode == standalone"             '[ "$(echo "$status_json" | jq -r .mode)" = "standalone" ]'
check "receipts_enabled == true"       '[ "$(echo "$status_json" | jq -r .receipts_enabled)" = "true" ]'
check "velum_enabled   == true"        '[ "$(echo "$status_json" | jq -r .velum_enabled)" = "true" ]'
check "bridge_enabled  defaults false" '[ "$(echo "$status_json" | jq -r .bridge_enabled)" = "false" ]'

echo ""
echo "[3] Native provider system"
prov_json="$(curl -fsS "$TOBA_URL/toba/provider")"
export prov_json
check "GET /toba/provider returns ok=true" '[ "$(echo "$prov_json" | jq -r .ok)" = "true" ]'
check "available_providers includes ollama"  'echo "$prov_json" | jq -e ".provider.available_providers | map(.id) | contains([\"ollama\"])"'
check "available_providers includes echo"    'echo "$prov_json" | jq -e ".provider.available_providers | map(.id) | contains([\"echo\"])"'
check "api_key never leaked in status"       '! echo "$prov_json" | jq -r ".. | strings?" | grep -qE "(sk-[A-Za-z0-9_-]{10,}|api[-_]key[\"=:]+[A-Za-z0-9])"'

echo ""
echo "[4] Runtime provider selection works"
sel_json="$(curl -fsS -X PATCH "$TOBA_URL/toba/provider" -H "content-type: application/json" -d '{"provider":"echo","model":"verify-debug"}')"
export sel_json
check "PATCH /toba/provider selects echo"  '[ "$(echo "$sel_json" | jq -r .provider.provider)" = "echo" ]'
check "echo provider is local"               '[ "$(echo "$sel_json" | jq -r .provider.local)" = "true" ]'

echo ""
echo "[5] Dux chat works standalone via echo provider"
chat_json="$(curl -fsS -X POST "$TOBA_URL/toba/dux/chat" -H "content-type: application/json" -d '{"message":"verify-standalone"}')"
export chat_json
check "Dux chat returns ok=true"             '[ "$(echo "$chat_json" | jq -r .ok)" = "true" ]'
check "Dux chat used echo provider"          '[ "$(echo "$chat_json" | jq -r .provider.provider)" = "echo" ]'
check "Dux chat reply echoes input"          'echo "$chat_json" | jq -r .reply | grep -q "verify-standalone"'

echo ""
echo "[6] Velum runs BEFORE provider for sensitive data"
sens_json="$(curl -fsS -X POST "$TOBA_URL/toba/dux/chat" -H "content-type: application/json" -d '{"message":"contact me at person@example.test"}')"
export sens_json
check "Velum redacted email field"           'echo "$sens_json" | jq -e ".velum.fields_redacted | contains([\"email\"])"'
check "Provider never saw raw email"         '! echo "$sens_json" | jq -r .reply | grep -q "person@example.test"'

echo ""
echo "[7] Receipts written for provider calls"
receipts_json="$(curl -fsS "$TOBA_URL/toba/receipts?action=model_call&limit=5")"
export receipts_json
check "model_call receipt exists"            '[ "$(echo "$receipts_json" | jq -r ".receipts | length")" -gt 0 ]'
check "receipt records provider=echo"        '[ "$(echo "$receipts_json" | jq -r ".receipts[0].provider")" = "echo" ]'

velum_receipts_json="$(curl -fsS "$TOBA_URL/toba/receipts?action=velum_review&limit=5")"
export velum_receipts_json
check "velum_review receipt exists"          '[ "$(echo "$velum_receipts_json" | jq -r ".receipts | length")" -gt 0 ]'

echo ""
echo "[8] Job Scout context is standalone"
js_json="$(curl -fsS "$TOBA_URL/toba/job-scout/context")"
export js_json
check "/job-scout/context returns ok=true"           '[ "$(echo "$js_json" | jq -r .ok)" = "true" ]'
check "honest: live_search_implemented == false"     '[ "$(echo "$js_json" | jq -r .live_search_implemented)" = "false" ]'
check "ingestion_mode = manual_or_external_tool"     '[ "$(echo "$js_json" | jq -r .ingestion_mode)" = "manual_or_external_tool" ]'

echo ""
echo "[9] Campaign dashboard works"
dash_json="$(curl -fsS "$TOBA_URL/toba/dashboard")"
export dash_json
check "GET /toba/dashboard returns ok=true" '[ "$(echo "$dash_json" | jq -r .ok)" = "true" ]'

echo ""
echo "[10] Velum endpoint review works"
v_json="$(curl -fsS -X POST "$TOBA_URL/toba/velum/review" -H "content-type: application/json" -d '{"text":"call 555-123-4567"}')"
export v_json
check "POST /toba/velum/review redacted phone"     'echo "$v_json" | jq -e ".velum.fields_redacted | contains([\"phone\"])"'

echo ""
echo "[11] No outbound Peh dependency in surface output"
combined="$(echo "$status_json $prov_json $chat_json")"
export combined
check "no 18791 leaks in standard responses"           '! echo "$combined" | grep -q "18791"'
check "no bridge claim in standalone status"           '[ "$(echo "$status_json" | jq -r .bridge_enabled)" = "false" ]'

echo ""
echo "── Reset provider to unconfigured (cleanup) ──"
curl -fsS -X PATCH "$TOBA_URL/toba/provider" -H "content-type: application/json" \
  -d '{"provider":"none","model":"none"}' >/dev/null && echo "  provider reset"

echo ""
echo "════════════════════════════════════════════════════"
echo "Results: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  echo "STANDALONE VERIFICATION FAILED"
  exit 1
fi
echo "STANDALONE VERIFIED — Toba runs standalone."
