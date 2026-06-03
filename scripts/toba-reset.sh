#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="${TOBA_DB_PATH:-${CURSUS_DB_PATH:-$ROOT/state/cursus.db}}"
MODE=""
DRY_RUN=0
KEEP_PROVIDER_CONFIG=0

usage() {
  cat <<USAGE
Usage: scripts/toba-reset.sh (--personal-data-only|--all-data) [--keep-provider-config] [--dry-run] [--db PATH]

Deletes user-owned Toba data while preserving schema and migrations.
Backs up the DB before any non-dry-run reset.
Never deletes .env or .env.bak files.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --personal-data-only|--all-data) MODE="$1"; shift ;;
    --keep-provider-config) KEEP_PROVIDER_CONFIG=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --db) DB_PATH="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "Choose --personal-data-only or --all-data." >&2
  usage
  exit 2
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "DB not found: $DB_PATH" >&2
  echo "Nothing was deleted."
  exit 1
fi

echo "Toba release reset"
echo "DB: $DB_PATH"
echo "Mode: $MODE"
echo "Keep provider config: $([[ "$KEEP_PROVIDER_CONFIG" == 1 ]] && echo yes || echo no)"
echo "Dry run: $([[ "$DRY_RUN" == 1 ]] && echo yes || echo no)"
echo
echo "Will clear: profile, onboarding, resumes, campaigns, applications, outreach, search lanes, evaluations, receipts, automation, Peh sessions, interview stories."
if [[ "$MODE" == "--all-data" ]]; then
  echo "Will also clear: products/catalog entries."
fi
if [[ "$KEEP_PROVIDER_CONFIG" != 1 ]]; then
  echo "Will also clear: per-agent provider/model/base URL/API key overrides."
fi
echo "Will preserve: schema, migrations, generic Peh agent definitions, .env files."

if [[ "$DRY_RUN" == 1 ]]; then
  node "$ROOT/scripts/reset-toba-db.mjs" --db "$DB_PATH" --mode "$MODE" --dry-run --keep-provider-config "$KEEP_PROVIDER_CONFIG"
  exit 0
fi

backup_dir="$ROOT/backups"
mkdir -p "$backup_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$backup_dir/toba-reset-$stamp.db"
cp "$DB_PATH" "$backup"
[[ -f "$DB_PATH-wal" ]] && cp "$DB_PATH-wal" "$backup-wal"
[[ -f "$DB_PATH-shm" ]] && cp "$DB_PATH-shm" "$backup-shm"
echo "Backup written: $backup"

node "$ROOT/scripts/reset-toba-db.mjs" --db "$DB_PATH" --mode "$MODE" --keep-provider-config "$KEEP_PROVIDER_CONFIG"
echo "Reset complete. Toba is in first-run blank state."
