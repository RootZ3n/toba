/**
 * Cursus Standalone Service
 * ==========================
 * Career Change Command Center — standalone product. No Squidley required.
 *
 * Environment:
 *   CURSUS_PORT                     — listen port (default 18815)
 *   CURSUS_HOST                     — listen host (default 127.0.0.1)
 *   CURSUS_DB_PATH                  — path to cursus.db (default /var/lib/cursus/cursus.db,
 *                                      falls back to legacy /mnt/ai/squidley-v2/state/cursus.db
 *                                      if that legacy file exists and the default does not)
 *   CURSUS_VERSION                  — reported version string
 *   CURSUS_CORS_ORIGIN              — CORS origin (default *)
 *   CURSUS_AUTH_TOKEN               — Bearer token. Required when bound to any non-loopback host
 *                                      (Tailscale, public). Optional on loopback.
 *   CURSUS_REQUIRE_AUTH             — "true" forces auth even on loopback; "false" leaves the
 *                                      legacy behavior (auth only when bound non-loopback OR token set)
 *   CURSUS_ALLOW_LOOPBACK_NO_AUTH   — "false" disables the loopback-skip when a token is set
 *   CURSUS_PROVIDER                 — native provider id: none|echo|ollama|openai|anthropic|openrouter
 *   CURSUS_MODEL                    — model name for the selected provider
 *   CURSUS_PROVIDER_BASE_URL        — provider API base URL (alias: CURSUS_PROVIDER_API_BASE)
 *   CURSUS_PROVIDER_API_KEY         — generic provider API key (never echoed in status)
 *   CURSUS_OPENROUTER_API_KEY       — preferred OpenRouter key (falls back to CURSUS_PROVIDER_API_KEY)
 *   CURSUS_OPENROUTER_REFERER       — optional HTTP-Referer header for OpenRouter
 *   CURSUS_OPENROUTER_TITLE         — optional X-Title header for OpenRouter (default "Cursus")
 *   CURSUS_LOCAL_ONLY               — "true" to block cloud providers globally
 *   CURSUS_AUTOMATION_MODE          — automation mode (manual|recommend-only|approval-required)
 *   CURSUS_BRIDGE_URL               — OPTIONAL legacy Squidley bridge URL; disabled by default
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { existsSync } from "node:fs";
import { CursusV1DB, CursusV2DB } from "./db.js";
import { registerRoutes } from "./routes.js";
import { loadNetworkConfig, shouldAllowRequest } from "./network.js";

const CANONICAL_DB = "/var/lib/cursus/cursus.db";
const LEGACY_DB = "/mnt/ai/squidley-v2/state/cursus.db";
const DB_PATH = process.env["CURSUS_DB_PATH"] ??
  (existsSync(CANONICAL_DB) || !existsSync(LEGACY_DB) ? CANONICAL_DB : LEGACY_DB);
const CORS_ORIGIN = process.env["CURSUS_CORS_ORIGIN"] ?? "*";

async function main() {
  // ── Network config + safety guard ──────────────────────────────────────────
  let netCfg;
  try {
    netCfg = loadNetworkConfig({
      ...(process.env["CURSUS_HOST"] !== undefined ? { CURSUS_HOST: process.env["CURSUS_HOST"] } : {}),
      ...(process.env["CURSUS_PORT"] !== undefined ? { CURSUS_PORT: process.env["CURSUS_PORT"] } : {}),
      ...(process.env["CURSUS_AUTH_TOKEN"] !== undefined ? { CURSUS_AUTH_TOKEN: process.env["CURSUS_AUTH_TOKEN"] } : {}),
      ...(process.env["CURSUS_REQUIRE_AUTH"] !== undefined ? { CURSUS_REQUIRE_AUTH: process.env["CURSUS_REQUIRE_AUTH"] } : {}),
      ...(process.env["CURSUS_ALLOW_LOOPBACK_NO_AUTH"] !== undefined ? { CURSUS_ALLOW_LOOPBACK_NO_AUTH: process.env["CURSUS_ALLOW_LOOPBACK_NO_AUTH"] } : {}),
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }
  if (netCfg.exposure !== "loopback_only") {
    console.warn("[cursus] WARNING: Binding to %s (%s) — network-accessible. Auth token is configured.", netCfg.host, netCfg.exposure);
  }
  if (netCfg.auth_required && !netCfg.auth_token_configured) {
    console.error("[cursus] FATAL: auth required but CURSUS_AUTH_TOKEN is unset.");
    process.exit(1);
  }

  const server = Fastify({ logger: { level: "info" } });

  await server.register(cors, { origin: CORS_ORIGIN });

  // ── Auth guard ────────────────────────────────────────────────────────────
  const AUTH_TOKEN = process.env["CURSUS_AUTH_TOKEN"] ?? "";
  if (netCfg.auth_required || AUTH_TOKEN) {
    server.addHook("onRequest", async (req, reply) => {
      const decision = shouldAllowRequest({
        path: req.url.split("?")[0] ?? "",
        remoteAddress: req.ip,
        authHeader: req.headers.authorization,
        cfg: netCfg,
        token: AUTH_TOKEN,
      });
      if (!decision.ok) {
        reply.status(decision.status).send(decision.body);
      }
    });
  }

  // Both V1 and V2 share the same SQLite file
  const v1 = new CursusV1DB(DB_PATH);
  const v2 = new CursusV2DB(DB_PATH);

  registerRoutes(server, v1, v2, netCfg);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    server.log.info(`${signal} received — shutting down`);
    await server.close();
    v1.close();
    v2.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await server.listen({ port: netCfg.port, host: netCfg.host });
  server.log.info(
    `Cursus standalone listening on ${netCfg.host}:${netCfg.port} ` +
    `(exposure=${netCfg.exposure}, auth=${netCfg.auth_required ? "required" : "off"}, db=${DB_PATH})`
  );
}

main().catch((err) => {
  console.error("Cursus startup failed:", err);
  process.exit(1);
});
