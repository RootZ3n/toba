/**
 * Cursus Standalone — Database Layer
 * ===================================
 * Self-contained V1 + V2 DB classes. No external service dependencies.
 * V1: profile, experience, certifications, projects, skills, products, export
 * V2: campaigns, applications, resumes, outreach, dux sessions, dashboard,
 *     onboarding, analytics, automation queue, job fingerprinting, receipts, velum
 */

import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);

/** Current schema version — bump when adding tables/columns */
export const CURSUS_SCHEMA_VERSION = 5;

// ── Types ────────────────────────────────────────────────────────────────────

// V2 types
export type CampaignPhase = "research" | "applying" | "interviewing" | "negotiating" | "closed";
export type AppStatus = "found" | "qualified" | "applied" | "responded" | "interviewing" | "closed";
export type OutreachType = "email" | "cover_letter" | "recruiter";
export type OutreachStatus = "staged" | "approved" | "sent" | "replied";
export type DuxSessionType = "interview" | "checkin" | "role_assessment" | "discovery";

export interface Campaign {
  id: string; name: string; target_role: string; phase: CampaignPhase;
  milestones: string; active: boolean; created_at: string;
}

export interface Application {
  id: string; campaign_id: string; company: string; role: string;
  url: string | null; salary_range: string | null; match_score: number | null;
  status: AppStatus; notes: string | null; applied_at: string | null;
  follow_up_at: string | null; created_at: string;
  source: string | null; location: string | null; remote: string | null;
  fingerprint: string | null;
}

export interface Resume {
  id: string; profile_version: number | null; base_resume: string;
  tailored_for: string | null; created_at: string;
}

export interface Outreach {
  id: string; application_id: string | null; type: OutreachType;
  subject: string; body: string; status: OutreachStatus;
  created_at: string; sent_at: string | null; gmail_thread_id: string | null;
}

export interface DuxSession {
  id: string; session_type: DuxSessionType; messages: string;
  profile_version_generated: number | null; created_at: string;
}

export interface DashboardStats {
  activeCampaign: Campaign | null;
  campaign: ({ name: string; phase: CampaignPhase; days_active: number } & Partial<Campaign>) | null;
  applicationCounts: Record<AppStatus, number>;
  stats: { applications_sent: number; responses: number; interviews: number; pending_outreach: number };
  totalApplications: number;
  pendingOutreach: number;
  approvedOutreach: number;
  sentOutreach: number;
  repliedOutreach: number;
  lastDuxSession: string | null;
  recentActivity: Array<{ type: string; detail: string; timestamp: string }>;
  recent_activity: Array<{ id: string; type: string; summary: string; timestamp: string }>;
  next_action: string;
}

// Receipt types
export type ReceiptAction =
  | "campaign_create" | "campaign_close" | "job_scout_run" | "model_call"
  | "velum_review" | "application_persist" | "application_update"
  | "outreach_generate" | "outreach_approve" | "outreach_reject"
  | "onboarding_complete" | "resume_ingest"
  | "automation_create" | "automation_approve" | "automation_reject" | "automation_execute"
  | "insight_generate" | "job_scout_search";

export interface Receipt {
  id: string;
  action: ReceiptAction;
  timestamp: string;
  campaign_id: string | null;
  provider: string | null;
  model: string | null;
  local_mode: boolean;
  velum_reviewed: boolean;
  velum_redacted: boolean;
  result_summary: string;
  errors: string | null;
  warnings: string | null;
}

// Search lane types
export type LanePriority = "primary" | "secondary" | "stretch";

export interface SearchLane {
  id: string;
  campaign_id: string;
  name: string;
  target_titles: string; // JSON array
  keywords: string; // JSON array
  negative_keywords: string; // JSON array
  locations: string; // JSON array
  remote_preference: string | null; // "remote" | "hybrid" | "onsite" | null
  source_filters: string; // JSON array
  priority: LanePriority;
  active: boolean;
  created_at: string;
}

// Job evaluation report types
export type EvalGrade = "A" | "B" | "C" | "D" | "F";

export interface JobEvaluation {
  id: string;
  application_id: string;
  role_summary: string;
  fit_analysis: string;
  gap_strategy: string;
  compensation_notes: string | null;
  resume_plan: string | null;
  interview_prep: string | null;
  legitimacy_grade: EvalGrade;
  overall_grade: EvalGrade;
  created_at: string;
}

// Interview story bank types
export type StoryFormat = "star" | "star_reflection" | "narrative";

export interface InterviewStory {
  id: string;
  title: string;
  format: StoryFormat;
  situation: string;
  task: string;
  action: string;
  result: string;
  reflection: string | null;
  linked_project_ids: string; // JSON array of project IDs
  linked_experience_ids: string; // JSON array of experience IDs
  tags: string; // JSON array
  created_at: string;
}

// Velum review result
export interface VelumReviewResult {
  reviewed: boolean;
  redacted: boolean;
  original_length: number;
  redacted_length: number;
  fields_redacted: string[];
  output: string;
}

// Provider config
export interface CursusProviderConfig {
  provider: string;
  model: string;
  api_base?: string;
  local: boolean;
}

// Cursus status
export interface CursusStatus {
  mode: "standalone";
  bridge_enabled: boolean;
  port: number;
  provider_mode: string;
  active_campaign: { id: string; name: string; target_role: string } | null;
  receipts_enabled: boolean;
  velum_enabled: boolean;
}

// Onboarding types
export type PrivacyMode = "local-only" | "local-preferred" | "cloud-allowed-with-review";

export interface OnboardingState {
  id: number;
  completed: boolean;
  completed_at: string | null;
  name: string | null;
  preferred_titles: string | null;
  work_preference: string | null;
  preferred_locations: string | null;
  salary_min: number | null;
  salary_max: number | null;
  years_experience: number | null;
  certifications: string | null;
  resume_uploaded: boolean;
  resume_id: string | null;
  privacy_mode: PrivacyMode;
  updated_at: string;
}

// Automation types
export type AutomationKind =
  | "job_scout" | "suggest_application" | "outreach_draft"
  | "follow_up_reminder" | "stale_app_reminder";
export type AutomationMode = "manual" | "recommend-only" | "approval-required";
export type AutomationStatus = "pending" | "awaiting_approval" | "approved" | "executed" | "rejected";

export interface AutomationTask {
  id: string;
  kind: AutomationKind;
  status: AutomationStatus;
  title: string;
  detail: string;
  campaign_id: string | null;
  application_id: string | null;
  schedule: string | null;
  created_at: string;
  resolved_at: string | null;
}

// Analytics types
export interface CampaignAnalytics {
  campaign_id: string;
  campaign_name: string;
  phase: CampaignPhase;
  days_active: number;
  applications: { total: number; by_status: Record<AppStatus, number>; by_role: Record<string, number>; by_location: Record<string, number>; by_source: Record<string, number> };
  rates: { response_rate: number; interview_conversion: number };
  outreach: { total: number; sent: number; response_rate: number };
  insights: string[];
}

// V1 types
export interface CursusProfile {
  id: number; name: string; title: string; summary: string;
  location: string; updated_at: string;
}

export interface CursusExperience {
  id: number; company: string; role: string; start_date: string;
  end_date: string | null; description: string; highlights: string[];
  is_current: boolean;
}

export interface CursusCertification {
  id: number; name: string; issuer: string;
  status: "complete" | "in_progress" | "planned";
  date_completed: string | null; notes: string;
}

export interface CursusProject {
  id: number; name: string; tagline: string; description: string;
  tech_stack: string[]; status: "active" | "complete" | "vision";
  portfolio_worthy: boolean; resume_bullet: string;
  archivum_entry_id: string | null;
}

export interface CursusSkill {
  id: number; category: string; skill: string;
  level: "expert" | "proficient" | "familiar";
}

export interface CursusProduct {
  id: number; name: string; tagline: string | null;
  problem_solved: string | null; target_market: string | null;
  status: "live" | "beta" | "planned"; tier: "free" | "setup-fee" | "platform";
  origin_date: string | null; github_url: string | null;
  demo_url: string | null; price_range: string | null; notes: string | null;
}

// ── V1 Database ──────────────────────────────────────────────────────────────

export class CursusV1DB {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  constructor(dbPath: string) {
    mkdirSync(join(dbPath, ".."), { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const BetterSqlite3 = require("better-sqlite3") as any;
    const DatabaseCtor = BetterSqlite3.default ?? BetterSqlite3;
    this.db = new DatabaseCtor(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.createTables();
    this.seedIfEmpty();
    this.stampVersion();
  }

  private stampVersion(): void {
    this.db.prepare(
      "INSERT INTO cursus_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(CURSUS_SCHEMA_VERSION));
  }

  getSchemaVersion(): number {
    const row = this.db.prepare("SELECT value FROM cursus_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  }

  getDbPath(): string { return this.db.name as string; }

  isReachable(): boolean {
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch { return false; }
  }

  private createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cursus_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cursus_profile (
        id INTEGER PRIMARY KEY, name TEXT, title TEXT, summary TEXT, location TEXT, updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS cursus_experience (
        id INTEGER PRIMARY KEY AUTOINCREMENT, company TEXT, role TEXT, start_date TEXT, end_date TEXT,
        description TEXT, highlights TEXT, is_current INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS cursus_certifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, issuer TEXT, status TEXT,
        date_completed TEXT, notes TEXT
      );
      CREATE TABLE IF NOT EXISTS cursus_projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, tagline TEXT, description TEXT,
        tech_stack TEXT, status TEXT, portfolio_worthy INTEGER DEFAULT 1,
        resume_bullet TEXT, archivum_entry_id TEXT
      );
      CREATE TABLE IF NOT EXISTS cursus_skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT, skill TEXT, level TEXT
      );
      CREATE TABLE IF NOT EXISTS cursus_products (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, tagline TEXT, problem_solved TEXT,
        target_market TEXT, status TEXT DEFAULT 'planned', tier TEXT DEFAULT 'free',
        origin_date TEXT, github_url TEXT, demo_url TEXT, price_range TEXT, notes TEXT
      );
    `);
  }

  private seedIfEmpty() {
    const count = (this.db.prepare("SELECT COUNT(*) as n FROM cursus_profile").get() as { n: number }).n;
    if (count > 0) return;

    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO cursus_profile (id, name, title, summary, location, updated_at) VALUES (1, ?, ?, ?, ?, ?)").run(
      "Jeffrey Miller",
      "AI Systems Engineer / Field Service Technician",
      "Self-directed technical professional with 20+ years in systems troubleshooting and electronics repair, now architecting production-grade AI infrastructure. Built Squidley V2 — a 22-module local-first AI orchestration platform — in 6 days. Pursuing CompTIA A+ and Security+.",
      "Moore, Oklahoma",
      now,
    );
  }

  getProfile(): CursusProfile {
    return this.db.prepare("SELECT * FROM cursus_profile WHERE id = 1").get() as CursusProfile;
  }

  updateProfile(patch: Partial<Omit<CursusProfile, "id">>): CursusProfile {
    const fields: string[] = [];
    const vals: Record<string, unknown> = {};
    if (patch.name !== undefined)     { fields.push("name = @name");       vals.name = patch.name; }
    if (patch.title !== undefined)    { fields.push("title = @title");     vals.title = patch.title; }
    if (patch.summary !== undefined)  { fields.push("summary = @summary"); vals.summary = patch.summary; }
    if (patch.location !== undefined) { fields.push("location = @location"); vals.location = patch.location; }
    if (fields.length > 0) {
      fields.push("updated_at = @updated_at");
      vals.updated_at = new Date().toISOString();
      this.db.prepare(`UPDATE cursus_profile SET ${fields.join(", ")} WHERE id = 1`).run(vals);
    }
    return this.getProfile();
  }

  listExperience(): CursusExperience[] {
    const rows = this.db.prepare("SELECT * FROM cursus_experience ORDER BY is_current DESC, start_date DESC").all() as Array<CursusExperience & { highlights: string }>;
    return rows.map(r => ({ ...r, highlights: JSON.parse(r.highlights || "[]"), is_current: !!r.is_current }));
  }

  addExperience(e: Omit<CursusExperience, "id">): CursusExperience {
    const r = this.db.prepare("INSERT INTO cursus_experience (company, role, start_date, end_date, description, highlights, is_current) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      e.company, e.role, e.start_date, e.end_date ?? null, e.description, JSON.stringify(e.highlights ?? []), e.is_current ? 1 : 0);
    return { ...e, id: Number(r.lastInsertRowid) };
  }

  listCertifications(): CursusCertification[] {
    return this.db.prepare("SELECT * FROM cursus_certifications ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END").all() as CursusCertification[];
  }

  updateCertification(id: number, patch: Partial<Omit<CursusCertification, "id">>): CursusCertification | null {
    const fields: string[] = [];
    const vals: Record<string, unknown> = { id };
    if (patch.status !== undefined)         { fields.push("status = @status");                   vals.status = patch.status; }
    if (patch.date_completed !== undefined) { fields.push("date_completed = @date_completed");   vals.date_completed = patch.date_completed; }
    if (patch.notes !== undefined)          { fields.push("notes = @notes");                     vals.notes = patch.notes; }
    if (fields.length === 0) return null;
    this.db.prepare(`UPDATE cursus_certifications SET ${fields.join(", ")} WHERE id = @id`).run(vals);
    return this.db.prepare("SELECT * FROM cursus_certifications WHERE id = ?").get(id) as CursusCertification;
  }

  listProjects(): CursusProject[] {
    const rows = this.db.prepare("SELECT * FROM cursus_projects ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'complete' THEN 1 ELSE 2 END").all() as Array<CursusProject & { tech_stack: string }>;
    return rows.map(r => ({ ...r, tech_stack: JSON.parse(r.tech_stack || "[]"), portfolio_worthy: !!r.portfolio_worthy }));
  }

  addProject(p: Omit<CursusProject, "id">): CursusProject {
    const r = this.db.prepare("INSERT INTO cursus_projects (name, tagline, description, tech_stack, status, portfolio_worthy, resume_bullet, archivum_entry_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      p.name, p.tagline, p.description, JSON.stringify(p.tech_stack ?? []), p.status, p.portfolio_worthy ? 1 : 0, p.resume_bullet, p.archivum_entry_id ?? null);
    return { ...p, id: Number(r.lastInsertRowid) };
  }

  listSkills(): CursusSkill[] {
    return this.db.prepare("SELECT * FROM cursus_skills ORDER BY category, CASE level WHEN 'expert' THEN 0 WHEN 'proficient' THEN 1 ELSE 2 END").all() as CursusSkill[];
  }

  listProducts(): CursusProduct[] {
    return this.db.prepare("SELECT * FROM cursus_products ORDER BY CASE status WHEN 'live' THEN 0 WHEN 'beta' THEN 1 ELSE 2 END").all() as CursusProduct[];
  }

  getProduct(id: number): CursusProduct | null {
    return (this.db.prepare("SELECT * FROM cursus_products WHERE id = ?").get(id) as CursusProduct) ?? null;
  }

  addProduct(p: Omit<CursusProduct, "id">): CursusProduct {
    const r = this.db.prepare("INSERT INTO cursus_products (name, tagline, problem_solved, target_market, status, tier, origin_date, github_url, demo_url, price_range, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      p.name, p.tagline, p.problem_solved, p.target_market, p.status, p.tier, p.origin_date, p.github_url, p.demo_url, p.price_range, p.notes);
    return { ...p, id: Number(r.lastInsertRowid) };
  }

  updateProduct(id: number, patch: Partial<Omit<CursusProduct, "id">>): CursusProduct | null {
    const fields: string[] = [];
    const vals: Record<string, unknown> = { id };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) { fields.push(`${key} = @${key}`); vals[key] = value; }
    }
    if (fields.length === 0) return null;
    this.db.prepare(`UPDATE cursus_products SET ${fields.join(", ")} WHERE id = @id`).run(vals);
    return this.getProduct(id);
  }

  exportResume(): string {
    const p = this.getProfile();
    const exp = this.listExperience();
    const certs = this.listCertifications();
    const projects = this.listProjects().filter(pr => pr.portfolio_worthy);
    const skills = this.listSkills();

    const lines: string[] = [];
    lines.push(p.name.toUpperCase());
    lines.push(p.title);
    lines.push(p.location);
    lines.push("");
    lines.push("SUMMARY");
    lines.push(p.summary);
    lines.push("");

    lines.push("EXPERIENCE");
    for (const e of exp) {
      lines.push(`${e.role} — ${e.company} (${e.start_date}–${e.end_date ?? "Present"})`);
      lines.push(e.description);
      for (const h of e.highlights) lines.push(`  • ${h}`);
      lines.push("");
    }

    lines.push("PROJECTS");
    for (const pr of projects) {
      lines.push(`${pr.name} — ${pr.tagline} [${pr.status}]`);
      lines.push(`  ${pr.resume_bullet}`);
      lines.push("");
    }

    lines.push("CERTIFICATIONS");
    for (const c of certs) {
      const status = c.status === "complete" ? "+" : c.status === "in_progress" ? ">" : "o";
      lines.push(`  ${status} ${c.name} (${c.issuer}) ${c.date_completed ?? ""}`);
    }
    lines.push("");

    lines.push("SKILLS");
    const byCat = new Map<string, string[]>();
    for (const s of skills) {
      const arr = byCat.get(s.category) ?? [];
      arr.push(s.skill);
      byCat.set(s.category, arr);
    }
    for (const [cat, sks] of byCat) {
      lines.push(`  ${cat}: ${sks.join(", ")}`);
    }

    return lines.join("\n");
  }

  exportPortfolio(): string {
    const p = this.getProfile();
    const projects = this.listProjects().filter(pr => pr.portfolio_worthy);
    const lines: string[] = [];

    lines.push(`# ${p.name}`);
    lines.push(`### ${p.title}`);
    lines.push("");
    lines.push(p.summary);
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("## Projects");
    lines.push("");

    for (const pr of projects) {
      const badge = pr.status === "active" ? "Active" : pr.status === "complete" ? "Complete" : "Vision";
      lines.push(`### ${pr.name}`);
      lines.push(`*${pr.tagline}* — ${badge}`);
      lines.push("");
      lines.push(pr.description);
      lines.push("");
      lines.push(`**Tech:** ${pr.tech_stack.join(" / ")}`);
      lines.push("");
    }

    return lines.join("\n");
  }

  exportProducts(): string {
    const products = this.listProducts();
    const lines: string[] = [];

    lines.push("# Product Catalog");
    lines.push(`*Generated ${new Date().toISOString().slice(0, 10)}*`);
    lines.push("");

    for (const p of products) {
      const statusBadge = p.status === "live" ? "Live" : p.status === "beta" ? "Beta" : "Planned";
      lines.push(`## ${p.name}`);
      if (p.tagline) lines.push(`*${p.tagline}*`);
      lines.push("");
      lines.push(`**Status:** ${statusBadge} | **Tier:** ${p.tier} | **Price:** ${p.price_range ?? "TBD"}`);
      if (p.origin_date) lines.push(`**First documented:** ${p.origin_date}`);
      lines.push("");
      if (p.problem_solved) { lines.push(`**Problem:** ${p.problem_solved}`); lines.push(""); }
      if (p.target_market) { lines.push(`**Market:** ${p.target_market}`); lines.push(""); }
      if (p.notes) { lines.push(p.notes); lines.push(""); }
      if (p.github_url) lines.push(`**GitHub:** ${p.github_url}`);
      if (p.demo_url) lines.push(`**Demo:** ${p.demo_url}`);
      lines.push("");
      lines.push("---");
      lines.push("");
    }

    return lines.join("\n");
  }

  close() { this.db.close(); }
}

// ── V2 Database ──────────────────────────────────────────────────────────────

export class CursusV2DB {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  constructor(dbPath: string) {
    mkdirSync(join(dbPath, ".."), { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const BetterSqlite3 = require("better-sqlite3") as any;
    const DatabaseCtor = BetterSqlite3.default ?? BetterSqlite3;
    this.db = new DatabaseCtor(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
    this.stampVersion();
  }

  private stampVersion(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS cursus_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.db.prepare(
      "INSERT INTO cursus_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(CURSUS_SCHEMA_VERSION));
  }

  getSchemaVersion(): number {
    try {
      const row = this.db.prepare("SELECT value FROM cursus_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
      return row ? parseInt(row.value, 10) : 0;
    } catch { return 0; }
  }

  private migrate(): void {
    const profileCols = [
      "ALTER TABLE cursus_profile ADD COLUMN cover_employer TEXT DEFAULT 'Confidential — Plant Tissue Culture Laboratory'",
      "ALTER TABLE cursus_profile ADD COLUMN cover_role TEXT DEFAULT 'Field Service Technician'",
      "ALTER TABLE cursus_profile ADD COLUMN cover_industry TEXT DEFAULT 'Biotechnology/Agricultural Research'",
      "ALTER TABLE cursus_profile ADD COLUMN nda_active INTEGER DEFAULT 1",
      "ALTER TABLE cursus_profile ADD COLUMN dream_job TEXT",
      "ALTER TABLE cursus_profile ADD COLUMN gap_analysis TEXT DEFAULT '[]'",
      "ALTER TABLE cursus_profile ADD COLUMN target_roles TEXT DEFAULT '[]'",
      "ALTER TABLE cursus_profile ADD COLUMN constraints_json TEXT DEFAULT '{}'",
    ];
    for (const sql of profileCols) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cursus_campaigns (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        target_role  TEXT NOT NULL,
        phase        TEXT NOT NULL DEFAULT 'research' CHECK (phase IN ('research','applying','interviewing','negotiating','closed')),
        milestones   TEXT NOT NULL DEFAULT '[]',
        active       INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cursus_applications (
        id           TEXT PRIMARY KEY,
        campaign_id  TEXT NOT NULL,
        company      TEXT NOT NULL,
        role         TEXT NOT NULL,
        url          TEXT,
        salary_range TEXT,
        match_score  INTEGER,
        status       TEXT NOT NULL DEFAULT 'found' CHECK (status IN ('found','qualified','applied','responded','interviewing','closed')),
        notes        TEXT,
        applied_at   TEXT,
        follow_up_at TEXT,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cursus_resumes (
        id               TEXT PRIMARY KEY,
        profile_version  INTEGER,
        base_resume      TEXT NOT NULL,
        tailored_for     TEXT,
        created_at       TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cursus_outreach (
        id              TEXT PRIMARY KEY,
        application_id  TEXT,
        type            TEXT NOT NULL CHECK (type IN ('email','cover_letter','recruiter')),
        subject         TEXT NOT NULL,
        body            TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','approved','sent','replied')),
        created_at      TEXT NOT NULL,
        sent_at         TEXT,
        gmail_thread_id TEXT
      );

      CREATE TABLE IF NOT EXISTS cursus_dux_sessions (
        id                        TEXT PRIMARY KEY,
        session_type              TEXT NOT NULL CHECK (session_type IN ('interview','checkin','role_assessment','discovery')),
        messages                  TEXT NOT NULL DEFAULT '[]',
        profile_version_generated INTEGER,
        created_at                TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_apps_campaign ON cursus_applications(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_apps_status ON cursus_applications(status);
      CREATE INDEX IF NOT EXISTS idx_outreach_status ON cursus_outreach(status);
      CREATE INDEX IF NOT EXISTS idx_outreach_app ON cursus_outreach(application_id);
      CREATE INDEX IF NOT EXISTS idx_dux_sessions_type ON cursus_dux_sessions(session_type);

      CREATE TABLE IF NOT EXISTS cursus_receipts (
        id              TEXT PRIMARY KEY,
        action          TEXT NOT NULL,
        timestamp       TEXT NOT NULL,
        campaign_id     TEXT,
        provider        TEXT,
        model           TEXT,
        local_mode      INTEGER NOT NULL DEFAULT 1,
        velum_reviewed  INTEGER NOT NULL DEFAULT 0,
        velum_redacted  INTEGER NOT NULL DEFAULT 0,
        result_summary  TEXT NOT NULL,
        errors          TEXT,
        warnings        TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_receipts_action ON cursus_receipts(action);
      CREATE INDEX IF NOT EXISTS idx_receipts_campaign ON cursus_receipts(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_receipts_timestamp ON cursus_receipts(timestamp);
    `);

    // ── Schema V4: onboarding, automation, app columns, fingerprints ────────
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cursus_onboarding (
        id                  INTEGER PRIMARY KEY DEFAULT 1,
        completed           INTEGER NOT NULL DEFAULT 0,
        completed_at        TEXT,
        name                TEXT,
        preferred_titles    TEXT,
        work_preference     TEXT,
        preferred_locations TEXT,
        salary_min          INTEGER,
        salary_max          INTEGER,
        years_experience    INTEGER,
        certifications      TEXT,
        resume_uploaded     INTEGER NOT NULL DEFAULT 0,
        resume_id           TEXT,
        privacy_mode        TEXT NOT NULL DEFAULT 'local-only',
        updated_at          TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cursus_automation (
        id             TEXT PRIMARY KEY,
        kind           TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'pending',
        title          TEXT NOT NULL,
        detail         TEXT NOT NULL DEFAULT '',
        campaign_id    TEXT,
        application_id TEXT,
        schedule       TEXT,
        created_at     TEXT NOT NULL,
        resolved_at    TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_auto_status ON cursus_automation(status);
      CREATE INDEX IF NOT EXISTS idx_auto_kind ON cursus_automation(kind);
    `);

    // Add columns to applications for source/location/remote/fingerprint
    const appCols = [
      "ALTER TABLE cursus_applications ADD COLUMN source TEXT",
      "ALTER TABLE cursus_applications ADD COLUMN location TEXT",
      "ALTER TABLE cursus_applications ADD COLUMN remote TEXT",
      "ALTER TABLE cursus_applications ADD COLUMN fingerprint TEXT",
    ];
    for (const sql of appCols) {
      try { this.db.exec(sql); } catch { /* already exists */ }
    }

    // Seed onboarding row if absent
    try {
      const count = (this.db.prepare("SELECT COUNT(*) as n FROM cursus_onboarding").get() as { n: number }).n;
      if (count === 0) {
        this.db.prepare("INSERT INTO cursus_onboarding (id, updated_at) VALUES (1, ?)").run(new Date().toISOString());
      }
    } catch { /* table might not exist yet in very old schemas */ }

    // ── Schema V5: search lanes, job evaluations, story bank, legitimacy ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cursus_search_lanes (
        id                TEXT PRIMARY KEY,
        campaign_id       TEXT NOT NULL,
        name              TEXT NOT NULL,
        target_titles     TEXT NOT NULL DEFAULT '[]',
        keywords          TEXT NOT NULL DEFAULT '[]',
        negative_keywords TEXT NOT NULL DEFAULT '[]',
        locations         TEXT NOT NULL DEFAULT '[]',
        remote_preference TEXT,
        source_filters    TEXT NOT NULL DEFAULT '[]',
        priority          TEXT NOT NULL DEFAULT 'primary' CHECK (priority IN ('primary','secondary','stretch')),
        active            INTEGER NOT NULL DEFAULT 1,
        created_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lanes_campaign ON cursus_search_lanes(campaign_id);

      CREATE TABLE IF NOT EXISTS cursus_job_evaluations (
        id                TEXT PRIMARY KEY,
        application_id    TEXT NOT NULL,
        role_summary      TEXT NOT NULL,
        fit_analysis      TEXT NOT NULL,
        gap_strategy      TEXT NOT NULL DEFAULT '',
        compensation_notes TEXT,
        resume_plan       TEXT,
        interview_prep    TEXT,
        legitimacy_grade  TEXT NOT NULL DEFAULT 'C' CHECK (legitimacy_grade IN ('A','B','C','D','F')),
        overall_grade     TEXT NOT NULL DEFAULT 'C' CHECK (overall_grade IN ('A','B','C','D','F')),
        created_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evals_app ON cursus_job_evaluations(application_id);

      CREATE TABLE IF NOT EXISTS cursus_interview_stories (
        id                    TEXT PRIMARY KEY,
        title                 TEXT NOT NULL,
        format                TEXT NOT NULL DEFAULT 'star' CHECK (format IN ('star','star_reflection','narrative')),
        situation             TEXT NOT NULL,
        task                  TEXT NOT NULL,
        action                TEXT NOT NULL,
        result                TEXT NOT NULL,
        reflection            TEXT,
        linked_project_ids    TEXT NOT NULL DEFAULT '[]',
        linked_experience_ids TEXT NOT NULL DEFAULT '[]',
        tags                  TEXT NOT NULL DEFAULT '[]',
        created_at            TEXT NOT NULL
      );
    `);

    // Application columns for legitimacy + follow-up cadence + lane tracking
    const appColsV5 = [
      "ALTER TABLE cursus_applications ADD COLUMN lane_id TEXT",
      "ALTER TABLE cursus_applications ADD COLUMN legitimacy_tier TEXT DEFAULT 'unknown'",
      "ALTER TABLE cursus_applications ADD COLUMN date_first_seen TEXT",
      "ALTER TABLE cursus_applications ADD COLUMN date_expired TEXT",
      "ALTER TABLE cursus_applications ADD COLUMN apply_url_status TEXT DEFAULT 'unknown'",
      "ALTER TABLE cursus_applications ADD COLUMN follow_up_cadence_days INTEGER",
      "ALTER TABLE cursus_applications ADD COLUMN last_follow_up_at TEXT",
      "ALTER TABLE cursus_applications ADD COLUMN follow_up_count INTEGER DEFAULT 0",
      "ALTER TABLE cursus_applications ADD COLUMN stale_notified INTEGER DEFAULT 0",
    ];
    for (const sql of appColsV5) {
      try { this.db.exec(sql); } catch { /* already exists */ }
    }
  }

  // ── Onboarding ────────────────────────────────────────────────────────────

  getOnboarding(): OnboardingState {
    return this.db.prepare("SELECT * FROM cursus_onboarding WHERE id = 1").get() as OnboardingState;
  }

  updateOnboarding(patch: Partial<Omit<OnboardingState, "id" | "updated_at">>): OnboardingState {
    const allowed = [
      "completed", "completed_at", "name", "preferred_titles", "work_preference",
      "preferred_locations", "salary_min", "salary_max", "years_experience",
      "certifications", "resume_uploaded", "resume_id", "privacy_mode",
    ];
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (allowed.includes(k)) {
        fields.push(`${k} = ?`);
        values.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
      }
    }
    if (fields.length === 0) return this.getOnboarding();
    fields.push("updated_at = ?");
    values.push(new Date().toISOString());
    this.db.prepare(`UPDATE cursus_onboarding SET ${fields.join(", ")} WHERE id = 1`).run(...values);
    return this.getOnboarding();
  }

  completeOnboarding(): OnboardingState {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE cursus_onboarding SET completed = 1, completed_at = ?, updated_at = ? WHERE id = 1").run(now, now);
    return this.getOnboarding();
  }

  // ── Profile (V2 extensions) ─────────────────────────────────────────────────

  getProfileV2(): Record<string, unknown> | null {
    return this.db.prepare("SELECT * FROM cursus_profile LIMIT 1").get() as Record<string, unknown> | null;
  }

  updateProfileV2(patch: Record<string, unknown>): void {
    const allowed = ["dream_job", "gap_analysis", "target_roles", "constraints_json", "cover_employer", "cover_role", "cover_industry", "nda_active"];
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (allowed.includes(k)) { fields.push(`${k} = ?`); values.push(v); }
    }
    if (fields.length === 0) return;
    values.push(new Date().toISOString());
    this.db.prepare(`UPDATE cursus_profile SET ${fields.join(", ")}, updated_at = ? WHERE id = 1`).run(...values);
  }

  // ── Campaigns ───────────────────────────────────────────────────────────────

  listCampaigns(): Campaign[] {
    return this.db.prepare("SELECT * FROM cursus_campaigns ORDER BY created_at DESC").all() as Campaign[];
  }

  getCampaign(id: string): Campaign | null {
    return this.db.prepare("SELECT * FROM cursus_campaigns WHERE id = ?").get(id) as Campaign | null;
  }

  createCampaign(name: string, targetRole: string): Campaign {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("UPDATE cursus_campaigns SET active = 0 WHERE active = 1").run();
    this.db.prepare("INSERT INTO cursus_campaigns (id, name, target_role, created_at) VALUES (?, ?, ?, ?)").run(id, name, targetRole, now);
    return this.getCampaign(id)!;
  }

  updateCampaign(id: string, patch: Partial<Pick<Campaign, "name" | "target_role" | "phase" | "milestones" | "active">>): Campaign | null {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (["name", "target_role", "phase", "milestones", "active"].includes(k)) {
        fields.push(`${k} = ?`);
        values.push(k === "active" ? (v ? 1 : 0) : v);
      }
    }
    if (fields.length === 0) return this.getCampaign(id);
    values.push(id);
    this.db.prepare(`UPDATE cursus_campaigns SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getCampaign(id);
  }

  closeCampaign(id: string): Campaign | null {
    const campaign = this.getCampaign(id);
    if (!campaign) return null;
    this.db.prepare("UPDATE cursus_campaigns SET active = 0, phase = 'closed' WHERE id = ?").run(id);
    return this.getCampaign(id);
  }

  getActiveCampaign(): Campaign | null {
    return this.db.prepare("SELECT * FROM cursus_campaigns WHERE active = 1 LIMIT 1").get() as Campaign | null;
  }

  countActiveCampaigns(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM cursus_campaigns WHERE active = 1").get() as { cnt: number };
    return row.cnt;
  }

  // ── Applications ────────────────────────────────────────────────────────────

  listApplications(campaignId?: string): Application[] {
    if (campaignId) return this.db.prepare("SELECT * FROM cursus_applications WHERE campaign_id = ? ORDER BY created_at DESC").all(campaignId) as Application[];
    return this.db.prepare("SELECT * FROM cursus_applications ORDER BY created_at DESC").all() as Application[];
  }

  getApplication(id: string): Application | null {
    return this.db.prepare("SELECT * FROM cursus_applications WHERE id = ?").get(id) as Application | null;
  }

  static jobFingerprint(company: string, role: string, url?: string | null): string {
    const raw = `${company.toLowerCase().trim()}|${role.toLowerCase().trim()}|${(url ?? "").toLowerCase().trim()}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
  }

  hasFingerprint(fingerprint: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM cursus_applications WHERE fingerprint = ? LIMIT 1").get(fingerprint);
    return !!row;
  }

  createApplication(data: {
    campaign_id: string; company: string; role: string;
    url?: string; salary_range?: string; match_score?: number; notes?: string;
    source?: string; location?: string; remote?: string; lane_id?: string;
  }): Application {
    const id = randomUUID();
    const now = new Date().toISOString();
    const fp = CursusV2DB.jobFingerprint(data.company, data.role, data.url);
    this.db.prepare(
      "INSERT INTO cursus_applications (id, campaign_id, company, role, url, salary_range, match_score, notes, source, location, remote, fingerprint, lane_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      id, data.campaign_id, data.company, data.role,
      data.url ?? null, data.salary_range ?? null, data.match_score ?? null, data.notes ?? null,
      data.source ?? null, data.location ?? null, data.remote ?? null, fp,
      data.lane_id ?? null, now,
    );
    return this.getApplication(id)!;
  }

  updateApplication(id: string, patch: Partial<Pick<Application, "status" | "notes" | "match_score" | "salary_range" | "applied_at" | "follow_up_at" | "url">> & Record<string, unknown>): Application | null {
    const allowed = ["status", "notes", "match_score", "salary_range", "applied_at", "follow_up_at", "url", "lane_id", "source", "location", "remote"];
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (allowed.includes(k)) {
        fields.push(`${k} = ?`); values.push(v);
      }
    }
    if (fields.length === 0) return this.getApplication(id);
    values.push(id);
    this.db.prepare(`UPDATE cursus_applications SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getApplication(id);
  }

  countApplicationsByStatus(campaignId?: string): Record<AppStatus, number> {
    const rows = campaignId
      ? this.db.prepare("SELECT status, COUNT(*) as cnt FROM cursus_applications WHERE campaign_id = ? GROUP BY status").all(campaignId) as Array<{ status: AppStatus; cnt: number }>
      : this.db.prepare("SELECT status, COUNT(*) as cnt FROM cursus_applications GROUP BY status").all() as Array<{ status: AppStatus; cnt: number }>;
    const counts: Record<string, number> = { found: 0, qualified: 0, applied: 0, responded: 0, interviewing: 0, closed: 0 };
    for (const r of rows) counts[r.status] = r.cnt;
    return counts as Record<AppStatus, number>;
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  getCampaignAnalytics(campaignId: string): CampaignAnalytics | null {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) return null;

    const counts = this.countApplicationsByStatus(campaignId);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    const apps = this.listApplications(campaignId);
    const byRole: Record<string, number> = {};
    const byLocation: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    for (const a of apps) {
      const roleKey = a.role || "Unknown";
      byRole[roleKey] = (byRole[roleKey] ?? 0) + 1;
      const locKey = (a as Application).location || "Unknown";
      byLocation[locKey] = (byLocation[locKey] ?? 0) + 1;
      const srcKey = (a as Application).source || "manual";
      bySource[srcKey] = (bySource[srcKey] ?? 0) + 1;
    }

    const applied = counts.applied + counts.responded + counts.interviewing + counts.closed;
    const responded = counts.responded + counts.interviewing;
    const responseRate = applied > 0 ? Math.round((responded / applied) * 100) : 0;
    const interviewConversion = responded > 0 ? Math.round((counts.interviewing / responded) * 100) : 0;

    // Outreach stats for this campaign's applications
    const appIds = apps.map(a => a.id);
    let outreachTotal = 0;
    let outreachSent = 0;
    let outreachReplied = 0;
    if (appIds.length > 0) {
      const placeholders = appIds.map(() => "?").join(",");
      const oRows = this.db.prepare(`SELECT status, COUNT(*) as cnt FROM cursus_outreach WHERE application_id IN (${placeholders}) GROUP BY status`).all(...appIds) as Array<{ status: string; cnt: number }>;
      for (const r of oRows) {
        outreachTotal += r.cnt;
        if (r.status === "sent" || r.status === "replied") outreachSent += r.cnt;
        if (r.status === "replied") outreachReplied += r.cnt;
      }
    }
    const outreachResponseRate = outreachSent > 0 ? Math.round((outreachReplied / outreachSent) * 100) : 0;

    const daysActive = Math.max(0, Math.floor((Date.now() - new Date(campaign.created_at).getTime()) / 86_400_000));

    // Generate local insights
    const insights = this.generateInsights(counts, total, byRole, byLocation, bySource, responseRate, interviewConversion, outreachSent, outreachResponseRate);

    return {
      campaign_id: campaignId,
      campaign_name: campaign.name,
      phase: campaign.phase,
      days_active: daysActive,
      applications: { total, by_status: counts, by_role: byRole, by_location: byLocation, by_source: bySource },
      rates: { response_rate: responseRate, interview_conversion: interviewConversion },
      outreach: { total: outreachTotal, sent: outreachSent, response_rate: outreachResponseRate },
      insights,
    };
  }

  private generateInsights(
    counts: Record<AppStatus, number>, total: number,
    byRole: Record<string, number>, byLocation: Record<string, number>,
    bySource: Record<string, number>,
    responseRate: number, interviewConversion: number,
    outreachSent: number, outreachResponseRate: number,
  ): string[] {
    const insights: string[] = [];

    if (total === 0) {
      insights.push("No applications yet. Run Job Scout or add jobs manually to get started.");
      return insights;
    }

    // Top role
    const topRole = Object.entries(byRole).sort((a, b) => b[1] - a[1])[0];
    if (topRole && Object.keys(byRole).length > 1) {
      insights.push(`Most applications are for "${topRole[0]}" roles (${topRole[1]}/${total}).`);
    }

    // Top location
    const locs = Object.entries(byLocation).filter(([k]) => k !== "Unknown").sort((a, b) => b[1] - a[1]);
    if (locs.length > 0 && locs[0]![1] > 1) {
      insights.push(`"${locs[0]![0]}" is the most common location (${locs[0]![1]} jobs).`);
    }

    // Response rate insight
    if (responseRate > 30) {
      insights.push(`Strong response rate at ${responseRate}%. Keep targeting similar roles.`);
    } else if (responseRate > 0 && responseRate <= 15) {
      insights.push(`Response rate is ${responseRate}%. Consider tailoring resumes more for each application.`);
    }

    // Interview conversion
    if (interviewConversion > 50) {
      insights.push(`Excellent interview conversion at ${interviewConversion}% — interview prep is paying off.`);
    }

    // Outreach
    if (outreachSent > 0 && outreachResponseRate > 20) {
      insights.push(`Outreach has a ${outreachResponseRate}% response rate — personalized messages are working.`);
    } else if (outreachSent > 3 && outreachResponseRate === 0) {
      insights.push(`${outreachSent} outreach messages sent with no replies. Consider adjusting your approach or targeting.`);
    }

    // Stale apps
    if (counts.applied > 3 && counts.responded === 0) {
      insights.push(`${counts.applied} applications submitted with no responses yet. Follow-ups may help.`);
    }

    // Source insight
    const srcEntries = Object.entries(bySource).filter(([k]) => k !== "manual").sort((a, b) => b[1] - a[1]);
    if (srcEntries.length > 0) {
      insights.push(`Top source: "${srcEntries[0]![0]}" (${srcEntries[0]![1]} jobs).`);
    }

    if (insights.length === 0) {
      insights.push("Campaign is active. Keep applying and reviewing your pipeline.");
    }

    return insights;
  }

  // ── Automation Queue ──────────────────────────────────────────────────────

  createAutomationTask(data: {
    kind: AutomationKind; title: string; detail?: string;
    campaign_id?: string; application_id?: string; schedule?: string;
  }): AutomationTask {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      "INSERT INTO cursus_automation (id, kind, status, title, detail, campaign_id, application_id, schedule, created_at) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)"
    ).run(id, data.kind, data.title, data.detail ?? "", data.campaign_id ?? null, data.application_id ?? null, data.schedule ?? null, now);
    return this.db.prepare("SELECT * FROM cursus_automation WHERE id = ?").get(id) as AutomationTask;
  }

  listAutomationTasks(status?: AutomationStatus): AutomationTask[] {
    if (status) return this.db.prepare("SELECT * FROM cursus_automation WHERE status = ? ORDER BY created_at DESC").all(status) as AutomationTask[];
    return this.db.prepare("SELECT * FROM cursus_automation ORDER BY created_at DESC").all() as AutomationTask[];
  }

  getAutomationTask(id: string): AutomationTask | null {
    return this.db.prepare("SELECT * FROM cursus_automation WHERE id = ?").get(id) as AutomationTask | null;
  }

  resolveAutomationTask(id: string, newStatus: "approved" | "rejected" | "executed"): AutomationTask | null {
    const task = this.getAutomationTask(id);
    if (!task) return null;
    // Only allow valid transitions
    const validFrom: Record<string, string[]> = {
      approved: ["pending", "awaiting_approval"],
      rejected: ["pending", "awaiting_approval"],
      executed: ["approved"],
    };
    if (!validFrom[newStatus]?.includes(task.status)) return null;
    const now = new Date().toISOString();
    this.db.prepare("UPDATE cursus_automation SET status = ?, resolved_at = ? WHERE id = ?").run(newStatus, now, id);
    return this.getAutomationTask(id);
  }

  countPendingAutomation(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM cursus_automation WHERE status IN ('pending', 'awaiting_approval')").get() as { cnt: number };
    return row.cnt;
  }

  // ── Resumes ─────────────────────────────────────────────────────────────────

  listResumes(): Resume[] {
    return this.db.prepare("SELECT * FROM cursus_resumes ORDER BY created_at DESC").all() as Resume[];
  }

  createResume(baseResume: string, profileVersion?: number, tailoredFor?: string): Resume {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO cursus_resumes (id, profile_version, base_resume, tailored_for, created_at) VALUES (?, ?, ?, ?, ?)").run(id, profileVersion ?? null, baseResume, tailoredFor ?? null, now);
    return this.db.prepare("SELECT * FROM cursus_resumes WHERE id = ?").get(id) as Resume;
  }

  // ── Outreach ────────────────────────────────────────────────────────────────

  listOutreach(status?: OutreachStatus): Outreach[] {
    if (status) return this.db.prepare("SELECT * FROM cursus_outreach WHERE status = ? ORDER BY created_at DESC").all(status) as Outreach[];
    return this.db.prepare("SELECT * FROM cursus_outreach ORDER BY created_at DESC").all() as Outreach[];
  }

  stageOutreach(data: { application_id?: string; type: OutreachType; subject: string; body: string }): Outreach {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      "INSERT INTO cursus_outreach (id, application_id, type, subject, body, status, created_at) VALUES (?, ?, ?, ?, ?, 'staged', ?)"
    ).run(id, data.application_id ?? null, data.type, data.subject, data.body, now);
    return this.db.prepare("SELECT * FROM cursus_outreach WHERE id = ?").get(id) as Outreach;
  }

  approveOutreach(id: string): Outreach | null {
    const existing = this.db.prepare("SELECT * FROM cursus_outreach WHERE id = ?").get(id) as Outreach | null;
    if (!existing || existing.status !== "staged") return null;
    this.db.prepare("UPDATE cursus_outreach SET status = 'approved' WHERE id = ? AND status = 'staged'").run(id);
    return this.db.prepare("SELECT * FROM cursus_outreach WHERE id = ?").get(id) as Outreach;
  }

  markOutreachSent(id: string, gmailThreadId?: string): Outreach | null {
    const existing = this.db.prepare("SELECT * FROM cursus_outreach WHERE id = ?").get(id) as Outreach | null;
    if (!existing || existing.status !== "approved") return null;
    const now = new Date().toISOString();
    this.db.prepare("UPDATE cursus_outreach SET status = 'sent', sent_at = ?, gmail_thread_id = ? WHERE id = ? AND status = 'approved'").run(now, gmailThreadId ?? null, id);
    return this.db.prepare("SELECT * FROM cursus_outreach WHERE id = ?").get(id) as Outreach;
  }

  markOutreachReplied(id: string): Outreach | null {
    this.db.prepare("UPDATE cursus_outreach SET status = 'replied' WHERE id = ? AND status = 'sent'").run(id);
    return this.db.prepare("SELECT * FROM cursus_outreach WHERE id = ?").get(id) as Outreach;
  }

  rejectOutreach(id: string): boolean {
    return this.db.prepare("DELETE FROM cursus_outreach WHERE id = ? AND status = 'staged'").run(id).changes > 0;
  }

  // ── Dux Sessions ────────────────────────────────────────────────────────────

  listDuxSessions(): DuxSession[] {
    return this.db.prepare("SELECT * FROM cursus_dux_sessions ORDER BY created_at DESC").all() as DuxSession[];
  }

  getDuxSession(id: string): DuxSession | null {
    return this.db.prepare("SELECT * FROM cursus_dux_sessions WHERE id = ?").get(id) as DuxSession | null;
  }

  createDuxSession(sessionType: DuxSessionType): DuxSession {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO cursus_dux_sessions (id, session_type, messages, created_at) VALUES (?, ?, '[]', ?)").run(id, sessionType, now);
    return this.getDuxSession(id)!;
  }

  appendDuxMessage(sessionId: string, role: "user" | "assistant", content: string): void {
    const session = this.getDuxSession(sessionId);
    if (!session) return;
    const messages = JSON.parse(session.messages) as Array<{ role: string; content: string; timestamp: string }>;
    messages.push({ role, content, timestamp: new Date().toISOString() });
    this.db.prepare("UPDATE cursus_dux_sessions SET messages = ? WHERE id = ?").run(JSON.stringify(messages), sessionId);
  }

  // ── Dashboard ───────────────────────────────────────────────────────────────

  getDashboard(): DashboardStats {
    const campaigns = this.listCampaigns();
    const activeCampaign = campaigns.find(c => c.active) ?? null;
    const counts = this.countApplicationsByStatus();
    const totalApplications = Object.values(counts).reduce((a, b) => a + b, 0);

    const outreachCounts = this.db.prepare("SELECT status, COUNT(*) as cnt FROM cursus_outreach GROUP BY status").all() as Array<{ status: string; cnt: number }>;
    const oc: Record<string, number> = {};
    for (const r of outreachCounts) oc[r.status] = r.cnt;

    const duxSessions = this.listDuxSessions();
    const lastDux = duxSessions.length > 0 ? duxSessions[0]!.created_at : null;

    const recentApps = this.db.prepare("SELECT 'application' as type, company || ' — ' || role as detail, created_at as timestamp FROM cursus_applications ORDER BY created_at DESC LIMIT 5").all() as Array<{ type: string; detail: string; timestamp: string }>;
    const recentOutreach = this.db.prepare("SELECT 'outreach' as type, type || ': ' || subject as detail, created_at as timestamp FROM cursus_outreach ORDER BY created_at DESC LIMIT 5").all() as Array<{ type: string; detail: string; timestamp: string }>;
    const recentActivity = [...recentApps, ...recentOutreach].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 10);
    const daysActive = activeCampaign
      ? Math.max(0, Math.floor((Date.now() - new Date(activeCampaign.created_at).getTime()) / 86_400_000))
      : 0;
    const stats = {
      applications_sent: counts.applied + counts.responded + counts.interviewing + counts.closed,
      responses: counts.responded + counts.interviewing,
      interviews: counts.interviewing,
      pending_outreach: oc["staged"] ?? 0,
    };
    const nextAction = activeCampaign
      ? (totalApplications === 0
          ? "Run Job Scout to seed the first application candidates."
          : stats.pending_outreach > 0
            ? "Review staged outreach before anything sends."
            : "Review pipeline and decide the next apply/follow-up move.")
      : "Create a campaign or ask Dux to help define the target role.";

    return {
      activeCampaign,
      campaign: activeCampaign ? { ...activeCampaign, name: activeCampaign.name, phase: activeCampaign.phase, days_active: daysActive } : null,
      applicationCounts: counts,
      stats,
      totalApplications,
      pendingOutreach: oc["staged"] ?? 0,
      approvedOutreach: oc["approved"] ?? 0,
      sentOutreach: oc["sent"] ?? 0,
      repliedOutreach: oc["replied"] ?? 0,
      lastDuxSession: lastDux,
      recentActivity,
      recent_activity: recentActivity.map((item, index) => ({
        id: `${item.type}-${item.timestamp}-${index}`,
        type: item.type,
        summary: item.detail,
        timestamp: item.timestamp,
      })),
      next_action: nextAction,
    };
  }

  // ── Receipts ──────────────────────────────────────────────────────────────

  createReceipt(data: {
    action: ReceiptAction;
    campaign_id?: string | null;
    provider?: string | null;
    model?: string | null;
    local_mode?: boolean;
    velum_reviewed?: boolean;
    velum_redacted?: boolean;
    result_summary: string;
    errors?: string | null;
    warnings?: string | null;
  }): Receipt {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO cursus_receipts (id, action, timestamp, campaign_id, provider, model, local_mode, velum_reviewed, velum_redacted, result_summary, errors, warnings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, data.action, now,
      data.campaign_id ?? null,
      data.provider ?? null,
      data.model ?? null,
      data.local_mode !== false ? 1 : 0,
      data.velum_reviewed ? 1 : 0,
      data.velum_redacted ? 1 : 0,
      data.result_summary,
      data.errors ?? null,
      data.warnings ?? null,
    );
    return this.db.prepare("SELECT * FROM cursus_receipts WHERE id = ?").get(id) as Receipt;
  }

  listReceipts(limit = 50, action?: ReceiptAction): Receipt[] {
    if (action) {
      return this.db.prepare("SELECT * FROM cursus_receipts WHERE action = ? ORDER BY timestamp DESC LIMIT ?").all(action, limit) as Receipt[];
    }
    return this.db.prepare("SELECT * FROM cursus_receipts ORDER BY timestamp DESC LIMIT ?").all(limit) as Receipt[];
  }

  // ── Velum (local review/redaction) ────────────────────────────────────────

  static velumReview(text: string, _context: string = "general"): VelumReviewResult {
    const patterns: Array<{ regex: RegExp; label: string; replacement: string }> = [
      { regex: /\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/g, label: "ssn", replacement: "[SSN-REDACTED]" },
      { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, label: "email", replacement: "[EMAIL-REDACTED]" },
      { regex: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, label: "phone", replacement: "[PHONE-REDACTED]" },
      { regex: /\b\d{1,5}\s+\w+(?:\s+\w+)*\s+(?:St|Ave|Blvd|Dr|Ln|Rd|Ct|Way|Pl|Ter)\b\.?(?:\s*,?\s*(?:Apt|Suite|Unit|#)\s*\w+)?/gi, label: "address", replacement: "[ADDRESS-REDACTED]" },
      { regex: /\b(?:4\d{3}|5[1-5]\d{2}|6011|3[47]\d{2})[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, label: "credit_card", replacement: "[CARD-REDACTED]" },
    ];

    let output = text;
    const fieldsRedacted: string[] = [];
    const originalLength = text.length;

    for (const { regex, label, replacement } of patterns) {
      if (regex.test(output)) {
        fieldsRedacted.push(label);
        output = output.replace(regex, replacement);
      }
    }

    return {
      reviewed: true,
      redacted: fieldsRedacted.length > 0,
      original_length: originalLength,
      redacted_length: output.length,
      fields_redacted: fieldsRedacted,
      output,
    };
  }

  // ── Search Lanes ──────────────────────────────────────────────────────────

  listSearchLanes(campaignId?: string): SearchLane[] {
    if (campaignId) return this.db.prepare("SELECT * FROM cursus_search_lanes WHERE campaign_id = ? ORDER BY priority, created_at").all(campaignId) as SearchLane[];
    return this.db.prepare("SELECT * FROM cursus_search_lanes ORDER BY priority, created_at").all() as SearchLane[];
  }

  getSearchLane(id: string): SearchLane | null {
    return this.db.prepare("SELECT * FROM cursus_search_lanes WHERE id = ?").get(id) as SearchLane | null;
  }

  createSearchLane(data: {
    campaign_id: string; name: string;
    target_titles?: string[]; keywords?: string[]; negative_keywords?: string[];
    locations?: string[]; remote_preference?: string | null; source_filters?: string[];
    priority?: LanePriority;
  }): SearchLane {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO cursus_search_lanes (id, campaign_id, name, target_titles, keywords, negative_keywords, locations, remote_preference, source_filters, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, data.campaign_id, data.name,
      JSON.stringify(data.target_titles ?? []),
      JSON.stringify(data.keywords ?? []),
      JSON.stringify(data.negative_keywords ?? []),
      JSON.stringify(data.locations ?? []),
      data.remote_preference ?? null,
      JSON.stringify(data.source_filters ?? []),
      data.priority ?? "primary",
      now,
    );
    return this.getSearchLane(id)!;
  }

  updateSearchLane(id: string, patch: Partial<Omit<SearchLane, "id" | "campaign_id" | "created_at">>): SearchLane | null {
    const allowed = ["name", "target_titles", "keywords", "negative_keywords", "locations", "remote_preference", "source_filters", "priority", "active"];
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.includes(k)) continue;
      fields.push(`${k} = ?`);
      if (k === "active") values.push(v ? 1 : 0);
      else if (Array.isArray(v)) values.push(JSON.stringify(v));
      else values.push(v);
    }
    if (fields.length === 0) return this.getSearchLane(id);
    values.push(id);
    this.db.prepare(`UPDATE cursus_search_lanes SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getSearchLane(id);
  }

  deleteSearchLane(id: string): boolean {
    return this.db.prepare("DELETE FROM cursus_search_lanes WHERE id = ?").run(id).changes > 0;
  }

  getActiveSearchLanes(campaignId: string): SearchLane[] {
    return this.db.prepare("SELECT * FROM cursus_search_lanes WHERE campaign_id = ? AND active = 1 ORDER BY priority").all(campaignId) as SearchLane[];
  }

  // ── Job Evaluations ────────────────────────────────────────────────────────

  listJobEvaluations(applicationId?: string): JobEvaluation[] {
    if (applicationId) return this.db.prepare("SELECT * FROM cursus_job_evaluations WHERE application_id = ? ORDER BY created_at DESC").all(applicationId) as JobEvaluation[];
    return this.db.prepare("SELECT * FROM cursus_job_evaluations ORDER BY created_at DESC").all() as JobEvaluation[];
  }

  getJobEvaluation(id: string): JobEvaluation | null {
    return this.db.prepare("SELECT * FROM cursus_job_evaluations WHERE id = ?").get(id) as JobEvaluation | null;
  }

  createJobEvaluation(data: {
    application_id: string; role_summary: string; fit_analysis: string;
    gap_strategy?: string; compensation_notes?: string; resume_plan?: string;
    interview_prep?: string; legitimacy_grade?: EvalGrade; overall_grade?: EvalGrade;
  }): JobEvaluation {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO cursus_job_evaluations (id, application_id, role_summary, fit_analysis, gap_strategy, compensation_notes, resume_plan, interview_prep, legitimacy_grade, overall_grade, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, data.application_id, data.role_summary, data.fit_analysis,
      data.gap_strategy ?? "", data.compensation_notes ?? null,
      data.resume_plan ?? null, data.interview_prep ?? null,
      data.legitimacy_grade ?? "C", data.overall_grade ?? "C", now,
    );
    return this.getJobEvaluation(id)!;
  }

  // ── Interview Story Bank ───────────────────────────────────────────────────

  listStories(): InterviewStory[] {
    return this.db.prepare("SELECT * FROM cursus_interview_stories ORDER BY created_at DESC").all() as InterviewStory[];
  }

  getStory(id: string): InterviewStory | null {
    return this.db.prepare("SELECT * FROM cursus_interview_stories WHERE id = ?").get(id) as InterviewStory | null;
  }

  createStory(data: {
    title: string; format?: StoryFormat;
    situation: string; task: string; action: string; result: string;
    reflection?: string; linked_project_ids?: number[]; linked_experience_ids?: number[];
    tags?: string[];
  }): InterviewStory {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO cursus_interview_stories (id, title, format, situation, task, action, result, reflection, linked_project_ids, linked_experience_ids, tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, data.title, data.format ?? "star",
      data.situation, data.task, data.action, data.result,
      data.reflection ?? null,
      JSON.stringify(data.linked_project_ids ?? []),
      JSON.stringify(data.linked_experience_ids ?? []),
      JSON.stringify(data.tags ?? []),
      now,
    );
    return this.getStory(id)!;
  }

  updateStory(id: string, patch: Partial<Omit<InterviewStory, "id" | "created_at">>): InterviewStory | null {
    const allowed = ["title", "format", "situation", "task", "action", "result", "reflection", "linked_project_ids", "linked_experience_ids", "tags"];
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.includes(k)) continue;
      fields.push(`${k} = ?`);
      if (Array.isArray(v)) values.push(JSON.stringify(v));
      else values.push(v);
    }
    if (fields.length === 0) return this.getStory(id);
    values.push(id);
    this.db.prepare(`UPDATE cursus_interview_stories SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getStory(id);
  }

  // ── Follow-up Cadence ──────────────────────────────────────────────────────

  getStaleApplications(staleDays = 7): Application[] {
    const cutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString();
    return this.db.prepare(
      `SELECT * FROM cursus_applications
       WHERE status IN ('applied', 'responded')
         AND created_at < ?
         AND (follow_up_at IS NULL OR follow_up_at < ?)
         AND (last_follow_up_at IS NULL OR last_follow_up_at < ?)
         AND stale_notified = 0
       ORDER BY created_at ASC`
    ).all(cutoff, cutoff, cutoff) as Application[];
  }

  recordFollowUp(id: string): Application | null {
    const now = new Date().toISOString();
    this.db.prepare(
      "UPDATE cursus_applications SET last_follow_up_at = ?, follow_up_count = COALESCE(follow_up_count, 0) + 1, stale_notified = 0 WHERE id = ?"
    ).run(now, id);
    return this.getApplication(id);
  }

  setFollowUpCadence(id: string, days: number): Application | null {
    const followUpAt = new Date(Date.now() + days * 86_400_000).toISOString();
    this.db.prepare(
      "UPDATE cursus_applications SET follow_up_cadence_days = ?, follow_up_at = ? WHERE id = ?"
    ).run(days, followUpAt, id);
    return this.getApplication(id);
  }

  // ── Application legitimacy ────────────────────────────────────────────────

  updateApplicationLegitimacy(id: string, patch: {
    legitimacy_tier?: string; date_first_seen?: string; date_expired?: string;
    apply_url_status?: string;
  }): Application | null {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (["legitimacy_tier", "date_first_seen", "date_expired", "apply_url_status"].includes(k)) {
        fields.push(`${k} = ?`); values.push(v);
      }
    }
    if (fields.length === 0) return this.getApplication(id);
    values.push(id);
    this.db.prepare(`UPDATE cursus_applications SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getApplication(id);
  }

  close(): void {
    this.db.close();
  }
}
