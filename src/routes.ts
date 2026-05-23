/**
 * Cursus Standalone — Route Registration
 * ========================================
 * All /cursus/* and top-level health/version/status routes.
 * No dependency on Squidley platform services.
 */

import type { FastifyInstance } from "fastify";
import type { CursusV1DB, CursusProduct, ReceiptAction, AutomationStatus, LanePriority, EvalGrade, StoryFormat } from "./db.js";
import { CursusV2DB, CURSUS_SCHEMA_VERSION } from "./db.js";
import {
  chat as providerChat,
  getStatus as getProviderStatus,
  getConfig as getProviderConfig,
  applyConfigPatch,
  ProviderError,
  isLocalProvider as providerIsLocal,
  type ChatMessage,
} from "./provider.js";

const CURSUS_VERSION = process.env["CURSUS_VERSION"] ?? "5.0.0";
const CURSUS_PORT = parseInt(process.env["CURSUS_PORT"] ?? "18815", 10);
const CURSUS_AUTOMATION_MODE = process.env["CURSUS_AUTOMATION_MODE"] ?? "approval-required";
// Optional Squidley bridge URL — disabled by default. When unset, Cursus runs
// fully standalone and never reaches out to Squidley. Bridge is for legacy
// integrations only and is NOT required.
const CURSUS_BRIDGE_URL = process.env["CURSUS_BRIDGE_URL"] ?? process.env["SQUIDLEY_CURSUS_URL"] ?? "";

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
): void {

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
    return reply.send({
      ok: true,
      mode: "standalone",
      bridge_enabled: !!CURSUS_BRIDGE_URL,
      port: CURSUS_PORT,
      provider: providerStatus.provider,
      provider_label: providerStatus.provider_label,
      model: providerStatus.model,
      provider_mode: providerStatus.local ? "local" : `cloud:${providerStatus.provider}`,
      provider_configured: providerStatus.configured,
      local_only_mode: providerStatus.local_only_mode,
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
      if (!existingTitle || existingTitle === "Jeffrey Miller") {
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
      result_summary: `Onboarding completed for "${state.name}". Privacy: ${state.privacy_mode}. Titles: ${state.preferred_titles ?? "none"}.`,
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

  server.patch<{ Body: Partial<{ name: string; title: string; summary: string; location: string }> }>("/cursus/profile", async (req, reply) => {
    const updated = v1.updateProfile(req.body);
    return reply.send({ ok: true, profile: updated });
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

  server.post<{ Body: {
    session_id?: string;
    message?: string;
    messages?: ChatMessage[];
    system?: string;
    max_tokens?: number;
    temperature?: number;
    velum?: boolean; // override (defaults true — Dux sees career data)
  } }>("/cursus/dux/chat", async (req, reply) => {
    const body = req.body ?? {};
    const userText = (body.message ?? "").toString();
    const explicitMessages = Array.isArray(body.messages) ? body.messages : null;
    if (!explicitMessages && !userText.trim()) {
      return reply.status(400).send({ ok: false, error: "message or messages required" });
    }

    // Velum: Dux conversations touch career/profile data by definition. Default ON.
    const velumOn = body.velum !== false;
    const messages: ChatMessage[] = [];
    if (body.system) messages.push({ role: "system", content: body.system });
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
        result_summary: `Dux chat Velum review: ${fieldsRedacted.length} fields redacted [${fieldsRedacted.join(", ") || "none"}]`,
      });
    }

    const cfg = getProviderConfig();
    try {
      const result = await providerChat({
        messages,
        ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      });
      v2.createReceipt({
        action: "model_call",
        provider: result.provider,
        model: result.model,
        local_mode: result.local,
        velum_reviewed: velumOn,
        velum_redacted: redacted,
        result_summary: `Dux chat: ${result.provider}/${result.model} (${result.content.length} chars${result.finish_reason ? `, ${result.finish_reason}` : ""})`,
      });
      return reply.send({
        ok: true,
        reply: result.content,
        provider: { provider: result.provider, model: result.model, local: result.local },
        velum: velumOn ? { reviewed: true, redacted, fields_redacted: fieldsRedacted } : { reviewed: false },
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.finish_reason ? { finish_reason: result.finish_reason } : {}),
      });
    } catch (err) {
      const isProviderErr = err instanceof ProviderError;
      const status = isProviderErr ? err.statusCode : 502;
      const code = isProviderErr ? err.code : "provider_call_failed";
      const msg = err instanceof Error ? err.message : String(err);
      v2.createReceipt({
        action: "model_call",
        provider: cfg.provider,
        model: cfg.model,
        local_mode: providerIsLocal(cfg.provider),
        velum_reviewed: velumOn,
        velum_redacted: redacted,
        result_summary: `Dux chat failed: ${code}`,
        errors: msg.slice(0, 500),
      });
      return reply.status(status).send({
        ok: false,
        error: msg,
        code,
        provider: { provider: cfg.provider, model: cfg.model, local: providerIsLocal(cfg.provider) },
        hint: cfg.provider === "none"
          ? "Configure a provider: set CURSUS_PROVIDER and CURSUS_MODEL, or POST /cursus/provider with {provider, model}."
          : undefined,
      });
    }
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
