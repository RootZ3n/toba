/**
 * Toba Logger Setup
 * =================
 * Fastify's pino logger is console-only by default. When Toba runs as a
 * background process there is no terminal, so warnings/errors vanish (audit C1).
 *
 * `buildLoggerOptions()` returns a Fastify logger config that tees every log
 * line to BOTH stdout (fd 1) and a persistent file (state/server.log) using
 * pino's native multi-target transport (pino 8+). No extra dependency needed.
 *
 * pino/file has no built-in size rotation, so `rotateLogIfNeeded()` performs a
 * lightweight size-based rotation at startup: when the live log reaches 10MB it
 * is shifted to server.log.1 (older segments cascade up to KEEP segments).
 */
import { statSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_LOG_FILE = "state/server.log";
export const LOG_ROTATE_BYTES = 10 * 1024 * 1024; // 10MB
export const LOG_ROTATE_KEEP = 5;

/**
 * Size-based rotation evaluated at startup. If `logFile` is at/over `maxBytes`,
 * cascade server.log.(keep-1) -> .keep (dropping the oldest) and finally move
 * server.log -> server.log.1, so the live file starts fresh and bounded.
 * Returns true if a rotation happened.
 */
export function rotateLogIfNeeded(
  logFile: string = DEFAULT_LOG_FILE,
  maxBytes: number = LOG_ROTATE_BYTES,
  keep: number = LOG_ROTATE_KEEP,
): boolean {
  let size = 0;
  try {
    size = statSync(logFile).size;
  } catch {
    return false; // no file yet — nothing to rotate
  }
  if (size < maxBytes) return false;

  // Drop the oldest segment, shift the rest up by one.
  for (let i = keep - 1; i >= 1; i--) {
    const from = `${logFile}.${i}`;
    const to = `${logFile}.${i + 1}`;
    if (existsSync(from)) {
      try { renameSync(from, to); } catch { /* best effort */ }
    }
  }
  try { renameSync(logFile, `${logFile}.1`); } catch { /* best effort */ }
  return true;
}

/**
 * Fastify `logger` config that writes to stdout AND `logFile`, both at info
 * level, via pino's native multi-target transport. Ensures the log directory
 * exists and rotates an oversized existing log before returning.
 */
export function buildLoggerOptions(logFile: string = DEFAULT_LOG_FILE) {
  try { mkdirSync(dirname(logFile), { recursive: true }); } catch { /* best effort */ }
  rotateLogIfNeeded(logFile);
  return {
    level: "info",
    transport: {
      targets: [
        { target: "pino/file", options: { destination: 1 }, level: "info" },              // stdout
        { target: "pino/file", options: { destination: logFile, mkdir: true }, level: "info" }, // file
      ],
    },
  };
}
