# Continue Without Claude — Cursus

## What this repo does

Cursus is the standalone career change command center. Runs on port 18815
with its own SQLite DB (`state/cursus.db`), provider/model registry, Velum
redactor, and receipts table. **Independent of Squidley.**

## Common commands

```bash
pnpm install
pnpm test           # vitest run
pnpm typecheck      # tsc --noEmit
pnpm build          # tsc -p tsconfig.json
pnpm start          # foreground

# As systemd service:
sudo systemctl status cursus
sudo systemctl restart cursus
sudo journalctl -u cursus -f
```

## Where to start

- `src/server.ts` — Fastify composition root
- `src/routes.ts` — all HTTP routes
- `src/db.ts` — SQLite schema + queries
- `src/provider.ts` — provider/model registry
- `README.md` — quick start
- `DATA-CONTRACT.md` — data contract (what Cursus stores)
- `AUDIT-REPORT.md`, `PHASE-REPORT.md` — historical audits

## Safe edit zones

- `docs/`, `README.md`, `scripts/`, test files
- Adding new routes (extend `src/routes.ts`)

## Dangerous edit zones

- `src/db.ts` — schema migrations need careful versioning (currently schema 5)
- `src/server.ts` — composition root
- `scripts/migrate-to-canonical.sh` — DB migration script

## How to recover

```bash
git log --oneline -5
git revert HEAD
sudo systemctl restart cursus

# DB recovery:
ls -la state/cursus.db*    # check for journal/wal
cp /mnt/ai/backups/cursus/<latest>.db state/cursus.db
sudo systemctl restart cursus
```

## Prompts for smaller models

```
"Add a new route to src/routes.ts following the pattern of existing
routes. Use Fastify's typed handlers and validate inputs with the
existing schema helpers."

"Add a vitest test in src/server.test.ts that hits the new route
and asserts the response shape."
```

## Top tasks

1. Add proper schema migration framework (currently ad-hoc)
2. Document env vars (PROVIDER_*, DB path overrides)
3. Add `smoke.sh` mirroring colosseum's pattern
4. Wire into symposium-command's `lab-wide-check.sh`
