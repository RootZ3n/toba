/**
 * Toba Backup Reaper
 * ==================
 * The reset script writes a timestamped DB backup before wiping data, but
 * nothing ever cleaned them up (audit H2) — they accumulate forever.
 *
 * `reapOldBackups()` enforces retention: the newest `keep` backups are always
 * retained regardless of age; any older backup beyond that set is deleted once
 * it exceeds `maxAgeDays`. Callable from server startup (TTL sweep) and reusable
 * for count-only pruning (pass maxAgeDays=0 to drop everything beyond `keep`).
 *
 * SQLite sidecars (-wal/-shm) for a reaped backup are removed alongside it.
 */
import { readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_BACKUP_DIR = "backups";
export const DEFAULT_KEEP = 5;
export const DEFAULT_MAX_AGE_DAYS = 30;

const BACKUP_RE = /^toba-reset-.*\.db$/;

export interface ReapResult {
  removed: string[];
  kept: string[];
}

export function reapOldBackups(
  maxAgeDays: number = DEFAULT_MAX_AGE_DAYS,
  opts: { dir?: string; keep?: number; now?: number } = {},
): ReapResult {
  const dir = opts.dir ?? DEFAULT_BACKUP_DIR;
  const keep = opts.keep ?? DEFAULT_KEEP;
  const now = opts.now ?? Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  let entries: Array<{ name: string; mtime: number }>;
  try {
    entries = readdirSync(dir)
      .filter((n) => BACKUP_RE.test(n))
      .map((n) => ({ name: n, mtime: statSync(join(dir, n)).mtimeMs }));
  } catch {
    return { removed: [], kept: [] }; // dir missing — nothing to reap
  }

  entries.sort((a, b) => b.mtime - a.mtime); // newest first

  const removed: string[] = [];
  const kept: string[] = [];
  entries.forEach((e, i) => {
    const ageMs = now - e.mtime;
    if (i >= keep && ageMs > maxAgeMs) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try { rmSync(join(dir, e.name + suffix)); } catch { /* sidecar may not exist */ }
      }
      removed.push(e.name);
    } else {
      kept.push(e.name);
    }
  });
  return { removed, kept };
}
