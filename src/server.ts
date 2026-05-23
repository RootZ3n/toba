/**
 * Cursus Standalone Service
 * ==========================
 * Career Change Command Center — standalone product. No Squidley required.
 *
 * Environment:
 *   CURSUS_PORT               — listen port (default 18815)
 *   CURSUS_HOST               — listen host (default 127.0.0.1)
 *   CURSUS_DB_PATH            — path to cursus.db (default /var/lib/cursus/cursus.db,
 *                                falls back to legacy /mnt/ai/squidley-v2/state/cursus.db
 *                                if that legacy file exists and the default does not)
 *   CURSUS_VERSION            — reported version string
 *   CURSUS_CORS_ORIGIN        — CORS origin (default *)
 *   CURSUS_AUTH_TOKEN         — required when CURSUS_HOST != 127.0.0.1/localhost
 *   CURSUS_PROVIDER           — native provider id: none|echo|ollama|openai|anthropic|openrouter
 *   CURSUS_MODEL              — model name for the selected provider
 *   CURSUS_PROVIDER_BASE_URL  — provider API base URL (alias: CURSUS_PROVIDER_API_BASE)
 *   CURSUS_PROVIDER_API_KEY   — provider API key (never echoed in status)
 *   CURSUS_LOCAL_ONLY         — "true" to block cloud providers
 *   CURSUS_AUTOMATION_MODE    — automation mode (manual|recommend-only|approval-required)
 *   CURSUS_BRIDGE_URL         — OPTIONAL legacy Squidley bridge URL; disabled by default
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { existsSync } from "node:fs";
import { CursusV1DB, CursusV2DB } from "./db.js";
import { registerRoutes } from "./routes.js";

const PORT = parseInt(process.env["CURSUS_PORT"] ?? "18815", 10);
const HOST = process.env["CURSUS_HOST"] ?? "127.0.0.1";
const CANONICAL_DB = "/var/lib/cursus/cursus.db";
const LEGACY_DB = "/mnt/ai/squidley-v2/state/cursus.db";
const DB_PATH = process.env["CURSUS_DB_PATH"] ??
  (existsSync(CANONICAL_DB) || !existsSync(LEGACY_DB) ? CANONICAL_DB : LEGACY_DB);
const CORS_ORIGIN = process.env["CURSUS_CORS_ORIGIN"] ?? "*";
const AUTH_TOKEN = process.env["CURSUS_AUTH_TOKEN"] ?? "";

async function main() {
  // ── Network exposure guard ─────────────────────────────────────────────────
  const isLocalhost = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
  if (!isLocalhost && !AUTH_TOKEN) {
    console.error(
      "[cursus] FATAL: CURSUS_HOST=%s exposes Cursus to the network but CURSUS_AUTH_TOKEN is not set.\n" +
      "Refusing to start unauthenticated on a non-localhost interface.\n" +
      "Either set CURSUS_HOST=127.0.0.1 or provide CURSUS_AUTH_TOKEN.",
      HOST,
    );
    process.exit(1);
  }
  if (!isLocalhost) {
    console.warn("[cursus] WARNING: Binding to %s — network-accessible. Auth token is configured.", HOST);
  }

  const server = Fastify({ logger: { level: "info" } });

  await server.register(cors, { origin: CORS_ORIGIN });

  // ── Auth guard (only when token configured) ────────────────────────────────
  if (AUTH_TOKEN) {
    server.addHook("onRequest", async (req, reply) => {
      // Health, version, and status are public
      if (req.url === "/health" || req.url === "/version" || req.url === "/status") return;
      const header = req.headers.authorization ?? "";
      if (header !== `Bearer ${AUTH_TOKEN}`) {
        reply.status(401).send({ ok: false, error: "Unauthorized" });
      }
    });
  }

  // Both V1 and V2 share the same SQLite file
  const v1 = new CursusV1DB(DB_PATH);
  const v2 = new CursusV2DB(DB_PATH);

  registerRoutes(server, v1, v2);

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

  await server.listen({ port: PORT, host: HOST });
  server.log.info(`Cursus standalone listening on ${HOST}:${PORT} (db: ${DB_PATH})`);
}

main().catch((err) => {
  console.error("Cursus startup failed:", err);
  process.exit(1);
});
