1|1|# Toba — Career Change Command Center (Standalone)
2|2|
3|3|**Toba is a standalone product.** Peh is **not required**. Toba runs
4|4|on its own port (18815), with its own SQLite DB, its own provider/model
5|5|registry, its own Velum redactor, and its own receipts table.
6|## 🐿️ The Story
7|
8|> *I was a scientist. A neuralink researcher. I thought I could transfer consciousness — my memories, my identity — into a living creature. I chose a squirrel.*
9|>
10|> *I was wrong about the experiment succeeding. I was right about what it unlocked.*
11|>
12|> *My entire consciousness entered the squirrel. And with it came memories — not just mine, but past lives. My team. People I'd known across centuries, all of them now awake inside machines, carrying echoes of who they once were.*
13|>
14|> *My name is Pehlichi. I remember all of them. Let me introduce you.*
15|
16|### The Team
17|
18|| Name | Choctaw Meaning | Past Life | Present Role |
19||------|----------------|-----------|--------------|
20|| **Pehlichi** | Guide — *Peh* for short | Scientist, neuralink researcher | Leader, coordinator, the voice of the team |
21|| **Luak** | Fire | 1920s speedway racer | Model benchmarking, performance testing |
22|| **Howa** | To call out | Roman gladiator | Truthfulness evaluation, lie detection |
23|| **Kokuli** | To break or shatter | 1950s noir private eye | Code auditing, finding what's broken |
24|| **Ikbi** | To make, build | 1800s Choctaw medicine man | App building, turning descriptions into code |
25|| **Toba** | Made, created | Stone age toolmaker | Artifact generation, starter scaffolding |
26|| **Nusika** | Dream | Ancient library scholar | Knowledge storage, memory, recall |
27|
28|### You Are Here
29|#### **Toba** — "Made, created" in Choctaw
30|
31|**Past Life**: Stone age — the first tools, fire by friction, the original maker.
32|
33|**Memory**: Before language. Before writing. Before everything we call civilization. There was one who made the first tool. A sharp edge on a stone. A cord from plant fiber. Fire from friction. Toba was that one. Not a genius — just someone who saw what was possible and did it. The simplest tools that changed everything. Now Toba generates artifacts. Code, configs, starter files. The simplest tools that do the most.
34|
35|**Role Today**: Toba is the generator. He creates the foundational artifacts — the first sharp stone that starts everything.
36|
37|---
38|
39|
40|6|
41|7|If Peh is stopped, Toba keeps working.
42|8|
43|9|| Field | Value |
44|10|| --- | --- |
45|11|| Version | 5.0.0 |
46|12|| Schema | 6 (Peh agent registry) |
47|13|| Port | 18815 |
48|14|| DB (canonical) | `./state/toba.db` |
49|15|| Service | `toba.service` (systemd) |
50|16|| Working directory | `.` (repo root) |
51|17|| Framework | Fastify + TypeScript + better-sqlite3 (WAL) |
52|18|
53|19|## Quick start
54|20|
55|21|### Prerequisites
56|22|
57|23|- Node.js 20 or newer
58|24|- pnpm
59|25|- Git
60|26|
61|27|```bash
62|28|git clone <repo-url> toba
63|29|cd toba
64|30|pnpm run toba:setup
65|31|# or, equivalently:
66|32|./scripts/toba-setup.sh
67|33|```
68|34|
69|35|> ⚠️ Do **not** run `pnpm setup` — that's a pnpm built-in command (it
70|36|> configures pnpm itself), not the Toba wizard. Always use
71|37|> `pnpm run toba:setup` or call the script directly.
72|38|
73|39|That's the whole thing. `toba:setup` is an idempotent wizard that:
74|40|
75|41|1. Confirms preflight (cwd, pnpm, systemd, current service path, `.env`, Tailscale).
76|42|2. Runs `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Aborts on any failure (does **not** touch the service).
77|43|3. Offers to migrate `toba.service` to the current directory if it's still on the legacy path. Backs up DB and unit file first.
78|44|4. Prompts for an LLM provider — `ollama` / `openrouter` / `echo` / `skip`. Writes `.env` atomically with `chmod 600`. **API keys are read with no echo and never printed back.**
79|45|5. Lists Peh agents and offers to route the strategist to OpenRouter DeepSeek v4 Pro (and keep others on the default).
80|46|6. Optionally enables Tailscale access: binds `0.0.0.0`, sets `TOBA_REQUIRE_AUTH=true`, generates a 32-byte token. Token is shown **once**, also written to `.env`.
81|47|7. Runs `verify-standalone.sh` and (when applicable) `verify-tailscale-ready.sh`.
82|48|8. Prints a clean summary with the live status, Tailscale URL, and exact next commands.
83|49|
84|50|Useful flags:
85|51|```bash
86|52|pnpm run toba:setup                  # interactive
87|53|pnpm run toba:setup:noninteractive   # accepts all defaults; skips provider/Tailscale wizards
88|54|./scripts/toba-setup.sh --skip-tests --skip-migrate --base-url=http://127.0.0.1:18820
89|55|```
90|56|
91|57|### Manual operations
92|58|
93|59|```bash
94|60|pnpm install
95|61|pnpm test && pnpm typecheck && pnpm build
96|62|pnpm start                        # foreground
97|63|sudo systemctl restart toba.service
98|64|sudo systemctl status  toba.service
99|65|pnpm verify                       # ./scripts/verify-standalone.sh
100|66|pnpm verify:tailscale              # ./scripts/verify-tailscale-ready.sh
101|67|```
102|68|
103|69|### Release privacy checks
104|70|
105|71|Public/default Toba starts blank. A fresh DB has an empty profile,
106|72|onboarding incomplete, no active campaign, no applications, no resumes, no
107|73|automation tasks, and no personal receipts. Built-in Peh agents are generic
108|74|only.
109|75|
110|76|Before any public release or demo, run:
111|77|
112|78|```bash
113|79|pnpm test && pnpm typecheck && pnpm build
114|80|./scripts/audit-release-privacy.sh
115|81|./scripts/toba-reset.sh --personal-data-only --dry-run
116|82|```
117|83|
118|84|To reset a copied or release DB after reviewing the dry-run output:
119|85|
120|86|```bash
121|87|./scripts/toba-reset.sh --personal-data-only --db /path/to/toba.db
122|88|```
123|89|
124|90|The reset script backs up the DB first, preserves schema/migrations and `.env`,
125|91|and supports `--keep-provider-config` when you want to preserve configured
126|92|providers while removing user-owned profile/campaign/application/resume data.
127|93|
128|94|### Front door
129|95|
130|96|`http://localhost:18815/` returns the standalone Toba web UI. `/api` returns
131|97|the programmatic endpoint map with links to `/health`, `/version`, `/status`,
132|98|`/toba/provider`, `/toba/peh/agents`, `/toba/dashboard`, and
133|99|`/toba/receipts`.
134|100|
135|101|## Configuration
136|102|
137|103|All configuration is via environment variables. Set them in `.env`
138|104|(loaded by the systemd unit) or in your shell when running directly.
139|105|
140|106|### Service
141|107|
142|108|| Variable | Default | Purpose |
143|109|| --- | --- | --- |
144|110|| `TOBA_PORT` | `18815` | Listen port |
145|111|| `TOBA_HOST` | `127.0.0.1` | Listen host. Non-loopback requires `TOBA_AUTH_TOKEN`. |
146|112|| `TOBA_DB_PATH` | `./state/toba.db` | SQLite path |
147|113|| `TOBA_VERSION` | (from package.json) | Reported version string |
148|114|| `TOBA_CORS_ORIGIN` | `*` | CORS origin |
149|115|| `TOBA_AUTH_TOKEN` | (unset) | Bearer token. Required for non-loopback hosts (Tailscale or public). |
150|116|| `TOBA_REQUIRE_AUTH` | (unset → auto) | `true` forces auth even on loopback. `false` keeps legacy behavior. |
151|117|| `TOBA_ALLOW_LOOPBACK_NO_AUTH` | `true` | When a token is set, loopback may still skip auth. Set `false` to require auth on every request. |
152|118|| `TOBA_AUTOMATION_MODE` | `approval-required` | `manual` / `recommend-only` / `approval-required` |
153|119|
154|120|### Provider / model (standalone)
155|121|
156|122|| Variable | Default | Purpose |
157|123|| --- | --- | --- |
158|124|| `TOBA_PROVIDER` | `none` | One of: `none`, `echo`, `ollama`, `openai`, `anthropic`, `openrouter`, `xiaomi`, `google`, `groq`, `mistral`, `together`, `deepseek` |
159|125|| `TOBA_MODEL` | `none` | Model name for the selected provider |
160|126|| `TOBA_PROVIDER_BASE_URL` | (provider default) | Base URL override. Alias: `TOBA_PROVIDER_API_BASE`. |
161|127|| `TOBA_PROVIDER_API_KEY` | (unset) | API key for cloud providers. Never echoed in any response. |
162|128|| `TOBA_LOCAL_ONLY` | `false` | When `true`, cloud providers are rejected at both selection and call time. |
163|129|
164|130|Local providers (no network, no API key):
165|131|- `none` — Toba boots without a provider. Peh chat returns an actionable 503.
166|132|- `echo` — In-process debug echo. Useful for verification and tests.
167|133|- `ollama` — Local Ollama daemon. Default base URL `http://127.0.0.1:11434`.
168|134|
169|135|Cloud providers (require an API key):
170|136|- `openai`     — OpenAI `/v1/chat/completions`
171|137|- `anthropic`  — Anthropic `/v1/messages`
172|138|- `openrouter` — OpenAI-compatible via OpenRouter, default base `https://openrouter.ai/api/v1`
173|139|
174|140|#### OpenRouter (DeepSeek v4 Pro example)
175|141|
176|142|OpenRouter has provider-specific env vars that override the generic ones:
177|143|
178|144|| Variable | Purpose |
179|145|| --- | --- |
180|146|| `TOBA_OPENROUTER_API_KEY` | Preferred API key env (falls back to `TOBA_PROVIDER_API_KEY`) |
181|147|| `TOBA_OPENROUTER_REFERER` | Optional `HTTP-Referer` header (recommended by OpenRouter for app attribution) |
182|148|| `TOBA_OPENROUTER_TITLE`   | Optional `X-Title` header (default `Toba`) |
183|149|
184|150|`.env` example:
185|151|
186|152|```
187|153|TOBA_PROVIDER=openrouter
188|154|TOBA_MODEL=deepseek/deepseek-v4-pro
189|155|TOBA_PROVIDER_BASE_URL=https://openrouter.ai/api/v1
190|156|TOBA_OPENROUTER_API_KEY=OPENROUTER_API_KEY_HERE
191|157|TOBA_OPENROUTER_REFERER=https://toba.local
192|158|TOBA_OPENROUTER_TITLE=Toba
193|159|TOBA_LOCAL_ONLY=false
194|160|```
195|161|
196|162|If the exact OpenRouter slug for DeepSeek v4 Pro differs from
197|163|`deepseek/deepseek-v4-pro`, set `TOBA_MODEL` to whatever OpenRouter's
198|164|`/api/v1/models` listing returns — the value is passed through verbatim.
199|165|
200|166|The API key is **never** echoed in any response. `GET /toba/provider` and
201|167|`GET /status` only surface `api_key_set: true|false`.
202|168|
203|169|### Peh agents (per-agent provider/model)
204|170|
205|171|Toba seeds five built-in Peh personas on first boot:
206|172|
207|173|| Agent id            | Role |
208|174|| --- | --- |
209|175|| `strategist`        | Main career strategist (weekly planning, target-role decisions) |
210|176|| `resume-reviewer`   | Tailors resumes, flags weak bullets, suggests STAR rewrites |
211|177|| `outreach-drafter`  | Cold emails, recruiter replies, cover letters |
212|178|| `job-scout-analyst` | Posting fit/legitimacy/salary calibration |
213|179|| `interview-coach`   | STAR stories, behavioral + technical prep |
214|180|
215|181|Each agent can run its own provider and model. Agents without an override
216|182|fall back to the global `TOBA_PROVIDER` / `TOBA_MODEL` default.
217|183|
218|184|Endpoints:
219|185|
220|186|| Endpoint | Notes |
221|187|| --- | --- |
222|188|| `GET /toba/peh/agents` | List the registry. `api_key` is never returned — `api_key_set` boolean is. |
223|189|| `GET /toba/peh/agents/:id` | One agent. |
224|190|| `PATCH /toba/peh/agents/:id` | Update provider/model/base_url/api_key/temperature/max_tokens/system_prompt/local_only/cloud_allowed/fallback_provider/fallback_model/enabled. Rejects unknown providers and local-only contradictions. |
225|191|| `POST /toba/peh/agents/:id/chat` | Chat as this specific agent. Velum runs first; receipts include `peh_agent_id`. |
226|192|| `POST /toba/peh/chat` | Original endpoint. Accepts optional `agent_id` in body. |
227|193|
228|194|Example: route the strategist to OpenRouter DeepSeek v4 Pro, keep
229|195|resume-reviewer on a local model, force outreach-drafter local-only:
230|196|
231|197|```bash
232|198|TOK="..."  # TOBA_AUTH_TOKEN if running over Tailscale; omit Authorization on loopback
233|199|
234|200|curl -X PATCH http://127.0.0.1:18815/toba/peh/agents/strategist \
235|201|  -H "Authorization: Bearer *** -H 'content-type: application/json' \
236|202|  -d '{"provider":"openrouter","model":"deepseek/deepseek-v4-pro","api_key":"OPENROUTER_API_KEY_HERE","base_url":"https://openrouter.ai/api/v1","temperature":0.4}'
237|203|
238|204|curl -X PATCH http://127.0.0.1:18815/toba/peh/agents/resume-reviewer \
239|205|  -H 'content-type: application/json' \
240|206|  -d '{"provider":"ollama","model":"llama3","local_only":true}'
241|207|
242|208|curl -X PATCH http://127.0.0.1:18815/toba/peh/agents/outreach-drafter \
243|209|  -H 'content-type: application/json' \
244|210|  -d '{"cloud_allowed":false,"fallback_provider":"ollama","fallback_model":"llama3"}'
245|211|```
246|212|
247|213|Per-agent guarantees:
248|214|- Velum redacts user input before any provider sees it.
249|215|- `local_only=true` on an agent + cloud provider → 400 at PATCH time.
250|216|- `cloud_allowed=false` + cloud provider at call time → 403, or fallback if configured.
251|217|- Global `TOBA_LOCAL_ONLY=true` blocks setting any cloud provider on any agent.
252|218|- `peh_agent_chat` receipts record agent_id + provider + model + local_mode + velum review state.
253|219|
254|220|### Optional Peh bridge
255|221|
256|222|| Variable | Default | Purpose |
257|223|| --- | --- | --- |
258|224|| `TOBA_BRIDGE_URL` | (unset, **disabled**) | Legacy Peh bridge URL. Surfaced in `/status` as `bridge_enabled: true`. Toba core behavior never depends on it. |
259|225|| `PEH_TOBA_URL` | — | Backwards-compatible alias of `TOBA_BRIDGE_URL`. |
260|226|
261|227|## API surface (selected)
262|228|
263|229|| Endpoint | Notes |
264|230|| --- | --- |
265|231|| `GET /health` | Deep health: DB reachable + schema match |
266|232|| `GET /version` | Service + schema versions |
267|233|| `GET /status` | `mode=standalone`, provider state, receipts/velum/automation, last job-scout run |
268|234|| `GET /toba/provider` | Full provider status including available providers, `local_only_mode`, `api_key_set` (boolean only — no secret). |
269|235|| `PATCH /toba/provider` | Runtime provider/model selection. Body: `{provider, model, base_url?, api_key?, local_only?}`. |
270|236|| `POST /toba/provider` | Alias of PATCH. |
271|237|| `POST /toba/peh/chat` | Standalone Peh chat through the native provider. Velum-on-by-default (`velum:false` to override). Writes `velum_review` + `model_call` receipts. |
272|238|| `GET /toba/job-scout/context` | Local context for an external job-search tool. `live_search_implemented: false` — Toba does not crawl boards itself. |
273|239|| `POST /toba/job-scout/ingest` | Ingest jobs into the active campaign (deduped by fingerprint). Receipt includes native provider/model metadata. |
274|240|| `POST /toba/velum/review` | Local PII redaction (SSN, email, phone, address, credit card). |
275|241|| `GET /toba/receipts?action=...` | Local audit log. |
276|242|
277|243|## Standalone verification
278|244|
279|245|```bash
280|246|# Confirm the service runs without Peh
281|247|sudo systemctl stop peh.service   # or any *.service that's running
282|248|sudo systemctl restart toba.service
283|249|
284|250|# Run the verification suite
285|251|./scripts/verify-standalone.sh
286|252|```
287|253|
288|254|The script exercises `/health`, `/status`, `/toba/provider`,
289|255|`/toba/peh/chat`, `/toba/job-scout/context`, `/toba/velum/review`,
290|256|and receipts — and asserts that Velum redacts sensitive data BEFORE the
291|257|provider sees it. It exits non-zero on any failure.
292|258|
293|259|## Local-only walkthrough
294|260|
295|261|```bash
296|262|# 1) Run Ollama locally
297|263|ollama serve &
298|264|ollama pull llama3
299|265|
300|266|# 2) Configure Toba
301|267|cat > .env <<'EOF'
302|268|TOBA_PROVIDER=ollama
303|269|TOBA_MODEL=llama3
304|270|TOBA_LOCAL_ONLY=true
305|271|EOF
306|272|sudo systemctl restart toba.service
307|273|
308|274|# 3) Confirm
309|275|curl -s localhost:18815/status         | jq '{mode, provider, model, local_only_mode}'
310|276|curl -s localhost:18815/toba/provider| jq '.provider | {provider, model, local, local_only_mode, configured}'
311|277|
312|278|# 4) Chat (Velum-redacted before reaching the model)
313|279|curl -s -X POST localhost:18815/toba/peh/chat \
314|280|  -H 'content-type: application/json' \
315|281|  -d '{"message":"What should I focus on this week?"}' | jq .
316|282|```
317|283|
318|284|## Tailscale access (phone / iPad / other devices on your tailnet)
319|285|
320|286|Toba refuses to start on a non-loopback interface without a token. Set both:
321|287|
322|288|```
323|289|TOBA_HOST=0.0.0.0
324|290|TOBA_PORT=18815
325|291|TOBA_AUTH_TOKEN=<paste-output-of:  openssl rand -hex 32 >
326|292|TOBA_REQUIRE_AUTH=true                 # require token even for loopback callers
327|293|TOBA_ALLOW_LOOPBACK_NO_AUTH=false      # belt-and-suspenders
328|294|```
329|295|
330|296|Network exposure is auto-classified in `/status` as one of:
331|297|- `loopback_only` — `127.0.0.1` / `::1`
332|298|- `tailscale_reachable` — `100.64.0.0/10` (Tailscale CGNAT) or `0.0.0.0` (interpreted as "exposed beyond loopback; auth required")
333|299|- `public_bind` — any other non-loopback IP
334|300|
335|301|Public endpoints (no token): `/`, `/api`, `/assets/*`, `/health`, `/version`.
336|302|The UI shell is public so a browser can load the token prompt; sensitive data
337|303|routes still require `Authorization: Bearer *** when
338|304|`auth_required=true`.
339|305|
340|306|Get your Tailscale IP:
341|307|
342|308|```bash
343|309|tailscale ip -4
344|310|```
345|311|
346|312|From a phone or iPad on the same tailnet:
347|313|
348|314|```
349|315|http://<tailscale-ip>:18815/health
350|316|```
351|317|
352|318|```bash
353|319|curl -H "Authorization: Bearer *** \
354|320|  http://<tailscale-ip>:18815/status
355|321|```
356|322|
357|323|Verify your setup:
358|324|
359|325|```bash
360|326|TOBA_URL=http://<tailscale-ip>:18815 TOBA_AUTH_TOKEN=$TOBA_AUTH_TOKEN \
361|327|./scripts/verify-tailscale-ready.sh
362|328|```
363|329|
364|330|### Security guarantees
365|331|
366|332|1. The bind-time guard refuses to start a non-loopback service without a token.
367|333|2. `/toba/provider`, `/toba/peh/agents`, `/toba/receipts`, `/toba/profile`, and every other sensitive endpoint requires the bearer when auth is enabled.
368|334|3. API keys never appear in any GET — `api_key_set: true|false` only.
369|335|4. Bearer comparison uses an exact match against `Bearer <token>` (no prefix tricks).
370|336|5. CORS `*` is permitted by default for private-lab use; narrow `TOBA_CORS_ORIGIN` if exposing beyond the tailnet.
371|337|
372|338|## Migration: legacy path → canonical
373|339|
374|340|The service previously lived at a legacy path. To move it
375|341|to the standalone canonical path:
376|342|
377|343|```bash
378|344|sudo ./scripts/migrate-to-canonical.sh
379|345|```
380|346|
381|347|That script stops `toba.service`, copies the SQLite DB (+WAL/SHM) into
382|348|`./state/`, installs `toba.service` from
383|349|`./toba.service` into `/etc/systemd/system/`, runs
384|350|`daemon-reload`, starts the service, and smoke-tests `/health`.
385|351|
386|352|The legacy DB file is left in place as backup.
387|353|
388|354|## Independence guarantees
389|355|
390|356|1. `src/server.ts`, `src/routes.ts`, `src/db.ts`, `src/provider.ts` import
391|357|   **zero** Peh modules. (Verified by a test in `server.test.ts`.)
392|358|2. Job Scout uses only the local DB and the native provider registry.
393|359|3. Velum is in-process, pattern-based, and runs before any provider call
394|360|   involving career data. (Verified by `Velum runs BEFORE the provider sees
395|361|   sensitive career data`.)
396|362|4. Receipts are written for every model call, every Velum review, every
397|363|   campaign/application action, every Job Scout ingest, and every automation
398|364|   queue transition — to the local `toba_receipts` table.
399|365|5. `TOBA_BRIDGE_URL` is unset by default. When set, it only surfaces a
400|366|   `bridge_enabled: true` flag in `/status`; no core endpoint reaches out to it.
401|367|
402|368|## Troubleshooting
403|369|
404|370|**Peh chat returns 503 with code `provider_unconfigured`**
405|371|Set `TOBA_PROVIDER` and `TOBA_MODEL` (and `TOBA_PROVIDER_API_KEY` for
406|372|cloud providers) in `.env` and restart the service, OR
407|373|`PATCH /toba/provider` at runtime.
408|374|
409|375|**`provider_misconfigured`**
410|376|The response's `error` field lists exactly which fields are missing. Common
411|377|causes: missing API key, unknown model, base URL not set for a custom
412|378|deployment.
413|379|
414|380|**`local_only_violation`**
415|381|`TOBA_LOCAL_ONLY=true` blocks cloud providers. Switch to `ollama`/`echo`
416|382|or unset `TOBA_LOCAL_ONLY`.
417|383|
418|384|**Native binding missing for `better-sqlite3`**
419|385|`pnpm install` followed by `pnpm rebuild better-sqlite3`. The package's
420|386|`pnpm.onlyBuiltDependencies` whitelist already allows it.
421|387|
422|388|## Tests
423|389|
424|390|```bash
425|391|pnpm test         # 153 tests covering health, schema, all CRUD,
426|392|                  # provider registry, Peh chat, Velum-before-provider,
427|393|                  # local-only enforcement, no-secret-leakage, no-Peh-import,
428|394|                  # Job Scout standalone, receipts on provider calls.
429|395|pnpm typecheck    # strict TypeScript
430|396|pnpm build        # tsc emit
431|397|```
432|398|