# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **World engine UI** — Pehverse world engine with "The Settlement" map, interactive scenes that match world map locations, and full wiring to the Toba backend.
- **World map assets** — Static assets for the world map UI.
- **MiMo prefix cache hit tracking** — Cache hit tracking for the MiMo prefix cache, providing better observability into cache performance.
- **Per-agent provider/model routing** — Each Peh agent (strategist, resume-reviewer, outreach-drafter, job-scout-analyst, interview-coach) can now be independently configured with its own provider, model, API key, temperature, and local-only/cloud-allowed settings.
- **Standalone setup wizard** — Idempotent `toba:setup` wizard that handles preflight checks, dependency installation, build verification, provider selection, Tailscale access configuration, and service migration.
- **Tailscale-ready verification** — `verify-tailscale-ready.sh` script to confirm secure remote access setup.
- **Release privacy hardening** — `audit-release-privacy.sh` and `toba-reset.sh` with `--personal-data-only` flag for safe public demos.
- **Receipts audit log** — Full audit trail (`toba_receipts` table) recording every model call, Velum review, campaign/application action, Job Scout ingest, and automation queue transition.

### Changed

- **Rebrand: cursus → toba** — All codebase references, routes, environment variables, and branding updated from `cursus` to `toba`.
- **Rebrand: Squidley → Peh** — All Squidley references replaced with Peh across the codebase.
- **Renamed: Dux → Peh** — Full rename across codebase including session memory, resume tailoring, and token footer.
- **Build system** — Native-build approval moved to `pnpm-workspace.yaml` for pnpm 11 compatibility.

### Fixed

- **Web build** — Fixed broken web build so the UI (and toba-web) serve assets correctly.
- **Route prefix rewrite** — Corrected `/toba/*` route prefix rewrite (audit item B1).
- **Factory reset scope** — Factory reset now clears current `toba_*` data, not just legacy `cursus_*` data (audit item H5).
- **Operational audit** — Fixed file logs, provider persistence, DB path, backup TTL, and shutdown timeout issues.
- **UI scenes** — Scenes now correctly match world map locations.

### Security

- **API keys never echoed** — Provider API keys are surfaced as `api_key_set: true|false` only, never leaked in any response.
- **Non-loopback auth enforcement** — Toba refuses to bind on non-loopback interfaces without a configured `CURSUS_AUTH_TOKEN`.
- **Loopback auth toggle** — `CURSUS_ALLOW_LOOPBACK_NO_AUTH` and `CURSUS_REQUIRE_AUTH` provide fine-grained control over authentication requirements.
