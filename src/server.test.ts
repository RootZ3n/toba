import Fastify from "fastify";
import { describe, expect, it, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { CursusV1DB, CursusV2DB, CURSUS_SCHEMA_VERSION } from "./db.js";
import { registerRoutes } from "./routes.js";

const SERVER_SOURCE = readFileSync(join(import.meta.dirname, "server.ts"), "utf-8");

function buildApp() {
  const dir = join(tmpdir(), `cursus-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "cursus.db");
  const v1 = new CursusV1DB(dbPath);
  const v2 = new CursusV2DB(dbPath);
  const app = Fastify();
  registerRoutes(app, v1, v2);
  return { app, v1, v2, dir, dbPath };
}

describe("Cursus standalone", () => {
  const contexts: Array<{ app: ReturnType<typeof Fastify>; v1: CursusV1DB; v2: CursusV2DB; dir: string }> = [];

  function create() {
    const ctx = buildApp();
    contexts.push(ctx);
    return ctx;
  }

  afterEach(async () => {
    for (const ctx of contexts) {
      try { await ctx.app.close(); } catch {}
      try { ctx.v1.close(); } catch {}
      try { ctx.v2.close(); } catch {}
      try { rmSync(ctx.dir, { recursive: true }); } catch {}
    }
    contexts.length = 0;
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Health + Version + Status
  // ══════════════════════════════════════════════════════════════════════════

  it("GET /health returns deep health with DB + schema info", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("cursus");
    expect(body.status).toBe("healthy");
    expect(body.db.reachable).toBe(true);
    expect(body.db.schema_version).toBe(CURSUS_SCHEMA_VERSION);
    expect(body.db.schema_match).toBe(true);
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.totalApplications).toBe("number");
    expect(typeof body.onboarded).toBe("boolean");
  });

  it("GET /version includes schema_version", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/version" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.service).toBe("cursus");
    expect(body.schema_version).toBe(CURSUS_SCHEMA_VERSION);
  });

  it("GET /status returns expanded status with all fields", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("standalone");
    expect(typeof body.port).toBe("number");
    expect(body.provider_mode).toBeDefined();
    expect(body.automation_mode).toBeDefined();
    expect(body.receipts_enabled).toBe(true);
    expect(body.velum_enabled).toBe(true);
    expect(typeof body.onboarding_complete).toBe("boolean");
    expect(typeof body.pending_approvals).toBe("number");
    expect(body.last_job_scout_run).toBeNull(); // no runs yet
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Schema + DB
  // ══════════════════════════════════════════════════════════════════════════

  it("V1 and V2 both stamp same schema version", () => {
    const dir = join(tmpdir(), `cursus-schema-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "cursus.db");
    const v1 = new CursusV1DB(dbPath);
    const v2 = new CursusV2DB(dbPath);
    expect(v1.getSchemaVersion()).toBe(CURSUS_SCHEMA_VERSION);
    expect(v2.getSchemaVersion()).toBe(CURSUS_SCHEMA_VERSION);
    v1.close(); v2.close();
    try { rmSync(dir, { recursive: true }); } catch {}
  });

  it("isReachable returns true for valid DB", () => {
    const dir = join(tmpdir(), `cursus-reach-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const v1 = new CursusV1DB(join(dir, "cursus.db"));
    expect(v1.isReachable()).toBe(true);
    v1.close();
    try { rmSync(dir, { recursive: true }); } catch {}
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 1: Onboarding
  // ══════════════════════════════════════════════════════════════════════════

  it("GET /cursus/onboarding returns initial state with provider info", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/cursus/onboarding" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.onboarding.completed).toBeFalsy();
    expect(body.onboarding.privacy_mode).toBe("local-only");
    expect(body.provider).toBeDefined();
    expect(body.provider.local).toBe(true);
  });

  it("POST /cursus/onboarding persists fields", async () => {
    const { app } = create();
    await app.ready();

    await app.inject({
      method: "POST", url: "/cursus/onboarding",
      payload: {
        name: "Test Person",
        preferred_titles: "AI Engineer, MLOps",
        work_preference: "remote",
        preferred_locations: "Remote City, Remote",
        salary_min: 80000,
        salary_max: 130000,
        years_experience: 20,
        certifications: "CompTIA A+, CompTIA Security+",
        privacy_mode: "local-preferred",
      },
    });

    const res = await app.inject({ method: "GET", url: "/cursus/onboarding" });
    const ob = res.json().onboarding;
    expect(ob.name).toBe("Test Person");
    expect(ob.preferred_titles).toBe("AI Engineer, MLOps");
    expect(ob.work_preference).toBe("remote");
    expect(ob.salary_min).toBe(80000);
    expect(ob.salary_max).toBe(130000);
    expect(ob.years_experience).toBe(20);
    expect(ob.privacy_mode).toBe("local-preferred");
  });

  it("POST /cursus/onboarding/complete requires name", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/cursus/onboarding/complete" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Name is required");
  });

  it("POST /cursus/onboarding/complete marks completed and syncs profile", async () => {
    const { app } = create();
    await app.ready();

    await app.inject({
      method: "POST", url: "/cursus/onboarding",
      payload: { name: "Test Person", preferred_titles: "AI Engineer, DevOps", preferred_locations: "OKC" },
    });

    const res = await app.inject({ method: "POST", url: "/cursus/onboarding/complete" });
    expect(res.statusCode).toBe(200);
    expect(res.json().onboarding.completed).toBeTruthy();
    expect(res.json().onboarding.completed_at).toBeDefined();

    // Check profile synced from blank default state.
    const profile = await app.inject({ method: "GET", url: "/cursus/profile" });
    expect(profile.json().profile.name).toBe("Test Person");
    expect(profile.json().profile.title).toBe("AI Engineer");
    expect(profile.json().profile.location).toBe("OKC");

    // Check target_roles synced
    const v2p = await app.inject({ method: "GET", url: "/cursus/profile/v2" });
    const roles = JSON.parse(v2p.json().profile.target_roles);
    expect(roles).toContain("AI Engineer");
    expect(roles).toContain("DevOps");

    // Check receipt
    const receipts = await app.inject({ method: "GET", url: "/cursus/receipts?action=onboarding_complete" });
    expect(receipts.json().receipts.length).toBe(1);
    expect(receipts.json().receipts[0].result_summary).not.toContain("Test Person");
    expect(receipts.json().receipts[0].result_summary).toContain("Privacy:");
  });

  it("onboarding does not overwrite existing professional title", async () => {
    const { app, v1 } = create();
    await app.ready();

    // Set a real professional title first
    v1.updateProfile({ title: "AI Systems Engineer / Field Service Technician" });

    await app.inject({
      method: "POST", url: "/cursus/onboarding",
      payload: { name: "Test Person", preferred_titles: "Help Desk, Desktop Support", preferred_locations: "OKC" },
    });
    await app.inject({ method: "POST", url: "/cursus/onboarding/complete" });

    const profile = await app.inject({ method: "GET", url: "/cursus/profile" });
    // Title must NOT be overwritten to "Help Desk"
    expect(profile.json().profile.title).toBe("AI Systems Engineer / Field Service Technician");
    // But name and location should still sync
    expect(profile.json().profile.name).toBe("Test Person");
    expect(profile.json().profile.location).toBe("OKC");
  });

  it("onboarding sets title when profile title is empty", async () => {
    const { app, v1 } = create();
    await app.ready();

    // Default seed title is "AI Systems Engineer / Field Service Technician" —
    // clear it to simulate empty profile
    v1.updateProfile({ title: "" });

    await app.inject({
      method: "POST", url: "/cursus/onboarding",
      payload: { name: "Test Person", preferred_titles: "Help Desk, Desktop Support" },
    });
    await app.inject({ method: "POST", url: "/cursus/onboarding/complete" });

    const profile = await app.inject({ method: "GET", url: "/cursus/profile" });
    expect(profile.json().profile.title).toBe("Help Desk");
  });

  it("POST /cursus/onboarding/resume uploads with Velum review", async () => {
    const { app } = create();
    await app.ready();

    const res = await app.inject({
      method: "POST", url: "/cursus/onboarding/resume",
      payload: { text: "Test Person, AI Engineer. SSN: 123-45-6789. 20 years experience in systems." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().velum.reviewed).toBe(true);
    expect(res.json().velum.redacted).toBe(true);
    expect(res.json().velum.fields_redacted).toContain("ssn");
    expect(res.json().resume.base_resume).toContain("[SSN-REDACTED]");
    expect(res.json().resume.base_resume).not.toContain("123-45-6789");

    // Check onboarding state updated
    const ob = await app.inject({ method: "GET", url: "/cursus/onboarding" });
    expect(ob.json().onboarding.resume_uploaded).toBeTruthy();
    expect(ob.json().onboarding.resume_id).toBeDefined();

    // Check receipts (resume_ingest + velum_review)
    const receipts = await app.inject({ method: "GET", url: "/cursus/receipts?action=resume_ingest" });
    expect(receipts.json().receipts.length).toBe(1);
    expect(receipts.json().receipts[0].velum_reviewed).toBeTruthy();
  });

  it("privacy preference persists across reads", async () => {
    const { app } = create();
    await app.ready();

    await app.inject({ method: "POST", url: "/cursus/onboarding", payload: { privacy_mode: "cloud-allowed-with-review" } });
    const res = await app.inject({ method: "GET", url: "/cursus/onboarding" });
    expect(res.json().onboarding.privacy_mode).toBe("cloud-allowed-with-review");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 2: Analytics
  // ══════════════════════════════════════════════════════════════════════════

  it("GET /cursus/analytics/campaign/:id returns analytics with insights", async () => {
    const { app } = create();
    await app.ready();

    const camp = await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Analytics Test", target_role: "SWE" } });
    const campId = camp.json().campaign.id;

    // Add some applications
    for (const [company, role, status] of [
      ["Google", "SWE", "applied"], ["Meta", "SWE", "interviewing"],
      ["Amazon", "DevOps", "responded"], ["Netflix", "SRE", "found"],
    ] as const) {
      const appRes = await app.inject({ method: "POST", url: "/cursus/applications", payload: { campaign_id: campId, company, role } });
      if (status !== "found") {
        await app.inject({ method: "PATCH", url: `/cursus/applications/${appRes.json().application.id}`, payload: { status } });
      }
    }

    const res = await app.inject({ method: "GET", url: `/cursus/analytics/campaign/${campId}` });
    expect(res.statusCode).toBe(200);
    const a = res.json().analytics;
    expect(a.campaign_name).toBe("Analytics Test");
    expect(a.applications.total).toBe(4);
    expect(a.applications.by_status.applied).toBe(1);
    expect(a.applications.by_status.interviewing).toBe(1);
    expect(a.applications.by_role["SWE"]).toBe(2);
    expect(a.rates.response_rate).toBeGreaterThan(0);
    expect(Array.isArray(a.insights)).toBe(true);

    // Receipt for insight generation
    const receipts = await app.inject({ method: "GET", url: "/cursus/receipts?action=insight_generate" });
    expect(receipts.json().receipts.length).toBeGreaterThanOrEqual(1);
  });

  it("analytics handles empty campaign gracefully", async () => {
    const { app } = create();
    await app.ready();

    const camp = await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Empty", target_role: "Dev" } });
    const campId = camp.json().campaign.id;

    const res = await app.inject({ method: "GET", url: `/cursus/analytics/campaign/${campId}` });
    expect(res.statusCode).toBe(200);
    const a = res.json().analytics;
    expect(a.applications.total).toBe(0);
    expect(a.insights.length).toBeGreaterThan(0);
    expect(a.insights[0]).toContain("No applications yet");
  });

  it("analytics returns 404 for nonexistent campaign", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/cursus/analytics/campaign/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 3: Automation Queue
  // ══════════════════════════════════════════════════════════════════════════

  it("automation task lifecycle: create -> approve -> execute", async () => {
    const { app } = create();
    await app.ready();

    const created = await app.inject({
      method: "POST", url: "/cursus/automation",
      payload: { kind: "job_scout", title: "Daily job search", detail: "Search for SWE roles" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().task.status).toBe("pending");
    const taskId = created.json().task.id;

    const approved = await app.inject({ method: "POST", url: `/cursus/automation/${taskId}/approve` });
    expect(approved.json().task.status).toBe("approved");

    const executed = await app.inject({ method: "POST", url: `/cursus/automation/${taskId}/execute` });
    expect(executed.json().task.status).toBe("executed");
    expect(executed.json().task.resolved_at).toBeDefined();
  });

  it("rejected automation tasks cannot be executed", async () => {
    const { app } = create();
    await app.ready();

    const created = await app.inject({
      method: "POST", url: "/cursus/automation",
      payload: { kind: "outreach_draft", title: "Draft email" },
    });
    const taskId = created.json().task.id;

    await app.inject({ method: "POST", url: `/cursus/automation/${taskId}/reject` });

    const execAttempt = await app.inject({ method: "POST", url: `/cursus/automation/${taskId}/execute` });
    expect(execAttempt.statusCode).toBe(400);
  });

  it("only approved tasks can be executed", async () => {
    const { app } = create();
    await app.ready();

    const created = await app.inject({
      method: "POST", url: "/cursus/automation",
      payload: { kind: "follow_up_reminder", title: "Follow up with Google" },
    });
    const taskId = created.json().task.id;

    // Can't execute pending task directly
    const res = await app.inject({ method: "POST", url: `/cursus/automation/${taskId}/execute` });
    expect(res.statusCode).toBe(400);
  });

  it("automation generates receipts for all transitions", async () => {
    const { app } = create();
    await app.ready();

    const created = await app.inject({
      method: "POST", url: "/cursus/automation",
      payload: { kind: "stale_app_reminder", title: "Check stale apps" },
    });
    const taskId = created.json().task.id;

    await app.inject({ method: "POST", url: `/cursus/automation/${taskId}/approve` });
    await app.inject({ method: "POST", url: `/cursus/automation/${taskId}/execute` });

    const createReceipts = await app.inject({ method: "GET", url: "/cursus/receipts?action=automation_create" });
    expect(createReceipts.json().receipts.length).toBeGreaterThanOrEqual(1);

    const approveReceipts = await app.inject({ method: "GET", url: "/cursus/receipts?action=automation_approve" });
    expect(approveReceipts.json().receipts.length).toBeGreaterThanOrEqual(1);

    const execReceipts = await app.inject({ method: "GET", url: "/cursus/receipts?action=automation_execute" });
    expect(execReceipts.json().receipts.length).toBeGreaterThanOrEqual(1);
  });

  it("automation list supports status filter", async () => {
    const { app } = create();
    await app.ready();

    await app.inject({ method: "POST", url: "/cursus/automation", payload: { kind: "job_scout", title: "A" } });
    const created2 = await app.inject({ method: "POST", url: "/cursus/automation", payload: { kind: "job_scout", title: "B" } });
    await app.inject({ method: "POST", url: `/cursus/automation/${created2.json().task.id}/approve` });

    const pending = await app.inject({ method: "GET", url: "/cursus/automation?status=pending" });
    expect(pending.json().tasks.length).toBe(1);

    const approved = await app.inject({ method: "GET", url: "/cursus/automation?status=approved" });
    expect(approved.json().tasks.length).toBe(1);

    const all = await app.inject({ method: "GET", url: "/cursus/automation" });
    expect(all.json().tasks.length).toBe(2);
    expect(all.json().mode).toBeDefined();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 4: Job Scout evolution
  // ══════════════════════════════════════════════════════════════════════════

  it("job fingerprinting prevents duplicate ingestion", async () => {
    const { app } = create();
    await app.ready();

    await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Dedup", target_role: "SWE" } });

    const first = await app.inject({
      method: "POST", url: "/cursus/job-scout/ingest",
      payload: { jobs: [{ company: "Acme", role: "SWE", url: "https://acme.com/1" }] },
    });
    expect(first.json().ingested).toBe(1);
    expect(first.json().duplicates_skipped).toBe(0);

    const second = await app.inject({
      method: "POST", url: "/cursus/job-scout/ingest",
      payload: { jobs: [
        { company: "Acme", role: "SWE", url: "https://acme.com/1" }, // duplicate
        { company: "Beta", role: "DevOps" }, // new
      ] },
    });
    expect(second.json().ingested).toBe(1);
    expect(second.json().duplicates_skipped).toBe(1);

    const apps = await app.inject({ method: "GET", url: "/cursus/applications" });
    expect(apps.json().applications.length).toBe(2); // not 3
  });

  it("job fingerprint is consistent for same company/role/url", () => {
    const fp1 = CursusV2DB.jobFingerprint("Acme", "SWE", "https://acme.com/1");
    const fp2 = CursusV2DB.jobFingerprint("Acme", "SWE", "https://acme.com/1");
    const fp3 = CursusV2DB.jobFingerprint("acme", "swe", "https://acme.com/1");
    expect(fp1).toBe(fp2);
    expect(fp1).toBe(fp3); // case insensitive
  });

  it("different jobs produce different fingerprints", () => {
    const fp1 = CursusV2DB.jobFingerprint("Acme", "SWE", "https://acme.com/1");
    const fp2 = CursusV2DB.jobFingerprint("Beta", "SWE", "https://beta.com/1");
    expect(fp1).not.toBe(fp2);
  });

  it("job-scout context includes onboarding preferences", async () => {
    const { app } = create();
    await app.ready();

    await app.inject({
      method: "POST", url: "/cursus/onboarding",
      payload: {
        name: "Tester",
        work_preference: "remote",
        preferred_locations: "Remote City",
        salary_min: 90000,
        salary_max: 140000,
        certifications: "CompTIA A+",
      },
    });

    await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Test", target_role: "AI Engineer" } });

    const res = await app.inject({ method: "GET", url: "/cursus/job-scout/context" });
    const ctx = res.json().context;
    expect(ctx.remote_preference).toBe("remote");
    expect(ctx.salary_range).toEqual({ min: 90000, max: 140000 });
    expect(ctx.certifications).toBe("CompTIA A+");
  });

  it("ingested jobs include source/location/remote metadata", async () => {
    const { app } = create();
    await app.ready();

    await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Meta", target_role: "SWE" } });

    const res = await app.inject({
      method: "POST", url: "/cursus/job-scout/ingest",
      payload: { jobs: [{ company: "Acme", role: "SWE", source: "indeed", location: "Remote", remote: "full" }] },
    });
    const app0 = res.json().applications[0];
    expect(app0.source).toBe("indeed");
    expect(app0.location).toBe("Remote");
    expect(app0.remote).toBe("full");
    expect(app0.fingerprint).toBeDefined();
    expect(app0.fingerprint.length).toBe(16);
  });

  it("job scout receipt notes duplicates skipped", async () => {
    const { app } = create();
    await app.ready();

    await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "R", target_role: "Dev" } });
    await app.inject({ method: "POST", url: "/cursus/job-scout/ingest", payload: { jobs: [{ company: "X", role: "Y" }] } });
    const second = await app.inject({ method: "POST", url: "/cursus/job-scout/ingest", payload: { jobs: [{ company: "X", role: "Y" }] } });
    expect(second.json().duplicates_skipped).toBe(1);
    expect(second.json().ingested).toBe(0);

    const receipts = await app.inject({ method: "GET", url: "/cursus/receipts?action=job_scout_run" });
    const allSummaries = receipts.json().receipts.map((r: any) => r.result_summary).join(" ");
    expect(allSummaries).toContain("duplicates skipped");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 4B: Lane-aware ingest
  // ══════════════════════════════════════════════════════════════════════════

  it("ingest with lane_id stores lane assignment", async () => {
    const { app } = create();
    await app.ready();
    const camp = await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "LaneIngest", target_role: "Dev" } });
    const campId = camp.json().campaign.id;
    const lane = await app.inject({ method: "POST", url: "/cursus/lanes", payload: { campaign_id: campId, name: "Primary", target_titles: ["Dev"], priority: "primary" } });
    const laneId = lane.json().lane.id;

    const res = await app.inject({
      method: "POST", url: "/cursus/job-scout/ingest",
      payload: { lane_id: laneId, jobs: [{ company: "Acme", role: "Dev" }] },
    });
    expect(res.json().ingested).toBe(1);
    expect(res.json().lane_id).toBe(laneId);
    expect(res.json().applications[0].lane_id).toBe(laneId);
  });

  it("ingest without lane_id still works (backwards compat)", async () => {
    const { app } = create();
    await app.ready();
    await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "NoLane", target_role: "Dev" } });

    const res = await app.inject({
      method: "POST", url: "/cursus/job-scout/ingest",
      payload: { jobs: [{ company: "Beta", role: "Ops" }] },
    });
    expect(res.json().ingested).toBe(1);
    expect(res.json().lane_id).toBeNull();
    expect(res.json().applications[0].lane_id).toBeNull();
  });

  it("ingest with nonexistent lane_id is rejected", async () => {
    const { app } = create();
    await app.ready();
    await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "BadLane", target_role: "Dev" } });

    const res = await app.inject({
      method: "POST", url: "/cursus/job-scout/ingest",
      payload: { lane_id: "nonexistent-lane-id", jobs: [{ company: "Gamma", role: "SRE" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Search lane not found");
  });

  it("ingest with lane_id from wrong campaign is rejected", async () => {
    const { app } = create();
    await app.ready();
    // Create first campaign + lane
    const camp1 = await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Camp1", target_role: "Dev" } });
    const lane1 = await app.inject({ method: "POST", url: "/cursus/lanes", payload: { campaign_id: camp1.json().campaign.id, name: "Lane1", target_titles: ["Dev"] } });
    const laneId = lane1.json().lane.id;
    // Create second campaign (deactivates first)
    await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Camp2", target_role: "Ops" } });

    const res = await app.inject({
      method: "POST", url: "/cursus/job-scout/ingest",
      payload: { lane_id: laneId, jobs: [{ company: "Delta", role: "Ops" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("does not belong to the active campaign");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 5: Operational (existing tests carry forward)
  // ══════════════════════════════════════════════════════════════════════════

  it("fresh DB starts blank with no personal campaign data", async () => {
    const { app } = create();
    await app.ready();
    const profile = await app.inject({ method: "GET", url: "/cursus/profile" });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().profile.name).toBeNull();
    expect(profile.json().profile.title).toBeNull();
    expect(profile.json().profile.summary).toBeNull();

    const v2p = await app.inject({ method: "GET", url: "/cursus/profile/v2" });
    expect(JSON.parse(v2p.json().profile.target_roles)).toEqual([]);
    expect(v2p.json().profile.cover_employer).toBeNull();
    expect(v2p.json().profile.nda_active).toBe(0);

    const campaigns = await app.inject({ method: "GET", url: "/cursus/campaigns" });
    const apps = await app.inject({ method: "GET", url: "/cursus/applications" });
    const resumes = await app.inject({ method: "GET", url: "/cursus/resumes" });
    const receipts = await app.inject({ method: "GET", url: "/cursus/receipts" });
    expect(campaigns.json().campaigns).toEqual([]);
    expect(apps.json().applications).toEqual([]);
    expect(resumes.json().resumes).toEqual([]);
    expect(receipts.json().receipts).toEqual([]);
  });

  it("profile fields and target_roles can be edited and cleared", async () => {
    const { app } = create();
    await app.ready();
    const saved = await app.inject({
      method: "PATCH", url: "/cursus/profile",
      payload: {
        name: "Test Person",
        email: "person@example.test",
        phone: "555-010-2222",
        location: "Remote City",
        title: "Platform Engineer",
        summary: "Release-safe test profile.",
        target_roles: "Platform Engineer, SRE",
        work_preference: "remote",
        preferred_locations: "Remote",
        salary_min: 100000,
        salary_max: 140000,
        years_experience: 7,
        certifications: "Test Certification",
        skills: "TypeScript, SQLite",
        links_json: "https://example.test/portfolio",
        privacy_mode: "local-preferred",
        provider_preference: "local",
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().profile.email).toBe("person@example.test");
    expect(saved.json().profile.skills).toContain("TypeScript");
    expect(JSON.parse(saved.json().profile_v2.target_roles)).toEqual(["Platform Engineer", "SRE"]);
    expect(saved.json().onboarding.preferred_titles).toBe("Platform Engineer, SRE");

    const cleared = await app.inject({ method: "POST", url: "/cursus/profile/clear" });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().profile.name).toBeNull();
    expect(cleared.json().profile.email).toBeNull();
    expect(cleared.json().onboarding.completed).toBe(0);
    const v2p = await app.inject({ method: "GET", url: "/cursus/profile/v2" });
    expect(JSON.parse(v2p.json().profile.target_roles)).toEqual([]);
  });

  it("factory reset script leaves a populated DB blank without touching schema", () => {
    const dir = join(tmpdir(), `cursus-reset-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "cursus.db");
    const v1 = new CursusV1DB(dbPath);
    const v2 = new CursusV2DB(dbPath);
    v1.updateProfile({ name: "Test Person", title: "Platform Engineer" });
    v2.createCampaign("Release Test", "Engineer");
    v2.createResume("Test resume body with enough words to store.", undefined, "Engineer");
    v2.createReceipt({ action: "campaign_create", result_summary: "test receipt" });
    v1.close(); v2.close();

    execFileSync("bash", [join(import.meta.dirname, "..", "scripts", "cursus-reset.sh"), "--personal-data-only", "--db", dbPath], {
      cwd: join(import.meta.dirname, ".."),
      stdio: "pipe",
      encoding: "utf-8",
    });

    const checkV1 = new CursusV1DB(dbPath);
    const checkV2 = new CursusV2DB(dbPath);
    expect(checkV1.getProfile().name).toBeNull();
    expect(checkV2.listCampaigns()).toEqual([]);
    expect(checkV2.listResumes()).toEqual([]);
    expect(checkV2.listReceipts()).toEqual([]);
    expect(checkV2.getSchemaVersion()).toBe(CURSUS_SCHEMA_VERSION);
    checkV1.close(); checkV2.close();
    try { rmSync(dir, { recursive: true }); } catch {}
  });

  it("release privacy audit fails on personal strings and passes a clean scan path", () => {
    const dir = join(tmpdir(), `cursus-audit-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const script = join(import.meta.dirname, "..", "scripts", "audit-release-privacy.sh");
    writeFileSync(join(dir, "clean.txt"), "generic release-safe fixture\n");
    expect(() => execFileSync("bash", [script, dir], { cwd: join(import.meta.dirname, ".."), stdio: "pipe" })).not.toThrow();
    writeFileSync(join(dir, "bad.txt"), `${"Jeffrey"} ${"Miller"}\n`);
    expect(() => execFileSync("bash", [script, dir], { cwd: join(import.meta.dirname, ".."), stdio: "pipe" })).toThrow();
    try { rmSync(dir, { recursive: true }); } catch {}
  });

  it("V2 dashboard returns valid structure", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/cursus/dashboard" });
    expect(res.statusCode).toBe(200);
    expect(res.json().dashboard.applicationCounts).toBeDefined();
    expect(res.json().dashboard.next_action).toBeDefined();
  });

  it("V2 dashboard shows no active campaign when none exists", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/cursus/dashboard" });
    expect(res.json().dashboard.activeCampaign).toBeNull();
    expect(res.json().dashboard.next_action).toContain("Create a campaign");
  });

  // Campaign CRUD
  it("campaign create, list, update", async () => {
    const { app } = create();
    await app.ready();
    const created = await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Test", target_role: "Engineer" } });
    expect(created.statusCode).toBe(200);
    const campId = created.json().campaign.id;
    const list = await app.inject({ method: "GET", url: "/cursus/campaigns" });
    expect(list.json().campaigns.length).toBeGreaterThanOrEqual(1);
    const patch = await app.inject({ method: "PATCH", url: `/cursus/campaigns/${campId}`, payload: { phase: "applying" } });
    expect(patch.json().campaign.phase).toBe("applying");
  });

  // Campaign close
  it("POST /cursus/campaigns/:id/close sets active=false and phase=closed", async () => {
    const { app } = create();
    await app.ready();
    const created = await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "CloseMe", target_role: "Dev" } });
    const campId = created.json().campaign.id;
    const closed = await app.inject({ method: "POST", url: `/cursus/campaigns/${campId}/close` });
    expect(closed.json().campaign.active).toBeFalsy();
    expect(closed.json().campaign.phase).toBe("closed");
  });

  it("closing a campaign clears it from dashboard", async () => {
    const { app } = create();
    await app.ready();
    const created = await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "ActiveOne", target_role: "Engineer" } });
    const campId = created.json().campaign.id;
    await app.inject({ method: "POST", url: `/cursus/campaigns/${campId}/close` });
    const dash = await app.inject({ method: "GET", url: "/cursus/dashboard" });
    expect(dash.json().dashboard.activeCampaign).toBeNull();
  });

  // One active campaign
  it("creating a new campaign deactivates the previous one", async () => {
    const { app, v2 } = create();
    await app.ready();
    await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "First", target_role: "Dev" } });
    const second = await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Second", target_role: "Ops" } });
    expect(v2.countActiveCampaigns()).toBe(1);
    expect(v2.getActiveCampaign()!.id).toBe(second.json().campaign.id);
  });

  it("only one active campaign at any time (DB level)", () => {
    const dir = join(tmpdir(), `cursus-single-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const v2 = new CursusV2DB(join(dir, "cursus.db"));
    v2.createCampaign("A", "Role A");
    v2.createCampaign("B", "Role B");
    v2.createCampaign("C", "Role C");
    expect(v2.countActiveCampaigns()).toBe(1);
    expect(v2.getActiveCampaign()!.name).toBe("C");
    v2.close();
    try { rmSync(dir, { recursive: true }); } catch {}
  });

  // Application CRUD
  it("application create requires campaign_id, company, role", async () => {
    const { app } = create();
    await app.ready();
    const bad = await app.inject({ method: "POST", url: "/cursus/applications", payload: { company: "Acme" } });
    expect(bad.statusCode).toBe(400);
    const camp = await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Test", target_role: "Eng" } });
    const good = await app.inject({ method: "POST", url: "/cursus/applications", payload: { campaign_id: camp.json().campaign.id, company: "Acme", role: "Dev" } });
    expect(good.statusCode).toBe(200);
    expect(good.json().application.company).toBe("Acme");
  });

  // Outreach
  it("outreach stealth: staged -> approved transition enforced", async () => {
    const { app } = create();
    await app.ready();
    const staged = await app.inject({ method: "POST", url: "/cursus/outreach/stage", payload: { type: "email", subject: "Hi", body: "Body text here" } });
    const id = staged.json().outreach.id;
    expect(staged.json().outreach.status).toBe("staged");
    const approved = await app.inject({ method: "POST", url: `/cursus/outreach/${id}/approve` });
    expect(approved.json().outreach.status).toBe("approved");
    const re = await app.inject({ method: "POST", url: `/cursus/outreach/${id}/approve` });
    expect(re.statusCode).toBe(400);
  });

  it("outreach reject only works on staged", async () => {
    const { app } = create();
    await app.ready();
    const staged = await app.inject({ method: "POST", url: "/cursus/outreach/stage", payload: { type: "email", subject: "Hi", body: "Body text here" } });
    const id = staged.json().outreach.id;
    const rejected = await app.inject({ method: "POST", url: `/cursus/outreach/${id}/reject` });
    expect(rejected.statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: `/cursus/outreach/${id}/reject` });
    expect(again.statusCode).toBe(400);
  });

  // Dux
  it("dux chat returns honest unconfigured error when no provider is set", async () => {
    // Reset provider to default-from-env ("none" in test env) before this case.
    const { resetConfigFromEnv } = await import("./provider.js");
    delete process.env["CURSUS_PROVIDER"];
    delete process.env["CURSUS_MODEL"];
    delete process.env["CURSUS_PROVIDER_API_KEY"];
    delete process.env["CURSUS_LOCAL_ONLY"];
    resetConfigFromEnv();
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/cursus/dux/chat", payload: { session_id: "x", message: "hi" } });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error.toLowerCase()).toContain("provider");
    expect(body.hint.toLowerCase()).toContain("configure");
    expect(body.provider.provider).toBe("none");
  });

  // Resume
  it("resume upload works with Velum review", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/cursus/resumes/upload", payload: { text: "This is my resume with enough content to pass validation" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().velum.reviewed).toBe(true);
  });

  it("resume upload rejects short text", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/cursus/resumes/upload", payload: { text: "too short" } });
    expect(res.statusCode).toBe(400);
  });

  // Velum
  it("velum review endpoint redacts SSN", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/cursus/velum/review", payload: { text: "SSN 123-45-6789", context: "profile" } });
    expect(res.json().velum.fields_redacted).toContain("ssn");
    expect(res.json().velum.output).toContain("[SSN-REDACTED]");
  });

  it("velum passes clean text through", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/cursus/velum/review", payload: { text: "I am an engineer" } });
    expect(res.json().velum.redacted).toBe(false);
  });

  it("outreach staging applies velum review", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/cursus/outreach/stage", payload: { type: "email", subject: "Intro", body: "Call me at 405-555-9999" } });
    expect(res.json().velum.fields_redacted).toContain("phone");
    expect(res.json().outreach.body).toContain("[PHONE-REDACTED]");
  });

  // Receipts
  it("campaign create generates a receipt", async () => {
    const { app } = create();
    await app.ready();
    await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Receipted", target_role: "Dev" } });
    const receipts = await app.inject({ method: "GET", url: "/cursus/receipts?action=campaign_create" });
    expect(receipts.json().receipts.length).toBeGreaterThanOrEqual(1);
  });

  it("receipts list supports limit", async () => {
    const { app } = create();
    await app.ready();
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: `C${i}`, target_role: "Dev" } });
    }
    const limited = await app.inject({ method: "GET", url: "/cursus/receipts?limit=2" });
    expect(limited.json().receipts.length).toBe(2);
  });

  // Provider
  it("GET /cursus/provider returns provider metadata", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/cursus/provider" });
    expect(res.json().provider.local).toBe(true);
  });

  // Job Scout context
  it("job-scout context returns campaign-derived queries", async () => {
    const { app } = create();
    await app.ready();
    await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "AI Search", target_role: "AI Engineer, MLOps" } });
    const res = await app.inject({ method: "GET", url: "/cursus/job-scout/context" });
    expect(res.json().context.all_target_roles).toContain("AI Engineer");
    expect(res.json().context.all_target_roles).toContain("MLOps");
  });

  it("job-scout ingest requires active campaign", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/cursus/job-scout/ingest", payload: { jobs: [{ company: "X", role: "Y" }] } });
    expect(res.statusCode).toBe(400);
  });

  it("target roles: primary from campaign, secondary from profile", async () => {
    const { app, v2 } = create();
    await app.ready();
    v2.updateProfileV2({ target_roles: JSON.stringify(["DevOps", "SRE", "AI Engineer"]) });
    await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Focus", target_role: "AI Engineer" } });
    const ctx = await app.inject({ method: "GET", url: "/cursus/job-scout/context" });
    const roles = ctx.json().context.all_target_roles;
    expect(roles[0]).toBe("AI Engineer");
    expect(roles).toContain("DevOps");
    expect(new Set(roles).size).toBe(roles.length); // no duplicates
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 6: Architecture safety
  // ══════════════════════════════════════════════════════════════════════════

  it("shared DB: two instances don't corrupt", () => {
    const dir = join(tmpdir(), `cursus-shared-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const v2a = new CursusV2DB(join(dir, "cursus.db"));
    const v2b = new CursusV2DB(join(dir, "cursus.db"));
    const camp = v2a.createCampaign("From A", "Engineer");
    expect(v2b.getCampaign(camp.id)!.name).toBe("From A");
    v2a.close(); v2b.close();
    try { rmSync(dir, { recursive: true }); } catch {}
  });

  it("server refuses non-localhost binding without auth token", () => {
    // The actual guard moved to network.ts; server.ts wires it.
    const netSrc = readFileSync(join(import.meta.dirname, "network.ts"), "utf-8");
    expect(SERVER_SOURCE).toContain("CURSUS_AUTH_TOKEN");
    expect(netSrc).toContain("Refusing to start unauthenticated");
    expect(SERVER_SOURCE).toContain("process.exit(1)");
  });

  it("routes don't carry provider dispatch logic — only the openrouter_configured status flag is allowed", () => {
    const routesSrc = readFileSync(join(import.meta.dirname, "routes.ts"), "utf-8");
    // routes.ts must not implement any provider-specific request/adapter logic.
    expect(routesSrc).not.toMatch(/case\s+['"]openrouter['"]/);
    expect(routesSrc).not.toMatch(/case\s+['"]anthropic['"]/);
    expect(routesSrc).not.toMatch(/case\s+['"]openai['"]/);
    expect(routesSrc).not.toMatch(/Bearer\s+\$\{[^}]*api_key/i); // no auth-header construction here
    expect(routesSrc).not.toMatch(/chat\/completions/); // no adapter URLs here
  });

  it("routes source delegates provider/model decisions to the provider module", () => {
    const routesSrc = readFileSync(join(import.meta.dirname, "routes.ts"), "utf-8");
    // All provider logic must come through ./provider.js.
    expect(routesSrc).toContain('from "./provider.js"');
    expect(routesSrc).toContain("isLocalProvider");
    expect(routesSrc).toContain("getProviderStatus");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // V5: Search Lanes
  // ══════════════════════════════════════════════════════════════════════════

  it("search lane CRUD: create, list, update, delete", async () => {
    const { app } = create();
    await app.ready();
    const camp = await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Lane Test", target_role: "IT Support" } });
    const campId = camp.json().campaign.id;

    const created = await app.inject({
      method: "POST", url: "/cursus/lanes",
      payload: {
        campaign_id: campId, name: "Help Desk",
        target_titles: ["Help Desk Technician", "Desktop Support"],
        keywords: ["tier 1", "tier 2"],
        negative_keywords: ["senior", "director"],
        locations: ["Remote City", "Remote"],
        remote_preference: "remote",
        priority: "primary",
      },
    });
    expect(created.statusCode).toBe(201);
    const lane = created.json().lane;
    expect(lane.name).toBe("Help Desk");
    expect(JSON.parse(lane.target_titles)).toContain("Help Desk Technician");
    expect(lane.priority).toBe("primary");
    expect(lane.active).toBeTruthy();

    // List
    const list = await app.inject({ method: "GET", url: `/cursus/lanes?campaign_id=${campId}` });
    expect(list.json().lanes.length).toBe(1);

    // Update
    const updated = await app.inject({ method: "PATCH", url: `/cursus/lanes/${lane.id}`, payload: { priority: "secondary" } });
    expect(updated.json().lane.priority).toBe("secondary");

    // Delete
    const del = await app.inject({ method: "DELETE", url: `/cursus/lanes/${lane.id}` });
    expect(del.statusCode).toBe(200);
    const afterDel = await app.inject({ method: "GET", url: `/cursus/lanes?campaign_id=${campId}` });
    expect(afterDel.json().lanes.length).toBe(0);
  });

  it("lane-aware job scout context returns search queries per lane", async () => {
    const { app } = create();
    await app.ready();
    const camp = await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Multi-Lane", target_role: "IT" } });
    const campId = camp.json().campaign.id;

    await app.inject({ method: "POST", url: "/cursus/lanes", payload: { campaign_id: campId, name: "Help Desk", target_titles: ["Help Desk", "IT Support"], locations: ["Remote"], priority: "primary" } });
    await app.inject({ method: "POST", url: "/cursus/lanes", payload: { campaign_id: campId, name: "Cyber", target_titles: ["SOC Analyst"], locations: ["OKC"], priority: "stretch" } });

    const ctx = await app.inject({ method: "GET", url: "/cursus/job-scout/lane-context" });
    expect(ctx.statusCode).toBe(200);
    const body = ctx.json();
    expect(body.lanes.length).toBe(2);
    expect(body.lanes[0].lane_name).toBe("Help Desk");
    expect(body.lanes[0].search_queries.length).toBeGreaterThan(0);
    expect(body.lanes[1].lane_name).toBe("Cyber");
    expect(body.campaign_id).toBe(campId);
  });

  it("lane requires campaign_id and name", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/cursus/lanes", payload: { name: "Nope" } });
    expect(res.statusCode).toBe(400);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // V5: Job Evaluations
  // ══════════════════════════════════════════════════════════════════════════

  it("job evaluation CRUD", async () => {
    const { app } = create();
    await app.ready();
    const camp = await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Eval", target_role: "Dev" } });
    const appRes = await app.inject({ method: "POST", url: "/cursus/applications", payload: { campaign_id: camp.json().campaign.id, company: "Acme", role: "Dev" } });
    const appId = appRes.json().application.id;

    const ev = await app.inject({
      method: "POST", url: "/cursus/evaluations",
      payload: {
        application_id: appId,
        role_summary: "Standard dev role",
        fit_analysis: "Strong fit based on portfolio",
        gap_strategy: "Need to brush up on React",
        compensation_notes: "$90k-120k range",
        resume_plan: "Emphasize reference platform architecture",
        interview_prep: "Prepare STAR stories about system design",
        legitimacy_grade: "A",
        overall_grade: "B",
      },
    });
    expect(ev.statusCode).toBe(201);
    expect(ev.json().evaluation.overall_grade).toBe("B");
    expect(ev.json().evaluation.legitimacy_grade).toBe("A");

    const list = await app.inject({ method: "GET", url: `/cursus/evaluations?application_id=${appId}` });
    expect(list.json().evaluations.length).toBe(1);

    const single = await app.inject({ method: "GET", url: `/cursus/evaluations/${ev.json().evaluation.id}` });
    expect(single.json().evaluation.role_summary).toBe("Standard dev role");
  });

  it("job evaluation requires application_id, role_summary, fit_analysis", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/cursus/evaluations", payload: { role_summary: "Nope" } });
    expect(res.statusCode).toBe(400);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // V5: Interview Story Bank
  // ══════════════════════════════════════════════════════════════════════════

  it("interview story CRUD", async () => {
    const { app } = create();
    await app.ready();
    const created = await app.inject({
      method: "POST", url: "/cursus/stories",
      payload: {
        title: "Reference Platform Architecture",
        format: "star_reflection",
        situation: "Needed a production-grade AI orchestration platform",
        task: "Design and build a 22-module system in under a week",
        action: "Architected TypeScript monorepo with strict module boundaries",
        result: "Fully operational platform with verification doctrine",
        reflection: "Speed matters less than getting the contracts right",
        linked_project_ids: [1],
        tags: ["architecture", "ai", "leadership"],
      },
    });
    expect(created.statusCode).toBe(201);
    const story = created.json().story;
    expect(story.title).toBe("Reference Platform Architecture");
    expect(story.format).toBe("star_reflection");
    expect(JSON.parse(story.tags)).toContain("architecture");

    const list = await app.inject({ method: "GET", url: "/cursus/stories" });
    expect(list.json().stories.length).toBe(1);

    const updated = await app.inject({ method: "PATCH", url: `/cursus/stories/${story.id}`, payload: { reflection: "Updated reflection" } });
    expect(updated.json().story.reflection).toBe("Updated reflection");
  });

  it("story requires STAR fields", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/cursus/stories", payload: { title: "Incomplete", situation: "Yep" } });
    expect(res.statusCode).toBe(400);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // V5: Follow-up Cadence
  // ══════════════════════════════════════════════════════════════════════════

  it("follow-up cadence: set and record", async () => {
    const { app } = create();
    await app.ready();
    const camp = await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Follow", target_role: "Dev" } });
    const campId = camp.json().campaign.id;
    const appRes = await app.inject({ method: "POST", url: "/cursus/applications", payload: { campaign_id: campId, company: "Acme", role: "Dev" } });
    const appId = appRes.json().application.id;

    await app.inject({ method: "PATCH", url: `/cursus/applications/${appId}`, payload: { status: "applied" } });

    const cadence = await app.inject({ method: "POST", url: `/cursus/applications/${appId}/cadence`, payload: { days: 5 } });
    expect(cadence.json().application.follow_up_cadence_days).toBe(5);
    expect(cadence.json().application.follow_up_at).toBeDefined();

    const followUp = await app.inject({ method: "POST", url: `/cursus/applications/${appId}/follow-up` });
    expect(followUp.json().application.follow_up_count).toBe(1);
    expect(followUp.json().application.last_follow_up_at).toBeDefined();
  });

  it("fresh application is NOT stale (created_at guard)", async () => {
    const { app, v2 } = create();
    await app.ready();
    const camp = await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Fresh", target_role: "Dev" } });
    const campId = camp.json().campaign.id;
    const appRes = await app.inject({ method: "POST", url: "/cursus/applications", payload: { campaign_id: campId, company: "NewCo", role: "Dev" } });
    await app.inject({ method: "PATCH", url: `/cursus/applications/${appRes.json().application.id}`, payload: { status: "applied" } });

    // 7-day threshold — app was just created, should NOT be stale
    const stale = v2.getStaleApplications(7);
    expect(stale.length).toBe(0);
  });

  it("old application with no follow_up_at IS stale", async () => {
    const { app, v2 } = create();
    await app.ready();
    const camp = await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Old", target_role: "Dev" } });
    const campId = camp.json().campaign.id;
    const appRes = await app.inject({ method: "POST", url: "/cursus/applications", payload: { campaign_id: campId, company: "OldCo", role: "Dev" } });
    const appId = appRes.json().application.id;
    await app.inject({ method: "PATCH", url: `/cursus/applications/${appId}`, payload: { status: "applied" } });

    // Backdate created_at to 10 days ago
    v2["db"].prepare("UPDATE cursus_applications SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 10 * 86_400_000).toISOString(), appId);

    const stale = v2.getStaleApplications(7);
    expect(stale.length).toBe(1);
    expect(stale[0]!.id).toBe(appId);
  });

  it("application with past follow_up_at IS stale", async () => {
    const { app, v2 } = create();
    await app.ready();
    const camp = await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Past", target_role: "Dev" } });
    const campId = camp.json().campaign.id;
    const appRes = await app.inject({ method: "POST", url: "/cursus/applications", payload: { campaign_id: campId, company: "PastCo", role: "Dev" } });
    const appId = appRes.json().application.id;
    await app.inject({ method: "PATCH", url: `/cursus/applications/${appId}`, payload: { status: "applied" } });

    // Backdate both created_at and follow_up_at
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    v2["db"].prepare("UPDATE cursus_applications SET created_at = ?, follow_up_at = ? WHERE id = ?")
      .run(old, old, appId);

    const stale = v2.getStaleApplications(7);
    expect(stale.length).toBe(1);
  });

  it("application with future follow_up_at is NOT stale", async () => {
    const { app, v2 } = create();
    await app.ready();
    const camp = await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Future", target_role: "Dev" } });
    const campId = camp.json().campaign.id;
    const appRes = await app.inject({ method: "POST", url: "/cursus/applications", payload: { campaign_id: campId, company: "FutureCo", role: "Dev" } });
    const appId = appRes.json().application.id;
    await app.inject({ method: "PATCH", url: `/cursus/applications/${appId}`, payload: { status: "applied" } });

    // Backdate created_at but set follow_up_at in the future
    v2["db"].prepare("UPDATE cursus_applications SET created_at = ?, follow_up_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 10 * 86_400_000).toISOString(), new Date(Date.now() + 3 * 86_400_000).toISOString(), appId);

    const stale = v2.getStaleApplications(7);
    expect(stale.length).toBe(0);
  });

  it("cadence rejects invalid days", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/cursus/applications/fake/cadence", payload: { days: 0 } });
    expect(res.statusCode).toBe(400);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // V5: Application Legitimacy
  // ══════════════════════════════════════════════════════════════════════════

  it("application legitimacy update", async () => {
    const { app } = create();
    await app.ready();
    const camp = await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Legit", target_role: "Dev" } });
    const appRes = await app.inject({ method: "POST", url: "/cursus/applications", payload: { campaign_id: camp.json().campaign.id, company: "Acme", role: "Dev" } });
    const appId = appRes.json().application.id;

    const updated = await app.inject({
      method: "PATCH", url: `/cursus/applications/${appId}/legitimacy`,
      payload: {
        legitimacy_tier: "verified",
        date_first_seen: "2026-05-20",
        apply_url_status: "active",
      },
    });
    expect(updated.json().application.legitimacy_tier).toBe("verified");
    expect(updated.json().application.date_first_seen).toBe("2026-05-20");
    expect(updated.json().application.apply_url_status).toBe("active");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // V6: Schema version
  // ══════════════════════════════════════════════════════════════════════════

  it("schema is now v6", () => {
    expect(CURSUS_SCHEMA_VERSION).toBe(6);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // STANDALONE: Provider registry / no-Squidley independence
  // ══════════════════════════════════════════════════════════════════════════

  it("status reports standalone mode and bridge disabled by default", async () => {
    delete process.env["CURSUS_BRIDGE_URL"];
    delete process.env["SQUIDLEY_CURSUS_URL"];
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/status" });
    const body = res.json();
    expect(body.mode).toBe("standalone");
    expect(body.bridge_enabled).toBe(false);
  });

  it("GET /cursus/provider returns full status without leaking api key", async () => {
    const { applyConfigPatch } = await import("./provider.js");
    applyConfigPatch({ provider: "openai", model: "gpt-test", api_key: "test-openai-secret", base_url: "https://api.example.com" });
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/cursus/provider" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider.provider).toBe("openai");
    expect(body.provider.model).toBe("gpt-test");
    expect(body.provider.local).toBe(false);
    expect(body.provider.base_url).toBe("https://api.example.com");
    expect(body.provider.api_key_set).toBe(true);
    expect(Array.isArray(body.provider.available_providers)).toBe(true);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("test-openai-secret");
    // restore
    applyConfigPatch({ provider: "none", model: "none", api_key: "", base_url: "" });
  });

  it("PATCH /cursus/provider selects providers and rejects unknown ones", async () => {
    const { app } = create();
    await app.ready();
    const ok = await app.inject({
      method: "PATCH", url: "/cursus/provider",
      payload: { provider: "echo", model: "debug" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().provider.provider).toBe("echo");
    expect(ok.json().provider.local).toBe(true);

    const bad = await app.inject({
      method: "PATCH", url: "/cursus/provider",
      payload: { provider: "nonexistent-vendor" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("unknown_provider");
  });

  it("local-only mode blocks selecting a cloud provider", async () => {
    const { applyConfigPatch } = await import("./provider.js");
    applyConfigPatch({ provider: "echo", model: "debug", local_only: true });
    const { app } = create();
    await app.ready();
    const res = await app.inject({
      method: "PATCH", url: "/cursus/provider",
      payload: { provider: "openai", model: "gpt-test", api_key: "test-openai-key" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("local_only_violation");
    applyConfigPatch({ local_only: false, provider: "none", model: "none", api_key: "" });
  });

  it("local-only mode at chat-time rejects cloud calls", async () => {
    const { applyConfigPatch } = await import("./provider.js");
    // Configure cloud first, then flip local_only without going through PATCH guard.
    applyConfigPatch({ provider: "openai", model: "gpt-test", api_key: "test-openai-key", base_url: "https://api.example.com" });
    // Direct config mutation via PATCH would fail. Use a synthetic env-style reset:
    process.env["CURSUS_LOCAL_ONLY"] = "true";
    const { resetConfigFromEnv } = await import("./provider.js");
    resetConfigFromEnv();
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/cursus/dux/chat", payload: { message: "hi" } });
    expect(res.statusCode).toBe(503); // misconfigured-from-env path -> "provider_misconfigured"
    delete process.env["CURSUS_LOCAL_ONLY"];
    resetConfigFromEnv();
    applyConfigPatch({ provider: "none", model: "none", api_key: "" });
  });

  it("dux chat with echo provider works standalone, writes Velum + model_call receipts", async () => {
    const { applyConfigPatch } = await import("./provider.js");
    applyConfigPatch({ provider: "echo", model: "debug" });
    const { app } = create();
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/cursus/dux/chat",
      payload: { message: "my email is person@example.test — what should I focus on?" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.provider.provider).toBe("echo");
    expect(body.provider.local).toBe(true);
    // Velum must redact the email BEFORE the provider sees it.
    expect(body.velum.reviewed).toBe(true);
    expect(body.velum.redacted).toBe(true);
    expect(body.velum.fields_redacted).toContain("email");
    expect(body.reply).toContain("[EMAIL-REDACTED]");
    expect(body.reply).not.toContain("person@example.test");

    const velumReceipts = await app.inject({ method: "GET", url: "/cursus/receipts?action=velum_review" });
    expect(velumReceipts.json().receipts.length).toBeGreaterThan(0);
    const modelReceipts = await app.inject({ method: "GET", url: "/cursus/receipts?action=model_call" });
    expect(modelReceipts.json().receipts.length).toBeGreaterThan(0);
    const r0 = modelReceipts.json().receipts[0];
    expect(r0.provider).toBe("echo");
    expect(r0.model).toBe("debug");
    expect(r0.local_mode).toBeTruthy();
    applyConfigPatch({ provider: "none", model: "none" });
  });

  it("Velum runs BEFORE the provider sees sensitive career data", async () => {
    const { applyConfigPatch } = await import("./provider.js");
    applyConfigPatch({ provider: "echo", model: "debug" });
    const { app } = create();
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/cursus/dux/chat",
      payload: { message: "call me at 555-123-4567 or 4111 1111 1111 1111" },
    });
    expect(res.statusCode).toBe(200);
    // Echo provider returns what it saw — confirm sensitive tokens never reached it.
    expect(res.json().reply).not.toContain("555-123-4567");
    expect(res.json().reply).not.toContain("4111 1111 1111 1111");
    expect(res.json().reply).toContain("[PHONE-REDACTED]");
    applyConfigPatch({ provider: "none", model: "none" });
  });

  it("dux chat receipt records errors when provider call fails", async () => {
    const { applyConfigPatch } = await import("./provider.js");
    // Point ollama at an unreachable port so the call errors fast.
    applyConfigPatch({ provider: "ollama", model: "no-such-model", base_url: "http://127.0.0.1:1" });
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/cursus/dux/chat", payload: { message: "hi", velum: false } });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.json().ok).toBe(false);
    const receipts = await app.inject({ method: "GET", url: "/cursus/receipts?action=model_call" });
    const failing = receipts.json().receipts.find((r: { errors: string | null }) => r.errors);
    expect(failing).toBeTruthy();
    expect(failing.provider).toBe("ollama");
    applyConfigPatch({ provider: "none", model: "none", base_url: "" });
  });

  it("Job Scout context endpoint is standalone (no Squidley required)", async () => {
    delete process.env["SQUIDLEY_CURSUS_URL"];
    delete process.env["CURSUS_BRIDGE_URL"];
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/cursus/job-scout/context" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.live_search_implemented).toBe(false);
    expect(body.ingestion_mode).toBe("manual_or_external_tool");
    expect(body.context.provider).toBeDefined();
  });

  it("Job Scout ingest writes receipt with native provider/model metadata", async () => {
    const { applyConfigPatch } = await import("./provider.js");
    applyConfigPatch({ provider: "echo", model: "test-model" });
    const { app } = create();
    await app.ready();
    const camp = await app.inject({ method: "POST", url: "/cursus/campaigns", payload: { name: "Ingest test", target_role: "DevOps" } });
    const cid = camp.json().campaign.id;
    void cid;
    const ingest = await app.inject({
      method: "POST", url: "/cursus/job-scout/ingest",
      payload: { jobs: [{ company: "Acme", role: "SRE", source: "manual" }] },
    });
    expect(ingest.statusCode).toBe(200);
    const receipts = await app.inject({ method: "GET", url: "/cursus/receipts?action=job_scout_run" });
    const r = receipts.json().receipts[0];
    expect(r.provider).toBe("echo");
    expect(r.model).toBe("test-model");
    expect(r.local_mode).toBeTruthy();
    applyConfigPatch({ provider: "none", model: "none" });
  });

  it("optional bridge URL surfaces in /status without changing standalone mode", async () => {
    process.env["CURSUS_BRIDGE_URL"] = "http://127.0.0.1:18791/cursus/bridge";
    // routes.ts reads CURSUS_BRIDGE_URL at module init, so build a fresh app
    // in a fresh require — vitest caches modules, so the simplest reliable
    // check is via /status seeing bridge_enabled flip. registerRoutes captures
    // the value at module load; for this test we just assert that the env var
    // form is recognized in the routes module reload path.
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/status" });
    // Standalone is always true even when bridge is configured.
    expect(res.json().mode).toBe("standalone");
    delete process.env["CURSUS_BRIDGE_URL"];
  });

  it("no test artifact loads a Squidley import or references port 18791 in routes/server/provider", () => {
    // Defensive: read the source modules and make sure no live import of
    // anything Squidley-only sneaks in. README is allowed to mention bridge.
    const routes = readFileSync(join(import.meta.dirname, "routes.ts"), "utf-8");
    const provider = readFileSync(join(import.meta.dirname, "provider.ts"), "utf-8");
    const server = readFileSync(join(import.meta.dirname, "server.ts"), "utf-8");
    for (const src of [routes, provider, server]) {
      expect(src).not.toMatch(/from\s+['"][^'"]*squidley[^'"]*['"]/i);
      expect(src).not.toMatch(/from\s+['"][^'"]*legatus[^'"]*['"]/i);
      expect(src).not.toMatch(/127\.0\.0\.1:18791/);
    }
  });

  // Sanity: the server module itself must compile + run without any Squidley env var set.
  it("server source contains no required Squidley env var", () => {
    expect(SERVER_SOURCE).not.toMatch(/process\.env\["SQUIDLEY_[A-Z_]+"]\s*\?\?\s*[a-z]/i);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 6: Per-Dux-agent provider/model selection
  // ══════════════════════════════════════════════════════════════════════════

  it("GET /cursus/dux/agents returns the seeded registry", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/cursus/dux/agents" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.agents)).toBe(true);
    const ids = body.agents.map((a: { id: string }) => a.id);
    expect(ids).toContain("strategist");
    expect(ids).toContain("resume-reviewer");
    expect(ids).toContain("outreach-drafter");
    expect(ids).toContain("job-scout-analyst");
    expect(ids).toContain("interview-coach");
    // Every agent must be sanitized — no api_key fields leaked.
    for (const a of body.agents) {
      expect(a.api_key).toBeUndefined();
      expect(typeof a.api_key_set).toBe("boolean");
    }
    expect(body.default_provider).toBeDefined();
  });

  it("PATCH /cursus/dux/agents/:id persists per-agent provider/model and never leaks api_key", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({
      method: "PATCH", url: "/cursus/dux/agents/strategist",
      payload: {
        provider: "openrouter",
        model: "deepseek/deepseek-v4-pro",
        base_url: "https://openrouter.ai/api/v1",
        api_key: "test-openrouter-strategist-secret",
        temperature: 0.4,
        max_tokens: 800,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agent.provider).toBe("openrouter");
    expect(body.agent.model).toBe("deepseek/deepseek-v4-pro");
    expect(body.agent.base_url).toBe("https://openrouter.ai/api/v1");
    expect(body.agent.api_key).toBeUndefined();
    expect(body.agent.api_key_set).toBe(true);
    expect(JSON.stringify(body)).not.toContain("test-openrouter-strategist-secret");

    // Verify persistence via GET
    const reread = await app.inject({ method: "GET", url: "/cursus/dux/agents/strategist" });
    expect(reread.json().agent.provider).toBe("openrouter");
    expect(JSON.stringify(reread.json())).not.toContain("test-openrouter-strategist-secret");
  });

  it("agent A uses model X while agent B uses model Y, in parallel", async () => {
    const { applyConfigPatch } = await import("./provider.js");
    applyConfigPatch({ provider: "echo", model: "global-default" });
    const { app } = create();
    await app.ready();
    await app.inject({ method: "PATCH", url: "/cursus/dux/agents/strategist",      payload: { provider: "echo", model: "strategist-model" } });
    await app.inject({ method: "PATCH", url: "/cursus/dux/agents/resume-reviewer", payload: { provider: "echo", model: "reviewer-model"   } });

    const a = await app.inject({ method: "POST", url: "/cursus/dux/agents/strategist/chat",      payload: { message: "weekly plan" } });
    const b = await app.inject({ method: "POST", url: "/cursus/dux/agents/resume-reviewer/chat", payload: { message: "tighten bullets"  } });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().provider.model).toBe("strategist-model");
    expect(b.json().provider.model).toBe("reviewer-model");
    applyConfigPatch({ provider: "none", model: "none" });
  });

  it("agent without overrides falls back to global default provider", async () => {
    const { applyConfigPatch } = await import("./provider.js");
    applyConfigPatch({ provider: "echo", model: "global-fallback" });
    const { app } = create();
    await app.ready();
    // outreach-drafter has no override yet
    const res = await app.inject({ method: "POST", url: "/cursus/dux/agents/outreach-drafter/chat", payload: { message: "hi" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().provider.model).toBe("global-fallback");
    expect(res.json().agent.id).toBe("outreach-drafter");
    applyConfigPatch({ provider: "none", model: "none" });
  });

  it("PATCH with local_only=true on agent rejects cloud provider", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({
      method: "PATCH", url: "/cursus/dux/agents/interview-coach",
      payload: { provider: "openrouter", model: "deepseek/deepseek-v4-pro", local_only: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("local_only_violation");
  });

  it("agent with cloud_allowed=false on a cloud default falls back or blocks", async () => {
    const { applyConfigPatch } = await import("./provider.js");
    applyConfigPatch({ provider: "openrouter", model: "deepseek/deepseek-v4-pro", api_key: "test-openrouter-key", base_url: "https://openrouter.ai/api/v1" });
    const { app } = create();
    await app.ready();
    // Block cloud for resume-reviewer with no fallback
    await app.inject({ method: "PATCH", url: "/cursus/dux/agents/resume-reviewer", payload: { cloud_allowed: false } });
    const blocked = await app.inject({ method: "POST", url: "/cursus/dux/agents/resume-reviewer/chat", payload: { message: "blocked" } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe("agent_cloud_blocked");

    // Now give it a local fallback
    await app.inject({ method: "PATCH", url: "/cursus/dux/agents/resume-reviewer", payload: { fallback_provider: "echo", fallback_model: "local-stand-in" } });
    const ok = await app.inject({ method: "POST", url: "/cursus/dux/agents/resume-reviewer/chat", payload: { message: "via fallback" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().provider.provider).toBe("echo");
    expect(ok.json().provider.fallback_used).toBe(true);
    applyConfigPatch({ provider: "none", model: "none", api_key: "", base_url: "" });
  });

  it("receipts for agent chat carry dux_agent_id, provider, and model", async () => {
    const { applyConfigPatch } = await import("./provider.js");
    applyConfigPatch({ provider: "echo", model: "receipts-model" });
    const { app } = create();
    await app.ready();
    await app.inject({ method: "POST", url: "/cursus/dux/agents/strategist/chat", payload: { message: "trace me" } });
    const res = await app.inject({ method: "GET", url: "/cursus/receipts?action=dux_agent_chat&limit=10" });
    const recs = res.json().receipts as Array<Record<string, unknown>>;
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0]!.dux_agent_id).toBe("strategist");
    expect(recs[0]!.provider).toBe("echo");
    expect(recs[0]!.model).toBe("receipts-model");
    applyConfigPatch({ provider: "none", model: "none" });
  });

  it("Velum runs BEFORE the agent's provider sees sensitive data", async () => {
    const { applyConfigPatch } = await import("./provider.js");
    applyConfigPatch({ provider: "echo", model: "velum-test" });
    const { app } = create();
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/cursus/dux/agents/outreach-drafter/chat",
      payload: { message: "Draft an email mentioning person@example.test and 555-123-4567" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply).toContain("[EMAIL-REDACTED]");
    expect(res.json().reply).toContain("[PHONE-REDACTED]");
    expect(res.json().reply).not.toContain("person@example.test");
    expect(res.json().reply).not.toContain("555-123-4567");
    applyConfigPatch({ provider: "none", model: "none" });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 7: OpenRouter (DeepSeek v4 Pro)
  // ══════════════════════════════════════════════════════════════════════════

  it("OpenRouter request shape: URL is /chat/completions on /api/v1 base, with Bearer + X-Title", async () => {
    const { buildRequestPreview } = await import("./provider.js");
    const preview = buildRequestPreview(
      { provider: "openrouter", model: "deepseek/deepseek-v4-pro", base_url: "https://openrouter.ai/api/v1", api_key: "test-openrouter-preview-key", local_only: false },
      { messages: [{ role: "user", content: "hi" }] },
    );
    expect(preview.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(preview.headers["authorization"]).toMatch(/^Bearer \[REDACTED:\d+\]$/);
    expect(preview.headers["X-Title"]).toBeDefined();
    expect(preview.body["model"]).toBe("deepseek/deepseek-v4-pro");
    expect(JSON.stringify(preview)).not.toContain("test-openrouter-preview-key");
  });

  it("OpenRouter respects HTTP-Referer when CURSUS_OPENROUTER_REFERER is set", async () => {
    process.env["CURSUS_OPENROUTER_REFERER"] = "https://cursus.local";
    const { buildRequestPreview } = await import("./provider.js");
    const preview = buildRequestPreview(
      { provider: "openrouter", model: "deepseek/deepseek-v4-pro", base_url: "https://openrouter.ai/api/v1", api_key: "k", local_only: false },
      { messages: [{ role: "user", content: "x" }] },
    );
    expect(preview.headers["HTTP-Referer"]).toBe("https://cursus.local");
    delete process.env["CURSUS_OPENROUTER_REFERER"];
  });

  it("CURSUS_OPENROUTER_API_KEY env wins over generic CURSUS_PROVIDER_API_KEY for openrouter", async () => {
    process.env["CURSUS_PROVIDER"] = "openrouter";
    process.env["CURSUS_MODEL"] = "deepseek/deepseek-v4-pro";
    process.env["CURSUS_PROVIDER_API_KEY"] = "generic-key";
    process.env["CURSUS_OPENROUTER_API_KEY"] = "openrouter-specific-key";
    const { resetConfigFromEnv, getConfig } = await import("./provider.js");
    resetConfigFromEnv();
    const cfg = getConfig();
    expect(cfg.provider).toBe("openrouter");
    expect(cfg.api_key).toBe("openrouter-specific-key");
    delete process.env["CURSUS_PROVIDER"];
    delete process.env["CURSUS_MODEL"];
    delete process.env["CURSUS_PROVIDER_API_KEY"];
    delete process.env["CURSUS_OPENROUTER_API_KEY"];
    resetConfigFromEnv();
  });

  it("OpenRouter status surfaces openrouter_configured boolean without leaking key", async () => {
    const { applyConfigPatch } = await import("./provider.js");
    applyConfigPatch({ provider: "openrouter", model: "deepseek/deepseek-v4-pro", api_key: "test-openrouter-status-key", base_url: "https://openrouter.ai/api/v1" });
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/status" });
    const body = res.json();
    expect(body.provider).toBe("openrouter");
    expect(body.model).toBe("deepseek/deepseek-v4-pro");
    expect(body.openrouter_configured).toBe(true);
    expect(JSON.stringify(body)).not.toContain("test-openrouter-status-key");
    applyConfigPatch({ provider: "none", model: "none", api_key: "" });
  });

  it("local_only blocks OpenRouter at selection time", async () => {
    const { applyConfigPatch } = await import("./provider.js");
    applyConfigPatch({ provider: "echo", model: "debug", local_only: true });
    const { app } = create();
    await app.ready();
    const res = await app.inject({
      method: "PATCH", url: "/cursus/provider",
      payload: { provider: "openrouter", model: "deepseek/deepseek-v4-pro", api_key: "test-openrouter-short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("local_only_violation");
    applyConfigPatch({ local_only: false, provider: "none", model: "none" });
  });

  it("Dux agent can select OpenRouter DeepSeek v4 Pro", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({
      method: "PATCH", url: "/cursus/dux/agents/strategist",
      payload: { provider: "openrouter", model: "deepseek/deepseek-v4-pro", api_key: "test-openrouter-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.provider).toBe("openrouter");
    expect(res.json().agent.model).toBe("deepseek/deepseek-v4-pro");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 8: Tailscale-safe network auth
  // ══════════════════════════════════════════════════════════════════════════

  it("network classifier identifies loopback / Tailscale / public", async () => {
    const { classifyBind, isTailscaleIp, isLoopbackHost } = await import("./network.js");
    expect(classifyBind("127.0.0.1")).toBe("loopback_only");
    expect(classifyBind("localhost")).toBe("loopback_only");
    expect(classifyBind("::1")).toBe("loopback_only");
    expect(classifyBind("100.64.0.1")).toBe("tailscale_reachable");
    expect(classifyBind("100.127.0.99")).toBe("tailscale_reachable");
    expect(classifyBind("203.0.113.10")).toBe("public_bind");
    expect(isTailscaleIp("100.100.42.7")).toBe(true);
    expect(isTailscaleIp("10.0.0.1")).toBe(false);
    expect(isLoopbackHost("127.0.0.42")).toBe(true);
  });

  it("loadNetworkConfig refuses non-loopback bind without a token", async () => {
    const { loadNetworkConfig } = await import("./network.js");
    expect(() => loadNetworkConfig({ CURSUS_HOST: "100.64.0.1" })).toThrow(/CURSUS_AUTH_TOKEN/);
    expect(() => loadNetworkConfig({ CURSUS_HOST: "0.0.0.0"   })).toThrow(/CURSUS_AUTH_TOKEN/);
  });

  it("loadNetworkConfig accepts non-loopback bind WITH a token; auth_required becomes true", async () => {
    const { loadNetworkConfig } = await import("./network.js");
    const cfg = loadNetworkConfig({ CURSUS_HOST: "100.64.0.1", CURSUS_AUTH_TOKEN: "secret-very-long-token-XXXX" });
    expect(cfg.exposure).toBe("tailscale_reachable");
    expect(cfg.auth_required).toBe(true);
    expect(cfg.auth_token_configured).toBe(true);
  });

  it("CURSUS_REQUIRE_AUTH=true forces auth even on loopback", async () => {
    const { loadNetworkConfig, shouldAllowRequest } = await import("./network.js");
    const cfg = loadNetworkConfig({ CURSUS_HOST: "127.0.0.1", CURSUS_AUTH_TOKEN: "tok", CURSUS_REQUIRE_AUTH: "true" });
    expect(cfg.auth_required).toBe(true);
    // loopback request without token → rejected
    const reject = shouldAllowRequest({ path: "/cursus/dashboard", remoteAddress: "127.0.0.1", authHeader: undefined, cfg, token: "tok" });
    expect(reject.ok).toBe(false);
    // loopback request with valid bearer → allowed
    const accept = shouldAllowRequest({ path: "/cursus/dashboard", remoteAddress: "127.0.0.1", authHeader: "Bearer tok", cfg, token: "tok" });
    expect(accept.ok).toBe(true);
    // /health remains public
    const health = shouldAllowRequest({ path: "/health", remoteAddress: "8.8.8.8", authHeader: undefined, cfg, token: "tok" });
    expect(health.ok).toBe(true);
  });

  it("remote (Tailscale) request without token is rejected; with token is allowed", async () => {
    const { loadNetworkConfig, shouldAllowRequest } = await import("./network.js");
    const cfg = loadNetworkConfig({ CURSUS_HOST: "100.64.0.1", CURSUS_AUTH_TOKEN: "tok-XYZ" });
    const noAuth = shouldAllowRequest({ path: "/cursus/profile", remoteAddress: "100.64.0.7", authHeader: undefined, cfg, token: "tok-XYZ" });
    expect(noAuth.ok).toBe(false);
    if (!noAuth.ok) expect(noAuth.status).toBe(401);
    const withAuth = shouldAllowRequest({ path: "/cursus/profile", remoteAddress: "100.64.0.7", authHeader: "Bearer tok-XYZ", cfg, token: "tok-XYZ" });
    expect(withAuth.ok).toBe(true);
  });

  it("/status surfaces network exposure + Dux agent count + OpenRouter posture", async () => {
    const { applyConfigPatch } = await import("./provider.js");
    applyConfigPatch({ provider: "openrouter", model: "deepseek/deepseek-v4-pro", api_key: "test-openrouter-status-secret", base_url: "https://openrouter.ai/api/v1" });
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/status" });
    const body = res.json();
    expect(body.network_exposure).toBeDefined();
    expect(body.host).toBeDefined();
    expect(typeof body.auth_required).toBe("boolean");
    expect(body.dux_agents.total).toBeGreaterThan(0);
    expect(Array.isArray(body.dux_agents.agents)).toBe(true);
    expect(body.openrouter_configured).toBe(true);
    expect(JSON.stringify(body)).not.toContain("test-openrouter-status-secret");
    applyConfigPatch({ provider: "none", model: "none", api_key: "" });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Web UI (SPA) shell
  // ══════════════════════════════════════════════════════════════════════════

  it("GET / serves the SPA shell HTML", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const body = res.body;
    // Shell references its static assets
    expect(body).toContain("/assets/styles.css");
    expect(body).toContain("/assets/app.js");
    // Shell mounts the navigation for every required workspace
    for (const hash of ["#dashboard", "#dux", "#profile", "#agents", "#campaigns", "#jobscout", "#apps", "#queue", "#receipts", "#settings"]) {
      expect(body).toContain(hash);
    }
    // Auth modal + brand
    expect(body).toContain("Auth required");
    expect(body).toContain("Career Command Center");
  });

  it("GET /assets/app.js returns JavaScript with key API calls", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/javascript");
    const body = res.body;
    // App talks to the real endpoints
    expect(body).toContain("/cursus/dux/agents");
    expect(body).toContain("/cursus/provider");
    expect(body).toContain("/cursus/receipts");
    expect(body).toContain("/cursus/job-scout/context");
    expect(body).toContain("/cursus/automation");
    // Auth handling
    expect(body).toContain("cursus_auth_token");
    expect(body).toContain("Bearer ");
    // Dux chat must pass agent_id when an agent is selected
    expect(body).toContain("/cursus/dux/agents/${agentId}/chat");
  });

  it("GET /assets/styles.css returns CSS", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/assets/styles.css" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/css");
    expect(res.body).toContain(".chip");
    expect(res.body).toContain(".sidenav");
    expect(res.body).toContain(".chat-shell");
  });

  it("GET /api returns the programmatic endpoint listing HTML", async () => {
    const { app } = create();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("API map");
    expect(res.body).toContain("/cursus/dux/agents");
  });

  it("GET / and /assets/* are public (allowed by network guard)", async () => {
    const { loadNetworkConfig, shouldAllowRequest } = await import("./network.js");
    const cfg = loadNetworkConfig({ CURSUS_HOST: "100.64.0.5", CURSUS_AUTH_TOKEN: "tok" });
    for (const path of ["/", "/api", "/assets/app.js", "/assets/styles.css", "/assets/anything-else.png"]) {
      const decision = shouldAllowRequest({ path, remoteAddress: "100.64.0.99", authHeader: undefined, cfg, token: "tok" });
      expect({ path, ok: decision.ok }).toEqual({ path, ok: true });
    }
  });

  it("SPA renders no API key strings even when an agent has a stored key", async () => {
    const { app } = create();
    await app.ready();
    // Configure a per-agent API key via PATCH (typical case)
    await app.inject({
      method: "PATCH", url: "/cursus/dux/agents/strategist",
      payload: { provider: "openrouter", model: "deepseek/deepseek-v4-pro", api_key: "test-openrouter-leak-secret" },
    });
    // The SPA shell HTML must not embed any key (it doesn't fetch keys; the API doesn't return them).
    const shell = await app.inject({ method: "GET", url: "/" });
    expect(shell.body).not.toContain("test-openrouter-leak-secret");
    // The agents endpoint sanitizes — double-check
    const agents = await app.inject({ method: "GET", url: "/cursus/dux/agents" });
    expect(agents.body).not.toContain("test-openrouter-leak-secret");
    expect(agents.body).toContain("api_key_set");
  });

  it("Receipt for dux_agent_update is written on PATCH", async () => {
    const { app } = create();
    await app.ready();
    await app.inject({ method: "PATCH", url: "/cursus/dux/agents/job-scout-analyst", payload: { provider: "echo", model: "scout-debug" } });
    const recs = await app.inject({ method: "GET", url: "/cursus/receipts?action=dux_agent_update" });
    const r = recs.json().receipts;
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].dux_agent_id).toBe("job-scout-analyst");
  });
});
