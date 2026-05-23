/**
 * Cursus Standalone — Route Registration
 * ========================================
 * All /cursus/* and top-level health/version/status routes.
 * No dependency on Squidley platform services.
 */

import type { FastifyInstance } from "fastify";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { CursusV1DB, CursusProduct, ReceiptAction, AutomationStatus, LanePriority, EvalGrade, StoryFormat, DuxAgent } from "./db.js";
import { CursusV2DB, CURSUS_SCHEMA_VERSION } from "./db.js";

// ── Web SPA assets (loaded once at module init) ──────────────────────────
const __webDir = (() => {
  try { return join(dirname(fileURLToPath(import.meta.url)), "web"); }
  catch { return join(process.cwd(), "src", "web"); }
})();
function readWebAsset(name: string): string {
  const path = join(__webDir, name);
  if (!existsSync(path)) return "";
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}
const WEB_INDEX  = readWebAsset("index.html");
const WEB_APP_JS = readWebAsset("app.js");
const WEB_STYLES = readWebAsset("styles.css");
import {
  chat as providerChat,
  getStatus as getProviderStatus,
  getConfig as getProviderConfig,
  applyConfigPatch,
  ProviderError,
  isLocalProvider as providerIsLocal,
  PROVIDER_REGISTRY,
  type ChatMessage,
  type ProviderConfig,
} from "./provider.js";
import type { NetworkConfig } from "./network.js";
import { classifyBind } from "./network.js";

const CURSUS_VERSION = process.env["CURSUS_VERSION"] ?? "5.0.0";
const CURSUS_PORT = parseInt(process.env["CURSUS_PORT"] ?? "18815", 10);
const CURSUS_AUTOMATION_MODE = process.env["CURSUS_AUTOMATION_MODE"] ?? "approval-required";
// Optional Squidley bridge URL — disabled by default. When unset, Cursus runs
// fully standalone and never reaches out to Squidley. Bridge is for legacy
// integrations only and is NOT required.
const CURSUS_BRIDGE_URL = process.env["CURSUS_BRIDGE_URL"] ?? process.env["SQUIDLEY_CURSUS_URL"] ?? "";

function listToJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return JSON.stringify(value.map(v => String(v).trim()).filter(Boolean));
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "[]";
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return JSON.stringify(parsed.map(v => String(v).trim()).filter(Boolean));
    } catch { /* comma/newline format below */ }
    return JSON.stringify(trimmed.split(/[,;\n]+/).map(v => v.trim()).filter(Boolean));
  }
  return undefined;
}

function numberOrNull(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getProviderMeta() {
  const s = getProviderStatus();
  return {
    provider: s.provider,
    model: s.model,
    local: s.local,
    configured: s.configured,
    base_url: s.base_url,
  };
}

export function registerRoutes(
  server: FastifyInstance,
  v1: CursusV1DB,
  v2: CursusV2DB,
  netCfg?: NetworkConfig,
): void {
  // Sensible default for tests / inline use: loopback, no auth.
  const network: NetworkConfig = netCfg ?? {
    host: process.env["CURSUS_HOST"] ?? "127.0.0.1",
    port: parseInt(process.env["CURSUS_PORT"] ?? "18815", 10),
    exposure: classifyBind(process.env["CURSUS_HOST"] ?? "127.0.0.1"),
    auth_required: false,
    auth_token_configured: !!process.env["CURSUS_AUTH_TOKEN"],
    require_auth_env: null,
    allow_loopback_skip: true,
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Web UI (SPA)
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/", async (_req, reply) => {
    if (!WEB_INDEX) {
      return reply
        .header("content-type", "text/plain; charset=utf-8")
        .status(500)
        .send("Cursus UI assets not found. Expected src/web/index.html. See /api for the JSON endpoint map.");
    }
    return reply.header("content-type", "text/html; charset=utf-8").send(WEB_INDEX);
  });

  server.get("/assets/app.js", async (_req, reply) => {
    if (!WEB_APP_JS) return reply.status(404).send("missing");
    return reply
      .header("content-type", "text/javascript; charset=utf-8")
      .header("cache-control", "no-cache")
      .send(WEB_APP_JS);
  });

  server.get("/assets/styles.css", async (_req, reply) => {
    if (!WEB_STYLES) return reply.status(404).send("missing");
    return reply
      .header("content-type", "text/css; charset=utf-8")
      .header("cache-control", "no-cache")
      .send(WEB_STYLES);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /api — programmatic landing (links + snapshot for tooling)
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/api", async (_req, reply) => {
    const providerStatus = getProviderStatus();
    const agents = v2.listDuxAgents();
    const authNote = network.auth_required
      ? `<p class="warn">Auth is <strong>required</strong>. Send <code>Authorization: Bearer &lt;token&gt;</code>.</p>`
      : `<p class="ok">Loopback-only — no token required.</p>`;
    const agentList = agents.map(a =>
      `<li><code>${a.id}</code> ${a.provider ? `(${a.provider}/${a.model ?? "?"})` : "(default)"}</li>`
    ).join("");
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cursus · API map</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; }
  h1 { margin: 0 0 .25rem; }
  .sub { color: #888; margin-top: 0; }
  .grid { display: grid; grid-template-columns: max-content 1fr; gap: .35rem 1rem; margin: 1rem 0; }
  code { background: rgba(127,127,127,.15); padding: .1rem .3rem; border-radius: 3px; }
  .ok   { color: #1a7f1a; } .warn { color: #b86c00; }
  ul.routes li { margin: .2rem 0; }
  a.btn { display: inline-block; padding: .35rem .7rem; border: 1px solid rgba(127,127,127,.35); border-radius: 4px; text-decoration: none; margin: .15rem .25rem .15rem 0; }
  hr { border: none; border-top: 1px solid rgba(127,127,127,.25); margin: 1.5rem 0; }
  footer { color: #888; font-size: 13px; }
</style></head><body>
<h1>Cursus · API map</h1>
<p class="sub">Programmatic endpoints — v${CURSUS_VERSION} (schema v${CURSUS_SCHEMA_VERSION}). For the interactive UI, go to <a href="/">/</a>.</p>
<div class="grid">
  <div>Mode</div>           <div><code>standalone</code></div>
  <div>Bind</div>           <div><code>${network.host}:${network.port}</code> · <code>${network.exposure}</code></div>
  <div>Auth required</div>  <div>${network.auth_required ? "yes" : "no"}</div>
  <div>Provider</div>       <div><code>${providerStatus.provider}</code> / <code>${providerStatus.model}</code> ${providerStatus.local ? "(local)" : "(cloud)"} · ${providerStatus.configured ? "configured" : "<span class=\"warn\">not configured</span>"}</div>
  <div>Local-only</div>     <div>${providerStatus.local_only_mode ? "yes" : "no"}</div>
  <div>Dux agents</div>     <div>${agents.length} seeded (${agents.filter(a => a.provider || a.model).length} with overrides)</div>
</div>
${authNote}
<p>JSON endpoints:</p>
<a class="btn" href="/health">/health</a>
<a class="btn" href="/version">/version</a>
<a class="btn" href="/status">/status</a>
<a class="btn" href="/cursus/provider">/cursus/provider</a>
<a class="btn" href="/cursus/dux/agents">/cursus/dux/agents</a>
<a class="btn" href="/cursus/dashboard">/cursus/dashboard</a>
<a class="btn" href="/cursus/receipts">/cursus/receipts</a>
<h2>Dux agents</h2>
<ul class="routes">${agentList}</ul>
<hr>
<footer>UI: <a href="/">/</a> · Setup: <code>pnpm run cursus:setup</code> · Verify: <code>./scripts/verify-standalone.sh</code></footer>
</body></html>`;
    return reply.header("content-type", "text/html; charset=utf-8").send(html);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Health + Version + Status
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/health", async (_req, reply) => {
    const dbReachable = v1.isReachable();
    const dbSchemaVersion = v1.getSchemaVersion();
    const schemaMatch = dbSchemaVersion === CURSUS_SCHEMA_VERSION;

    if (!dbReachable) {
      return reply.status(503).send({
        ok: false,
        status: "degraded",
        service: "cursus",
        version: CURSUS_VERSION,
        db: { reachable: false, path: v1.getDbPath() },
        uptime: process.uptime(),
      });
    }

    try {
      const dashboard = v2.getDashboard();
      const onboarding = v2.getOnboarding();
      return reply.send({
        ok: true,
        status: schemaMatch ? "healthy" : "healthy_schema_drift",
        service: "cursus",
        version: CURSUS_VERSION,
        db: {
          reachable: true,
          path: v1.getDbPath(),
          schema_version: dbSchemaVersion,
          expected_schema_version: CURSUS_SCHEMA_VERSION,
          schema_match: schemaMatch,
        },
        totalApplications: dashboard.totalApplications,
        activeCampaign: dashboard.activeCampaign?.name ?? null,
        pendingOutreach: dashboard.pendingOutreach,
        onboarded: !!onboarding?.completed,
        uptime: process.uptime(),
      });
    } catch (err) {
      return reply.status(503).send({
        ok: false,
        status: "degraded",
        service: "cursus",
        version: CURSUS_VERSION,
        db: { reachable: true, path: v1.getDbPath(), schema_version: dbSchemaVersion },
        error: String(err).slice(0, 200),
        uptime: process.uptime(),
      });
    }
  });

  server.get("/version", async (_req, reply) => {
    return reply.send({
      service: "cursus",
      version: CURSUS_VERSION,
      schema_version: CURSUS_SCHEMA_VERSION,
      node: process.version,
      uptime: process.uptime(),
    });
  });

  server.get("/status", async (_req, reply) => {
    const activeCampaign = v2.getActiveCampaign();
    const onboarding = v2.getOnboarding();
    const lastScoutReceipts = v2.listReceipts(1, "job_scout_run");
    const providerStatus = getProviderStatus();
    const agents = v2.listDuxAgents();
    const openrouterEnvKeySet = !!(process.env["CURSUS_OPENROUTER_API_KEY"] ?? "");
    const globalOpenRouterConfigured = providerStatus.provider === "openrouter" && providerStatus.configured;
    const agentOpenRouterConfigured = agents.some(a => a.provider === "openrouter" && !!a.api_key && !!a.model);
    return reply.send({
      ok: true,
      mode: "standalone",
      bridge_enabled: !!CURSUS_BRIDGE_URL,
      // ── Network exposure ──
      host: network.host,
      port: network.port,
      network_exposure: network.exposure,
      auth_required: network.auth_required,
      auth_token_configured: network.auth_token_configured,
      // ── Provider/model recap ──
      provider: providerStatus.provider,
      provider_label: providerStatus.provider_label,
      model: providerStatus.model,
      provider_mode: providerStatus.local ? "local" : `cloud:${providerStatus.provider}`,
      provider_configured: providerStatus.configured,
      local_only_mode: providerStatus.local_only_mode,
      // ── OpenRouter ──
      openrouter_configured: globalOpenRouterConfigured || agentOpenRouterConfigured || openrouterEnvKeySet,
      openrouter_source: globalOpenRouterConfigured ? "global" : agentOpenRouterConfigured ? "agent" : openrouterEnvKeySet ? "env" : null,
      openrouter_env_key_set: openrouterEnvKeySet,
      // ── Dux agents summary ──
      dux_agents: {
        total: agents.length,
        enabled: agents.filter(a => a.enabled === 1).length,
        with_overrides: agents.filter(a => a.provider || a.model).length,
        agents: agents.map(a => ({
          id: a.id,
          enabled: a.enabled === 1,
          provider: a.provider ?? null,
          model: a.model ?? null,
          local_only: a.local_only === 1,
          cloud_allowed: a.cloud_allowed !== 0,
        })),
      },
      // ── Existing ──
      automation_mode: CURSUS_AUTOMATION_MODE,
      active_campaign: activeCampaign
        ? { id: activeCampaign.id, name: activeCampaign.name, target_role: activeCampaign.target_role }
        : null,
      onboarding_complete: !!onboarding?.completed,
      receipts_enabled: true,
      velum_enabled: true,
      last_job_scout_run: lastScoutReceipts[0]?.timestamp ?? null,
      pending_approvals: v2.countPendingAutomation(),
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Onboarding
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/cursus/onboarding", async (_req, reply) => {
    const state = v2.getOnboarding();
    return reply.send({ ok: true, onboarding: state, provider: getProviderMeta() });
  });

  server.post<{ Body: Record<string, unknown> }>("/cursus/onboarding", async (req, reply) => {
    const updated = v2.updateOnboarding(req.body ?? {});
    return reply.send({ ok: true, onboarding: updated });
  });

  server.post("/cursus/onboarding/clear", async (_req, reply) => {
    return reply.send({ ok: true, onboarding: v2.clearOnboarding() });
  });

  server.post("/cursus/onboarding/complete", async (_req, reply) => {
    const state = v2.getOnboarding();
    if (!state.name) {
      return reply.status(400).send({ ok: false, error: "Name is required before completing onboarding" });
    }

    const completed = v2.completeOnboarding();

    // Sync name/title/location to V1 profile if present.
    // Title: only set from preferred_titles when profile has no meaningful title already.
    const profilePatch: Record<string, string> = {};
    if (state.name) profilePatch.name = state.name;
    if (state.preferred_titles) {
      const existingTitle = v1.getProfile()?.title ?? "";
      if (!existingTitle) {
        profilePatch.title = state.preferred_titles.split(/[,;]+/)[0]!.trim();
      }
    }
    if (state.preferred_locations) profilePatch.location = state.preferred_locations.split(/[,;]+/)[0]!.trim();
    if (Object.keys(profilePatch).length > 0) v1.updateProfile(profilePatch);

    // Sync target_roles to V2 profile
    if (state.preferred_titles) {
      const roles = state.preferred_titles.split(/[,;]+/).map(r => r.trim()).filter(Boolean);
      v2.updateProfileV2({ target_roles: JSON.stringify(roles) });
    }

    v2.createReceipt({
      action: "onboarding_complete",
      result_summary: `Onboarding completed. Privacy: ${state.privacy_mode}.`,
    });

    return reply.send({ ok: true, onboarding: completed });
  });

  server.post<{ Body: { text: string; tailored_for?: string } }>("/cursus/onboarding/resume", async (req, reply) => {
    const resumeText = req.body?.text ?? "";
    if (!resumeText || resumeText.length < 20) {
      return reply.status(400).send({ ok: false, error: "Resume text too short. Provide at least 20 characters." });
    }

    const velumResult = CursusV2DB.velumReview(resumeText, "resume");
    const resume = v2.createResume(velumResult.output, undefined, req.body?.tailored_for);

    v2.updateOnboarding({ resume_uploaded: true, resume_id: resume.id });

    v2.createReceipt({
      action: "resume_ingest",
      velum_reviewed: true,
      velum_redacted: velumResult.redacted,
      result_summary: `Resume ingested during onboarding (${resumeText.length} chars). Velum: ${velumResult.fields_redacted.length} fields redacted.`,
    });

    v2.createReceipt({
      action: "velum_review",
      velum_reviewed: true,
      velum_redacted: velumResult.redacted,
      result_summary: `Resume Velum review: ${velumResult.fields_redacted.length} fields redacted [${velumResult.fields_redacted.join(", ") || "none"}]`,
    });

    return reply.send({
      ok: true,
      resume,
      velum: {
        reviewed: true,
        redacted: velumResult.redacted,
        fields_redacted: velumResult.fields_redacted,
        original_length: velumResult.original_length,
        redacted_length: velumResult.redacted_length,
      },
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // V1 — Career Profile
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/cursus/profile", async (_req, reply) => reply.send({ ok: true, profile: v1.getProfile() }));

  server.patch<{ Body: Record<string, unknown> }>("/cursus/profile", async (req, reply) => {
    const body = req.body ?? {};
    const profilePatch: Record<string, unknown> = {};
    const profileFields = [
      "name", "email", "phone", "title", "summary", "location",
      "work_preference", "preferred_locations", "salary_min", "salary_max",
      "years_experience", "certifications", "skills", "links_json",
      "privacy_mode", "provider_preference",
    ];
    for (const key of profileFields) {
      if (body[key] === undefined) continue;
      profilePatch[key] = ["salary_min", "salary_max", "years_experience"].includes(key)
        ? numberOrNull(body[key])
        : body[key];
    }
    const targetRoles = listToJson(body["target_roles"]);
    if (targetRoles !== undefined) profilePatch["target_roles"] = targetRoles;
    for (const key of ["dream_job", "gap_analysis", "constraints_json", "cover_employer", "cover_role", "cover_industry", "nda_active"]) {
      if (body[key] !== undefined) profilePatch[key] = body[key];
    }
    if (Object.keys(profilePatch).length > 0) v2.updateProfileV2(profilePatch);
    const updated = v1.updateProfile(profilePatch);

    const onboardingPatch: Record<string, unknown> = {};
    if (body["name"] !== undefined) onboardingPatch["name"] = body["name"] || null;
    if (body["target_roles"] !== undefined) {
      const roles = listToJson(body["target_roles"]);
      onboardingPatch["preferred_titles"] = roles ? (JSON.parse(roles) as string[]).join(", ") : null;
    }
    for (const key of ["work_preference", "preferred_locations", "salary_min", "salary_max", "years_experience", "certifications", "privacy_mode"]) {
      if (body[key] !== undefined) {
        onboardingPatch[key] = ["salary_min", "salary_max", "years_experience"].includes(key)
          ? numberOrNull(body[key])
          : body[key] || null;
      }
    }
    if (Object.keys(onboardingPatch).length > 0) v2.updateOnboarding(onboardingPatch);
    return reply.send({ ok: true, profile: updated, profile_v2: v2.getProfileV2(), onboarding: v2.getOnboarding() });
  });

  server.post("/cursus/profile/clear", async (_req, reply) => {
    const profile = v1.clearProfile();
    const onboarding = v2.clearOnboarding();
    return reply.send({ ok: true, profile, onboarding });
  });

  server.delete("/cursus/profile", async (_req, reply) => {
    const profile = v1.clearProfile();
    const onboarding = v2.clearOnboarding();
    return reply.send({ ok: true, profile, onboarding });
  });

  server.get("/cursus/experience", async (_req, reply) => reply.send({ ok: true, experience: v1.listExperience() }));

  server.post<{ Body: { company: string; role: string; start_date: string; end_date?: string; description: string; highlights?: string[]; is_current?: boolean } }>("/cursus/experience", async (req, reply) => {
    const entry = v1.addExperience({ ...req.body, highlights: req.body.highlights ?? [], is_current: req.body.is_current ?? false, end_date: req.body.end_date ?? null });
    return reply.status(201).send({ ok: true, entry });
  });

  server.get("/cursus/certifications", async (_req, reply) => reply.send({ ok: true, certifications: v1.listCertifications() }));

  server.patch<{ Params: { id: string }; Body: Partial<{ status: "complete" | "in_progress" | "planned"; date_completed: string | null; notes: string }> }>("/cursus/certifications/:id", async (req, reply) => {
    const updated = v1.updateCertification(parseInt(req.params.id), req.body);
    if (!updated) return reply.status(404).send({ error: "Certification not found" });
    return reply.send({ ok: true, certification: updated });
  });

  server.get("/cursus/projects", async (_req, reply) => reply.send({ ok: true, projects: v1.listProjects() }));

  server.post<{ Body: { name: string; tagline: string; description: string; tech_stack?: string[]; status?: string; portfolio_worthy?: boolean; resume_bullet: string; archivum_entry_id?: string } }>("/cursus/projects", async (req, reply) => {
    const project = v1.addProject({ ...req.body, tech_stack: req.body.tech_stack ?? [], status: (req.body.status ?? "active") as "active" | "complete" | "vision", portfolio_worthy: req.body.portfolio_worthy ?? true, archivum_entry_id: req.body.archivum_entry_id ?? null });
    return reply.status(201).send({ ok: true, project });
  });

  server.get("/cursus/skills", async (_req, reply) => reply.send({ ok: true, skills: v1.listSkills() }));

  server.get("/cursus/export/resume", async (_req, reply) => {
    const text = v1.exportResume();
    return reply.header("Content-Type", "text/plain").send(text);
  });

  server.get("/cursus/export/portfolio", async (_req, reply) => {
    const text = v1.exportPortfolio();
    return reply.header("Content-Type", "text/markdown").send(text);
  });

  server.get("/cursus/products", async (_req, reply) => reply.send({ ok: true, products: v1.listProducts() }));

  server.post<{ Body: Omit<CursusProduct, "id"> }>("/cursus/products", async (req, reply) => {
    const product = v1.addProduct(req.body);
    return reply.send({ ok: true, product });
  });

  server.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/cursus/products/:id", async (req, reply) => {
    const updated = v1.updateProduct(parseInt(req.params.id), req.body);
    if (!updated) return reply.status(404).send({ ok: false, error: "Product not found" });
    return reply.send({ ok: true, product: updated });
  });

  server.get("/cursus/export/products", async (_req, reply) => {
    const text = v1.exportProducts();
    return reply.header("Content-Type", "text/markdown").send(text);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // V2 — Career Command Center
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/cursus/dashboard", async (_req, reply) => {
    return reply.send({ ok: true, dashboard: v2.getDashboard() });
  });

  // Campaigns
  server.get("/cursus/campaigns", async (_req, reply) => {
    return reply.send({ ok: true, campaigns: v2.listCampaigns() });
  });

  server.delete("/cursus/campaigns", async (_req, reply) => {
    return reply.send({ ok: true, cleared: v2.clearCampaigns() });
  });

  server.post<{ Body: { name: string; target_role: string } }>("/cursus/campaigns", async (req, reply) => {
    const { name, target_role } = req.body ?? {};
    if (!name || !target_role) return reply.status(400).send({ ok: false, error: "name and target_role required" });
    const campaign = v2.createCampaign(name, target_role);
    v2.createReceipt({
      action: "campaign_create",
      campaign_id: campaign.id,
      result_summary: `Created campaign "${campaign.name}" targeting "${campaign.target_role}"`,
    });
    return reply.send({ ok: true, campaign });
  });

  server.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/cursus/campaigns/:id", async (req, reply) => {
    return reply.send({ ok: true, campaign: v2.updateCampaign(req.params.id, req.body ?? {}) });
  });

  server.post<{ Params: { id: string } }>("/cursus/campaigns/:id/close", async (req, reply) => {
    const closed = v2.closeCampaign(req.params.id);
    if (!closed) return reply.status(404).send({ ok: false, error: "Campaign not found" });
    v2.createReceipt({
      action: "campaign_close",
      campaign_id: closed.id,
      result_summary: `Closed campaign "${closed.name}"`,
    });
    return reply.send({ ok: true, campaign: closed });
  });

  // Applications
  server.get("/cursus/applications", async (req, reply) => {
    const cid = (req.query as Record<string, string>).campaign_id;
    return reply.send({ ok: true, applications: v2.listApplications(cid || undefined) });
  });

  server.delete("/cursus/applications", async (_req, reply) => {
    return reply.send({ ok: true, cleared: v2.clearApplications() });
  });

  server.post<{ Body: { campaign_id: string; company: string; role: string; url?: string; salary_range?: string; match_score?: number; notes?: string; source?: string; location?: string; remote?: string } }>("/cursus/applications", async (req, reply) => {
    const { campaign_id, company, role } = req.body ?? {};
    if (!campaign_id || !company || !role) return reply.status(400).send({ ok: false, error: "campaign_id, company, and role required" });
    const application = v2.createApplication(req.body);
    v2.createReceipt({
      action: "application_persist",
      campaign_id,
      result_summary: `Added application: ${company} — ${role}`,
    });
    return reply.send({ ok: true, application });
  });

  server.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/cursus/applications/:id", async (req, reply) => {
    const updated = v2.updateApplication(req.params.id, req.body ?? {});
    if (updated) {
      v2.createReceipt({
        action: "application_update",
        campaign_id: updated.campaign_id,
        result_summary: `Updated application ${updated.company} — ${updated.role}: ${JSON.stringify(req.body).slice(0, 100)}`,
      });
    }
    return reply.send({ ok: true, application: updated });
  });

  // Resumes
  server.get("/cursus/resumes", async (_req, reply) => {
    return reply.send({ ok: true, resumes: v2.listResumes() });
  });

  server.delete("/cursus/resumes", async (_req, reply) => {
    const cleared = v2.clearResumes();
    v2.updateOnboarding({ resume_uploaded: false, resume_id: null });
    return reply.send({ ok: true, cleared });
  });

  server.post<{ Body: { base_resume: string; profile_version?: number; tailored_for?: string } }>("/cursus/resumes/generate", async (req, reply) => {
    const { base_resume } = req.body ?? {};
    if (!base_resume) return reply.status(400).send({ ok: false, error: "base_resume required" });
    return reply.send({ ok: true, resume: v2.createResume(base_resume, req.body.profile_version, req.body.tailored_for) });
  });

  server.post<{ Body: { text?: string; tailored_for?: string } }>("/cursus/resumes/upload", async (req, reply) => {
    const resumeText = req.body?.text ?? "";
    if (!resumeText || resumeText.length < 20) {
      return reply.status(400).send({ ok: false, error: "Resume text too short. Provide at least 20 characters." });
    }
    const velumResult = CursusV2DB.velumReview(resumeText, "resume");
    const resume = v2.createResume(velumResult.output, undefined, req.body?.tailored_for);
    v2.createReceipt({
      action: "velum_review",
      velum_reviewed: true,
      velum_redacted: velumResult.redacted,
      result_summary: `Resume uploaded (${resumeText.length} chars). Velum: ${velumResult.fields_redacted.length} fields redacted.`,
    });
    return reply.send({ ok: true, resume, extractedLength: resumeText.length, velum: { reviewed: true, redacted: velumResult.redacted, fields_redacted: velumResult.fields_redacted } });
  });

  // Outreach (stealth enforced)
  server.get("/cursus/outreach", async (req, reply) => {
    const status = (req.query as Record<string, string>).status;
    return reply.send({ ok: true, outreach: v2.listOutreach(status as any || undefined) });
  });

  server.post<{ Body: { application_id?: string; type: string; subject: string; body: string } }>("/cursus/outreach/stage", async (req, reply) => {
    const { type, subject, body: bodyText } = req.body ?? {};
    if (!type || !subject || !bodyText) return reply.status(400).send({ ok: false, error: "type, subject, and body required" });
    const velumResult = CursusV2DB.velumReview(bodyText, "outreach");
    const outreach = v2.stageOutreach({ ...req.body, body: velumResult.output } as any);
    v2.createReceipt({
      action: "outreach_generate",
      velum_reviewed: true,
      velum_redacted: velumResult.redacted,
      result_summary: `Staged ${type}: "${subject}" (velum: ${velumResult.fields_redacted.length} redacted)`,
    });
    return reply.send({ ok: true, outreach, velum: { reviewed: true, redacted: velumResult.redacted, fields_redacted: velumResult.fields_redacted } });
  });

  server.post<{ Params: { id: string } }>("/cursus/outreach/:id/approve", async (req, reply) => {
    const result = v2.approveOutreach(req.params.id);
    if (!result) return reply.status(400).send({ ok: false, error: "Can only approve staged outreach" });
    v2.createReceipt({ action: "outreach_approve", result_summary: `Approved outreach: "${result.subject}"` });
    return reply.send({ ok: true, outreach: result });
  });

  server.post<{ Params: { id: string } }>("/cursus/outreach/:id/reject", async (req, reply) => {
    const ok = v2.rejectOutreach(req.params.id);
    if (!ok) return reply.status(400).send({ ok: false, error: "Can only reject staged outreach" });
    v2.createReceipt({ action: "outreach_reject", result_summary: `Rejected outreach ${req.params.id}` });
    return reply.send({ ok: true });
  });

  // Dux sessions
  server.get("/cursus/dux/sessions", async (_req, reply) => {
    return reply.send({ ok: true, sessions: v2.listDuxSessions() });
  });

  server.post<{ Body: { session_type?: string; type?: string } }>("/cursus/dux/sessions", async (req, reply) => {
    return reply.send({ ok: true, session: v2.createDuxSession((req.body?.session_type ?? req.body?.type ?? "checkin") as any) });
  });

  /**
   * Resolve the effective ProviderConfig for an agent — agent overrides win
   * over the in-process default. Returns the config plus the agent's
   * additional constraints (cloud_allowed, local_only).
   */
  function effectiveAgentConfig(agent: DuxAgent | null): {
    cfg: ProviderConfig;
    agent_local_only: boolean;
    agent_cloud_allowed: boolean;
    using_fallback: boolean;
  } {
    const base = getProviderConfig();
    const cfg: ProviderConfig = { ...base };
    if (agent) {
      if (agent.provider)          cfg.provider = agent.provider;
      if (agent.model)             cfg.model    = agent.model;
      if (agent.base_url)          cfg.base_url = agent.base_url;
      else if (agent.provider && PROVIDER_REGISTRY[agent.provider]?.default_base_url && !base.base_url) {
        cfg.base_url = PROVIDER_REGISTRY[agent.provider]!.default_base_url!;
      }
      if (agent.api_key)           cfg.api_key  = agent.api_key;
      if (agent.local_only === 1)  cfg.local_only = true;
    }
    const agent_local_only    = agent?.local_only === 1;
    const agent_cloud_allowed = agent?.cloud_allowed !== 0; // null/1 = allowed; 0 = blocked
    return { cfg, agent_local_only, agent_cloud_allowed, using_fallback: false };
  }

  /**
   * Run a Dux chat turn. Single implementation used by both the legacy
   * /cursus/dux/chat (with optional body.agent_id) and the agent-scoped
   * /cursus/dux/agents/:agentId/chat endpoint.
   */
  async function runDuxChat(
    body: {
      session_id?: string;
      message?: string;
      messages?: ChatMessage[];
      system?: string;
      max_tokens?: number;
      temperature?: number;
      velum?: boolean;
      agent_id?: string;
    },
    explicitAgent: DuxAgent | null,
  ): Promise<{ status: number; payload: Record<string, unknown> }> {
    const agent = explicitAgent ?? (body.agent_id ? v2.getDuxAgent(body.agent_id) : null);
    if (body.agent_id && !agent) {
      return { status: 404, payload: { ok: false, error: `Dux agent not found: ${body.agent_id}` } };
    }
    if (agent && agent.enabled !== 1) {
      return { status: 400, payload: { ok: false, error: `Dux agent "${agent.id}" is disabled` } };
    }

    const userText = (body.message ?? "").toString();
    const explicitMessages = Array.isArray(body.messages) ? body.messages : null;
    if (!explicitMessages && !userText.trim()) {
      return { status: 400, payload: { ok: false, error: "message or messages required" } };
    }

    // Velum: Dux conversations touch career/profile data by definition. Default ON.
    const velumOn = body.velum !== false;
    const messages: ChatMessage[] = [];
    const systemPrompt = body.system ?? agent?.system_prompt ?? null;
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });

    const fieldsRedacted: string[] = [];
    let redacted = false;
    if (explicitMessages) {
      for (const m of explicitMessages) {
        if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") continue;
        let content = String(m.content ?? "");
        if (velumOn && m.role === "user") {
          const vr = CursusV2DB.velumReview(content, "dux_chat");
          content = vr.output;
          if (vr.redacted) { redacted = true; for (const f of vr.fields_redacted) if (!fieldsRedacted.includes(f)) fieldsRedacted.push(f); }
        }
        messages.push({ role: m.role, content });
      }
    } else {
      let content = userText;
      if (velumOn) {
        const vr = CursusV2DB.velumReview(content, "dux_chat");
        content = vr.output;
        if (vr.redacted) { redacted = true; fieldsRedacted.push(...vr.fields_redacted); }
      }
      messages.push({ role: "user", content });
    }

    if (velumOn) {
      v2.createReceipt({
        action: "velum_review",
        velum_reviewed: true,
        velum_redacted: redacted,
        dux_agent_id: agent?.id ?? null,
        result_summary: `Dux ${agent?.id ?? "chat"} Velum review: ${fieldsRedacted.length} fields redacted [${fieldsRedacted.join(", ") || "none"}]`,
      });
    }

    const eff = effectiveAgentConfig(agent);
    let cfg = eff.cfg;
    let usingFallback = false;

    // Per-agent guard: cloud_allowed=0 blocks cloud providers for this agent.
    if (!eff.agent_cloud_allowed && !providerIsLocal(cfg.provider)) {
      // If agent has a fallback configured, switch to it; otherwise reject.
      if (agent?.fallback_provider) {
        cfg = { ...cfg, provider: agent.fallback_provider, model: agent.fallback_model ?? cfg.model };
        if (PROVIDER_REGISTRY[cfg.provider]?.default_base_url && !cfg.base_url) {
          cfg = { ...cfg, base_url: PROVIDER_REGISTRY[cfg.provider]!.default_base_url! };
        }
        usingFallback = true;
        if (!providerIsLocal(cfg.provider)) {
          return { status: 403, payload: { ok: false, code: "agent_cloud_blocked",
            error: `Dux agent "${agent.id}" has cloud_allowed=false and its fallback "${cfg.provider}" is also cloud. Configure a local fallback.` } };
        }
      } else {
        return { status: 403, payload: { ok: false, code: "agent_cloud_blocked",
          error: `Dux agent "${agent?.id}" has cloud_allowed=false but the selected provider "${cfg.provider}" is cloud. Configure a local provider for this agent or set fallback_provider.` } };
      }
    }

    try {
      const chatReq: { messages: ChatMessage[]; max_tokens?: number; temperature?: number } = {
        messages,
      };
      const maxTokens = body.max_tokens ?? agent?.max_tokens ?? undefined;
      const temperature = body.temperature ?? agent?.temperature ?? undefined;
      if (maxTokens !== undefined && maxTokens !== null) chatReq.max_tokens = maxTokens;
      if (temperature !== undefined && temperature !== null) chatReq.temperature = temperature;

      const result = await providerChat(chatReq, cfg);
      v2.createReceipt({
        action: agent ? "dux_agent_chat" : "model_call",
        provider: result.provider,
        model: result.model,
        local_mode: result.local,
        velum_reviewed: velumOn,
        velum_redacted: redacted,
        dux_agent_id: agent?.id ?? null,
        result_summary: `Dux ${agent ? agent.id : "chat"}: ${result.provider}/${result.model} (${result.content.length} chars${result.finish_reason ? `, ${result.finish_reason}` : ""})${usingFallback ? " [fallback]" : ""}`,
      });
      return {
        status: 200,
        payload: {
          ok: true,
          reply: result.content,
          agent: agent ? { id: agent.id, display_name: agent.display_name } : null,
          provider: { provider: result.provider, model: result.model, local: result.local, fallback_used: usingFallback },
          velum: velumOn ? { reviewed: true, redacted, fields_redacted: fieldsRedacted } : { reviewed: false },
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.finish_reason ? { finish_reason: result.finish_reason } : {}),
        },
      };
    } catch (err) {
      const isProviderErr = err instanceof ProviderError;
      const status = isProviderErr ? err.statusCode : 502;
      const code = isProviderErr ? err.code : "provider_call_failed";
      const msg = err instanceof Error ? err.message : String(err);
      v2.createReceipt({
        action: agent ? "dux_agent_chat" : "model_call",
        provider: cfg.provider,
        model: cfg.model,
        local_mode: providerIsLocal(cfg.provider),
        velum_reviewed: velumOn,
        velum_redacted: redacted,
        dux_agent_id: agent?.id ?? null,
        result_summary: `Dux ${agent ? agent.id : "chat"} failed: ${code}`,
        errors: msg.slice(0, 500),
      });
      void usingFallback;
      return {
        status,
        payload: {
          ok: false,
          error: msg,
          code,
          agent: agent ? { id: agent.id, display_name: agent.display_name } : null,
          provider: { provider: cfg.provider, model: cfg.model, local: providerIsLocal(cfg.provider) },
          hint: cfg.provider === "none"
            ? "Configure a provider: set CURSUS_PROVIDER and CURSUS_MODEL, or POST /cursus/provider with {provider, model}."
            : undefined,
        },
      };
    }
  }

  server.post<{ Body: {
    session_id?: string;
    message?: string;
    messages?: ChatMessage[];
    system?: string;
    max_tokens?: number;
    temperature?: number;
    velum?: boolean;
    agent_id?: string;
  } }>("/cursus/dux/chat", async (req, reply) => {
    const result = await runDuxChat(req.body ?? {}, null);
    return reply.status(result.status).send(result.payload);
  });

  // ───── Dux agent registry ──────────────────────────────────────────────────

  server.get("/cursus/dux/agents", async (_req, reply) => {
    const agents = v2.listDuxAgents().map(a => CursusV2DB.sanitizeDuxAgent(a));
    return reply.send({ ok: true, agents, default_provider: getProviderStatus() });
  });

  server.get<{ Params: { id: string } }>("/cursus/dux/agents/:id", async (req, reply) => {
    const agent = v2.getDuxAgent(req.params.id);
    if (!agent) return reply.status(404).send({ ok: false, error: `Dux agent not found: ${req.params.id}` });
    return reply.send({ ok: true, agent: CursusV2DB.sanitizeDuxAgent(agent), default_provider: getProviderStatus() });
  });

  const patchAgent = async (
    req: { params: { id: string }; body?: Record<string, unknown> | null },
    reply: { status: (n: number) => { send: (b: unknown) => unknown }; send: (b: unknown) => unknown },
  ) => {
    const b = req.body ?? {};
    const id = req.params.id;
    const existing = v2.getDuxAgent(id);
    if (!existing) return reply.status(404).send({ ok: false, error: `Dux agent not found: ${id}` });

    // Validate provider if supplied.
    if (typeof b["provider"] === "string" && !PROVIDER_REGISTRY[(b["provider"] as string).toLowerCase()]) {
      return reply.status(400).send({ ok: false, code: "unknown_provider",
        error: `Unknown provider "${b["provider"]}". Available: ${Object.keys(PROVIDER_REGISTRY).join(", ")}.` });
    }
    if (typeof b["fallback_provider"] === "string" && b["fallback_provider"] !== "" &&
        !PROVIDER_REGISTRY[(b["fallback_provider"] as string).toLowerCase()]) {
      return reply.status(400).send({ ok: false, code: "unknown_provider",
        error: `Unknown fallback provider "${b["fallback_provider"]}".` });
    }
    // Local-only contradiction: agent local_only=1 with cloud provider.
    const nextProvider = (typeof b["provider"] === "string" ? (b["provider"] as string).toLowerCase() : existing.provider) ?? null;
    const nextLocalOnly = (typeof b["local_only"] === "boolean" ? (b["local_only"] ? 1 : 0)
      : typeof b["local_only"] === "number" ? (b["local_only"] ? 1 : 0) : existing.local_only);
    if (nextLocalOnly === 1 && nextProvider && !PROVIDER_REGISTRY[nextProvider]?.local) {
      return reply.status(400).send({ ok: false, code: "local_only_violation",
        error: `Cannot set local_only=true on agent "${id}" with cloud provider "${nextProvider}".` });
    }
    // Global local_only blocks cloud per-agent providers too.
    if (getProviderConfig().local_only && nextProvider && !PROVIDER_REGISTRY[nextProvider]?.local) {
      return reply.status(400).send({ ok: false, code: "local_only_violation",
        error: `Global CURSUS_LOCAL_ONLY=true blocks cloud provider "${nextProvider}" for agent "${id}".` });
    }

    const patch: Partial<DuxAgent> = {};
    const passthrough = ["display_name", "role", "provider", "model", "base_url", "api_key",
      "temperature", "max_tokens", "system_prompt", "fallback_provider", "fallback_model"];
    for (const k of passthrough) {
      if (b[k] !== undefined) (patch as Record<string, unknown>)[k] = b[k];
    }
    for (const k of ["enabled", "local_only", "cloud_allowed"]) {
      if (b[k] !== undefined) {
        const v = b[k];
        (patch as Record<string, unknown>)[k] = typeof v === "boolean" ? (v ? 1 : 0) : v === null ? null : Number(v) ? 1 : 0;
      }
    }
    const updated = v2.updateDuxAgent(id, patch);
    v2.createReceipt({
      action: "dux_agent_update",
      dux_agent_id: id,
      provider: updated?.provider ?? null,
      model: updated?.model ?? null,
      local_mode: updated?.local_only === 1 || (updated?.provider ? PROVIDER_REGISTRY[updated.provider]?.local ?? false : true),
      result_summary: `Dux agent ${id} updated: ${Object.keys(patch).join(", ") || "(no changes)"}`,
    });
    return reply.send({ ok: true, agent: updated ? CursusV2DB.sanitizeDuxAgent(updated) : null });
  };
  server.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/cursus/dux/agents/:id", patchAgent as never);
  server.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/cursus/dux/agents/:id/provider", patchAgent as never);

  server.post<{ Params: { id: string }; Body: {
    session_id?: string;
    message?: string;
    messages?: ChatMessage[];
    system?: string;
    max_tokens?: number;
    temperature?: number;
    velum?: boolean;
  } }>("/cursus/dux/agents/:id/chat", async (req, reply) => {
    const agent = v2.getDuxAgent(req.params.id);
    if (!agent) return reply.status(404).send({ ok: false, error: `Dux agent not found: ${req.params.id}` });
    const result = await runDuxChat(req.body ?? {}, agent);
    return reply.status(result.status).send(result.payload);
  });

  // Profile V2 extensions
  server.get("/cursus/profile/v2", async (_req, reply) => {
    return reply.send({ ok: true, profile: v2.getProfileV2() });
  });

  server.patch<{ Body: Record<string, unknown> }>("/cursus/profile/v2", async (req, reply) => {
    v2.updateProfileV2(req.body ?? {});
    return reply.send({ ok: true, profile: v2.getProfileV2() });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Analytics
  // ═══════════════════════════════════════════════════════════════════════════

  server.get<{ Params: { id: string } }>("/cursus/analytics/campaign/:id", async (req, reply) => {
    const analytics = v2.getCampaignAnalytics(req.params.id);
    if (!analytics) return reply.status(404).send({ ok: false, error: "Campaign not found" });
    v2.createReceipt({
      action: "insight_generate",
      campaign_id: req.params.id,
      local_mode: true,
      result_summary: `Generated ${analytics.insights.length} insights for campaign "${analytics.campaign_name}"`,
    });
    return reply.send({ ok: true, analytics });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Automation Queue
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/cursus/automation", async (req, reply) => {
    const status = (req.query as Record<string, string>).status as AutomationStatus | undefined;
    return reply.send({ ok: true, tasks: v2.listAutomationTasks(status || undefined), mode: CURSUS_AUTOMATION_MODE });
  });

  server.delete("/cursus/automation", async (_req, reply) => {
    return reply.send({ ok: true, cleared: v2.clearAutomation() });
  });

  server.post<{ Body: { kind: string; title: string; detail?: string; campaign_id?: string; application_id?: string; schedule?: string } }>("/cursus/automation", async (req, reply) => {
    const { kind, title } = req.body ?? {};
    if (!kind || !title) return reply.status(400).send({ ok: false, error: "kind and title required" });
    const task = v2.createAutomationTask(req.body as any);
    v2.createReceipt({
      action: "automation_create",
      campaign_id: req.body.campaign_id,
      result_summary: `Automation task created: "${title}" (${kind})`,
    });
    return reply.send({ ok: true, task });
  });

  server.post<{ Params: { id: string } }>("/cursus/automation/:id/approve", async (req, reply) => {
    const resolved = v2.resolveAutomationTask(req.params.id, "approved");
    if (!resolved) return reply.status(400).send({ ok: false, error: "Cannot approve this task (invalid state)" });
    v2.createReceipt({
      action: "automation_approve",
      campaign_id: resolved.campaign_id,
      result_summary: `Approved automation: "${resolved.title}"`,
    });
    return reply.send({ ok: true, task: resolved });
  });

  server.post<{ Params: { id: string } }>("/cursus/automation/:id/reject", async (req, reply) => {
    const resolved = v2.resolveAutomationTask(req.params.id, "rejected");
    if (!resolved) return reply.status(400).send({ ok: false, error: "Cannot reject this task (invalid state)" });
    v2.createReceipt({
      action: "automation_reject",
      campaign_id: resolved.campaign_id,
      result_summary: `Rejected automation: "${resolved.title}"`,
    });
    return reply.send({ ok: true, task: resolved });
  });

  server.post<{ Params: { id: string } }>("/cursus/automation/:id/execute", async (req, reply) => {
    const resolved = v2.resolveAutomationTask(req.params.id, "executed");
    if (!resolved) return reply.status(400).send({ ok: false, error: "Can only execute approved tasks" });
    v2.createReceipt({
      action: "automation_execute",
      campaign_id: resolved.campaign_id,
      result_summary: `Executed automation: "${resolved.title}"`,
    });
    return reply.send({ ok: true, task: resolved });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Velum (review/redact)
  // ═══════════════════════════════════════════════════════════════════════════

  server.post<{ Body: { text: string; context?: string } }>("/cursus/velum/review", async (req, reply) => {
    const { text, context } = req.body ?? {};
    if (!text) return reply.status(400).send({ ok: false, error: "text required" });
    const result = CursusV2DB.velumReview(text, context);
    v2.createReceipt({
      action: "velum_review",
      velum_reviewed: true,
      velum_redacted: result.redacted,
      result_summary: `Velum review (${context ?? "general"}): ${result.fields_redacted.length} fields redacted`,
    });
    return reply.send({ ok: true, velum: result });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Receipts
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/cursus/receipts", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const limit = parseInt(q.limit ?? "50", 10);
    const action = q.action as ReceiptAction | undefined;
    return reply.send({ ok: true, receipts: v2.listReceipts(limit, action) });
  });

  server.delete("/cursus/receipts", async (_req, reply) => {
    return reply.send({ ok: true, cleared: v2.clearReceipts() });
  });

  server.post<{ Body: { keep_provider_config?: boolean; dry_run?: boolean } }>("/cursus/reset", async (req, reply) => {
    if (req.body?.dry_run) {
      return reply.send({
        ok: true,
        dry_run: true,
        would_clear: ["profile", "onboarding", "resumes", "campaigns", "applications", "receipts", "automation", "dux sessions"],
      });
    }
    const profile = v1.clearProfile();
    const cleared = v2.resetPersonalData({ keepProviderConfig: !!req.body?.keep_provider_config });
    return reply.send({ ok: true, cleared, profile, onboarding: v2.getOnboarding() });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Provider/Model Config
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/cursus/provider", async (_req, reply) => {
    return reply.send({ ok: true, provider: getProviderStatus() });
  });

  // Runtime selection — applied in-process, not persisted. To make persistent,
  // set CURSUS_PROVIDER/CURSUS_MODEL/CURSUS_PROVIDER_BASE_URL/CURSUS_PROVIDER_API_KEY/CURSUS_LOCAL_ONLY
  // in the systemd unit (or .env consumed by it) and restart the service.
  const applyProvider = async (
    req: { body?: Record<string, unknown> | null },
    reply: { status: (n: number) => { send: (b: unknown) => unknown }; send: (b: unknown) => unknown },
  ) => {
    const b = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (typeof b["provider"] === "string") patch["provider"] = b["provider"];
    if (typeof b["model"] === "string") patch["model"] = b["model"];
    if (typeof b["base_url"] === "string") patch["base_url"] = b["base_url"];
    if (typeof b["api_key"] === "string") patch["api_key"] = b["api_key"];
    if (typeof b["local_only"] === "boolean") patch["local_only"] = b["local_only"];
    try {
      const next = applyConfigPatch(patch);
      return reply.send({ ok: true, provider: next });
    } catch (err) {
      if (err instanceof ProviderError) {
        return reply.status(err.statusCode).send({ ok: false, error: err.message, code: err.code });
      }
      throw err;
    }
  };
  server.patch<{ Body: Record<string, unknown> }>("/cursus/provider", applyProvider as never);
  server.post<{ Body: Record<string, unknown> }>("/cursus/provider", applyProvider as never);

  // ═══════════════════════════════════════════════════════════════════════════
  // Job Scout (campaign-aware query derivation — standalone)
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/cursus/job-scout/context", async (_req, reply) => {
    const activeCampaign = v2.getActiveCampaign();
    const profileV2 = v2.getProfileV2();
    const profile = v1.getProfile();
    const onboarding = v2.getOnboarding();

    const targetRoles: string[] = [];
    if (activeCampaign?.target_role) {
      targetRoles.push(...activeCampaign.target_role.split(/[,;\n]+/).map(r => r.trim()).filter(Boolean));
    }
    if (profileV2 && typeof profileV2.target_roles === "string") {
      try {
        const parsed = JSON.parse(profileV2.target_roles as string) as string[];
        if (Array.isArray(parsed)) targetRoles.push(...parsed.filter((r: string) => !targetRoles.includes(r)));
      } catch { /* not parseable */ }
    }

    const location = profile?.location ?? onboarding?.preferred_locations?.split(/[,;]+/)[0]?.trim() ?? null;
    const remote = onboarding?.work_preference ?? null;
    const salaryMin = onboarding?.salary_min ?? null;
    const salaryMax = onboarding?.salary_max ?? null;
    const certs = onboarding?.certifications ?? null;

    return reply.send({
      ok: true,
      // Job Scout is standalone: it derives search context from local DB and
      // returns it for use by an external tool (manual or semi-manual ingestion
      // via POST /cursus/job-scout/ingest). Live external job search is not
      // implemented in-process — Cursus does not crawl boards itself.
      live_search_implemented: false,
      ingestion_mode: "manual_or_external_tool",
      context: {
        campaign_id: activeCampaign?.id ?? null,
        campaign_name: activeCampaign?.name ?? null,
        primary_target_role: activeCampaign?.target_role ?? null,
        all_target_roles: targetRoles,
        location,
        remote_preference: remote,
        salary_range: salaryMin || salaryMax ? { min: salaryMin, max: salaryMax } : null,
        certifications: certs,
        provider: getProviderMeta(),
      },
    });
  });

  server.post<{ Body: { lane_id?: string; jobs: Array<{ company: string; role: string; url?: string; salary_range?: string; match_score?: number; match_reason?: string; source?: string; location?: string; remote?: string }> } }>("/cursus/job-scout/ingest", async (req, reply) => {
    const { jobs, lane_id } = req.body ?? {};
    if (!Array.isArray(jobs) || jobs.length === 0) {
      return reply.status(400).send({ ok: false, error: "jobs array required" });
    }
    const activeCampaign = v2.getActiveCampaign();
    if (!activeCampaign) {
      return reply.status(400).send({ ok: false, error: "No active campaign to ingest jobs into" });
    }

    // Validate lane_id if provided
    if (lane_id) {
      const lane = v2.getSearchLane(lane_id);
      if (!lane) {
        return reply.status(400).send({ ok: false, error: `Search lane not found: ${lane_id}` });
      }
      if (lane.campaign_id !== activeCampaign.id) {
        return reply.status(400).send({ ok: false, error: "Search lane does not belong to the active campaign" });
      }
    }

    const persisted = [];
    const skippedDuplicates: string[] = [];
    for (const job of jobs) {
      if (!job.company || !job.role) continue;
      const fp = CursusV2DB.jobFingerprint(job.company, job.role, job.url);
      if (v2.hasFingerprint(fp)) {
        skippedDuplicates.push(`${job.company} — ${job.role}`);
        continue;
      }
      const app = v2.createApplication({
        campaign_id: activeCampaign.id,
        company: job.company,
        role: job.role,
        url: job.url,
        salary_range: job.salary_range,
        match_score: job.match_score,
        notes: job.match_reason ? `Match: ${job.match_reason}` : undefined,
        source: job.source,
        location: job.location,
        remote: job.remote,
        lane_id: lane_id,
      });
      persisted.push(app);
    }

    const provStatus = getProviderStatus();
    v2.createReceipt({
      action: "job_scout_run",
      campaign_id: activeCampaign.id,
      provider: provStatus.provider,
      model: provStatus.model,
      local_mode: provStatus.local,
      result_summary: `Job Scout ingested ${persisted.length}/${jobs.length} jobs into campaign "${activeCampaign.name}"${lane_id ? ` (lane: ${lane_id})` : ""}${skippedDuplicates.length > 0 ? `. ${skippedDuplicates.length} duplicates skipped.` : ""}`,
    });

    return reply.send({
      ok: true,
      ingested: persisted.length,
      duplicates_skipped: skippedDuplicates.length,
      campaign_id: activeCampaign.id,
      lane_id: lane_id ?? null,
      applications: persisted,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Search Lanes
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/cursus/lanes", async (req, reply) => {
    const cid = (req.query as Record<string, string>).campaign_id;
    return reply.send({ ok: true, lanes: v2.listSearchLanes(cid || undefined) });
  });

  server.get<{ Params: { id: string } }>("/cursus/lanes/:id", async (req, reply) => {
    const lane = v2.getSearchLane(req.params.id);
    if (!lane) return reply.status(404).send({ ok: false, error: "Lane not found" });
    return reply.send({ ok: true, lane });
  });

  server.post<{ Body: { campaign_id: string; name: string; target_titles?: string[]; keywords?: string[]; negative_keywords?: string[]; locations?: string[]; remote_preference?: string; source_filters?: string[]; priority?: LanePriority } }>("/cursus/lanes", async (req, reply) => {
    const { campaign_id, name } = req.body ?? {};
    if (!campaign_id || !name) return reply.status(400).send({ ok: false, error: "campaign_id and name required" });
    const lane = v2.createSearchLane(req.body);
    v2.createReceipt({ action: "campaign_create", campaign_id, result_summary: `Search lane created: "${name}" (${req.body.priority ?? "primary"})` });
    return reply.status(201).send({ ok: true, lane });
  });

  server.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/cursus/lanes/:id", async (req, reply) => {
    const updated = v2.updateSearchLane(req.params.id, req.body ?? {});
    if (!updated) return reply.status(404).send({ ok: false, error: "Lane not found" });
    return reply.send({ ok: true, lane: updated });
  });

  server.delete<{ Params: { id: string } }>("/cursus/lanes/:id", async (req, reply) => {
    const ok = v2.deleteSearchLane(req.params.id);
    if (!ok) return reply.status(404).send({ ok: false, error: "Lane not found" });
    return reply.send({ ok: true });
  });

  // Lane-aware job scout context
  server.get("/cursus/job-scout/lane-context", async (_req, reply) => {
    const activeCampaign = v2.getActiveCampaign();
    if (!activeCampaign) return reply.send({ ok: true, context: null, lanes: [] });

    const lanes = v2.getActiveSearchLanes(activeCampaign.id);
    const profile = v1.getProfile();
    const onboarding = v2.getOnboarding();

    const laneContexts = lanes.map(lane => {
      const titles = JSON.parse(lane.target_titles) as string[];
      const keywords = JSON.parse(lane.keywords) as string[];
      const negKw = JSON.parse(lane.negative_keywords) as string[];
      const locs = JSON.parse(lane.locations) as string[];
      return {
        lane_id: lane.id,
        lane_name: lane.name,
        priority: lane.priority,
        target_titles: titles,
        keywords,
        negative_keywords: negKw,
        locations: locs.length > 0 ? locs : [profile?.location ?? onboarding?.preferred_locations?.split(/[,;]+/)[0]?.trim() ?? "Remote"],
        remote_preference: lane.remote_preference ?? onboarding?.work_preference ?? null,
        search_queries: titles.flatMap(t => {
          const queries = [`${t} ${keywords.join(" ")}`.trim()];
          for (const loc of locs.length > 0 ? locs : ["remote"]) {
            queries.push(`${t} ${loc}`.trim());
          }
          return queries;
        }),
      };
    });

    return reply.send({
      ok: true,
      campaign_id: activeCampaign.id,
      campaign_name: activeCampaign.name,
      lanes: laneContexts,
      certifications: onboarding?.certifications ?? null,
      salary_range: onboarding?.salary_min || onboarding?.salary_max
        ? { min: onboarding.salary_min, max: onboarding.salary_max } : null,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Job Evaluations (A-G report)
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/cursus/evaluations", async (req, reply) => {
    const appId = (req.query as Record<string, string>).application_id;
    return reply.send({ ok: true, evaluations: v2.listJobEvaluations(appId || undefined) });
  });

  server.get<{ Params: { id: string } }>("/cursus/evaluations/:id", async (req, reply) => {
    const ev = v2.getJobEvaluation(req.params.id);
    if (!ev) return reply.status(404).send({ ok: false, error: "Evaluation not found" });
    return reply.send({ ok: true, evaluation: ev });
  });

  server.post<{ Body: { application_id: string; role_summary: string; fit_analysis: string; gap_strategy?: string; compensation_notes?: string; resume_plan?: string; interview_prep?: string; legitimacy_grade?: EvalGrade; overall_grade?: EvalGrade } }>("/cursus/evaluations", async (req, reply) => {
    const { application_id, role_summary, fit_analysis } = req.body ?? {};
    if (!application_id || !role_summary || !fit_analysis) {
      return reply.status(400).send({ ok: false, error: "application_id, role_summary, and fit_analysis required" });
    }
    const evaluation = v2.createJobEvaluation(req.body);
    v2.createReceipt({
      action: "insight_generate",
      result_summary: `Job evaluation created for application ${application_id}: overall=${req.body.overall_grade ?? "C"}, legitimacy=${req.body.legitimacy_grade ?? "C"}`,
    });
    return reply.status(201).send({ ok: true, evaluation });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Interview Story Bank
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/cursus/stories", async (_req, reply) => {
    return reply.send({ ok: true, stories: v2.listStories() });
  });

  server.get<{ Params: { id: string } }>("/cursus/stories/:id", async (req, reply) => {
    const story = v2.getStory(req.params.id);
    if (!story) return reply.status(404).send({ ok: false, error: "Story not found" });
    return reply.send({ ok: true, story });
  });

  server.post<{ Body: { title: string; format?: StoryFormat; situation: string; task: string; action: string; result: string; reflection?: string; linked_project_ids?: number[]; linked_experience_ids?: number[]; tags?: string[] } }>("/cursus/stories", async (req, reply) => {
    const { title, situation, task, action, result } = req.body ?? {};
    if (!title || !situation || !task || !action || !result) {
      return reply.status(400).send({ ok: false, error: "title, situation, task, action, and result required" });
    }
    const story = v2.createStory(req.body);
    v2.createReceipt({ action: "insight_generate", result_summary: `Interview story added: "${title}" (${req.body.format ?? "star"})` });
    return reply.status(201).send({ ok: true, story });
  });

  server.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/cursus/stories/:id", async (req, reply) => {
    const updated = v2.updateStory(req.params.id, req.body ?? {});
    if (!updated) return reply.status(404).send({ ok: false, error: "Story not found" });
    return reply.send({ ok: true, story: updated });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Follow-up Cadence
  // ═══════════════════════════════════════════════════════════════════════════

  server.get("/cursus/follow-ups/stale", async (req, reply) => {
    const days = parseInt((req.query as Record<string, string>).days ?? "7", 10);
    const stale = v2.getStaleApplications(days);
    return reply.send({ ok: true, stale_applications: stale, days });
  });

  server.post<{ Params: { id: string } }>("/cursus/applications/:id/follow-up", async (req, reply) => {
    const updated = v2.recordFollowUp(req.params.id);
    if (!updated) return reply.status(404).send({ ok: false, error: "Application not found" });
    v2.createReceipt({ action: "application_update", campaign_id: updated.campaign_id, result_summary: `Follow-up recorded for ${updated.company} — ${updated.role} (#${(updated as any).follow_up_count})` });
    return reply.send({ ok: true, application: updated });
  });

  server.post<{ Params: { id: string }; Body: { days: number } }>("/cursus/applications/:id/cadence", async (req, reply) => {
    const days = req.body?.days;
    if (!days || days < 1) return reply.status(400).send({ ok: false, error: "days >= 1 required" });
    const updated = v2.setFollowUpCadence(req.params.id, days);
    if (!updated) return reply.status(404).send({ ok: false, error: "Application not found" });
    return reply.send({ ok: true, application: updated });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Application Legitimacy
  // ═══════════════════════════════════════════════════════════════════════════

  server.patch<{ Params: { id: string }; Body: { legitimacy_tier?: string; date_first_seen?: string; date_expired?: string; apply_url_status?: string } }>("/cursus/applications/:id/legitimacy", async (req, reply) => {
    const updated = v2.updateApplicationLegitimacy(req.params.id, req.body ?? {});
    if (!updated) return reply.status(404).send({ ok: false, error: "Application not found" });
    return reply.send({ ok: true, application: updated });
  });
}
