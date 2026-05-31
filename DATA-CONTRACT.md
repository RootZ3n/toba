# Toba Data Contract

## User-owned data (never auto-overwrite)
| Table | Owner | Notes |
|---|---|---|
| `toba_profile` | User | Name, title, summary, location. Editable via PATCH. |
| `toba_experience` | User | Work history entries. |
| `toba_certifications` | User | Cert status, dates. Only user marks complete. |
| `toba_projects` | User | Portfolio projects. |
| `toba_products` | User | Product catalog. |
| `toba_skills` | User | Skills inventory. |
| `toba_resumes` | User | Resume texts. Velum-reviewed on ingest. |
| `toba_interview_stories` | User | STAR stories. User creates/edits. |
| `toba_onboarding` | User | Onboarding preferences. |

## System-managed data (auto-created, system-maintained)
| Table | Owner | Notes |
|---|---|---|
| `toba_campaigns` | System+User | User creates; system enforces one-active. |
| `toba_search_lanes` | System+User | User defines; system uses for job scout context. |
| `toba_applications` | System+User | Job scout auto-creates; user updates status. |
| `toba_job_evaluations` | System | Generated evaluation reports. |
| `toba_outreach` | System+User | Staged by system; approved/rejected by user. |
| `toba_automation` | System | Task queue. User approves/rejects. |
| `toba_dux_sessions` | System | Chat session logs. |
| `toba_receipts` | System | Immutable audit trail. Never deleted. |
| `toba_meta` | System | Schema version tracking. |

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
| `state/toba.db` | DB | Single SQLite file, WAL mode. |
| `apps/toba/src/db.ts` | Code | Schema + all DB operations. |
| `apps/toba/src/routes.ts` | Code | All HTTP endpoints. |
| `apps/toba/src/server.ts` | Code | Fastify bootstrap. |
| `apps/toba/src/server.test.ts` | Code | 63 tests covering all features. |
