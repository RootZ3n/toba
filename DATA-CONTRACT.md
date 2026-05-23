# Cursus Data Contract

## User-owned data (never auto-overwrite)
| Table | Owner | Notes |
|---|---|---|
| `cursus_profile` | User | Name, title, summary, location. Editable via PATCH. |
| `cursus_experience` | User | Work history entries. |
| `cursus_certifications` | User | Cert status, dates. Only user marks complete. |
| `cursus_projects` | User | Portfolio projects. |
| `cursus_products` | User | Product catalog. |
| `cursus_skills` | User | Skills inventory. |
| `cursus_resumes` | User | Resume texts. Velum-reviewed on ingest. |
| `cursus_interview_stories` | User | STAR stories. User creates/edits. |
| `cursus_onboarding` | User | Onboarding preferences. |

## System-managed data (auto-created, system-maintained)
| Table | Owner | Notes |
|---|---|---|
| `cursus_campaigns` | System+User | User creates; system enforces one-active. |
| `cursus_search_lanes` | System+User | User defines; system uses for job scout context. |
| `cursus_applications` | System+User | Job scout auto-creates; user updates status. |
| `cursus_job_evaluations` | System | Generated evaluation reports. |
| `cursus_outreach` | System+User | Staged by system; approved/rejected by user. |
| `cursus_automation` | System | Task queue. User approves/rejects. |
| `cursus_dux_sessions` | System | Chat session logs. |
| `cursus_receipts` | System | Immutable audit trail. Never deleted. |
| `cursus_meta` | System | Schema version tracking. |

## Safety rules
1. **No auto-submission**: Applications are never submitted without explicit user approval.
2. **No auto-send**: Outreach is staged, never sent, without user approval.
3. **No cert auto-complete**: Certification status changes require explicit user action.
4. **Velum review**: All resume/outreach text passes through Velum redaction before storage.
5. **Receipts**: Major actions generate receipts. Receipts are append-only.
6. **Backup before migration**: Schema migrations require a timestamped backup first.
7. **Localhost only**: Service refuses to bind non-localhost without auth token.

## Files
| Path | Type | Notes |
|---|---|---|
| `state/cursus.db` | DB | Single SQLite file, WAL mode. |
| `apps/cursus/src/db.ts` | Code | Schema + all DB operations. |
| `apps/cursus/src/routes.ts` | Code | All HTTP endpoints. |
| `apps/cursus/src/server.ts` | Code | Fastify bootstrap. |
| `apps/cursus/src/server.test.ts` | Code | 63 tests covering all features. |
