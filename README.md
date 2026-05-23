# Cursus — Career Change Command Center (Standalone)

**Cursus is a standalone product.** Squidley is **not required**. Cursus runs
on its own port (18815), with its own SQLite DB, its own provider/model
registry, its own Velum redactor, and its own receipts table.

If Squidley is stopped, Cursus keeps working.

| Field | Value |
| --- | --- |
| Version | 5.0.0 |
| Schema | 6 (Dux agent registry) |
| Port | 18815 |
| DB (canonical) | `/mnt/ai/cursus/state/cursus.db` |
| Service | `cursus.service` (systemd) |
| Working directory | `/mnt/ai/cursus` |
| Framework | Fastify + TypeScript + better-sqlite3 (WAL) |

## Quick start

```bash
# Install
cd /mnt/ai/cursus
pnpm install

# Run tests + typecheck + build
pnpm test && pnpm typecheck && pnpm build

# Run the service directly (foreground)
pnpm start

# Or use the systemd service
sudo systemctl restart cursus.service
sudo systemctl status  cursus.service
```

## Configuration

All configuration is via environment variables. Set them in `/mnt/ai/cursus/.env`
(loaded by the systemd unit) or in your shell when running directly.

### Service

| Variable | Default | Purpose |
| --- | --- | --- |
| `CURSUS_PORT` | `18815` | Listen port |
| `CURSUS_HOST` | `127.0.0.1` | Listen host. Non-loopback requires `CURSUS_AUTH_TOKEN`. |
| `CURSUS_DB_PATH` | `/mnt/ai/cursus/state/cursus.db` | SQLite path |
| `CURSUS_VERSION` | (from package.json) | Reported version string |
| `CURSUS_CORS_ORIGIN` | `*` | CORS origin |
| `CURSUS_AUTH_TOKEN` | (unset) | Bearer token. Required for non-loopback hosts (Tailscale or public). |
| `CURSUS_REQUIRE_AUTH` | (unset → auto) | `true` forces auth even on loopback. `false` keeps legacy behavior. |
| `CURSUS_ALLOW_LOOPBACK_NO_AUTH` | `true` | When a token is set, loopback may still skip auth. Set `false` to require auth on every request. |
| `CURSUS_AUTOMATION_MODE` | `approval-required` | `manual` / `recommend-only` / `approval-required` |

### Provider / model (standalone)

| Variable | Default | Purpose |
| --- | --- | --- |
| `CURSUS_PROVIDER` | `none` | One of: `none`, `echo`, `ollama`, `openai`, `anthropic`, `openrouter` |
| `CURSUS_MODEL` | `none` | Model name for the selected provider |
| `CURSUS_PROVIDER_BASE_URL` | (provider default) | Base URL override. Alias: `CURSUS_PROVIDER_API_BASE`. |
| `CURSUS_PROVIDER_API_KEY` | (unset) | API key for cloud providers. Never echoed in any response. |
| `CURSUS_LOCAL_ONLY` | `false` | When `true`, cloud providers are rejected at both selection and call time. |

Local providers (no network, no API key):
- `none` — Cursus boots without a provider. Dux chat returns an actionable 503.
- `echo` — In-process debug echo. Useful for verification and tests.
- `ollama` — Local Ollama daemon. Default base URL `http://127.0.0.1:11434`.

Cloud providers (require an API key):
- `openai`     — OpenAI `/v1/chat/completions`
- `anthropic`  — Anthropic `/v1/messages`
- `openrouter` — OpenAI-compatible via OpenRouter, default base `https://openrouter.ai/api/v1`

#### OpenRouter (DeepSeek v4 Pro example)

OpenRouter has provider-specific env vars that override the generic ones:

| Variable | Purpose |
| --- | --- |
| `CURSUS_OPENROUTER_API_KEY` | Preferred API key env (falls back to `CURSUS_PROVIDER_API_KEY`) |
| `CURSUS_OPENROUTER_REFERER` | Optional `HTTP-Referer` header (recommended by OpenRouter for app attribution) |
| `CURSUS_OPENROUTER_TITLE`   | Optional `X-Title` header (default `Cursus`) |

`.env` example:

```
CURSUS_PROVIDER=openrouter
CURSUS_MODEL=deepseek/deepseek-v4-pro
CURSUS_PROVIDER_BASE_URL=https://openrouter.ai/api/v1
CURSUS_OPENROUTER_API_KEY=sk-or-v1-...
CURSUS_OPENROUTER_REFERER=https://cursus.local
CURSUS_OPENROUTER_TITLE=Cursus
CURSUS_LOCAL_ONLY=false
```

If the exact OpenRouter slug for DeepSeek v4 Pro differs from
`deepseek/deepseek-v4-pro`, set `CURSUS_MODEL` to whatever OpenRouter's
`/api/v1/models` listing returns — the value is passed through verbatim.

The API key is **never** echoed in any response. `GET /cursus/provider` and
`GET /status` only surface `api_key_set: true|false`.

### Dux agents (per-agent provider/model)

Cursus seeds five built-in Dux personas on first boot:

| Agent id            | Role |
| --- | --- |
| `strategist`        | Main career strategist (weekly planning, target-role decisions) |
| `resume-reviewer`   | Tailors resumes, flags weak bullets, suggests STAR rewrites |
| `outreach-drafter`  | Cold emails, recruiter replies, cover letters |
| `job-scout-analyst` | Posting fit/legitimacy/salary calibration |
| `interview-coach`   | STAR stories, behavioral + technical prep |

Each agent can run its own provider and model. Agents without an override
fall back to the global `CURSUS_PROVIDER` / `CURSUS_MODEL` default.

Endpoints:

| Endpoint | Notes |
| --- | --- |
| `GET /cursus/dux/agents` | List the registry. `api_key` is never returned — `api_key_set` boolean is. |
| `GET /cursus/dux/agents/:id` | One agent. |
| `PATCH /cursus/dux/agents/:id` | Update provider/model/base_url/api_key/temperature/max_tokens/system_prompt/local_only/cloud_allowed/fallback_provider/fallback_model/enabled. Rejects unknown providers and local-only contradictions. |
| `POST /cursus/dux/agents/:id/chat` | Chat as this specific agent. Velum runs first; receipts include `dux_agent_id`. |
| `POST /cursus/dux/chat` | Original endpoint. Accepts optional `agent_id` in body. |

Example: route the strategist to OpenRouter DeepSeek v4 Pro, keep
resume-reviewer on a local model, force outreach-drafter local-only:

```bash
TOK="..."  # CURSUS_AUTH_TOKEN if running over Tailscale; omit Authorization on loopback

curl -X PATCH http://127.0.0.1:18815/cursus/dux/agents/strategist \
  -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"provider":"openrouter","model":"deepseek/deepseek-v4-pro","api_key":"sk-or-...","base_url":"https://openrouter.ai/api/v1","temperature":0.4}'

curl -X PATCH http://127.0.0.1:18815/cursus/dux/agents/resume-reviewer \
  -H 'content-type: application/json' \
  -d '{"provider":"ollama","model":"llama3","local_only":true}'

curl -X PATCH http://127.0.0.1:18815/cursus/dux/agents/outreach-drafter \
  -H 'content-type: application/json' \
  -d '{"cloud_allowed":false,"fallback_provider":"ollama","fallback_model":"llama3"}'
```

Per-agent guarantees:
- Velum redacts user input before any provider sees it.
- `local_only=true` on an agent + cloud provider → 400 at PATCH time.
- `cloud_allowed=false` + cloud provider at call time → 403, or fallback if configured.
- Global `CURSUS_LOCAL_ONLY=true` blocks setting any cloud provider on any agent.
- `dux_agent_chat` receipts record agent_id + provider + model + local_mode + velum review state.

### Optional Squidley bridge

| Variable | Default | Purpose |
| --- | --- | --- |
| `CURSUS_BRIDGE_URL` | (unset, **disabled**) | Legacy Squidley bridge URL. Surfaced in `/status` as `bridge_enabled: true`. Cursus core behavior never depends on it. |
| `SQUIDLEY_CURSUS_URL` | — | Backwards-compatible alias of `CURSUS_BRIDGE_URL`. |

## API surface (selected)

| Endpoint | Notes |
| --- | --- |
| `GET /health` | Deep health: DB reachable + schema match |
| `GET /version` | Service + schema versions |
| `GET /status` | `mode=standalone`, provider state, receipts/velum/automation, last job-scout run |
| `GET /cursus/provider` | Full provider status including available providers, `local_only_mode`, `api_key_set` (boolean only — no secret). |
| `PATCH /cursus/provider` | Runtime provider/model selection. Body: `{provider, model, base_url?, api_key?, local_only?}`. |
| `POST /cursus/provider` | Alias of PATCH. |
| `POST /cursus/dux/chat` | Standalone Dux chat through the native provider. Velum-on-by-default (`velum:false` to override). Writes `velum_review` + `model_call` receipts. |
| `GET /cursus/job-scout/context` | Local context for an external job-search tool. `live_search_implemented: false` — Cursus does not crawl boards itself. |
| `POST /cursus/job-scout/ingest` | Ingest jobs into the active campaign (deduped by fingerprint). Receipt includes native provider/model metadata. |
| `POST /cursus/velum/review` | Local PII redaction (SSN, email, phone, address, credit card). |
| `GET /cursus/receipts?action=...` | Local audit log. |

## Standalone verification

```bash
# Confirm the service runs without Squidley
sudo systemctl stop squidley.service   # or any *.service that's running
sudo systemctl restart cursus.service

# Run the verification suite
/mnt/ai/cursus/scripts/verify-standalone.sh
```

The script exercises `/health`, `/status`, `/cursus/provider`,
`/cursus/dux/chat`, `/cursus/job-scout/context`, `/cursus/velum/review`,
and receipts — and asserts that Velum redacts sensitive data BEFORE the
provider sees it. It exits non-zero on any failure.

## Local-only walkthrough

```bash
# 1) Run Ollama locally
ollama serve &
ollama pull llama3

# 2) Configure Cursus
cat > /mnt/ai/cursus/.env <<'EOF'
CURSUS_PROVIDER=ollama
CURSUS_MODEL=llama3
CURSUS_LOCAL_ONLY=true
EOF
sudo systemctl restart cursus.service

# 3) Confirm
curl -s localhost:18815/status         | jq '{mode, provider, model, local_only_mode}'
curl -s localhost:18815/cursus/provider| jq '.provider | {provider, model, local, local_only_mode, configured}'

# 4) Chat (Velum-redacted before reaching the model)
curl -s -X POST localhost:18815/cursus/dux/chat \
  -H 'content-type: application/json' \
  -d '{"message":"What should I focus on this week?"}' | jq .
```

## Tailscale access (phone / iPad / other devices on your tailnet)

Cursus refuses to start on a non-loopback interface without a token. Set both:

```
CURSUS_HOST=0.0.0.0
CURSUS_PORT=18815
CURSUS_AUTH_TOKEN=<paste-output-of:  openssl rand -hex 32 >
CURSUS_REQUIRE_AUTH=true                 # require token even for loopback callers
CURSUS_ALLOW_LOOPBACK_NO_AUTH=false      # belt-and-suspenders
```

Network exposure is auto-classified in `/status` as one of:
- `loopback_only` — `127.0.0.1` / `::1`
- `tailscale_reachable` — `100.64.0.0/10` (Tailscale CGNAT) or `0.0.0.0` (interpreted as "exposed beyond loopback; auth required")
- `public_bind` — any other non-loopback IP

Public endpoints (no token): `/health`, `/version`. All other endpoints
require `Authorization: Bearer $CURSUS_AUTH_TOKEN` when `auth_required=true`.

Get your Tailscale IP:

```bash
tailscale ip -4
```

From a phone or iPad on the same tailnet:

```
http://<tailscale-ip>:18815/health
```

```bash
curl -H "Authorization: Bearer $CURSUS_AUTH_TOKEN" \
  http://<tailscale-ip>:18815/status
```

Verify your setup:

```bash
CURSUS_URL=http://<tailscale-ip>:18815 CURSUS_AUTH_TOKEN=$CURSUS_AUTH_TOKEN \
  /mnt/ai/cursus/scripts/verify-tailscale-ready.sh
```

### Security guarantees

1. The bind-time guard refuses to start a non-loopback service without a token.
2. `/cursus/provider`, `/cursus/dux/agents`, `/cursus/receipts`, `/cursus/profile`, and every other sensitive endpoint requires the bearer when auth is enabled.
3. API keys never appear in any GET — `api_key_set: true|false` only.
4. Bearer comparison uses an exact match against `Bearer <token>` (no prefix tricks).
5. CORS `*` is permitted by default; if you wire a browser UI, narrow `CURSUS_CORS_ORIGIN` accordingly.

## Migration: legacy path → canonical

The service previously lived at `/mnt/ai/squidley-v2/apps/cursus`. To move it
to the standalone canonical path `/mnt/ai/cursus`:

```bash
sudo /mnt/ai/cursus/scripts/migrate-to-canonical.sh
```

That script stops `cursus.service`, copies the SQLite DB (+WAL/SHM) into
`/mnt/ai/cursus/state`, installs `cursus.service` from
`/mnt/ai/cursus/cursus.service` into `/etc/systemd/system/`, runs
`daemon-reload`, starts the service, and smoke-tests `/health`.

The legacy DB file is left in place as backup.

## Independence guarantees

1. `src/server.ts`, `src/routes.ts`, `src/db.ts`, `src/provider.ts` import
   **zero** Squidley modules. (Verified by a test in `server.test.ts`.)
2. Job Scout uses only the local DB and the native provider registry.
3. Velum is in-process, pattern-based, and runs before any provider call
   involving career data. (Verified by `Velum runs BEFORE the provider sees
   sensitive career data`.)
4. Receipts are written for every model call, every Velum review, every
   campaign/application action, every Job Scout ingest, and every automation
   queue transition — to the local `cursus_receipts` table.
5. `CURSUS_BRIDGE_URL` is unset by default. When set, it only surfaces a
   `bridge_enabled: true` flag in `/status`; no core endpoint reaches out to it.

## Troubleshooting

**Dux chat returns 503 with code `provider_unconfigured`**
Set `CURSUS_PROVIDER` and `CURSUS_MODEL` (and `CURSUS_PROVIDER_API_KEY` for
cloud providers) in `/mnt/ai/cursus/.env` and restart the service, OR
`PATCH /cursus/provider` at runtime.

**`provider_misconfigured`**
The response's `error` field lists exactly which fields are missing. Common
causes: missing API key, unknown model, base URL not set for a custom
deployment.

**`local_only_violation`**
`CURSUS_LOCAL_ONLY=true` blocks cloud providers. Switch to `ollama`/`echo`
or unset `CURSUS_LOCAL_ONLY`.

**Native binding missing for `better-sqlite3`**
`pnpm install` followed by `pnpm rebuild better-sqlite3`. The package's
`pnpm.onlyBuiltDependencies` whitelist already allows it.

## Tests

```bash
pnpm test         # 86 tests covering health, schema, all CRUD,
                  # provider registry, dux chat, Velum-before-provider,
                  # local-only enforcement, no-secret-leakage, no-Squidley-import,
                  # Job Scout standalone, receipts on provider calls.
pnpm typecheck    # strict TypeScript
pnpm build        # tsc emit
```
