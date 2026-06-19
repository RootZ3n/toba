/**
 * Toba Standalone Service
 * =======================
 * Career transformation platform — standalone product.
 *
 * Environment (TOBA_* preferred, CURSUS_* accepted as fallback):
 *   TOBA_PORT                      — listen port (default 18815)
 *   TOBA_HOST                      — listen host (default 127.0.0.1)
 *   TOBA_DB_PATH                   — path to toba.db (default /var/lib/toba/toba.db,
 *                                     falls back to legacy paths if they exist)
 *   TOBA_VERSION                   — reported version string
 *   TOBA_CORS_ORIGIN               — CORS origin (default *)
 *   TOBA_PROVIDER                  — native provider id: none|echo|ollama|openai|anthropic|openrouter
 *   TOBA_MODEL                     — model name for the selected provider
 *   TOBA_PROVIDER_BASE_URL         — provider API base URL (alias: TOBA_PROVIDER_API_BASE)
 *   TOBA_PROVIDER_API_KEY          — generic provider API key (never echoed in status)
 *   TOBA_OPENROUTER_API_KEY        — preferred OpenRouter key (falls back to TOBA_PROVIDER_API_KEY)
 *   TOBA_OPENROUTER_REFERER        — optional HTTP-Referer header for OpenRouter
 *   TOBA_OPENROUTER_TITLE          — optional X-Title header for OpenRouter (default "Toba")
 *   TOBA_LOCAL_ONLY                — "true" to block cloud providers globally
 *   TOBA_AUTOMATION_MODE           — automation mode (manual|recommend-only|approval-required)
 *   TOBA_BRIDGE_URL                — OPTIONAL legacy bridge URL; disabled by default
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { velumFastify } from "velum-ai/adapters/fastify";
import { TobaV1DB, TobaV2DB } from "./db.js";
import { registerRoutes } from "./routes.js";
import { loadNetworkConfig } from "./network.js";
import { rewriteRequestUrl } from "./rewrite.js";
import { buildLoggerOptions } from "./logger.js";
import { resolveDbPath } from "./dbpath.js";
import { reapOldBackups } from "./backups.js";
import { gracefulShutdown } from "./shutdown.js";
import { loadProviderConfig } from "./provider.js";

// Env helper: TOBA_* preferred, CURSUS_* fallback
const env = (toba: string, cursus: string, fallback?: string) =>
  process.env[toba] ?? process.env[cursus] ?? fallback;

// One canonical default; no filesystem-probe fallback chain (audit H1).
const DB_PATH = resolveDbPath();
const CORS_ORIGIN = env("TOBA_CORS_ORIGIN", "CURSUS_CORS_ORIGIN", "*")!;

async function main() {
  const netCfg = loadNetworkConfig({
    ...(env("TOBA_HOST", "CURSUS_HOST") !== undefined ? { TOBA_HOST: env("TOBA_HOST", "CURSUS_HOST") } : {}),
    ...(env("TOBA_PORT", "CURSUS_PORT") !== undefined ? { TOBA_PORT: env("TOBA_PORT", "CURSUS_PORT") } : {}),
  });

  if (netCfg.exposure !== "loopback_only") {
    console.warn("[toba] WARNING: Binding to %s (%s) — network-accessible.", netCfg.host, netCfg.exposure);
  }

  const server = Fastify({
    // Tee logs to stdout AND state/server.log so a backgrounded process keeps a
    // persistent operational record (audit C1).
    logger: buildLoggerOptions(),
    // Backward compatibility: legacy /cursus/* paths are rewritten to /toba/*.
    rewriteUrl: (req) => rewriteRequestUrl(req.url),
  });

  await server.register(cors, { origin: CORS_ORIGIN });

  // Velum: AI privacy/injection defense middleware
  velumFastify(server, { defaultPiiLevel: 2 });

  server.log.info(`Using database: ${DB_PATH}`);

  // Load persisted provider config (audit C3): a state/provider-config.json file
  // overrides env defaults, so operator changes survive restarts.
  const providerSource = loadProviderConfig();
  server.log.info(`Provider config source: ${providerSource}`);

  // Best-effort backup TTL sweep (audit H2): drop backups beyond the newest 5
  // that are older than 30 days.
  try {
    const { removed } = reapOldBackups();
    if (removed.length > 0) server.log.info(`Reaped ${removed.length} old backup(s)`);
  } catch (err) {
    server.log.warn(`Backup reaper failed: ${(err as Error).message}`);
  }

  // Both V1 and V2 share the same SQLite file
  const v1 = new TobaV1DB(DB_PATH);
  const v2 = new TobaV2DB(DB_PATH);

  registerRoutes(server, v1, v2, netCfg);

  // Graceful shutdown with a bounded 5s timeout so a hung DB close can't wedge
  // the process forever (audit H3).
  const shutdown = async (signal: string) => {
    server.log.info(`${signal} received — shutting down`);
    await gracefulShutdown(
      [() => server.close(), () => v1.close(), () => v2.close()],
      { timeoutMs: 5000, onWarn: (m) => server.log.warn(m) },
    );
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await server.listen({ port: netCfg.port, host: netCfg.host });
  server.log.info(
    `Toba standalone listening on ${netCfg.host}:${netCfg.port} ` +
    `(exposure=${netCfg.exposure}, db=${DB_PATH})`
  );
}

main().catch((err) => {
  console.error("Toba startup failed:", err);
  process.exit(1);
});
