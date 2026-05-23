#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCAN_PATH="${1:-$ROOT}"
ALLOWLIST="$ROOT/scripts/privacy-audit-allowlist.txt"

cd "$ROOT"

if [[ "$SCAN_PATH" == "$ROOT" || "$SCAN_PATH" == "." ]]; then
  mapfile -t files < <(git ls-files | grep -Ev '(^node_modules/|^dist/|\.png$|\.jpg$|\.jpeg$|\.gif$|\.webp$|\.ico$|\.db$|\.sqlite$|tsconfig\.tsbuildinfo$)')
else
  mapfile -t files < <(find "$SCAN_PATH" -type f | grep -Ev '(^|/)(node_modules|dist)/|\.png$|\.jpg$|\.jpeg$|\.gif$|\.webp$|\.ico$|\.db$|\.sqlite$|tsconfig\.tsbuildinfo$')
fi

patterns=(
  'Jeffrey[[:space:]]+Miller|Jeff[[:space:]]+Miller'
  'Moore,[[:space:]]*Oklahoma|Oklahoma[[:space:]]+City|Post-A\+[[:space:]]+Job[[:space:]]+Search[[:space:]]+2026'
  'Squidley[[:space:]]+V2[[:space:]]+Architecture'
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
  '(\+?1[-.[:space:]]*)?(\([0-9]{3}\)|[0-9]{3})[-.[:space:]]*[0-9]{3}[-.[:space:]]*[0-9]{4}'
  'sk-or-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{20,}'
  'Bearer[[:space:]]+[A-Za-z0-9._~+/=-]{16,}'
  '(OPENROUTER|API|AUTH|TOKEN|SECRET|KEY)[A-Z0-9_]*[[:space:]]*=[[:space:]]*["'\'']?[A-Za-z0-9._~+/=-]{12,}'
  '/home/[A-Za-z0-9._-]+|/Users/[A-Za-z0-9._-]+'
)

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

for file in "${files[@]}"; do
  [[ -f "$file" ]] || continue
  [[ "$file" == "scripts/audit-release-privacy.sh" ]] && continue
  [[ "$file" == "scripts/privacy-audit-allowlist.txt" ]] && continue
  if ! LC_ALL=C grep -Iq . "$file"; then
    continue
  fi
  for pattern in "${patterns[@]}"; do
    grep -HInE "$pattern" "$file" >> "$tmp" || true
  done
done

if [[ -s "$ALLOWLIST" && -s "$tmp" ]]; then
  filtered="$(mktemp)"
  cp "$tmp" "$filtered"
  while IFS= read -r allow || [[ -n "$allow" ]]; do
    [[ -z "$allow" || "$allow" =~ ^# ]] && continue
    grep -Ev "$allow" "$filtered" > "$filtered.next" || true
    mv "$filtered.next" "$filtered"
  done < "$ALLOWLIST"
  mv "$filtered" "$tmp"
fi

if [[ -s "$tmp" ]]; then
  echo "Cursus release privacy audit FAILED. Review these tracked findings:"
  cat "$tmp"
  exit 1
fi

echo "Cursus release privacy audit passed: no unallowlisted personal data or secret patterns found."
