/**
 * Toba DB Path Resolution
 * =======================
 * One canonical default. The previous fallback chain (audit H1) used
 * `existsSync` so that once /var/lib/toba/toba.db existed it was pinned forever,
 * silently ignoring an operator's intended path. Resolution is now purely:
 *
 *   TOBA_DB_PATH ?? CURSUS_DB_PATH ?? "/var/lib/toba/toba.db"
 *
 * Migrations of data living at legacy paths belong in a dedicated migration
 * script, not in startup fallback logic.
 */
export const DEFAULT_DB_PATH = "/var/lib/toba/toba.db";

export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.TOBA_DB_PATH ?? env.CURSUS_DB_PATH ?? DEFAULT_DB_PATH;
}
