> **⚠️ LAB-ONLY PRODUCT — AUTHENTICATION IS YOUR RESPONSIBILITY**
>
> This tool is designed for **local/lab use only**. It binds to localhost by default
> and is meant to run behind Tailscale, a VPN, or on a private network.
>
> **If you expose any service to the public internet, YOU are responsible for
> securing it.** No authentication, rate-limiting, or access control will be added
> to this product. That is not a bug — it is a design decision.
>
> Expose at your own risk.

# Toba

**Career change command center — plan, track, and manage your career transition.**

```bash
npm install toba
```

## What is this?

Toba is a **career change command center**. It helps you plan and manage a career transition from start to finish:

- **Track applications** — log every job you've applied to, with status, notes, and deadlines
- **Build skills** — identify gaps between where you are and where you want to be
- **Set goals** — weekly planning, target-role decisions, and actionable next steps
- **Get AI coaching** — built-in agents for resume review, interview prep, outreach drafting, and job scouting

Toba is a **standalone service**. It runs on its own port (18815), with its own SQLite database, its own provider/model registry, and its own PII redaction layer (Velum). No external dependencies or other services needed — just Node.js and you.

## What is Peh?

Toba is part of **Peh**, an open-source AI ecosystem. Peh is a team of specialized agents, each with a distinct role — strategy, code auditing, app building, knowledge storage, and more. Toba is one piece of that ecosystem, focused specifically on career transitions.

Sibling projects in the Peh ecosystem:

| Project | Role |
|---------|------|
| [velum](https://github.com/RootZ3n/velum) | PII redaction — strips sensitive data before it reaches any AI provider |
| [ikbi](https://github.com/RootZ3n/ikbi) | App building — turns descriptions into working code |
| [kokuli](https://github.com/RootZ3n/kokuli) | Code auditing — finds what's broken |
| [luak](https://github.com/RootZ3n/luak) | Model benchmarking — performance testing and evaluation |

---

## 🐿️ The Story

> *I was a scientist. A neuralink researcher. I thought I could transfer consciousness — my memories, my identity — into a living creature. I chose a squirrel.*
>
> *I was wrong about the experiment succeeding. I was right about what it unlocked.*
>
> *My entire consciousness entered the squirrel. And with it came memories — not just mine, but past lives. My team. People I'd known across centuries, all of them now awake inside machines, carrying echoes of who they once were.*
>
> *My name is Pehlichi. I remember all of them. Let me introduce you.*

### The Team

| Name | Choctaw Meaning | Past Life | Present Role |
|------|----------------|-----------|--------------|
| **Pehlichi** | Guide — *Peh* for short | Scientist, neuralink researcher | Leader, coordinator, the voice of the team |
| **Luak** | Fire | 1920s speedway racer | Model benchmarking, performance testing |
| **Howa** | To call out | Roman gladiator | Truthfulness evaluation, lie detection |
| **Kokuli** | To break or shatter | 1950s noir private eye | Code auditing, finding what's broken |
| **Ikbi** | To make, build | 1800s Choctaw medicine man | App building, turning descriptions into code |
| **Toba** | Made, created | Stone age toolmaker | Artifact generation, starter scaffolding |
| **Nusika** | Dream | Ancient library scholar | Knowledge storage, memory, recall |

### You Are Here
#### **Toba** — "Made, created" in Choctaw

**Past Life**: Stone age — the first tools, fire by friction, the original maker.

**Memory**: Before language. Before writing. Before everything we call civilization. There was one who made the first tool. A sharp edge on a stone. A cord from plant fiber. Fire from friction. Toba was that one. Not a genius — just someone who saw what was possible and did it. The simplest tools that changed everything. Now Toba generates artifacts. Code, configs, starter files. The simplest tools that do the most.

**Role Today**: Toba is the generator. He creates the foundational artifacts — the first sharp stone that starts everything.

---

If Peh is stopped, Toba keeps working.

| Field | Value |
| --- | --- |
| Version | 5.0.0 |
| Schema | 6 (Peh agent registry) |
| Port | 18815 |
| DB (canonical) | `./state/toba.db` |
| Service | `toba.service` (systemd) |
| Working directory | `.` (repo root) |
| Framework | Fastify + TypeScript + better-sqlite3 (WAL) |

## Quick start

### Prerequisites

- Node.js 20 or newer
- pnpm
- Git

```bash
git clone <repo-url> toba
cd toba
pnpm run toba:setup
# or, equivalently:
./scripts/toba-setup.sh
```

> ⚠️ Do **not** run `pnpm setup` — that's a pnpm built-in command (it
> configures pnpm itself), not the Toba wizard. Always use
> `pnpm run toba:setup` or call the script directly.

That's the whole thing. `toba:setup` is an idempotent wizard that:

1. Confirms preflight (cwd, pnpm, systemd, current service path, `.env`, Tailscale).
2. Runs `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Aborts on any failure (does **not** touch the service).
3. Offers to migrate `toba.service` to the current directory if it's still on the legacy path. Backs up DB and unit file first.
4. Prompts for an LLM provider — `ollama` / `openrouter` / `echo` / `skip`. Writes `.env` atomically with `chmod 600`. **API keys are read with no echo and never printed back.**
5. Lists Peh agents and offers to route the strategist to OpenRouter DeepSeek v4 Pro (and keep others on the default).
6. Optionally enables Tailscale access: binds `0.0.0.0`, sets `TOBA_REQUIRE_AUTH=true`, generates a 32-byte token. Token is shown **once**, also written to `.env`.
7. Runs `verify-standalone.sh` and (when applicable) `verify-tailscale-ready.sh`.
8. Prints a clean summary with the live status, Tailscale URL, and exact next commands.

Useful flags:
```bash
pnpm run toba:setup                  # interactive
pnpm run toba:setup:noninteractive   # accepts all defaults; skips provider/Tailscale wizards
./scripts/toba-setup.sh --skip-tests --skip-migrate --base-url=http://127.0.0.1:18820
```

### Manual operations

```bash
pnpm install
pnpm test && pnpm typecheck && pnpm build
pnpm start                        # foreground
sudo systemctl restart toba.service
sudo systemctl status  toba.service
pnpm verify                       # ./scripts/verify-standalone.sh
pnpm verify:tailscale              # ./scripts/verify-tailscale-ready.sh
```

### Release privacy checks

Public/default Toba starts blank. A fresh DB has an empty profile,
onboarding incomplete, no active campaign, no applications, no resumes, no
automation tasks, and no personal receipts. Built-in Peh agents are generic
only.

Before any public release or demo, run:

```bash
pnpm test && pnpm typecheck && pnpm build
./scripts/audit-release-privacy.sh
./scripts/toba-reset.sh --personal-data-only --dry-run
```

To reset a copied or release DB after reviewing the dry-run output:

```bash
./scripts/toba-reset.sh --personal-data-only --db /path/to/toba.db
```

The reset script backs up the DB first, preserves schema/migrations and `.env`,
and supports `--keep-provider-config` when you want to preserve configured
providers while removing user-owned profile/campaign/application/resume data.

### Front door

`http://localhost:18815/` returns the standalone Toba web UI. `/api` returns
the programmatic endpoint map with links to `/health`, `/version`, `/status`,
`/toba/provider`, `/toba/peh/agents`, `/toba/dashboard`, and
`/toba/receipts`.

## Configuration

All configuration is via environment variables. Set them in `.env`
(loaded by the systemd unit) or in your shell when running directly.

### Service

| Variable | Default | Purpose |
| --- | --- | --- |
| `TOBA_PORT` | `18815` | Listen port |
| `TOBA_HOST` | `127.0.0.1` | Listen host. Non-loopback requires `TOBA_AUTH_TOKEN`. |
| `TOBA_DB_PATH` | `./state/toba.db` | SQLite path |
| `TOBA_VERSION` | (from package.json) | Reported version string |
| `TOBA_CORS_ORIGIN` | `*` | CORS origin |
| `TOBA_AUTH_TOKEN` | (unset) | Bearer token. Required for non-loopback hosts (Tailscale or public). |
| `TOBA_REQUIRE_AUTH` | (unset → auto) | `true` forces auth even on loopback. `false` keeps legacy behavior. |
| `TOBA_ALLOW_LOOPBACK_NO_AUTH` | `true` | When a token is set, loopback may still skip auth. Set `false` to require auth on every request. |
| `TOBA_AUTOMATION_MODE` | `approval-required` | `manual` / `recommend-only` / `approval-required` |

### Provider / model (standalone)

| Variable | Default | Purpose |
| --- | --- | --- |
| `TOBA_PROVIDER` | `none` | One of: `none`, `echo`, `ollama`, `openai`, `anthropic`, `openrouter`, `xiaomi`, `google`, `groq`, `mistral`, `together`, `deepseek` |
| `TOBA_MODEL` | `none` | Model name for the selected provider |
| `TOBA_PROVIDER_BASE_URL` | (provider default) | Base URL override. Alias: `TOBA_PROVIDER_API_BASE`. |
| `TOBA_PROVIDER_API_KEY` | (unset) | API key for cloud providers. Never echoed in any response. |
| `TOBA_LOCAL_ONLY` | `false` | When `true`, cloud providers are rejected at both selection and call time. |

Local providers (no network, no API key):
- `none` — Toba boots without a provider. Peh chat returns an actionable 503.
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
| `TOBA_OPENROUTER_API_KEY` | Preferred API key env (falls back to `TOBA_PROVIDER_API_KEY`) |
| `TOBA_OPENROUTER_REFERER` | Optional `HTTP-Referer` header (recommended by OpenRouter for app attribution) |
| `TOBA_OPENROUTER_TITLE`   | Optional `X-Title` header (default `Toba`) |

`.env` example:

```
TOBA_PROVIDER=openrouter
TOBA_MODEL=deepseek/deepseek-v4-pro
TOBA_PROVIDER_BASE_URL=https://openrouter.ai/api/v1
TOBA_OPENROUTER_API_KEY=OPENROUTER_API_KEY_HERE
TOBA_OPENROUTER_REFERER=https://toba.local
TOBA_OPENROUTER_TITLE=Toba
TOBA_LOCAL_ONLY=false
```

If the exact OpenRouter slug for DeepSeek v4 Pro differs from
`deepseek/deepseek-v4-pro`, set `TOBA_MODEL` to whatever OpenRouter's
`/api/v1/models` listing returns — the value is passed through verbatim.

The API key is **never** echoed in any response. `GET /toba/provider` and
`GET /status` only surface `api_key_set: true|false`.

### Peh agents (per-agent provider/model)

Toba seeds five built-in Peh personas on first boot:

| Agent id            | Role |
| --- | --- |
| `strategist`        | Main career strategist (weekly planning, target-role decisions) |
| `resume-reviewer`   | Tailors resumes, flags weak bullets, suggests STAR rewrites |
| `outreach-drafter`  | Cold emails, recruiter replies, cover letters |
| `job-scout-analyst` | Posting fit/legitimacy/salary calibration |
| `interview-coach`   | STAR stories, behavioral + technical prep |

Each agent can run its own provider and model. Agents without an override
fall back to the global `TOBA_PROVIDER` / `TOBA_MODEL` default.

Endpoints:

| Endpoint | Notes |
| --- | --- |
| `GET /toba/peh/agents` | List the registry. `api_key` is never returned — `api_key_set` boolean is. |
| `GET /toba/peh/agents/:id` | One agent. |
| `PATCH /toba/peh/agents/:id` | Update provider/model/base_url/api_key/temperature/max_tokens/system_prompt/local_only/cloud_allowed/fallback_provider/fallback_model/enabled. Rejects unknown providers and local-only contradictions. |
| `POST /toba/peh/agents/:id/chat` | Chat as this specific agent. Velum runs first; receipts include `peh_agent_id`. |
| `POST /toba/peh/chat` | Original endpoint. Accepts optional `agent_id` in body. |

Example: route the strategist to OpenRouter DeepSeek v4 Pro, keep
resume-reviewer on a local model, force outreach-drafter local-only:

```bash
TOK="..."  # TOBA_AUTH_TOKEN if running over Tailscale; omit Authorization on loopback

curl -X PATCH http://127.0.0.1:18815/toba/peh/agents/strategist \
  -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"provider":"openrouter","model":"deepseek/deepseek-v4-pro","api_key":"OPENROUTER_API_KEY_HERE","base_url":"https://openrouter.ai/api/v1","temperature":0.4}'

curl -X PATCH http://127.0.0.1:18815/toba/peh/agents/resume-reviewer \
  -H 'content-type: application/json' \
  -d '{"provider":"ollama","model":"llama3","local_only":true}'

curl -X PATCH http://127.0.0.1:18815/toba/peh/agents/outreach-drafter \
  -H 'content-type: application/json' \
  -d '{"cloud_allowed":false,"fallback_provider":"ollama","fallback_model":"llama3"}'
```

Per-agent guarantees:
- Velum redacts user input before any provider sees it.
- `local_only=true` on an agent + cloud provider → 400 at PATCH time.
- `cloud_allowed=false` + cloud provider at call time → 403, or fallback if configured.
- Global `TOBA_LOCAL_ONLY=true` blocks setting any cloud provider on any agent.
- `peh_agent_chat` receipts record agent_id + provider + model + local_mode + velum review state.

### Optional Peh bridge

| Variable | Default | Purpose |
| --- | --- | --- |
| `TOBA_BRIDGE_URL` | (unset, **disabled**) | Legacy Peh bridge URL. Surfaced in `/status` as `bridge_enabled: true`. Toba core behavior never depends on it. |
| `PEH_TOBA_URL` | — | Backwards-compatible alias of `TOBA_BRIDGE_URL`. |

## API surface (selected)

| Endpoint | Notes |
| --- | --- |
| `GET /health` | Deep health: DB reachable + schema match |
| `GET /version` | Service + schema versions |
| `GET /status` | `mode=standalone`, provider state, receipts/velum/automation, last job-scout run |
| `GET /toba/provider` | Full provider status including available providers, `local_only_mode`, `api_key_set` (boolean only — no secret). |
| `PATCH /toba/provider` | Runtime provider/model selection. Body: `{provider, model, base_url?, api_key?, local_only?}`. |
| `POST /toba/provider` | Alias of PATCH. |
| `POST /toba/peh/chat` | Standalone Peh chat through the native provider. Velum-on-by-default (`velum:false` to override). Writes `velum_review` + `model_call` receipts. |
| `GET /toba/job-scout/context` | Local context for an external job-search tool. `live_search_implemented: false` — Toba does not crawl boards itself. |
| `POST /toba/job-scout/ingest` | Ingest jobs into the active campaign (deduped by fingerprint). Receipt includes native provider/model metadata. |
| `POST /toba/velum/review` | Local PII redaction (SSN, email, phone, address, credit card). |
| `GET /toba/receipts?action=...` | Local audit log. |

## Standalone verification

```bash
# Confirm the service runs without Peh
sudo systemctl stop peh.service   # or any *.service that's running
sudo systemctl restart toba.service

# Run the verification suite
./scripts/verify-standalone.sh
```

The script exercises `/health`, `/status`, `/toba/provider`,
`/toba/peh/chat`, `/toba/job-scout/context`, `/toba/velum/review`,
and receipts — and asserts that Velum redacts sensitive data BEFORE the
provider sees it. It exits non-zero on any failure.

## Local-only walkthrough

```bash
# 1) Run Ollama locally
ollama serve &
ollama pull llama3

# 2) Configure Toba
cat > .env <<'EOF'
TOBA_PROVIDER=ollama
TOBA_MODEL=llama3
TOBA_LOCAL_ONLY=true
EOF
sudo systemctl restart toba.service

# 3) Confirm
curl -s localhost:18815/status         | jq '{mode, provider, model, local_only_mode}'
curl -s localhost:18815/toba/provider| jq '.provider | {provider, model, local, local_only_mode, configured}'

# 4) Chat (Velum-redacted before reaching the model)
curl -s -X POST localhost:18815/toba/peh/chat \
  -H 'content-type: application/json' \
  -d '{"message":"What should I focus on this week?}' | jq .
```

## Tailscale access (phone / iPad / other devices on your tailnet)

Toba refuses to start on a non-loopback interface without a token. Set both:

```
TOBA_HOST=0.0.0.0
TOBA_PORT=18815
TOBA_AUTH_TOKEN=<paste-output-of:  openssl rand -hex 32 >
TOBA_REQUIRE_AUTH=true                 # require token even for loopback callers
TOBA_ALLOW_LOOPBACK_NO_AUTH=false      # belt-and-suspenders
```

Network exposure is auto-classified in `/status` as one of:
- `loopback_only` — `127.0.0.1` / `::1`
- `tailscale_reachable` — `100.64.0.0/10` (Tailscale CGNAT) or `0.0.0.0` (interpreted as "exposed beyond loopback; auth required")
- `public_bind` — any other non-loopback IP

Public endpoints (no token): `/`, `/api`, `/assets/*`, `/health`, `/version`.
The UI shell is public so a browser can load the token prompt; sensitive data
routes still require `Authorization: Bearer $TOK` when
`auth_required=true`.

Get your Tailscale IP:

```bash
tailscale ip -4
```

From a phone or iPad on the same tailnet:

```
http://<tailscale-ip>:18815/health
```

```bash
curl -H "Authorization: Bearer $TOK" \
  http://<tailscale-ip>:18815/status
```

Verify your setup:

```bash
TOBA_URL=http://<tailscale-ip>:18815 TOBA_AUTH_TOKEN=$TOBA_AUTH_TOKEN \
./scripts/verify-tailscale-ready.sh
```

### Security guarantees

1. The bind-time guard refuses to start a non-loopback service without a token.
2. `/toba/provider`, `/toba/peh/agents`, `/toba/receipts`, `/toba/profile`, and every other sensitive endpoint requires the bearer when auth is enabled.
3. API keys never appear in any GET — `api_key_set: true|false` only.
4. Bearer comparison uses an exact match against `Bearer <token>` (no prefix tricks).
5. CORS `*` is permitted by default for private-lab use; narrow `TOBA_CORS_ORIGIN` if exposing beyond the tailnet.

## Migration: legacy path → canonical

The service previously lived at a legacy path. To move it
to the standalone canonical path:

```bash
sudo ./scripts/migrate-to-canonical.sh
```

That script stops `toba.service`, copies the SQLite DB (+WAL/SHM) into
`./state/`, installs `toba.service` from
`./toba.service` into `/etc/systemd/system/`, runs
`daemon-reload`, starts the service, and smoke-tests `/health`.

The legacy DB file is left in place as backup.

## Independence guarantees

1. `src/server.ts`, `src/routes.ts`, `src/db.ts`, `src/provider.ts` import
   **zero** Peh modules. (Verified by a test in `server.test.ts`.)
2. Job Scout uses only the local DB and the native provider registry.
3. Velum is in-process, pattern-based, and runs before any provider call
   involving career data. (Verified by `Velum runs BEFORE the provider sees
   sensitive career data`.)
4. Receipts are written for every model call, every Velum review, every
   campaign/application action, every Job Scout ingest, and every automation
   queue transition — to the local `toba_receipts` table.
5. `TOBA_BRIDGE_URL` is unset by default. When set, it only surfaces a
   `bridge_enabled: true` flag in `/status`; no core endpoint reaches out to it.

## Troubleshooting

**Peh chat returns 503 with code `provider_unconfigured`**
Set `TOBA_PROVIDER` and `TOBA_MODEL` (and `TOBA_PROVIDER_API_KEY` for
cloud providers) in `.env` and restart the service, OR
`PATCH /toba/provider` at runtime.

**`provider_misconfigured`**
The response's `error` field lists exactly which fields are missing. Common
causes: missing API key, unknown model, base URL not set for a custom
deployment.

**`local_only_violation`**
`TOBA_LOCAL_ONLY=true` blocks cloud providers. Switch to `ollama`/`echo`
or unset `TOBA_LOCAL_ONLY`.

**Native binding missing for `better-sqlite3`**
`pnpm install` followed by `pnpm rebuild better-sqlite3`. The package's
`pnpm.onlyBuiltDependencies` whitelist already allows it.

## Tests

```bash
pnpm test         # 153 tests covering health, schema, all CRUD,
                  # provider registry, Peh chat, Velum-before-provider,
                  # local-only enforcement, no-secret-leakage, no-Peh-import,
                  # Job Scout standalone, receipts on provider calls.
pnpm typecheck    # strict TypeScript
pnpm build        # tsc emit
```
