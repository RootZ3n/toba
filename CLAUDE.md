# Toba

Toba is the career/productivity platform in the **Pehverse lab** — Jeffrey Miller's
multi-agent AI development ecosystem. It is a **standalone** "Career Transformation
Command Center": a self-contained Fastify + TypeScript + SQLite service that helps
users run a job search end to end (resume management, job search/scouting, skill
tracking, outreach drafting, interview prep). Toba runs on its own port (18815),
its own SQLite DB, its own provider/model registry, and its own PII redactor
(Velum) with a local audit-log (receipts). It does **not** depend on Peh — if Peh
is stopped, Toba keeps working. An optional Peh bridge is disabled by default and
never affects core behavior.

## Build / Test / Dev commands

Package manager is **pnpm**. Scripts (exact, from `package.json`):

| Command | What it does |
| --- | --- |
| `pnpm dev` | `tsx watch src/server.ts` — hot-reload dev server |
| `pnpm start` | `tsx src/server.ts` — run service in foreground |
| `pnpm build` | `tsc -p tsconfig.json` then copy `src/web/` → `dist/web/` |
| `pnpm typecheck` | `tsc --noEmit` (strict) |
| `pnpm test` | `vitest run` — full test suite |
| `pnpm clean` | `rm -rf dist` |
| `pnpm toba:setup` | `bash scripts/toba-setup.sh` — interactive setup wizard |
| `pnpm toba:setup:noninteractive` | Setup wizard, accepts all defaults |
| `pnpm verify` | `bash scripts/verify-standalone.sh` — standalone smoke checks |
| `pnpm verify:tailscale` | `bash scripts/verify-tailscale-ready.sh` |

There is **no `lint` script and no ESLint/Prettier config** — `pnpm typecheck` is
the static gate. Standard pre-release / pre-commit gate:

```bash
pnpm test && pnpm typecheck && pnpm build
```

Requires Node 20+ (see `.nvmrc` / `.node-version`). `better-sqlite3` is a native
module; if its binding is missing, run `pnpm rebuild better-sqlite3`.

## Key conventions

- **Language/runtime:** TypeScript, ESM (`"type": "module"`). Imports use the
  `.js` extension on local module specifiers (e.g. `import { ... } from "./db.js"`)
  because of `moduleResolution: "bundler"` + ESM output. Match this when adding files.
- **Strict TS:** `strict: true`, target ES2022. Keep types explicit on exported
  surfaces; the DB layer exports rich domain types (e.g. `Campaign`, `AppStatus`,
  `PehAgent`).
- **No heavy frameworks/ORM.** Direct `better-sqlite3` queries inside the DB
  classes. Dependencies are intentionally minimal: `fastify`, `@fastify/cors`,
  `better-sqlite3`.
- **Pure helper modules.** Network/path/logger/backup/shutdown logic lives in
  small pure modules (`network.ts`, `dbpath.ts`, etc.) so they are unit-testable
  and `server.ts` just wires them together.
- **Env config:** all configuration via `TOBA_*` env vars, with legacy `CURSUS_*`
  names accepted as fallback. Loaded from `.env` (see `.env.example`). See the
  README for the full variable table.
- **Secrets never echoed.** API keys are never returned by any GET endpoint; only
  an `api_key_set: true|false` boolean is surfaced.
- **Receipts + Velum.** Every model call, Velum review, CRUD action, Job Scout
  ingest, and automation transition writes a receipt to the local
  `toba_receipts` table. Velum (in-process PII redaction) runs **before** any
  provider sees career data.
- **Schema versioning.** `TOBA_SCHEMA_VERSION` in `src/db.ts` is the source of
  truth (currently **8**) — bump it when adding tables/columns. (Note: the README
  prose lists an older schema number; trust the constant in `db.ts`.)
- **Backward compatibility.** Legacy `/cursus/*` URLs are rewritten to `/toba/*`
  at the Fastify layer (`rewrite.ts`).

## Architecture notes

Single Fastify service. Entry point is `src/server.ts`, which loads config, opens
the DB, registers routes, and handles graceful shutdown. Source files (all under
`src/`):

| File | Role |
| --- | --- |
| `server.ts` | App entry: builds Fastify, CORS, logger, loads provider config, opens DB (V1 + V2), registers routes, SIGTERM/SIGINT graceful shutdown. |
| `db.ts` | The bulk of the domain logic (~2k lines). Two DB classes over one SQLite file: **`TobaV1DB`** (profile, experience, certifications, projects, skills, products, export) and **`TobaV2DB`** (campaigns, applications, resumes, outreach, Peh sessions, dashboard, onboarding, analytics, automation queue, job fingerprinting/dedupe, receipts, Velum). Exports schema version + all domain types. |
| `routes.ts` | All HTTP routes (~2k lines): `/health`, `/version`, `/status`, `/api`, the web SPA shell, and the `/toba/*` API — provider config, Peh agents + chat, Job Scout context/ingest, Velum review, receipts, profile/campaign/application/resume CRUD. Embeds the web assets at module init. |
| `provider.ts` | Native provider/model registry. Built-in: `none`, `echo`, `ollama` (local) and cloud (`openai`, `anthropic`, `openrouter`, etc.). `chat(req, overrides)` supports per-call (per-agent) provider/model routing. Enforces `TOBA_LOCAL_ONLY`. Persists runtime config to `state/provider-config.json` so operator changes survive restarts. |
| `network.ts` | Pure bind/exposure helpers: classifies host as `loopback_only` / `tailscale_reachable` / `public_bind`; detects Tailscale CGNAT range. Auth is required for non-loopback binds. |
| `dbpath.ts` | Resolves DB path: `TOBA_DB_PATH ?? CURSUS_DB_PATH ?? /var/lib/toba/toba.db`. |
| `logger.ts` | Builds Fastify logger options (tees to stdout + `state/server.log`). |
| `backups.ts` | Best-effort backup TTL sweep on boot. |
| `shutdown.ts` | Bounded graceful-shutdown helper. |
| `rewrite.ts` | Legacy `/cursus/*` → `/toba/*` URL rewriting. |
| `web/` | Static SPA (`index.html`, `app.js`, `styles.css`) served by the service; copied into `dist/web/` on build. |

**Peh agents.** Toba seeds five built-in personas on first boot (`strategist`,
`resume-reviewer`, `outreach-drafter`, `job-scout-analyst`, `interview-coach`).
Each can run its own provider/model (via `provider.ts` per-call overrides) or fall
back to the global `TOBA_PROVIDER`/`TOBA_MODEL`.

### Tests

- Runner: **Vitest** (`vitest.config.ts`, `include: ["src/**/*.test.ts"]`).
- The suite lives almost entirely in **`src/server.test.ts`** — an integration
  test that builds a real Fastify app + a fresh `TobaV1DB`/`TobaV2DB` in a temp
  dir per test (via `buildApp()`), exercises routes with `app.inject`, then tears
  down (closes app/DBs, removes temp dir) in `afterEach`. Provider-config writes
  are redirected into the temp dir with `setProviderConfigPath` so tests never
  touch the repo's `state/`.
- Notable invariants asserted: no Peh imports in core files, no secret leakage in
  responses, Velum-before-provider ordering, and local-only enforcement.
- Add new tests as `src/**/*.test.ts`. Prefer the existing temp-dir + `inject`
  pattern over hitting a running server.

## Operations notes

- Deployed as `toba.service` (systemd); canonical working dir is the repo root,
  canonical DB is `./state/toba.db` (the `TOBA_DB_PATH` default differs —
  `/var/lib/toba/toba.db` — so set it explicitly per deployment).
- Helper scripts in `scripts/`: `toba-setup.sh`, `verify-standalone.sh`,
  `verify-tailscale-ready.sh`, `migrate-to-canonical.sh`, `toba-reset.sh`,
  `audit-release-privacy.sh`.
- See `README.md` for the full env-var reference, API surface, Tailscale setup,
  and privacy/release checks; `DATA-CONTRACT.md` and `CHANGELOG.md` for data
  shape and history.
