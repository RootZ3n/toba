#!/usr/bin/env bash
# Toba one-command setup wizard
# =================================
# Idempotent. Re-runnable. Never prints secrets. Backs up before mutating.
#
#   cd /mnt/ai/cursus
#   ./scripts/toba-setup.sh
#
# What it does:
#   1. Preflight (cwd, pnpm, systemctl, current service config, .env, tailscale)
#   2. pnpm test + typecheck + build — abort on failure
#   3. Migration to /mnt/ai/cursus if service still runs from legacy path
#   4. Provider wizard (ollama / openrouter / echo / skip), .env atomic write + chmod 600
#   5. Dux agent wizard — assign provider/model per agent via local API
#   6. Optional Tailscale wizard — bind 0.0.0.0, generate auth token, REQUIRE_AUTH
#   7. Verification bundle (verify-standalone + verify-tailscale-ready)
#   8. Clean final summary
#
# Flags:
#   --non-interactive      Take no input; use defaults; skip provider/Tailscale wizards
#   --skip-tests           Skip the pnpm test step (NOT recommended)
#   --skip-migrate         Don't touch /etc/systemd/system/toba.service
#   --base-url URL         Override the URL used for API probes (default http://127.0.0.1:18815)
#
# Exit codes:
#   0  success
#   1  preflight failed / generic error
#   2  tests failed
#   3  migration failed
#   4  service did not come up healthy after a restart
#   5  verification bundle failed

set -uo pipefail

# ── Constants ────────────────────────────────────────────────────────────────
CANONICAL_DIR="/mnt/ai/cursus"
SERVICE_NAME="toba.service"
SERVICE_UNIT="/etc/systemd/system/${SERVICE_NAME}"
ENV_FILE="${CANONICAL_DIR}/.env"
DEFAULT_BASE_URL="http://127.0.0.1:18815"

# ── Args ────────────────────────────────────────────────────────────────────
NON_INTERACTIVE=0
SKIP_TESTS=0
SKIP_MIGRATE=0
BASE_URL="$DEFAULT_BASE_URL"
for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --skip-tests)      SKIP_TESTS=1 ;;
    --skip-migrate)    SKIP_MIGRATE=1 ;;
    --base-url=*)      BASE_URL="${arg#*=}" ;;
    --base-url)        shift; BASE_URL="${1:-$DEFAULT_BASE_URL}" ;;
    --help|-h)
      sed -n '2,30p' "$0"; exit 0 ;;
  esac
done

# ── Colors / output helpers ─────────────────────────────────────────────────
if [ -t 1 ]; then
  C_DIM=$'\e[2m'; C_RST=$'\e[0m'; C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_BOLD=$'\e[1m'; C_INFO=$'\e[36m'
else
  C_DIM=""; C_RST=""; C_OK=""; C_WARN=""; C_ERR=""; C_BOLD=""; C_INFO=""
fi
say()   { printf "%s\n" "$*"; }
hr()    { printf -- "%s\n" "────────────────────────────────────────────────────────────────────"; }
banner(){ hr; printf "%s%s%s\n" "$C_BOLD" "$1" "$C_RST"; hr; }
note()  { printf "%s%s%s\n" "$C_DIM" "$1" "$C_RST"; }
info()  { printf "%s%s%s\n" "$C_INFO" "$1" "$C_RST"; }
ok()    { printf "%s✓ %s%s\n" "$C_OK"   "$1" "$C_RST"; }
warn()  { printf "%s! %s%s\n" "$C_WARN" "$1" "$C_RST"; }
err()   { printf "%s✗ %s%s\n" "$C_ERR"  "$1" "$C_RST"; }
fail()  { err "$1"; exit "${2:-1}"; }

# Read a yes/no answer with default. Honors --non-interactive.
# usage: ask_yn "Prompt?" [Y|N]  -> sets $REPLY_YN to "y" or "n"
REPLY_YN=""
ask_yn() {
  local prompt="$1"; local default="${2:-Y}"; local hint
  if [ "$default" = "Y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  if [ "$NON_INTERACTIVE" = "1" ]; then
    REPLY_YN="$(echo "$default" | tr '[:upper:]' '[:lower:]')"
    say "$prompt $hint  (non-interactive → $REPLY_YN)"
    return
  fi
  local raw
  printf "%s %s " "$prompt" "$hint"
  IFS= read -r raw || true
  raw="$(echo "${raw:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  if [ -z "$raw" ]; then raw="$(echo "$default" | tr '[:upper:]' '[:lower:]')"; fi
  case "$raw" in y|yes) REPLY_YN="y" ;; n|no) REPLY_YN="n" ;; *) REPLY_YN="$(echo "$default" | tr '[:upper:]' '[:lower:]')";; esac
}

# ask_str "Prompt:" "default" -> $REPLY_STR
REPLY_STR=""
ask_str() {
  local prompt="$1"; local default="${2:-}"
  if [ "$NON_INTERACTIVE" = "1" ]; then REPLY_STR="$default"; say "$prompt [${default}]  (non-interactive)"; return; fi
  local raw
  if [ -n "$default" ]; then printf "%s [%s] " "$prompt" "$default"; else printf "%s " "$prompt"; fi
  IFS= read -r raw || true
  if [ -z "${raw:-}" ]; then REPLY_STR="$default"; else REPLY_STR="$raw"; fi
}

# ask_secret "Prompt:"  -> $REPLY_SECRET (NEVER echoed, NEVER logged)
REPLY_SECRET=""
ask_secret() {
  local prompt="$1"
  if [ "$NON_INTERACTIVE" = "1" ]; then REPLY_SECRET=""; say "$prompt  (non-interactive → empty)"; return; fi
  printf "%s " "$prompt"
  IFS= read -rs REPLY_SECRET || true
  printf "\n"
}

# ── Sudo helper ─────────────────────────────────────────────────────────────
SUDO=""
require_sudo() {
  if [ "$(id -u)" -eq 0 ]; then SUDO=""; return; fi
  if ! command -v sudo >/dev/null 2>&1; then
    fail "This step needs root (sudo) and sudo is not installed." 1
  fi
  SUDO="sudo"
}

# ── Backup helper ───────────────────────────────────────────────────────────
backup_file() {
  local src="$1"
  [ -f "$src" ] || return 0
  local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
  local dst="${src}.bak.${stamp}"
  cp -a "$src" "$dst"
  note "  backup: ${dst}"
}

# ── .env atomic update ──────────────────────────────────────────────────────
# upsert_env KEY VALUE  — adds or replaces KEY=VALUE in ENV_FILE atomically.
# Values are written raw; do not pass anything you wouldn't put in a shell .env.
upsert_env() {
  local key="$1"; local val="$2"
  local dir; dir="$(dirname "$ENV_FILE")"
  mkdir -p "$dir"
  local tmp; tmp="$(mktemp "${dir}/.env.upsert.XXXXXX")"
  trap 'rm -f "$tmp"' RETURN
  if [ -f "$ENV_FILE" ]; then
    awk -v K="$key" -v V="$val" '
      BEGIN { written = 0 }
      $0 ~ "^" K "=" { print K "=" V; written = 1; next }
      { print }
      END   { if (!written) print K "=" V }
    ' "$ENV_FILE" > "$tmp"
  else
    printf "%s=%s\n" "$key" "$val" > "$tmp"
  fi
  mv -f "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

# ── Step 1: Preflight ───────────────────────────────────────────────────────
banner "Toba Setup Wizard"

# Cwd check
CURRENT_DIR="$(pwd -P)"
if [ "$CURRENT_DIR" != "$CANONICAL_DIR" ]; then
  warn "Not running from ${CANONICAL_DIR} (got ${CURRENT_DIR})."
  if [ -d "$CANONICAL_DIR" ]; then
    note "  Switching to ${CANONICAL_DIR}"
    cd "$CANONICAL_DIR" || fail "Cannot cd to ${CANONICAL_DIR}" 1
  else
    fail "${CANONICAL_DIR} does not exist." 1
  fi
fi
ok "Working directory: ${CANONICAL_DIR}"

command -v pnpm >/dev/null 2>&1 || fail "pnpm not on PATH. Install pnpm first." 1
ok "pnpm available: $(pnpm --version)"

HAS_SYSTEMD=0
if command -v systemctl >/dev/null 2>&1; then HAS_SYSTEMD=1; ok "systemd available"; else warn "systemctl not found — skipping service-level operations"; fi

# Service config detection
SERVICE_ACTIVE="no"; SERVICE_WORKDIR=""; SERVICE_DBPATH=""; SERVICE_HOST=""; SERVICE_PORT=""
if [ "$HAS_SYSTEMD" = "1" ]; then
  SERVICE_ACTIVE="$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo no)"
  if [ -f "$SERVICE_UNIT" ]; then
    SERVICE_WORKDIR="$(awk -F= '/^WorkingDirectory=/{print $2}' "$SERVICE_UNIT" | head -1)"
    SERVICE_DBPATH="$(awk -F= '/^Environment=(TOBA|CURSUS)_DB_PATH=/{print substr($0, index($0,"=")+1)}' "$SERVICE_UNIT" | sed 's/^[A-Z_]*_DB_PATH=//' | head -1)"
    SERVICE_HOST="$(awk -F= '/^Environment=(TOBA|CURSUS)_HOST=/{print substr($0, index($0,"=")+1)}' "$SERVICE_UNIT" | sed 's/^[A-Z_]*_HOST=//' | head -1)"
    SERVICE_PORT="$(awk -F= '/^Environment=(TOBA|CURSUS)_PORT=/{print substr($0, index($0,"=")+1)}' "$SERVICE_UNIT" | sed 's/^[A-Z_]*_PORT=//' | head -1)"
  fi
  printf "  service: %s · WorkingDirectory=%s · DB=%s · %s:%s\n" \
    "$SERVICE_ACTIVE" "${SERVICE_WORKDIR:-?}" "${SERVICE_DBPATH:-?}" "${SERVICE_HOST:-?}" "${SERVICE_PORT:-?}"
fi

ENV_PRESENT="no"; [ -f "$ENV_FILE" ] && ENV_PRESENT="yes"
ok ".env: ${ENV_PRESENT} (${ENV_FILE})"

TAILSCALE_AVAILABLE="no"; TAILSCALE_IP=""
if command -v tailscale >/dev/null 2>&1; then
  TAILSCALE_AVAILABLE="yes"
  TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  ok "Tailscale: yes${TAILSCALE_IP:+ (ip=${TAILSCALE_IP})}"
else
  note "Tailscale not installed — Tailscale wizard will be unavailable."
fi

# ── Step 2: Build/test verification ─────────────────────────────────────────
if [ "$SKIP_TESTS" = "1" ]; then
  warn "Skipping tests (--skip-tests)"
else
  banner "Verifying source"
  info "pnpm install (silent)"
  pnpm install --silent 2>&1 | tail -3 || fail "pnpm install failed" 2
  ok "deps installed"

  info "pnpm typecheck"
  if ! pnpm typecheck >/tmp/toba-setup-typecheck.log 2>&1; then
    err "typecheck failed — log: /tmp/toba-setup-typecheck.log"
    tail -20 /tmp/toba-setup-typecheck.log
    exit 2
  fi
  ok "typecheck clean"

  info "pnpm test"
  if ! pnpm test >/tmp/toba-setup-test.log 2>&1; then
    err "tests failed — log: /tmp/toba-setup-test.log"
    tail -25 /tmp/toba-setup-test.log
    exit 2
  fi
  TESTS_LINE="$(grep -E "^ *Tests" /tmp/toba-setup-test.log | tail -1 || echo "")"
  ok "tests passed${TESTS_LINE:+ — $TESTS_LINE}"

  info "pnpm build"
  if ! pnpm build >/tmp/toba-setup-build.log 2>&1; then
    err "build failed — log: /tmp/toba-setup-build.log"
    tail -20 /tmp/toba-setup-build.log
    exit 2
  fi
  ok "build clean"
fi

# ── Step 3: Migration ───────────────────────────────────────────────────────
NEEDS_MIGRATION=0
if [ "$HAS_SYSTEMD" = "1" ] && [ -n "$SERVICE_WORKDIR" ] && [ "$SERVICE_WORKDIR" != "$CANONICAL_DIR" ]; then
  NEEDS_MIGRATION=1
fi

if [ "$NEEDS_MIGRATION" = "1" ] && [ "$SKIP_MIGRATE" != "1" ]; then
  banner "Service migration to ${CANONICAL_DIR}"
  warn "toba.service WorkingDirectory=${SERVICE_WORKDIR} differs from canonical."
  ask_yn "Migrate toba.service to ${CANONICAL_DIR} now? (stops service ~10s)" "Y"
  if [ "$REPLY_YN" = "y" ]; then
    require_sudo
    if [ -x "${CANONICAL_DIR}/scripts/migrate-to-canonical.sh" ]; then
      info "Running migrate-to-canonical.sh (sudo required)…"
      $SUDO "${CANONICAL_DIR}/scripts/migrate-to-canonical.sh" || fail "Migration script failed" 3
    else
      err "Migration script missing at scripts/migrate-to-canonical.sh"
      exit 3
    fi
    ok "Service migrated"
  else
    warn "Migration skipped. Service is still running from ${SERVICE_WORKDIR}."
  fi
elif [ "$NEEDS_MIGRATION" = "0" ]; then
  ok "Service is already on canonical path (${SERVICE_WORKDIR:-not yet installed})"
fi

# Helper to restart toba.service (after env changes) and wait for /health.
restart_and_wait() {
  if [ "$HAS_SYSTEMD" != "1" ]; then warn "  no systemd — skipping restart"; return; fi
  if ! systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}"; then
    warn "  ${SERVICE_NAME} is not installed yet — skipping restart"
    return
  fi
  require_sudo
  info "Restarting ${SERVICE_NAME}…"
  $SUDO systemctl restart "$SERVICE_NAME" || fail "systemctl restart failed" 4
  local tries=0; local max=20
  while [ "$tries" -lt "$max" ]; do
    if curl -fsS --max-time 1 "${BASE_URL}/health" >/dev/null 2>&1; then
      ok "  service healthy"
      return
    fi
    tries=$((tries+1)); sleep 0.5
  done
  err "  service did not return healthy /health within ~10s"
  $SUDO journalctl -u "$SERVICE_NAME" -n 20 --no-pager || true
  exit 4
}

# ── Helper: PATCH /toba/provider via local API (or, when auth required, with token) ─
patch_provider() {
  local body="$1"
  local token="${TOBA_AUTH_TOKEN_RUNTIME:-}"
  local hdr=()
  [ -n "$token" ] && hdr=(-H "Authorization: Bearer $token")
  curl -fsS -X PATCH "${BASE_URL}/toba/provider" \
    -H 'content-type: application/json' "${hdr[@]}" \
    -d "$body" >/dev/null
}
patch_agent() {
  local id="$1"; local body="$2"
  local token="${TOBA_AUTH_TOKEN_RUNTIME:-}"
  local hdr=()
  [ -n "$token" ] && hdr=(-H "Authorization: Bearer $token")
  curl -fsS -X PATCH "${BASE_URL}/toba/dux/agents/${id}" \
    -H 'content-type: application/json' "${hdr[@]}" \
    -d "$body" >/dev/null
}

# ── Step 4: Provider wizard ─────────────────────────────────────────────────
banner "Provider configuration"
PROVIDER_CHOICE=""
PROVIDER_MODEL=""
HAS_OPENROUTER_KEY=0
if [ "$NON_INTERACTIVE" = "1" ]; then
  warn "Non-interactive — leaving provider unchanged"
else
  cat <<EOF
Select an LLM provider for Dux chat:
  1) ollama        — local Ollama (TOBA_LOCAL_ONLY=true)
  2) openrouter    — OpenRouter (default model: deepseek/deepseek-v4-pro)
  3) echo          — local debug echo (no real model)
  4) skip          — leave unconfigured

EOF
  ask_str "Choice [1-4]" "1"
  PROVIDER_CHOICE="$REPLY_STR"
  case "$PROVIDER_CHOICE" in
    1|ollama)
      ask_str "Ollama model name" "llama3"
      PROVIDER_MODEL="$REPLY_STR"
      backup_file "$ENV_FILE"
      upsert_env TOBA_PROVIDER         ollama
      upsert_env TOBA_MODEL            "$PROVIDER_MODEL"
      upsert_env TOBA_PROVIDER_BASE_URL "http://127.0.0.1:11434"
      upsert_env TOBA_LOCAL_ONLY       true
      ok "Ollama selected — model: ${PROVIDER_MODEL}"
      ;;
    2|openrouter)
      ask_str "OpenRouter model slug" "deepseek/deepseek-v4-pro"
      PROVIDER_MODEL="$REPLY_STR"
      ask_secret "OpenRouter API key (input hidden — press Enter to skip writing key now):"
      backup_file "$ENV_FILE"
      upsert_env TOBA_PROVIDER          openrouter
      upsert_env TOBA_MODEL             "$PROVIDER_MODEL"
      upsert_env TOBA_PROVIDER_BASE_URL "https://openrouter.ai/api/v1"
      upsert_env TOBA_LOCAL_ONLY        false
      if [ -n "$REPLY_SECRET" ]; then
        upsert_env TOBA_OPENROUTER_API_KEY "$REPLY_SECRET"
        HAS_OPENROUTER_KEY=1
        ok "OpenRouter selected — model: ${PROVIDER_MODEL} (API key written, chmod 600)"
      else
        warn "OpenRouter selected — model: ${PROVIDER_MODEL} (no API key entered; chat will return 503 until you set TOBA_OPENROUTER_API_KEY)"
      fi
      REPLY_SECRET=""   # forget immediately
      ;;
    3|echo)
      backup_file "$ENV_FILE"
      upsert_env TOBA_PROVIDER  echo
      upsert_env TOBA_MODEL     "toba-echo"
      upsert_env TOBA_LOCAL_ONLY false
      ok "Echo provider selected (debug only)"
      ;;
    4|skip|*)
      info "Provider unchanged — Dux chat will return a friendly 503 until configured."
      PROVIDER_CHOICE="skip"
      ;;
  esac
fi

# Restart so the new env takes effect
if [ "$PROVIDER_CHOICE" != "skip" ] && [ -n "$PROVIDER_CHOICE" ]; then
  restart_and_wait
fi

# ── Step 5: Dux agent wizard ────────────────────────────────────────────────
banner "Dux agents"
AGENTS_JSON=""
if AGENTS_JSON="$(curl -fsS --max-time 5 "${BASE_URL}/toba/dux/agents" 2>/dev/null)"; then
  if command -v jq >/dev/null 2>&1; then
    echo "$AGENTS_JSON" | jq -r '.agents[] | "  \(.id) — \(.role) (\(.provider // "default")/\(.model // "default"))"'
  else
    note "(install jq for a prettier listing)"
  fi
else
  warn "Could not reach ${BASE_URL}/toba/dux/agents (service may not be running)"
fi

if [ "$NON_INTERACTIVE" != "1" ] && [ -n "$AGENTS_JSON" ]; then
  if [ "$PROVIDER_CHOICE" = "2" ] || [ "$PROVIDER_CHOICE" = "openrouter" ]; then
    ask_yn "Route the strategist agent to OpenRouter (${PROVIDER_MODEL})?" "Y"
    if [ "$REPLY_YN" = "y" ]; then
      patch_agent strategist "$(printf '{"provider":"openrouter","model":%s,"base_url":"https://openrouter.ai/api/v1","temperature":0.4}' "$(printf '%s' "$PROVIDER_MODEL" | jq -Rs . 2>/dev/null || printf '"%s"' "$PROVIDER_MODEL")")" \
        && ok "strategist → openrouter/${PROVIDER_MODEL}" \
        || warn "Could not PATCH strategist (provider call may have failed)"
    fi
    ask_yn "Keep the other agents on the global default provider?" "Y"
    [ "$REPLY_YN" = "y" ] && ok "other agents will use the global default (no change)"
  elif [ "$PROVIDER_CHOICE" = "1" ] || [ "$PROVIDER_CHOICE" = "ollama" ]; then
    ask_yn "Assign all agents to the Ollama default? (or leave them as global-default fallback)" "N"
    if [ "$REPLY_YN" = "y" ]; then
      for id in strategist resume-reviewer outreach-drafter job-scout-analyst interview-coach; do
        patch_agent "$id" "$(printf '{"provider":"ollama","model":%s,"local_only":true}' "$(printf '"%s"' "$PROVIDER_MODEL")")" \
          && note "  $id → ollama/${PROVIDER_MODEL}" || true
      done
    fi
  fi
fi

# Sanity: no API-key leakage on /toba/dux/agents
if AGENTS_JSON="$(curl -fsS --max-time 5 "${BASE_URL}/toba/dux/agents" 2>/dev/null)"; then
  if echo "$AGENTS_JSON" | grep -qE 'sk-or-[A-Za-z0-9_-]{8,}|"api_key":"sk-'; then
    err "API key appears in /toba/dux/agents response — refusing to continue"
    exit 1
  fi
  ok "no API-key leak in agents endpoint"
fi

# ── Step 6: Tailscale ───────────────────────────────────────────────────────
banner "Tailscale access"
ENABLE_TAILSCALE="n"
if [ "$NON_INTERACTIVE" = "1" ]; then
  info "Non-interactive — leaving network bind unchanged"
elif [ "$TAILSCALE_AVAILABLE" != "yes" ]; then
  note "Tailscale CLI not installed — skipping."
else
  ask_yn "Make Toba reachable over Tailscale? (binds 0.0.0.0, requires auth token)" "N"
  ENABLE_TAILSCALE="$REPLY_YN"
fi

GENERATED_TOKEN=""
if [ "$ENABLE_TAILSCALE" = "y" ]; then
  # Generate token (printed once below — never persisted in logs).
  GENERATED_TOKEN="$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | xxd -p -c 64)"
  [ -n "$GENERATED_TOKEN" ] || fail "Could not generate auth token (need openssl or xxd)" 1

  backup_file "$ENV_FILE"
  upsert_env TOBA_HOST                   "0.0.0.0"
  upsert_env TOBA_PORT                   "${SERVICE_PORT:-18815}"
  upsert_env TOBA_AUTH_TOKEN             "$GENERATED_TOKEN"
  upsert_env TOBA_REQUIRE_AUTH           "true"
  upsert_env TOBA_ALLOW_LOOPBACK_NO_AUTH "false"

  # Used by remaining patch_* calls in this session
  TOBA_AUTH_TOKEN_RUNTIME="$GENERATED_TOKEN"
  restart_and_wait
  ok "Tailscale-ready: bound 0.0.0.0, auth required"
else
  ok "Keeping loopback-only bind"
fi

# ── Step 7: Verification bundle ─────────────────────────────────────────────
banner "Verification"
VERIFY_OK=1
if [ -x "${CANONICAL_DIR}/scripts/verify-standalone.sh" ]; then
  info "verify-standalone.sh"
  if TOBA_URL="$BASE_URL" "${CANONICAL_DIR}/scripts/verify-standalone.sh" > /tmp/toba-verify-standalone.log 2>&1; then
    tail -1 /tmp/toba-verify-standalone.log | sed 's/^/  /'
  else
    err "standalone verification FAILED (log: /tmp/toba-verify-standalone.log)"
    tail -20 /tmp/toba-verify-standalone.log
    VERIFY_OK=0
  fi
fi
if [ -x "${CANONICAL_DIR}/scripts/verify-tailscale-ready.sh" ]; then
  info "verify-tailscale-ready.sh"
  if TOBA_URL="$BASE_URL" TOBA_AUTH_TOKEN="${GENERATED_TOKEN:-}" "${CANONICAL_DIR}/scripts/verify-tailscale-ready.sh" > /tmp/toba-verify-tailscale.log 2>&1; then
    tail -1 /tmp/toba-verify-tailscale.log | sed 's/^/  /'
  else
    err "Tailscale-ready verification FAILED (log: /tmp/toba-verify-tailscale.log)"
    tail -25 /tmp/toba-verify-tailscale.log
    VERIFY_OK=0
  fi
fi

# Smoke calls — uses generated token if any
SMOKE_HDR=()
[ -n "$GENERATED_TOKEN" ] && SMOKE_HDR=(-H "Authorization: Bearer $GENERATED_TOKEN")
SMOKE_STATUS="$(curl -fsS "${SMOKE_HDR[@]}" "${BASE_URL}/status" 2>/dev/null || echo "{}")"
SMOKE_PROVIDER="$(curl -fsS "${SMOKE_HDR[@]}" "${BASE_URL}/toba/provider" 2>/dev/null || echo "{}")"

# ── Step 8: Final summary ───────────────────────────────────────────────────
banner "Toba setup complete"
if [ "$HAS_SYSTEMD" = "1" ]; then
  printf "  Service:        %s\n" "$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo unknown)"
fi
printf "  Canonical path: %s\n" "$CANONICAL_DIR"
DB_REPORT="$(echo "$SMOKE_STATUS" | { command -v jq >/dev/null && jq -r '.host + ":" + (.port|tostring)' || cat; } 2>/dev/null || echo "")"
printf "  Bind:           %s\n" "${DB_REPORT:-loopback_only}"
EXPOSURE="$(echo "$SMOKE_STATUS" | { command -v jq >/dev/null && jq -r '.network_exposure // "?"' || echo "?"; } 2>/dev/null)"
AUTH_REQ="$(echo "$SMOKE_STATUS" | { command -v jq >/dev/null && jq -r '.auth_required // false' || echo "?"; } 2>/dev/null)"
PROV="$(echo "$SMOKE_STATUS" | { command -v jq >/dev/null && jq -r '.provider // "?"' || echo "?"; } 2>/dev/null)"
MOD="$(echo "$SMOKE_STATUS"  | { command -v jq >/dev/null && jq -r '.model // "?"' || echo "?"; } 2>/dev/null)"
DUX_TOTAL="$(echo "$SMOKE_STATUS" | { command -v jq >/dev/null && jq -r '.dux_agents.total // 0' || echo "?"; } 2>/dev/null)"
DUX_OVR="$(echo "$SMOKE_STATUS"   | { command -v jq >/dev/null && jq -r '.dux_agents.with_overrides // 0' || echo "?"; } 2>/dev/null)"
printf "  Exposure:       %s\n" "$EXPOSURE"
printf "  Auth required:  %s\n" "$AUTH_REQ"
printf "  Provider/model: %s / %s\n" "$PROV" "$MOD"
printf "  Dux agents:     %s total · %s with overrides\n" "$DUX_TOTAL" "$DUX_OVR"
printf "  .env:           %s (chmod 600, contains secrets)\n" "$ENV_FILE"
[ "$VERIFY_OK" = "1" ] && ok "verifications passed" || warn "verifications had failures (see logs above)"

if [ "$ENABLE_TAILSCALE" = "y" ]; then
  hr
  printf "%sTailscale access%s\n" "$C_BOLD" "$C_RST"
  if [ -n "$TAILSCALE_IP" ]; then
    printf "  URL:      %shttp://%s:%s/%s\n" "$C_INFO" "$TAILSCALE_IP" "${SERVICE_PORT:-18815}" "$C_RST"
    printf "  curl:     curl -H 'Authorization: Bearer \$TOBA_AUTH_TOKEN' http://%s:%s/status\n" "$TAILSCALE_IP" "${SERVICE_PORT:-18815}"
  fi
  printf "  Token:    %s%s%s\n" "$C_WARN" "$GENERATED_TOKEN" "$C_RST"
  printf "%s  ↑ shown once; saved in %s (chmod 600). Treat as a secret.%s\n" "$C_DIM" "$ENV_FILE" "$C_RST"
fi

hr
echo "Next steps:"
case "${PROVIDER_CHOICE:-}" in
  2|openrouter)
    [ "$HAS_OPENROUTER_KEY" = "1" ] \
      && echo "  • Try the strategist: curl ${SMOKE_HDR[*]:-} -X POST ${BASE_URL}/toba/dux/agents/strategist/chat -H 'content-type: application/json' -d '{\"message\":\"weekly plan\"}'" \
      || echo "  • Add your OpenRouter key:  edit ${ENV_FILE} → set TOBA_OPENROUTER_API_KEY=…  then  sudo systemctl restart ${SERVICE_NAME}"
    ;;
  1|ollama)
    echo "  • Make sure 'ollama serve' is running and 'ollama pull ${PROVIDER_MODEL:-llama3}' completed"
    echo "  • Try: curl ${SMOKE_HDR[*]:-} -X POST ${BASE_URL}/toba/dux/chat -H 'content-type: application/json' -d '{\"message\":\"hello\"}'"
    ;;
  3|echo) echo "  • Echo provider is for debugging. Switch to ollama/openrouter when ready." ;;
  skip|*) echo "  • Configure a provider: rerun  pnpm run cursus:setup  (or ./scripts/toba-setup.sh)" ;;
esac
echo "  • Browse the landing page:  ${BASE_URL}/"
echo "  • Logs:  journalctl -u ${SERVICE_NAME} -f"

[ "$VERIFY_OK" = "1" ] || exit 5
exit 0
