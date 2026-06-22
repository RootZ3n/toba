/**
 * Toba — Application Tracker Tools
 * =================================
 * CRUD tools for the application-tracker agent.
 * Uses a dedicated `toba_tracker_applications` table to avoid conflicts
 * with the existing campaign-based `toba_applications` table.
 */

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { registerTool, type ToolResult } from "./registry.js";

const require = createRequire(import.meta.url);

// ── Tracker Application Types ──────────────────────────────────────────────

export type TrackerAppStatus = "saved" | "applied" | "interviewing" | "offer" | "rejected" | "ghosted";

export interface TrackerApplication {
  id: string;
  company: string;
  position: string;
  url: string | null;
  date_applied: string | null;
  status: TrackerAppStatus;
  follow_up_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// ── DB Helper ──────────────────────────────────────────────────────────────

/**
 * Ensure the tracker applications table exists.
 * Called once during tool initialization.
 */
export function ensureTrackerTable(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS toba_tracker_applications (
      id            TEXT PRIMARY KEY,
      company       TEXT NOT NULL,
      position      TEXT NOT NULL,
      url           TEXT,
      date_applied  TEXT,
      status        TEXT NOT NULL DEFAULT 'applied'
                    CHECK (status IN ('saved','applied','interviewing','offer','rejected','ghosted')),
      follow_up_date TEXT,
      notes         TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_app_status ON toba_tracker_applications(status);
    CREATE INDEX IF NOT EXISTS idx_tracker_app_follow_up ON toba_tracker_applications(follow_up_date);
  `);
}

// ── CRUD Operations ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createTrackerApp(db: any, data: {
  company: string;
  position: string;
  url?: string;
  date_applied?: string;
  status?: TrackerAppStatus;
  follow_up_date?: string;
  notes?: string;
}): TrackerApplication {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO toba_tracker_applications (id, company, position, url, date_applied, status, follow_up_date, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.company,
    data.position,
    data.url ?? null,
    data.date_applied ?? null,
    data.status ?? "applied",
    data.follow_up_date ?? null,
    data.notes ?? null,
    now,
    now,
  );
  return db.prepare("SELECT * FROM toba_tracker_applications WHERE id = ?").get(id) as TrackerApplication;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function listTrackerApps(db: any, status?: TrackerAppStatus): TrackerApplication[] {
  if (status) {
    return db.prepare("SELECT * FROM toba_tracker_applications WHERE status = ? ORDER BY updated_at DESC").all(status) as TrackerApplication[];
  }
  return db.prepare("SELECT * FROM toba_tracker_applications ORDER BY updated_at DESC").all() as TrackerApplication[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getTrackerApp(db: any, id: string): TrackerApplication | null {
  return (db.prepare("SELECT * FROM toba_tracker_applications WHERE id = ?").get(id) as TrackerApplication) ?? null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function updateTrackerApp(db: any, id: string, patch: {
  company?: string;
  position?: string;
  url?: string;
  date_applied?: string;
  status?: TrackerAppStatus;
  follow_up_date?: string;
  notes?: string;
}): TrackerApplication | null {
  const existing = getTrackerApp(db, id);
  if (!existing) return null;

  const fields: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const values: any[] = [];
  const allowed = ["company", "position", "url", "date_applied", "status", "follow_up_date", "notes"] as const;
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(patch[key]);
    }
  }
  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE toba_tracker_applications SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getTrackerApp(db, id);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function deleteTrackerApp(db: any, id: string): boolean {
  const result = db.prepare("DELETE FROM toba_tracker_applications WHERE id = ?").run(id);
  return result.changes > 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getFollowUps(db: any, withinDays = 7): TrackerApplication[] {
  const now = new Date();
  const futureDate = new Date(now.getTime() + withinDays * 86_400_000);
  return db.prepare(`
    SELECT * FROM toba_tracker_applications
    WHERE follow_up_date IS NOT NULL
      AND follow_up_date <= ?
      AND status NOT IN ('rejected', 'ghosted')
    ORDER BY follow_up_date ASC
  `).all(futureDate.toISOString().split("T")[0]) as TrackerApplication[];
}

// ── Register Tools ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerApplicationTools(db: any): void {
  ensureTrackerTable(db);

  registerTool({
    definition: {
      name: "create_application",
      description: "Create a new job application entry to track. Use this when the user wants to log a new job application.",
      parameters: {
        type: "object",
        properties: {
          company: { type: "string", description: "Company name" },
          position: { type: "string", description: "Job position/title" },
          url: { type: "string", description: "URL of the job posting (optional)" },
          date_applied: { type: "string", description: "Date applied in YYYY-MM-DD format (optional)" },
          status: { type: "string", description: "Application status", enum: ["applied", "interviewing", "offer", "rejected", "ghosted"] },
          follow_up_date: { type: "string", description: "Follow-up date in YYYY-MM-DD format (optional)" },
          notes: { type: "string", description: "Additional notes about the application (optional)" },
        },
        required: ["company", "position"],
      },
    },
    execute: async (args): Promise<ToolResult> => {
      const company = String(args.company ?? "").trim();
      const position = String(args.position ?? "").trim();
      if (!company || !position) {
        return { success: false, error: "company and position are required" };
      }
      try {
        const app = createTrackerApp(db, {
          company,
          position,
          url: args.url ? String(args.url) : undefined,
          date_applied: args.date_applied ? String(args.date_applied) : undefined,
          status: args.status as TrackerAppStatus | undefined,
          follow_up_date: args.follow_up_date ? String(args.follow_up_date) : undefined,
          notes: args.notes ? String(args.notes) : undefined,
        });
        return { success: true, data: app };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  registerTool({
    definition: {
      name: "list_applications",
      description: "List all tracked job applications, optionally filtered by status.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status (optional)", enum: ["applied", "interviewing", "offer", "rejected", "ghosted"] },
        },
      },
    },
    execute: async (args): Promise<ToolResult> => {
      try {
        const apps = listTrackerApps(db, args.status as TrackerAppStatus | undefined);
        return { success: true, data: { applications: apps, count: apps.length } };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  registerTool({
    definition: {
      name: "get_application",
      description: "Get details of a specific tracked job application by ID.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Application ID" },
        },
        required: ["id"],
      },
    },
    execute: async (args): Promise<ToolResult> => {
      const id = String(args.id ?? "").trim();
      if (!id) return { success: false, error: "id is required" };
      try {
        const app = getTrackerApp(db, id);
        if (!app) return { success: false, error: `Application not found: ${id}` };
        return { success: true, data: app };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  registerTool({
    definition: {
      name: "update_application",
      description: "Update an existing tracked job application. Only provide fields you want to change.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Application ID" },
          company: { type: "string", description: "Company name" },
          position: { type: "string", description: "Job position/title" },
          url: { type: "string", description: "URL of the job posting" },
          date_applied: { type: "string", description: "Date applied in YYYY-MM-DD format" },
          status: { type: "string", description: "Application status", enum: ["applied", "interviewing", "offer", "rejected", "ghosted"] },
          follow_up_date: { type: "string", description: "Follow-up date in YYYY-MM-DD format" },
          notes: { type: "string", description: "Additional notes" },
        },
        required: ["id"],
      },
    },
    execute: async (args): Promise<ToolResult> => {
      const id = String(args.id ?? "").trim();
      if (!id) return { success: false, error: "id is required" };
      try {
        const patch: Record<string, unknown> = {};
        for (const key of ["company", "position", "url", "date_applied", "status", "follow_up_date", "notes"]) {
          if (args[key] !== undefined) patch[key] = String(args[key]);
        }
        const updated = updateTrackerApp(db, id, patch as Parameters<typeof updateTrackerApp>[2]);
        if (!updated) return { success: false, error: `Application not found: ${id}` };
        return { success: true, data: updated };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  registerTool({
    definition: {
      name: "delete_application",
      description: "Delete a tracked job application by ID.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Application ID" },
        },
        required: ["id"],
      },
    },
    execute: async (args): Promise<ToolResult> => {
      const id = String(args.id ?? "").trim();
      if (!id) return { success: false, error: "id is required" };
      try {
        const deleted = deleteTrackerApp(db, id);
        if (!deleted) return { success: false, error: `Application not found: ${id}` };
        return { success: true, data: { deleted: true, id } };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  registerTool({
    definition: {
      name: "get_follow_ups",
      description: "Get applications that need follow-up within a specified number of days. Use this to remind the user about pending follow-ups.",
      parameters: {
        type: "object",
        properties: {
          within_days: { type: "string", description: "Number of days to look ahead (default 7)" },
        },
      },
    },
    execute: async (args): Promise<ToolResult> => {
      try {
        const days = parseInt(String(args.within_days ?? "7"), 10) || 7;
        const followUps = getFollowUps(db, days);
        return {
          success: true,
          data: {
            follow_ups: followUps,
            count: followUps.length,
            within_days: days,
            message: followUps.length > 0
              ? `You have ${followUps.length} application(s) needing follow-up within ${days} days.`
              : `No follow-ups due within ${days} days.`,
          },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
