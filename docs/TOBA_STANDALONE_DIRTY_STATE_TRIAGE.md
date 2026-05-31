# Toba Standalone Dirty State Triage

Date: 2026-05-23

Context: Peh-v2 removed its embedded Toba package in commit `c53f110`. `/mnt/ai/toba` is now the standalone source of truth. Peh integrates by bridge/proxy only.

## Classification

| Path | Classification | Decision |
| --- | --- | --- |
| `README.md` | docs/readme work | Commit. Documents standalone setup wizard, provider choices, Tailscale/auth posture, UI/API front doors, and no-Peh operation. |
| `package.json` | setup/install work | Commit. Adds explicit setup and verification scripts; no Peh dependency. |
| `.gitignore` | env/secret risk handling | Commit. Adds `.env*` coverage so `.env.bak.*` files are ignored. |
| `.env.bak.20260523-100730` | env/secret risk | Do not commit. Local backup may contain tokens/API keys. |
| `scripts/toba-setup.sh` | setup/install work | Commit. One-command standalone setup with preflight, tests/build, provider wizard, Tailscale auth setup, and verification. |
| `src/network.ts` | network/Tailscale/auth guard work | Commit. Allows only the UI shell/API map/static assets plus health/version as public paths; sensitive routes remain bearer-gated when auth is required. |
| `src/routes.ts` | intentional standalone release work / web UI work | Commit. Serves Toba-owned SPA assets and `/api` endpoint map from the standalone service. Provider dispatch remains delegated to `provider.ts`. |
| `src/server.test.ts` | tests | Commit. Adds coverage for SPA shell, static assets, API map, public UI shell paths, and no API-key leakage. |
| `src/web/index.html` | web UI work | Commit. First-party standalone Toba UI shell. Not generated and not copied from Peh. |
| `src/web/app.js` | web UI work | Commit. Vanilla JS client for Toba endpoints. Stores bearer token only in browser localStorage and sends it as `Authorization: Bearer ...`. |
| `src/web/styles.css` | web UI work | Commit. Static styles for the standalone UI. Not generated. |

## Validation Notes

- Package scripts remain independent: `build`, `start`, `typecheck`, `test`, `toba:setup`, `verify`, and `verify:tailscale`.
- No package dependency or script points at Peh.
- Network guard still refuses unauthenticated non-loopback binds.
- Tailscale access remains explicit: bind beyond loopback only with auth token, with `CURSUS_REQUIRE_AUTH=true` and `CURSUS_ALLOW_LOOPBACK_NO_AUTH=false` recommended.
- `/`, `/api`, and `/assets/*` are public by design so the browser UI and token prompt can load before authentication. Sensitive JSON routes stay protected.
- Cloud provider calls are not automatic. They occur only through configured provider/model paths and remain blocked by `CURSUS_LOCAL_ONLY=true`.

## Deferred / Not Committed

- `.env` and `.env.bak.*` remain local-only secret material.
- No generated `dist`, `state`, DB, logs, cache, or `node_modules` files should be committed.
