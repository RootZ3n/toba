#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const dbPath = getArg("--db");
const mode = getArg("--mode") ?? "--personal-data-only";
const dryRun = args.includes("--dry-run");
const keepProviderConfig = getArg("--keep-provider-config") === "1";

if (!dbPath) {
  console.error("Missing --db PATH");
  process.exit(2);
}

const db = new Database(dbPath);
const exists = (table) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
const count = (table) => exists(table) ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : 0;
const del = (table) => exists(table) ? db.prepare(`DELETE FROM ${table}`).run().changes : 0;
const columns = (table) => exists(table) ? new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)) : new Set();
const updateExisting = (table, assignments, where = "") => {
  const cols = columns(table);
  const fields = [];
  const values = [];
  for (const [name, value] of assignments) {
    if (!cols.has(name)) continue;
    fields.push(`${name} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return 0;
  return db.prepare(`UPDATE ${table} SET ${fields.join(", ")} ${where}`).run(...values).changes;
};

const tables = [
  "cursus_resumes",
  "cursus_search_lanes",
  "cursus_job_evaluations",
  "cursus_outreach",
  "cursus_applications",
  "cursus_campaigns",
  "cursus_receipts",
  "cursus_automation",
  "cursus_dux_sessions",
  "cursus_interview_stories",
  "cursus_experience",
  "cursus_certifications",
  "cursus_projects",
  "cursus_skills",
];
if (mode === "--all-data") tables.push("cursus_products");

console.log("Current row counts:");
for (const table of tables) console.log(`${table}: ${count(table)}`);

if (dryRun) {
  console.log("Dry run only. No data deleted.");
  db.close();
  process.exit(0);
}

const tx = db.transaction(() => {
  const summary = {};
  for (const table of tables) summary[table] = del(table);
  if (exists("cursus_profile")) {
    updateExisting("cursus_profile", [
      ["name", null], ["email", null], ["phone", null], ["title", null], ["summary", null],
      ["location", null], ["work_preference", null], ["preferred_locations", null],
      ["salary_min", null], ["salary_max", null], ["years_experience", null],
      ["certifications", null], ["skills", null], ["links_json", null],
      ["privacy_mode", "local-only"], ["provider_preference", null],
      ["cover_employer", null], ["cover_role", null], ["cover_industry", null],
      ["nda_active", 0], ["dream_job", null], ["gap_analysis", "[]"],
      ["target_roles", "[]"], ["constraints_json", "{}"], ["updated_at", new Date().toISOString()],
    ], "WHERE id = 1");
  }
  if (exists("cursus_onboarding")) {
    updateExisting("cursus_onboarding", [
      ["completed", 0], ["completed_at", null], ["name", null],
      ["preferred_titles", null], ["work_preference", null],
      ["preferred_locations", null], ["salary_min", null], ["salary_max", null],
      ["years_experience", null], ["certifications", null],
      ["resume_uploaded", 0], ["resume_id", null],
      ["privacy_mode", "local-only"], ["updated_at", new Date().toISOString()],
    ], "WHERE id = 1");
  }
  if (!keepProviderConfig && exists("cursus_dux_agents")) {
    updateExisting("cursus_dux_agents", [
      ["provider", null], ["model", null], ["base_url", null], ["api_key", null],
      ["local_only", null], ["cloud_allowed", null], ["temperature", null],
      ["max_tokens", null], ["fallback_provider", null], ["fallback_model", null],
      ["updated_at", new Date().toISOString()],
    ]);
  }
  return summary;
});

console.log("Deleted rows:");
console.log(JSON.stringify(tx(), null, 2));
db.close();
