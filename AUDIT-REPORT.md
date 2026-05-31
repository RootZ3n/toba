# Toba Standalone Audit Report

**Date:** 2026-05-14
**Version:** 3.0.0
**Schema Version:** 3
**Tests:** 40 passed, 0 failed
**Typecheck:** Clean

---

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `src/db.ts` | Modified | Added receipts table, Velum static review, closeCampaign, getActiveCampaign, countActiveCampaigns, receipt CRUD, schema v3 |
| `src/routes.ts` | Rewritten | Added 7 new endpoints, Velum integration on outreach/resume, receipt generation on all major actions, provider config |
| `src/server.ts` | Modified | Added env var docs for provider/model/bridge, /status to auth bypass |
| `src/server.test.ts` | Rewritten | 40 tests (was 15) covering all new features |
| `package.json` | Modified | Version bump 2.0.0 -> 3.0.0 |
| `toba.service` | Modified | Updated paths for standalone /mnt/ai/toba, added CURSUS_PROVIDER/MODEL env vars |

---

## What Was Broken

### B. Campaign Lifecycle
- **No close endpoint.** Only way to close was PATCH with `{active: false, phase: "closed"}`.
- **No enforcement test.** createCampaign already deactivated previous campaigns (line 534), but no test proved it.
- **UI had stop button** (PATCH-based), but no dedicated API action.

### C. Target Roles
- `target_role` (campaign) and `target_roles` (profile V2) existed in parallel with no defined relationship.
- No endpoint merged them for Job Scout or other consumers.

### D. Job Scout Campaign Awareness
- Agent JSON had hardcoded "AI/ML/systems engineering, cybersecurity, DevOps" and "remote or hybrid locations".
- No standalone endpoint to derive search context from campaign + profile.
- No persistence path for found jobs into toba_applications.

### E. Velum
- Completely absent. No PII review before cloud calls. No redaction.
- Resume uploads and outreach drafts went through unreviewed.

### F. Receipts
- No receipts system in standalone. Legatus had its own, but Toba standalone had zero audit trail.

### G. Model/Provider Selection
- No provider config. Dux chat returned 503 with no clarity on what provider would be needed.
- No metadata about provider/model in any output.

### H. Bridge Behavior
- Mode system existed in Peh API (toba-mode.test.ts), but standalone had no /status endpoint showing its mode.

---

## What Was Fixed

### A. Standalone Service and Port
**Status: Already solid, minor improvements.**
- Port 18815 via CURSUS_PORT (already existed)
- Health/version endpoints (already existed)
- Added `/status` endpoint showing mode, port, provider, campaign state, receipts/velum enabled
- `/status` added to auth bypass list
- Systemd service updated for /mnt/ai/toba standalone path

### B. Campaign Lifecycle
- **Added `POST /toba/campaigns/:id/close`** — dedicated close action setting `{active: false, phase: "closed"}`
- **Added `closeCampaign(id)` DB method** — atomic close operation
- **Added `getActiveCampaign()` DB method** — direct active campaign lookup
- **Added `countActiveCampaigns()` DB method** — active count for enforcement verification
- **One-active-campaign enforced:** createCampaign deactivates all active campaigns before inserting (was already doing this, now tested)
- **Receipt generated** on both campaign create and close
- **7 campaign tests added:** close action, dashboard cleared after close, 404 on nonexistent, deactivation on create, DB-level single-active enforcement

### C. Target Roles
- **Added `GET /toba/job-scout/context`** — returns merged target roles:
  - `primary_target_role`: from active campaign's `target_role`
  - `all_target_roles`: campaign roles + profile `target_roles` (deduplicated)
  - `location`: from V1 profile
- **3 target role tests:** primary vs secondary behavior, profile fallback, deduplication

### D. Job Scout Campaign Awareness
- **Added `GET /toba/job-scout/context`** — campaign-aware search context derivation
  - Returns campaign_id, campaign_name, primary_target_role, all_target_roles, location, provider metadata
  - No hardcoded targets — all derived from campaign + profile
- **Added `POST /toba/job-scout/ingest`** — persists found jobs as toba_applications
  - Requires active campaign
  - Creates applications with company, role, url, salary_range, match_score, match_reason
  - Generates job_scout_run receipt with campaign metadata
- **5 Job Scout tests:** context derivation, profile fallback, null campaign, ingest persistence, ingest metadata

### E. Velum for Toba
- **Added `TobaV2DB.velumReview(text, context)` static method** — local PII detection and redaction
  - Detects: SSN, email, phone, street address, credit card numbers
  - Returns: reviewed, redacted, fields_redacted, original/redacted length, cleaned output
- **Added `POST /toba/velum/review`** — standalone review endpoint
- **Integrated into resume upload** — resumes pass through Velum before storage
- **Integrated into outreach staging** — outreach body is Velum-reviewed, redacted text stored
- **Receipt generated** for every Velum review
- **5 Velum tests:** SSN redaction, email+phone redaction, clean passthrough, outreach integration, resume integration

### F. Receipts System
- **Added `toba_receipts` table** (schema v3)
  - Fields: id, action, timestamp, campaign_id, provider, model, local_mode, velum_reviewed, velum_redacted, result_summary, errors, warnings
  - Indexed on action, campaign_id, timestamp
- **Added `createReceipt()` and `listReceipts()` DB methods**
- **Added `GET /toba/receipts`** — list receipts with optional `?action=` and `?limit=` filters
- **Receipts generated for:**
  - campaign_create, campaign_close
  - job_scout_run
  - application_persist, application_update
  - outreach_generate, outreach_approve, outreach_reject
  - velum_review
- **5 receipt tests:** campaign create/close receipts, application receipts, velum receipts, limit parameter

### G. Model and Provider Selection
- **Added env vars:** CURSUS_PROVIDER, CURSUS_MODEL, CURSUS_PROVIDER_API_BASE
- **Added `GET /toba/provider`** — returns current provider config (provider, model, api_base, local flag)
- **Provider metadata included** in Job Scout receipts
- **Local-first by default:** CURSUS_PROVIDER defaults to "local", isLocalProvider() helper
- **1 provider test:** endpoint returns metadata with local flag

### H. Bridge Behavior
- **Added `GET /status`** — returns operational status:
  - mode: "standalone" or "bridge" (based on PEH_CURSUS_URL)
  - port, provider_mode, active_campaign, receipts_enabled, velum_enabled
- **1 status test:** verifies standalone mode and all fields

---

## Exact Routes/Endpoints Added or Changed

### New Endpoints (7)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/status` | Service status (mode, port, provider, campaign, features) |
| POST | `/toba/campaigns/:id/close` | Close/stop a campaign |
| POST | `/toba/velum/review` | Velum PII review/redaction |
| GET | `/toba/receipts` | List receipts (optional ?action=, ?limit=) |
| GET | `/toba/provider` | Provider/model config metadata |
| GET | `/toba/job-scout/context` | Campaign-aware search context derivation |
| POST | `/toba/job-scout/ingest` | Persist found jobs into active campaign |

### Modified Endpoints (4)
| Method | Path | Change |
|--------|------|--------|
| POST | `/toba/campaigns` | Now generates receipt |
| POST | `/toba/applications` | Now generates receipt |
| PATCH | `/toba/applications/:id` | Now generates receipt |
| POST | `/toba/resumes/upload` | Now runs Velum review, returns velum metadata |
| POST | `/toba/outreach/stage` | Now runs Velum review on body, returns velum metadata |
| POST | `/toba/outreach/:id/approve` | Now generates receipt |
| POST | `/toba/outreach/:id/reject` | Now generates receipt |

---

## Toba Port/Service Details

- **Port:** 18815 (configurable via CURSUS_PORT)
- **Host:** 127.0.0.1 (configurable via CURSUS_HOST, requires CURSUS_AUTH_TOKEN for non-localhost)
- **DB:** SQLite at CURSUS_DB_PATH (default: /mnt/ai/toba/state/toba.db)
- **systemd:** `toba.service` — copy to `/etc/systemd/system/toba.service`

## How to Start Standalone Toba

```bash
cd /mnt/ai/toba
pnpm install
pnpm start
# or
pnpm dev   # watch mode
```

With systemd:
```bash
sudo cp toba.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now toba
```

## How to Verify Standalone

```bash
# Health check
curl http://127.0.0.1:18815/health

# Status (mode, provider, campaign)
curl http://127.0.0.1:18815/status

# Version
curl http://127.0.0.1:18815/version

# Should show mode: "standalone", velum_enabled: true, receipts_enabled: true
```

---

## Test Results

```
 RUN  v1.6.1 /mnt/ai/toba

 ✓ src/server.test.ts  (40 tests) 309ms

 Test Files  1 passed (1)
      Tests  40 passed (40)
```

### Test Breakdown (40 tests)
- Health/version/status: 3
- Schema version: 2
- V1 Profile: 1
- V2 Dashboard: 2
- Campaign CRUD: 1
- Campaign close: 3
- One-active-campaign enforcement: 2
- Application CRUD: 1
- Outreach stealth: 2
- Dux chat 503: 1
- Resume upload: 2
- Velum review/redaction: 5
- Receipts: 5
- Provider/model: 1
- Job Scout context: 3
- Job Scout ingest: 3
- Shared DB safety: 1
- Network guard: 2
- Target roles: 1

Typecheck: Clean (0 errors)

---

## Remaining Deferred Work

1. **Dux chat in standalone** — Returns 503. Needs CURSUS_PROVIDER to actually call an LLM (OpenRouter, Ollama, etc.). Provider integration is wired for config but actual LLM calls are not implemented in standalone. This is by design — Peh bridge handles it.

2. **Job Scout actual execution** — The `GET /toba/job-scout/context` endpoint provides campaign-aware queries, and `POST /toba/job-scout/ingest` persists results. The actual job search execution (RSS/Tavily/LLM) remains in Legatus agents. To make standalone Job Scout fully independent, an execution engine would need to be added.

3. **Gmail integration** — Remains Peh-only (OAuth, send). Not ported to standalone.

4. **Web UI updates** — The stop button in `apps/web/app/toba/page.tsx` already uses PATCH. Could be updated to use the new `POST /campaigns/:id/close` endpoint. Receipts viewer and Velum status could be added to the UI.

5. **Velum cloud-call interception** — Current Velum reviews text before storage. When cloud provider calls are added to standalone, Velum should intercept outbound payloads too.

6. **Peh API route deduplication** — `apps/api/src/routes/toba.ts` and `apps/api/src/db/toba.ts` duplicate V1 schema/logic. Could be refactored to import from apps/toba shared core, but this is lower priority since the bridge mode already proxies to standalone.
