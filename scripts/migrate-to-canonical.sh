#!/usr/bin/env bash
# Toba migration to canonical /mnt/ai/cursus
# =============================================
# One-shot migration script for moving the live Toba service from the legacy
# /mnt/ai/peh-v2/apps/cursus path to /mnt/ai/cursus (the standalone path).
#
# Requires sudo for stopping the service, installing the unit, and reloading systemd.
#
# This script:
#   1. Stops toba.service
#   2. Copies the SQLite DB (+ WAL/SHM) from the legacy state dir to /mnt/ai/cursus/state
#   3. Installs /mnt/ai/cursus/toba.service as /etc/systemd/system/toba.service
#   4. Runs systemctl daemon-reload
#   5. Starts toba.service
#   6. Verifies /health responds 200
#   7. Optionally runs the full standalone verification script

set -euo pipefail

LEGACY_DB_DIR="${TOBA_LEGACY_DB_DIR:-/mnt/ai/peh-v2/state}"
CANONICAL_DB_DIR="/mnt/ai/cursus/state"
SERVICE_SRC="/mnt/ai/cursus/toba.service"
SERVICE_DST="/etc/systemd/system/toba.service"

if [ "$(id -u)" -ne 0 ]; then
  echo "This migration must run as root. Re-run with sudo."
  exit 1
fi

echo "[1/6] Stopping toba.service"
systemctl stop toba.service || true
# Give SQLite a moment to flush WAL.
sleep 1

echo "[2/6] Copying DB from $LEGACY_DB_DIR to $CANONICAL_DB_DIR"
mkdir -p "$CANONICAL_DB_DIR"
if [ -f "$LEGACY_DB_DIR/cursus.db" ]; then
  cp -a "$LEGACY_DB_DIR/cursus.db" "$CANONICAL_DB_DIR/cursus.db"
  [ -f "$LEGACY_DB_DIR/cursus.db-wal" ] && cp -a "$LEGACY_DB_DIR/cursus.db-wal" "$CANONICAL_DB_DIR/" || true
  [ -f "$LEGACY_DB_DIR/cursus.db-shm" ] && cp -a "$LEGACY_DB_DIR/cursus.db-shm" "$CANONICAL_DB_DIR/" || true
  # Ensure the runtime user can read/write — service runs as zen.
  chown -R zen:zen "$CANONICAL_DB_DIR"
else
  echo "  (no legacy DB at $LEGACY_DB_DIR/cursus.db — fresh DB will be created on first run)"
fi

echo "[3/6] Installing systemd unit $SERVICE_SRC -> $SERVICE_DST"
cp "$SERVICE_SRC" "$SERVICE_DST"

echo "[4/6] systemctl daemon-reload"
systemctl daemon-reload

echo "[5/6] Starting toba.service"
systemctl start toba.service
sleep 2
systemctl is-active toba.service

echo "[6/6] Smoke-testing /health"
if curl -fsS http://127.0.0.1:18815/health | grep -q '"ok":true'; then
  echo "  /health is healthy"
else
  echo "  /health failed — see: journalctl -u toba.service -n 50"
  exit 1
fi

echo ""
echo "Migration complete. Service is running from /mnt/ai/cursus."
echo "Run the full verification:  /mnt/ai/cursus/scripts/verify-standalone.sh"
echo "Legacy DB left in place at $LEGACY_DB_DIR/cursus.db (safe to archive)."
