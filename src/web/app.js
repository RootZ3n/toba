/*  Toba Career Transformation Platform — frontend
 *  ------------------------------------------------
 *  Vanilla JS SPA. Hash-routed. Talks to the local Toba API.
 *  No external libs. Edit live; no build step.
 */

"use strict";

// ── State ────────────────────────────────────────────────────────────────
let serverStatus = null;
let agentsCache  = null;

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return node;
};
const fmtTime = (iso) => {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
};
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);

async function api(path, opts = {}) {
  const headers = { "accept": "application/json", ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData)) {
    headers["content-type"] = headers["content-type"] || "application/json";
    if (typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { ...opts, headers });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    if (res.status === 401) showAuthModal({ msg: "Token required or invalid." });
    const err = new Error(typeof data === "string" ? data : (data.error || `HTTP ${res.status}`));
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read selected file"));
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function markdownInline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function markdownToHtml(markdown) {
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  const out = [];
  let para = [];
  let list = null;
  let code = false;
  let codeLines = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${markdownInline(para.join(" ").trim())}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.type}>${list.items.map(i => `<li>${markdownInline(i)}</li>`).join("")}</${list.type}>`);
    list = null;
  };
  const flushCode = () => {
    if (!codeLines.length) return;
    out.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeLines = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim().startsWith("```")) {
      if (code) { flushCode(); code = false; }
      else { flushPara(); flushList(); code = true; }
      continue;
    }
    if (code) { codeLines.push(raw); continue; }

    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min(4, heading[1].length + 2);
      out.push(`<h${level}>${markdownInline(heading[2])}</h${level}>`);
      continue;
    }

    const ordered = /^\d+\.\s+(.+)$/.exec(line);
    const unordered = /^[-*]\s+(.+)$/.exec(line);
    if (ordered || unordered) {
      flushPara();
      const type = ordered ? "ol" : "ul";
      if (!list || list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push((ordered || unordered)[1]);
      continue;
    }

    para.push(line.trim());
  }
  flushCode();
  flushPara();
  flushList();
  return out.join("");
}

// ── Toast ────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 4200);
}

// ── Status chip refresh ──────────────────────────────────────────────────
async function refreshStatus() {
  try {
    serverStatus = await api("/status");
    paintChips();
  } catch (err) {
    toast(`Status error: ${err.message}`, "err");
  }
}
function paintChips() {
  const setChip = (key, text, kind = "") => {
    const node = $(`[data-bind="${key}"]`);
    if (!node) return;
    node.textContent = text;
    node.className = `chip ${kind}`.trim();
  };
  const s = serverStatus || {};
  setChip("status.service",  s.ok ? "online" : "offline",                        s.ok ? "ok" : "err");
  setChip("status.exposure", s.network_exposure || "—",                          s.network_exposure === "loopback_only" ? "ok" : "cloud");
  setChip("status.provider", s.provider ? `${s.provider}/${s.model || "?"}` : "no provider",
                              s.provider_configured ? "ok" : (s.provider && s.provider !== "none" ? "warn" : ""));
  setChip("status.version",  s.host ? `${s.host}:${s.port} · v${s.dux_agents ? "" : ""}schema${s._sv || ""}` : "toba");
}

// ── Routing ──────────────────────────────────────────────────────────────
const ROUTES = {
  dashboard: renderDashboard,
  dux:       renderDuxChat,
  profile:   renderProfile,
  agents:    renderAgents,
  campaigns: renderCampaigns,
  jobscout:  renderJobScout,
  apps:      renderApplications,
  queue:     renderQueue,
  receipts:  renderReceipts,
  settings:  renderSettings,
};
window.addEventListener("hashchange", () => navigate(location.hash || "#dashboard"));

async function navigate(hash) {
  const key = (hash || "#dashboard").replace(/^#/, "").split("?")[0];
  $$(".nav-item").forEach(a => a.classList.toggle("active", a.getAttribute("href") === `#${key}`));
  const main = $("#main");
  main.innerHTML = `<section class="loading">Loading ${key}…</section>`;
  const handler = ROUTES[key] || renderDashboard;
  try {
    await handler(main);
  } catch (err) {
    main.innerHTML = "";
    main.appendChild(el("div", { class: "banner err" }, `Error: ${err.message}`));
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────
(async function boot() {
  await refreshStatus();
  navigate(location.hash || "#dashboard");
  // Light periodic refresh
  setInterval(refreshStatus, 30_000);
})();

// ═══════════════════════════════════════════════════════════════════════════
//  Views
// ═══════════════════════════════════════════════════════════════════════════

// ── Dashboard ────────────────────────────────────────────────────────────
async function renderDashboard(root) {
  const [status, dashboard, receipts] = await Promise.allSettled([
    api("/status"),
    api("/toba/dashboard").catch(() => null),
    api("/toba/receipts?limit=8").catch(() => null),
  ]);
  const s = status.status === "fulfilled" ? status.value : {};
  const d = dashboard.status === "fulfilled" ? dashboard.value?.dashboard : null;
  const r = receipts.status === "fulfilled" ? receipts.value?.receipts || [] : [];

  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Dashboard"));
  root.appendChild(el("p", { class: "muted" }, "Service status, active campaign, provider, and recent activity at a glance."));

  // Status row
  const stats = el("div", { class: "grid cols4" });
  const mkStat = (label, value, klass = "") =>
    el("div", { class: "stat" },
      el("div", { class: "stat-label" }, label),
      el("div", { class: `stat-value ${klass}` }, value ?? "—"));

  stats.append(
    mkStat("Service",        s.ok ? "online" : "offline",                 s.ok ? "" : "dim"),
    mkStat("Mode",           s.mode || "?"),
    mkStat("Bind",           s.host && s.port ? `${s.host}:${s.port}` : "?"),
    mkStat("Exposure",       s.network_exposure || "?"),
    mkStat("Provider",       s.provider || "none"),
    mkStat("Model",          s.model || "—"),
    mkStat("Local-only",     s.local_only_mode ? "yes" : "no"),
    mkStat("Dux agents",     s.dux_agents ? `${s.dux_agents.enabled}/${s.dux_agents.total}` : "—"),
    mkStat("Pending approvals", String(s.pending_approvals ?? 0)),
    mkStat("Active campaign", s.active_campaign?.name || "—"),
    mkStat("Last Job Scout", s.last_job_scout_run ? fmtTime(s.last_job_scout_run) : "never"),
  );
  root.appendChild(stats);

  // Next action card
  if (d?.next_action) {
    root.appendChild(el("div", { class: "card", style: "margin-top:1rem;" },
      el("h3", {}, "Next action"),
      el("p", {}, d.next_action),
    ));
  }

  // Recent receipts
  const recipientCard = el("div", { class: "card", style: "margin-top:1rem;" }, el("h3", {}, "Latest receipts"));
  if (r.length === 0) {
    recipientCard.appendChild(el("div", { class: "empty" }, "No receipts yet."));
  } else {
    for (const rec of r.slice(0, 8)) {
      recipientCard.appendChild(receiptRow(rec));
    }
  }
  root.appendChild(recipientCard);
}

// ── Dux Chat ─────────────────────────────────────────────────────────────
async function renderDuxChat(root) {
  if (!agentsCache) {
    try { agentsCache = await api("/toba/dux/agents"); } catch (err) { agentsCache = { agents: [] }; }
  }
  const uploadedResumes = await api("/toba/resumes").then(r => r.resumes || []).catch(() => []);
  const latestResume = uploadedResumes[0] || null;
  const resumeContextDefault = !!latestResume && latestResume.velum_reviewed === 1;
  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Dux Chat"));
  root.appendChild(el("p", { class: "muted" },
    "Talk to a Dux agent. Velum redacts your input before the provider sees it."));

  const shell = el("div", { class: "chat-shell" });
  const controls = el("div", { class: "chat-controls" });
  const agentSelect = el("select", { class: "grow" });
  agentSelect.appendChild(el("option", { value: "" }, "(default — global provider)"));
  for (const a of agentsCache.agents || []) {
    const meta = a.provider ? `${a.provider}/${a.model || "?"}` : "default";
    agentSelect.appendChild(el("option", { value: a.id }, `${a.display_name || a.id} — ${meta}`));
  }
  const velumChk = el("label", { class: "row" },
    el("input", { type: "checkbox", id: "velumOn", checked: true, style: "width:auto;" }),
    el("span", { class: "small muted" }, "Velum on"));
  const contextControls = el("div", { class: "row", style: "flex-wrap:wrap;" },
    el("label", { class: "row small" }, el("input", { type: "checkbox", id: "ctxProfile", checked: true, style: "width:auto;" }), "Include profile"),
    el("label", { class: "row small" }, el("input", { type: "checkbox", id: "ctxResume", checked: resumeContextDefault, style: "width:auto;" }), "Include resume"),
    el("label", { class: "row small" }, el("input", { type: "checkbox", id: "ctxCampaign", checked: true, style: "width:auto;" }), "Include active campaign"),
    el("label", { class: "row small" }, el("input", { type: "checkbox", id: "ctxApplications", checked: true, style: "width:auto;" }), "Include applications/jobs"),
    el("label", { class: "row small" }, el("input", { type: "checkbox", id: "ctxReceipts", style: "width:auto;" }), "Include recent receipts"));
  const clearBtn = el("button", { class: "btn-ghost", onclick: () => { log.innerHTML = ""; } }, "Clear");
  controls.append(agentSelect, velumChk, clearBtn);

  const log = el("div", { class: "chat-log" });
  log.appendChild(el("div", { class: "chat-msg system" },
    el("div", { class: "who" }, "system"),
    "Ready. Pick an agent above (or use the global default) and send a message."));

  const form = el("form", { class: "chat-form" });
  const ta = el("textarea", { placeholder: "Ask Dux…  (Enter to send · Shift+Enter for newline)" });
  const sendBtn = el("button", { class: "btn-primary", type: "submit" }, "Send");
  form.append(ta, sendBtn);

  shell.append(controls, contextControls, log, form);
  root.appendChild(shell);

  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = ta.value.trim();
    if (!msg) return;
    ta.value = "";
    log.appendChild(el("div", { class: "chat-msg user" },
      el("div", { class: "who" }, "you"),
      msg));
    log.scrollTop = log.scrollHeight;

    const agentId = agentSelect.value;
    const url = agentId ? `/toba/dux/agents/${agentId}/chat` : "/toba/dux/chat";
    const placeholder = el("div", { class: "chat-msg assistant" },
      el("div", { class: "who" }, agentId || "dux"),
      el("span", { class: "muted" }, "Thinking…"));
    log.appendChild(placeholder);
    log.scrollTop = log.scrollHeight;

    try {
      const body = {
        message: msg,
        velum: $("#velumOn").checked,
        include_context: {
          profile: $("#ctxProfile").checked,
          resume: $("#ctxResume").checked,
          campaign: $("#ctxCampaign").checked,
          applications: $("#ctxApplications").checked,
          receipts: $("#ctxReceipts").checked,
        },
      };
      const res = await api(url, { method: "POST", body });
      placeholder.innerHTML = "";
      placeholder.appendChild(el("div", { class: "who" }, res.agent?.id || agentId || "dux"));
      placeholder.appendChild(el("div", { class: "markdown", html: markdownToHtml(res.reply || "") }));
      const metaBits = [];
      if (res.provider) metaBits.push(`${res.provider.provider}/${res.provider.model}${res.provider.local ? " · local" : " · cloud"}`);
      if (res.provider?.fallback_used) metaBits.push("fallback");
      if (res.velum?.reviewed) metaBits.push(`velum: ${res.velum.redacted ? `redacted [${(res.velum.fields_redacted||[]).join(",")}]` : "ok"}`);
      if (res.context) {
        metaBits.push(`profile:${res.context.profile_included ? "yes" : "no"}`);
        metaBits.push(`resume:${res.context.resume_included ? "yes" : "no"}`);
        metaBits.push(`campaign:${res.context.campaign_included ? "yes" : "no"}`);
        metaBits.push(`apps:${res.context.applications_included ?? 0}`);
        metaBits.push(`receipts:${res.context.receipts_included ?? 0}`);
      }
      if (res.usage) metaBits.push(`tokens in=${res.usage.input_tokens ?? "?"} out=${res.usage.output_tokens ?? "?"}`);
      if (res.finish_reason) metaBits.push(res.finish_reason);
      placeholder.appendChild(el("div", { class: "meta" }, metaBits.join(" · ")));
      if (res.context) {
        placeholder.appendChild(el("div", { class: "meta" },
          `Context: profile ${res.context.profile_included ? "included" : "off"}, ` +
          `resume ${res.context.resume_included ? "included" : res.context.resume_available ? "off" : "missing"}, ` +
          `campaign ${res.context.campaign_included ? "included" : "off"}, ` +
          `${res.context.applications_included ?? 0} application(s), ` +
          `${res.context.receipts_included ?? 0} receipt(s), ` +
          `Velum ${res.context.velum_reviewed ? "reviewed" : "not reviewed"}`));
      }
    } catch (err) {
      placeholder.classList.remove("assistant");
      placeholder.classList.add("system");
      const detail = err.data || {};
      placeholder.innerHTML = "";
      placeholder.appendChild(el("div", { class: "who" }, "error"));
      placeholder.appendChild(el("span", { class: "err" }, err.message));
      if (detail.code) placeholder.appendChild(el("div", { class: "meta" }, `code: ${detail.code}`));
      if (detail.hint) placeholder.appendChild(el("div", { class: "meta" }, detail.hint));
    }
    log.scrollTop = log.scrollHeight;
  });
}

// ── Profile / Resume ─────────────────────────────────────────────────────
async function renderProfile(root) {
  const [profile, profileV2, onboarding, resumes] = await Promise.allSettled([
    api("/toba/profile"),
    api("/toba/profile/v2").catch(() => null),
    api("/toba/onboarding").catch(() => null),
    api("/toba/resumes").catch(() => null),
  ]);
  const p = profile.status === "fulfilled" ? profile.value?.profile : {};
  const p2 = profileV2.status === "fulfilled" ? profileV2.value?.profile || {} : {};
  const ob = onboarding.status === "fulfilled" ? onboarding.value?.onboarding || {} : {};
  const rs = resumes.status === "fulfilled" ? resumes.value?.resumes || [] : [];
  const targets = (() => {
    try { return Array.isArray(JSON.parse(p2.target_roles || "[]")) ? JSON.parse(p2.target_roles || "[]").join(", ") : ""; }
    catch { return ""; }
  })();
  const incomplete = !p?.name && !p?.title && !p?.summary && !targets && rs.length === 0;

  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Profile"));
  root.appendChild(el("p", { class: "muted" }, "Edit exactly what Toba knows about you. New installs start blank; resume uploads are Velum-reviewed before storage."));
  if (incomplete) root.appendChild(el("div", { class: "banner warn" }, "Profile incomplete. No campaign, resume, target role, or personal profile data is set."));

  // Profile card
  const profForm = el("form", { class: "card" },
    el("h3", {}, "Editable profile workspace"),
    el("div", { class: "form-grid" },
      el("label", {}, "Name"),                  el("input", { name: "name", value: p?.name || "" }),
      el("label", {}, "Email"),                 el("input", { name: "email", type: "email", value: p?.email || "" }),
      el("label", {}, "Phone"),                 el("input", { name: "phone", value: p?.phone || "" }),
      el("label", {}, "Location"),              el("input", { name: "location", value: p?.location || "" }),
      el("label", {}, "Professional title"),    el("input", { name: "title", value: p?.title || "" }),
      el("label", {}, "Target roles"),          el("input", { name: "target_roles", value: targets, placeholder: "comma-separated roles" }),
      el("label", {}, "Work preference"),       el("input", { name: "work_preference", value: p?.work_preference || ob.work_preference || "", placeholder: "remote / hybrid / onsite" }),
      el("label", {}, "Preferred locations"),   el("input", { name: "preferred_locations", value: p?.preferred_locations || ob.preferred_locations || "" }),
      el("label", {}, "Salary min"),            el("input", { name: "salary_min", type: "number", value: p?.salary_min ?? ob.salary_min ?? "" }),
      el("label", {}, "Salary max"),            el("input", { name: "salary_max", type: "number", value: p?.salary_max ?? ob.salary_max ?? "" }),
      el("label", {}, "Years experience"),      el("input", { name: "years_experience", type: "number", min: "0", value: p?.years_experience ?? ob.years_experience ?? "" }),
      el("label", {}, "Certifications"),        el("textarea", { name: "certifications" }, p?.certifications || ob.certifications || ""),
      el("label", {}, "Skills"),                el("textarea", { name: "skills" }, p?.skills || ""),
      el("label", {}, "Links / portfolio"),     el("textarea", { name: "links_json", placeholder: "URLs or JSON if you prefer" }, p?.links_json || ""),
      el("label", {}, "Privacy mode"),          el("select", { name: "privacy_mode" },
        el("option", { value: "local-only", selected: (p?.privacy_mode || ob.privacy_mode) === "local-only" }, "local-only"),
        el("option", { value: "local-preferred", selected: (p?.privacy_mode || ob.privacy_mode) === "local-preferred" }, "local-preferred"),
        el("option", { value: "cloud-allowed-with-review", selected: (p?.privacy_mode || ob.privacy_mode) === "cloud-allowed-with-review" }, "cloud-allowed-with-review")),
      el("label", {}, "Provider preference"),   el("input", { name: "provider_preference", value: p?.provider_preference || "" }),
      el("label", {}, "Summary"),               el("textarea", { name: "summary" }, p?.summary || ""),
    ),
    el("div", { class: "muted small", id: "profileSavedState" }, `Last saved: ${fmtTime(p?.updated_at)}`),
    el("div", { class: "btn-row", style: "margin-top:.8rem;" },
      el("button", { class: "btn-primary", type: "submit" }, "Save profile"),
      el("button", { class: "btn-warn", type: "button", onclick: async () => {
        if (!confirm("Clear profile and onboarding data? Resumes, campaigns, applications, and receipts are not deleted by this button.")) return;
        try { await api("/toba/profile/clear", { method: "POST" }); toast("Profile cleared", "warn"); navigate("#profile"); }
        catch (err) { toast(err.message, "err"); }
      } }, "Reset / clear profile")));
  profForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(profForm);
    const patch = Object.fromEntries(fd.entries());
    try {
      const saved = await api("/toba/profile", { method: "PATCH", body: patch });
      $("#profileSavedState").textContent = `Last saved: ${fmtTime(saved.profile?.updated_at || new Date().toISOString())}`;
      toast("Profile saved", "ok");
    } catch (err) { toast(err.message, "err"); }
  });
  root.appendChild(profForm);

  // Onboarding card
  const obCard = el("div", { class: "card" },
    el("h3", {}, `Onboarding ${ob.completed ? "(complete)" : "(in progress)"}`),
    el("div", { class: "grid cols2" },
      mkRow("Preferred titles",    ob.preferred_titles),
      mkRow("Work preference",     ob.work_preference),
      mkRow("Preferred locations", ob.preferred_locations),
      mkRow("Salary",              ob.salary_min || ob.salary_max ? `${ob.salary_min ?? "?"} – ${ob.salary_max ?? "?"}` : "—"),
      mkRow("Years experience",    ob.years_experience),
      mkRow("Certifications",      ob.certifications),
      mkRow("Privacy mode",        ob.privacy_mode),
      mkRow("Resume uploaded",     ob.resume_uploaded ? "yes" : "no"),
    ));
  root.appendChild(obCard);

  // Resume upload card
  const upForm = el("form", { class: "card" },
    el("h3", {}, "Resume upload"),
    el("p", { class: "muted small" }, "Choose a PDF, DOCX, RTF, TXT, or Markdown resume. Velum redacts SSN, email, phone, address, and credit-card patterns before storage."),
    el("input", { name: "resume_file", type: "file", accept: ".pdf,.docx,.rtf,.txt,.md,.markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,application/rtf" }),
    el("textarea", { name: "text", placeholder: "Optional fallback: paste resume text… (min 20 chars)" }),
    el("label", {}, "Tailored for (role)"),
    el("input", { name: "tailored_for", placeholder: "e.g. Senior SRE @ Acme" }),
    el("div", { class: "btn-row", style: "margin-top:.6rem;" },
      el("button", { class: "btn-primary", type: "submit" }, "Upload + Velum review"))
  );
  const resultBox = el("div", {});
  upForm.appendChild(resultBox);
  upForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(upForm);
    const file = upForm.elements.resume_file?.files?.[0] || null;
    const body = {
      text: String(fd.get("text") || ""),
      tailored_for: String(fd.get("tailored_for") || ""),
    };
    if (file) {
      if (file.size > 5 * 1024 * 1024) { toast("Resume file is too large (max 5 MB)", "warn"); return; }
      body.file = {
        name: file.name,
        type: file.type || "application/octet-stream",
        base64: await fileToBase64(file),
      };
    } else if (!body.text || body.text.length < 20) {
      toast("Choose a resume file or paste at least 20 characters", "warn");
      return;
    }
    try {
      const res = await api("/toba/resumes/upload", { method: "POST", body });
      resultBox.innerHTML = "";
      const v = res.velum || {};
      const fileNote = res.upload?.filename ? ` from ${res.upload.filename}` : "";
      resultBox.appendChild(el("div", { class: "banner ok" },
        `Saved${fileNote} as resume #${res.resume?.id?.slice(0,8) || "?"}. Velum reviewed (${v.redacted ? `redacted: ${(v.fields_redacted||[]).join(", ") || "—"}` : "no redaction needed"}).`));
      toast("Resume uploaded", "ok");
      setTimeout(() => navigate("#profile"), 800);
    } catch (err) { toast(err.message, "err"); }
  });
  root.appendChild(upForm);

  // Resumes list
  const listCard = el("div", { class: "card" }, el("h3", {}, `Resumes (${rs.length})`));
  if (rs.length === 0) {
    listCard.appendChild(el("div", { class: "empty" }, "No resumes uploaded yet."));
  } else {
    const latest = rs[0];
    listCard.appendChild(el("div", { class: "banner ok" },
      `Latest resume: ${latest.filename || latest.tailored_for || "pasted text"} · uploaded ${fmtTime(latest.uploaded_at || latest.created_at)} · ` +
      `Velum ${latest.velum_reviewed === 1 ? "reviewed" : "unknown"}${latest.velum_redacted === 1 ? `, redacted ${(() => { try { return JSON.parse(latest.velum_fields_redacted || "[]").join(", "); } catch { return ""; } })()}` : ""}`));
    for (const r of rs.slice(0, 10)) {
      listCard.appendChild(el("div", { class: "list-row" },
        el("div", {},
          el("strong", {}, r.filename || r.tailored_for || "(pasted resume)"),
          el("div", { class: "muted small" }, r.summary ? r.summary.slice(0, 180) : `${r.extracted_length || r.base_resume?.length || 0} chars parsed`)),
        el("div", { class: "meta" },
          el("span", { class: "tag" }, `#${(r.id || "").slice(0, 8)}`),
          el("span", { class: "tag ok" }, r.velum_reviewed === 1 ? "Velum reviewed" : "Velum unknown"),
          el("span", {}, fmtTime(r.created_at)))));
    }
  }
  root.appendChild(listCard);
}
function mkRow(k, v) {
  return el("div", { class: "stat" },
    el("div", { class: "stat-label" }, k),
    el("div", { class: "stat-value" }, v == null || v === "" ? "—" : String(v)));
}

// ── Dux Agents ───────────────────────────────────────────────────────────
async function renderAgents(root) {
  let providers;
  const [agents, providerStatus] = await Promise.allSettled([
    api("/toba/dux/agents"),
    api("/toba/provider"),
  ]);
  if (agents.status !== "fulfilled") throw new Error("Could not load agents");
  agentsCache = agents.value;
  providers = providerStatus.status === "fulfilled" ? providerStatus.value.provider.available_providers || [] : [];

  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Dux Agents"));
  root.appendChild(el("p", { class: "muted" },
    "Per-agent provider/model overrides. API keys are write-only — the server never returns them; you'll see only an ",
    el("code", {}, "api_key_set"), " boolean."));

  const grid = el("div", { class: "grid cols2" });
  for (const a of agents.value.agents || []) grid.appendChild(agentCard(a, providers));
  root.appendChild(grid);
}
function agentCard(a, providers) {
  const card = el("form", { class: "card" });
  card.appendChild(el("div", { class: "row", style: "justify-content:space-between;" },
    el("h3", { style: "margin:0;" }, `${a.display_name || a.id}`),
    el("div", { class: "row" },
      el("span", { class: `tag ${a.enabled ? "ok" : "warn"}` }, a.enabled ? "enabled" : "disabled"),
      a.provider ? el("span", { class: "tag cloud" }, `${a.provider}/${a.model || "?"}`) : el("span", { class: "tag" }, "default"))));
  card.appendChild(el("p", { class: "muted small", style: "margin:.25rem 0 .65rem;" }, a.role));

  const providerSel = el("select", { name: "provider" });
  providerSel.appendChild(el("option", { value: "" }, "(use global default)"));
  for (const p of providers) providerSel.appendChild(el("option", { value: p.id, selected: a.provider === p.id }, `${p.label} · ${p.local ? "local" : "cloud"}`));

  card.appendChild(el("div", { class: "form-grid" },
    el("label", {}, "Provider"),    providerSel,
    el("label", {}, "Model"),       el("input", { name: "model",       value: a.model || "" }),
    el("label", {}, "Base URL"),    el("input", { name: "base_url",    value: a.base_url || "", placeholder: "(provider default)" }),
    el("label", {}, "API key"),     el("input", { name: "api_key", type: "password", placeholder: a.api_key_set ? "•••••• (stored — leave blank to keep)" : "(none stored)" }),
    el("label", {}, "Temperature"), el("input", { name: "temperature", type: "number", step: "0.1", value: a.temperature ?? "" }),
    el("label", {}, "Max tokens"),  el("input", { name: "max_tokens",  type: "number", value: a.max_tokens ?? "" }),
    el("label", {}, "Local-only"),  el("select", { name: "local_only" },
      el("option", { value: "",       selected: a.local_only == null }, "(default)"),
      el("option", { value: "true",   selected: a.local_only === 1   }, "yes"),
      el("option", { value: "false",  selected: a.local_only === 0   }, "no")),
    el("label", {}, "Cloud allowed"), el("select", { name: "cloud_allowed" },
      el("option", { value: "",       selected: a.cloud_allowed == null }, "(default)"),
      el("option", { value: "true",   selected: a.cloud_allowed === 1   }, "yes"),
      el("option", { value: "false",  selected: a.cloud_allowed === 0   }, "no")),
    el("label", {}, "Enabled"),     el("select", { name: "enabled" },
      el("option", { value: "true",  selected: a.enabled === 1 }, "yes"),
      el("option", { value: "false", selected: a.enabled === 0 }, "no")),
    el("label", { class: "full" }, "System prompt"),
    el("textarea", { name: "system_prompt", class: "full" }, a.system_prompt || ""),
  ));
  card.appendChild(el("div", { class: "btn-row", style: "margin-top:.8rem;" },
    el("button", { class: "btn-primary", type: "submit" }, "Save"),
    el("a", { class: "btn-ghost", href: `#dux` }, "Chat as " + a.id)));
  card.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(card);
    const raw = Object.fromEntries(fd.entries());
    const patch = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === "" || v == null) continue;
      if (["local_only", "cloud_allowed", "enabled"].includes(k)) patch[k] = (v === "true");
      else if (["temperature", "max_tokens"].includes(k)) patch[k] = Number(v);
      else patch[k] = v;
    }
    // Don't send empty api_key — that would wipe stored credentials.
    if (!patch.api_key) delete patch.api_key;
    try {
      const res = await api(`/toba/dux/agents/${a.id}`, { method: "PATCH", body: patch });
      toast(`Agent "${a.id}" saved`, "ok");
      // Update local card with sanitized response (drops api_key field)
      const refreshed = res.agent;
      if (refreshed) {
        agentsCache = null;
        navigate("#agents");
      }
    } catch (err) { toast(err.message, "err"); }
  });
  return card;
}

// ── Campaigns ────────────────────────────────────────────────────────────
// Render a small "source badge" — explains where an effective value came from.
function sourceBadge(source) {
  const labels = {
    campaign:   { text: "from campaign",   class: "ok"   },
    profile:    { text: "from profile",    class: "cloud"},
    onboarding: { text: "from onboarding", class: "cloud"},
    default:    { text: "default — not set", class: "warn" },
  };
  const meta = labels[source] || { text: source, class: "" };
  return el("span", { class: `tag ${meta.class}`, title: `Source: ${source}` }, meta.text);
}

async function renderCampaigns(root) {
  const camps = (await api("/toba/campaigns")).campaigns || [];
  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Campaigns"));
  root.appendChild(el("p", { class: "muted" },
    "One active campaign at a time. Campaigns are strategy objects — every field is editable, and the ",
    el("strong", {}, "effective"), " context below shows ", el("em", {}, "where each value came from"),
    " (campaign / profile / onboarding / default)."));

  const active = camps.find(c => c.active);

  // ── Active campaign editor with source-traced effective context ──────────
  if (active) {
    // Fetch the full record + sources
    let detail;
    try { detail = await api(`/toba/campaigns/${active.id}`); }
    catch (err) { toast(`Failed to load campaign: ${err.message}`, "err"); detail = { campaign: active, effective_context: null }; }
    const c = detail.campaign;
    const eff = detail.effective_context;

    // Parse JSON-encoded preferred_locations off the raw row
    let storedLocations = [];
    try { storedLocations = c.preferred_locations ? JSON.parse(c.preferred_locations) : []; } catch { storedLocations = []; }

    const form = el("form", { class: "card" });
    form.appendChild(el("h3", {}, "Active campaign — editable"));

    // ── Strategy form ──
    const wpRadios = el("div", { class: "row", style: "flex-wrap:wrap;" });
    for (const opt of ["any", "remote", "hybrid", "onsite"]) {
      const radio = el("label", { class: "row", style: "background:var(--bg-2); border:1px solid var(--line); padding:.35rem .65rem; border-radius:5px; cursor:pointer;" },
        el("input", { type: "radio", name: "work_preference", value: opt, checked: (c.work_preference || "") === opt, style: "width:auto; margin:0;" }),
        el("span", {}, opt));
      wpRadios.appendChild(radio);
    }
    const clearWp = el("button", { type: "button", class: "btn-ghost", onclick: () => {
      Array.from(form.querySelectorAll('input[name="work_preference"]')).forEach(r => r.checked = false);
      markDirty();
    } }, "clear (use inherited)");
    wpRadios.appendChild(clearWp);

    form.appendChild(el("div", { class: "form-grid" },
      el("label", {}, "Name"),                        el("input", { name: "name", value: c.name }),
      el("label", {}, "Phase"),                       el("select", { name: "phase" },
        ...["research", "applying", "interviewing", "negotiating", "closed"].map(p =>
          el("option", { value: p, selected: c.phase === p }, p))),
      el("label", { class: "full" }, "Target roles (comma-separated)"),
      el("input", { name: "target_role", class: "full", value: c.target_role || "", placeholder: "e.g. MSP Technician, Desktop Support" }),

      el("label", { class: "full" },
        "Work preference ",
        eff?.work_preference ? sourceBadge(eff.work_preference.source) : null,
        eff?.work_preference?.source === "default" ? el("span", { class: "muted small", style: "margin-left:.5rem;" }, " — currently defaults to ", el("code", {}, "any")) : null),
      el("div", { class: "full" }, wpRadios),

      el("label", { class: "full" },
        "Preferred locations (comma-separated) ",
        eff?.locations ? sourceBadge(eff.locations.source) : null),
      el("input", { name: "preferred_locations_csv", class: "full",
        value: storedLocations.join(", "),
        placeholder: eff?.locations?.value?.length ? `inherited: ${eff.locations.value.join(", ")}` : "no locations set" }),

      el("label", {}, "Salary min"),  el("input", { name: "salary_min", type: "number", value: c.salary_min ?? "" }),
      el("label", {}, "Salary max"),  el("input", { name: "salary_max", type: "number", value: c.salary_max ?? "" }),
      el("label", {}, "Years experience target"), el("input", { name: "years_experience_target", type: "number", value: c.years_experience_target ?? "" }),
      el("label", {}, "Certifications focus"),    el("input", { name: "certifications", value: c.certifications ?? "" }),
      el("label", { class: "full" }, "Notes"),
      el("textarea", { name: "notes", class: "full" }, c.notes ?? ""),
    ));

    // Unsaved-changes indicator + save/cancel
    const dirty = el("span", { class: "tag warn", style: "display:none;" }, "unsaved changes");
    const initial = JSON.stringify(formSnapshot(form));
    function markDirty() {
      dirty.style.display = JSON.stringify(formSnapshot(form)) === initial ? "none" : "";
    }
    function formSnapshot(f) {
      const fd = new FormData(f);
      const out = {};
      for (const [k, v] of fd.entries()) out[k] = v;
      // include unchecked radios consistently
      if (!out.work_preference) out.work_preference = "";
      return out;
    }
    form.addEventListener("input",  markDirty);
    form.addEventListener("change", markDirty);

    form.appendChild(el("div", { class: "btn-row", style: "margin-top:.9rem; align-items:center;" },
      el("button", { class: "btn-primary", type: "submit" }, "Save changes"),
      el("button", { class: "btn-ghost",   type: "button", onclick: () => navigate("#campaigns") }, "Cancel"),
      el("a",       { class: "btn-ghost",   href: `#apps?campaign_id=${c.id}` }, "View applications"),
      el("button", { class: "btn-warn",    type: "button", onclick: async () => {
        if (!confirm(`Close campaign "${c.name}"?`)) return;
        try { await api(`/toba/campaigns/${c.id}/close`, { method: "POST" }); toast("Campaign closed", "ok"); navigate("#campaigns"); }
        catch (err) { toast(err.message, "err"); }
      } }, "Close campaign"),
      dirty,
    ));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const raw = Object.fromEntries(fd.entries());
      const patch = {};
      // Free-text fields
      for (const k of ["name", "target_role", "phase", "certifications", "notes"]) {
        if (raw[k] !== undefined) patch[k] = String(raw[k]);
      }
      // Numbers — empty string -> null (clears override)
      for (const k of ["salary_min", "salary_max", "years_experience_target"]) {
        if (raw[k] === "" || raw[k] == null) patch[k] = null;
        else patch[k] = Number(raw[k]);
      }
      // Work preference — empty means "clear override" -> null so it falls back
      patch.work_preference = raw.work_preference ? raw.work_preference : null;
      // Locations CSV -> array (empty CSV -> [] which clears the campaign override)
      const csv = (raw.preferred_locations_csv || "").toString().trim();
      patch.preferred_locations = csv ? csv.split(/\s*,\s*/).filter(Boolean) : null;

      try {
        const res = await api(`/toba/campaigns/${c.id}`, { method: "PATCH", body: patch });
        toast("Campaign saved", "ok");
        // Show the new effective context inline
        const effPanel = $("#effPanel");
        if (effPanel && res.effective_context) effPanel.replaceWith(renderEffectivePanel(res.effective_context));
        // Re-snapshot to reset dirty state
        const fresh = JSON.stringify(formSnapshot(form));
        // eslint-disable-next-line no-undef
        Object.defineProperty(form, "_snap", { value: fresh, writable: true });
        dirty.style.display = "none";
        // Trigger a full re-render so source badges update
        setTimeout(() => navigate("#campaigns"), 400);
      } catch (err) { toast(err.message, "err"); }
    });

    root.appendChild(form);

    // ── Effective context panel ──
    if (eff) root.appendChild(renderEffectivePanel(eff));

    // ── Analytics ──
    try {
      const a = (await api(`/toba/analytics/campaign/${c.id}`)).analytics;
      const insights = el("div", {});
      if (a?.insights?.length) {
        const ul = el("ul", { style: "margin:0; padding-left:1.1rem;" });
        for (const i of a.insights) ul.appendChild(el("li", {}, typeof i === "string" ? i : (i.message || JSON.stringify(i))));
        insights.appendChild(ul);
      } else insights.appendChild(el("div", { class: "empty" }, "No insights yet — log some applications."));
      root.appendChild(el("div", { class: "card" },
        el("h3", {}, "Analytics"),
        el("div", { class: "grid cols4" },
          mkRow("Apps",          a?.total_applications ?? 0),
          mkRow("Responses",     a?.responses ?? 0),
          mkRow("Interviews",    a?.interviews ?? 0),
          mkRow("Response rate", a?.response_rate != null ? `${Math.round(a.response_rate * 100)}%` : "—"),
        ),
        insights));
    } catch { /* analytics endpoint failure is non-fatal */ }

  } else {
    // No active campaign — show create form (now with full strategy fields)
    const form = el("form", { class: "card" },
      el("h3", {}, "Start a campaign"),
      el("p", { class: "muted small" }, "Only ", el("code", {}, "name"), " and ", el("code", {}, "target_role"),
        " are required up front. Other fields (work preference, locations, salary, etc.) become editable once the campaign exists. Until you set them, the search context defaults to ",
        el("code", {}, "work_preference = any"), " and ", el("code", {}, "locations = []"), "."),
      el("div", { class: "form-grid" },
        el("label", {}, "Name"),         el("input", { name: "name", required: true }),
        el("label", {}, "Target role"),  el("input", { name: "target_role", required: true, placeholder: "e.g. MSP Technician, Desktop Support" })),
      el("div", { class: "btn-row", style: "margin-top:.6rem;" },
        el("button", { class: "btn-primary", type: "submit" }, "Create")));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try { await api("/toba/campaigns", { method: "POST", body: Object.fromEntries(fd.entries()) }); toast("Campaign created", "ok"); navigate("#campaigns"); }
      catch (err) { toast(err.message, "err"); }
    });
    root.appendChild(form);
  }

  // ── History ──
  const history = el("div", { class: "card" }, el("h3", {}, "All campaigns"));
  if (camps.length === 0) history.appendChild(el("div", { class: "empty" }, "No campaigns yet."));
  else {
    const tbl = el("table", {}, el("thead", {}, el("tr", {},
      el("th", {}, "Name"), el("th", {}, "Target"), el("th", {}, "Phase"), el("th", {}, "Active"), el("th", {}, "Updated"))));
    const tb = el("tbody", {});
    for (const c of camps) tb.appendChild(el("tr", {},
      el("td", {}, c.name),
      el("td", {}, c.target_role),
      el("td", {}, c.phase),
      el("td", {}, el("span", { class: `tag ${c.active ? "ok" : ""}` }, c.active ? "yes" : "—")),
      el("td", { class: "muted" }, fmtTime(c.updated_at || c.created_at))));
    tbl.appendChild(tb);
    history.appendChild(tbl);
  }
  root.appendChild(history);
}

// Effective-context panel reused by campaigns AND Job Scout.
function renderEffectivePanel(eff) {
  const card = el("div", { class: "card", id: "effPanel" }, el("h3", {}, "Effective search context"));
  const tbl = el("table", {}, el("thead", {}, el("tr", {},
    el("th", {}, "Field"), el("th", {}, "Value"), el("th", {}, "Source"))));
  const tb = el("tbody", {});
  const rows = [
    ["Target roles",     (eff.target_roles.value || []).join(", ") || "—",      eff.target_roles.source],
    ["Work preference",  eff.work_preference.value,                              eff.work_preference.source],
    ["Locations",        (eff.locations.value || []).join(", ") || "—",          eff.locations.source],
    ["Salary min",       eff.salary_min.value ?? "—",                            eff.salary_min.source],
    ["Salary max",       eff.salary_max.value ?? "—",                            eff.salary_max.source],
    ["Certifications",   eff.certifications.value ?? "—",                        eff.certifications.source],
    ["Years exp target", eff.years_experience_target.value ?? "—",               eff.years_experience_target.source],
    ["Notes",            eff.notes.value ?? "—",                                 eff.notes.source],
  ];
  // Show a warning banner if anything important is on a default
  const defaultsList = rows.filter(([_, __, src]) => src === "default").map(([f]) => f);
  if (defaultsList.length) {
    card.appendChild(el("div", { class: "banner" },
      `Using fallback default(s) because no explicit preference exists: `,
      el("strong", {}, defaultsList.join(", ")), `. Set them on the campaign for explicit control.`));
  }
  for (const [field, value, source] of rows) {
    tb.appendChild(el("tr", {},
      el("td", {}, field),
      el("td", { class: "muted", style: "font-family:var(--mono);" }, String(value)),
      el("td", {}, sourceBadge(source))));
  }
  tbl.appendChild(tb);
  card.appendChild(tbl);
  return card;
}

// ── Job Scout ────────────────────────────────────────────────────────────
async function renderJobScout(root) {
  const ctx = await api("/toba/job-scout/context").catch(() => null);
  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Job Scout"));
  root.appendChild(el("p", { class: "muted" },
    "Toba does not crawl boards itself. Use the context below to drive an external search tool, then ingest results here."));

  // Effective search context — sourced per field
  const c = ctx?.context || {};
  const eff = ctx?.effective;
  if (eff) {
    root.appendChild(renderEffectivePanel(eff));
  } else {
    // Fallback if /context didn't return effective (old build)
    root.appendChild(el("div", { class: "card" }, el("h3", {}, "Search context"),
      el("div", { class: "grid cols3" },
        mkRow("Campaign", c.campaign_name || "—"),
        mkRow("Primary target", c.primary_target_role || "—"),
        mkRow("Remote preference", c.remote_preference || "—"))));
  }

  // Operational notes
  root.appendChild(el("div", { class: "card" }, el("h3", {}, "Ingestion mode"),
    el("div", { class: "grid cols3" },
      mkRow("Live search?", ctx?.live_search_implemented ? "yes" : "no (external/manual)"),
      mkRow("Mode",          ctx?.ingestion_mode || "—"),
      mkRow("Campaign",      c.campaign_name || "—"))));

  if (!c.campaign_id) {
    root.appendChild(el("div", { class: "banner warn" }, "Create a campaign first. Job Scout will not ingest applications without an active campaign."));
    return;
  }

  root.appendChild(el("div", { class: "row", style: "margin: .5rem 0 1rem;" },
    el("a", { class: "btn-ghost", href: "#campaigns" }, "Edit campaign strategy →")));

  // Manual ingest
  const form = el("form", { class: "card" },
    el("h3", {}, "Ingest a job (manual)"),
    el("div", { class: "form-grid" },
      el("label", {}, "Company"),       el("input", { name: "company", required: true }),
      el("label", {}, "Role / title"),  el("input", { name: "role", required: true }),
      el("label", {}, "Location"),      el("input", { name: "location" }),
      el("label", {}, "URL"),           el("input", { name: "url", type: "url" }),
      el("label", {}, "Source"),        el("input", { name: "source", placeholder: "linkedin / referral / manual…" }),
      el("label", {}, "Salary range"),  el("input", { name: "salary_range", placeholder: "$X – $Y" }),
      el("label", {}, "Remote / hybrid"), el("select", { name: "remote" },
        el("option", { value: "" }, "(unspecified)"),
        el("option", { value: "remote" }, "remote"),
        el("option", { value: "hybrid" }, "hybrid"),
        el("option", { value: "onsite" }, "onsite")),
      el("label", {}, "Match score (0–100)"), el("input", { name: "match_score", type: "number", min: 0, max: 100 }),
      el("label", { class: "full" }, "Match reason / why recommended"),
      el("textarea", { name: "match_reason", class: "full" })),
    el("div", { class: "btn-row", style: "margin-top:.6rem;" },
      el("button", { class: "btn-primary", type: "submit" }, "Ingest")));
  const resultBox = el("div", {});
  form.appendChild(resultBox);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const raw = Object.fromEntries(fd.entries());
    if (raw.match_score) raw.match_score = Number(raw.match_score);
    const job = {}; for (const [k, v] of Object.entries(raw)) if (v) job[k] = v;
    try {
      const res = await api("/toba/job-scout/ingest", { method: "POST", body: { jobs: [job] } });
      resultBox.innerHTML = "";
      if (res.ingested) resultBox.appendChild(el("div", { class: "banner ok" }, `Ingested ${res.ingested} job(s). Campaign: ${res.campaign_id?.slice(0,8) || "?"}.`));
      if (res.duplicates_skipped) resultBox.appendChild(el("div", { class: "banner" }, `${res.duplicates_skipped} duplicate(s) skipped (fingerprint match).`));
      form.reset();
      toast("Job ingested", "ok");
    } catch (err) { toast(err.message, "err"); }
  });
  root.appendChild(form);
}

// ── Applications ─────────────────────────────────────────────────────────
async function renderApplications(root) {
  const hash = location.hash;
  const m = /[?&]campaign_id=([^&]+)/.exec(hash);
  const cid = m ? m[1] : "";
  const url = cid ? `/toba/applications?campaign_id=${encodeURIComponent(cid)}` : "/toba/applications";
  const apps = (await api(url)).applications || [];

  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Applications"));
  root.appendChild(el("p", { class: "muted" }, `Tracking ${apps.length} application(s)${cid ? ` in campaign ${cid.slice(0,8)}` : " across all campaigns"}.`));

  const STATUSES = ["found", "qualified", "applied", "responded", "interviewing", "closed"];
  const counts = {};
  for (const s of STATUSES) counts[s] = apps.filter(a => a.status === s).length;

  // Filter chips
  const filterBar = el("div", { class: "row", style: "margin-bottom:1rem;" },
    el("button", { class: "btn-ghost", "data-filter": "" }, `all (${apps.length})`));
  for (const s of STATUSES) {
    filterBar.appendChild(el("button", { class: "btn-ghost", "data-filter": s }, `${s} (${counts[s]})`));
  }
  root.appendChild(filterBar);

  const tableCard = el("div", { class: "card" });
  const renderRows = (filter) => {
    const rows = apps.filter(a => !filter || a.status === filter);
    tableCard.innerHTML = "";
    if (rows.length === 0) { tableCard.appendChild(el("div", { class: "empty" }, "No applications.")); return; }
    const tbl = el("table", {}, el("thead", {}, el("tr", {},
      el("th", {}, "Company"), el("th", {}, "Role"), el("th", {}, "Status"),
      el("th", {}, "Score"), el("th", {}, "Source"), el("th", {}, "Updated"), el("th", {}, ""))));
    const tb = el("tbody", {});
    for (const a of rows) {
      const statusSel = el("select", {}, ...STATUSES.map(s => el("option", { value: s, selected: a.status === s }, s)));
      statusSel.addEventListener("change", async () => {
        try { await api(`/toba/applications/${a.id}`, { method: "PATCH", body: { status: statusSel.value } }); toast("Updated", "ok"); }
        catch (err) { toast(err.message, "err"); statusSel.value = a.status; }
      });
      tb.appendChild(el("tr", {},
        el("td", {}, a.company),
        el("td", {}, a.role + (a.url ? "" : ""), a.url ? el("a", { href: a.url, target: "_blank", rel: "noopener", style: "margin-left:.5rem;" }, "↗") : null),
        el("td", {}, statusSel),
        el("td", {}, a.match_score != null ? `${a.match_score}` : "—"),
        el("td", { class: "muted" }, a.source || "—"),
        el("td", { class: "muted" }, fmtTime(a.applied_at || a.created_at)),
        el("td", {}, el("button", { class: "btn-ghost", onclick: async () => {
          if (!confirm(`Mark stale follow-up on ${a.company}?`)) return;
          try { await api(`/toba/applications/${a.id}/follow-up`, { method: "POST" }); toast("Follow-up recorded", "ok"); navigate("#apps"); }
          catch (err) { toast(err.message, "err"); }
        } }, "Follow up"))));
    }
    tbl.appendChild(tb);
    tableCard.appendChild(tbl);
  };
  renderRows("");
  filterBar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-filter]");
    if (!btn) return;
    renderRows(btn.dataset.filter);
  });
  root.appendChild(tableCard);
}

// ── Automation / Approval queue ──────────────────────────────────────────
async function renderQueue(root) {
  const tasks = (await api("/toba/automation").catch(() => ({ tasks: [], mode: "?" })));
  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Automation Queue"));
  root.appendChild(el("p", { class: "muted" }, `Mode: `, el("code", {}, tasks.mode || "?"), `. Tasks are queued for review; nothing executes without approval.`));

  const list = el("div", { class: "card" }, el("h3", {}, "Pending"));
  const items = tasks.tasks || [];
  if (items.length === 0) list.appendChild(el("div", { class: "empty" }, "Queue is empty."));
  for (const t of items) {
    const row = el("div", { class: "list-row" },
      el("div", {},
        el("strong", {}, t.title),
        el("div", { class: "meta" }, `${t.kind} · ${fmtTime(t.created_at)}`)),
      el("div", { class: "btn-row" },
        el("span", { class: `tag ${t.status === "pending" ? "warn" : "ok"}` }, t.status),
        t.status === "pending" ? el("button", { class: "btn-primary", onclick: () => act(t.id, "approve") }, "Approve") : null,
        t.status === "pending" ? el("button", { class: "btn-ghost",  onclick: () => act(t.id, "reject") }, "Reject")   : null,
        t.status === "approved" ? el("button", { class: "btn-primary", onclick: () => act(t.id, "execute") }, "Execute") : null));
    list.appendChild(row);
  }
  root.appendChild(list);

  async function act(id, what) {
    try { await api(`/toba/automation/${id}/${what}`, { method: "POST" }); toast(`${what}d`, "ok"); navigate("#queue"); }
    catch (err) { toast(err.message, "err"); }
  }
}

// ── Receipts ─────────────────────────────────────────────────────────────
async function renderReceipts(root) {
  const ACTIONS = ["", "model_call", "dux_agent_chat", "velum_review", "job_scout_run",
                   "application_persist", "application_update", "campaign_create", "campaign_close",
                   "outreach_generate", "outreach_approve", "outreach_reject",
                   "automation_create", "automation_approve", "automation_reject", "automation_execute",
                   "onboarding_complete", "resume_ingest", "insight_generate", "dux_agent_update"];
  let active = "";
  const filter = el("div", { class: "row", style: "margin-bottom: 1rem;" });
  for (const a of ACTIONS) {
    filter.appendChild(el("button", { class: "btn-ghost", onclick: () => { active = a; load(); } }, a || "all"));
  }
  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Receipts"));
  root.appendChild(el("p", { class: "muted" }, "Local audit log. Click any row to expand."));
  root.appendChild(filter);
  const out = el("div", {});
  root.appendChild(out);

  async function load() {
    out.innerHTML = "<div class='loading'>Loading…</div>";
    const q = active ? `?action=${encodeURIComponent(active)}&limit=100` : "?limit=100";
    const recs = (await api(`/toba/receipts${q}`)).receipts || [];
    out.innerHTML = "";
    if (!recs.length) { out.appendChild(el("div", { class: "empty" }, "No receipts.")); return; }
    for (const r of recs) out.appendChild(receiptRow(r));
  }
  load();
}
function receiptRow(r) {
  const kindClass = r.errors ? "err" : (!r.local_mode ? "cloud" : "ok");
  const summary = el("summary", {},
    el("span", { class: `tag ${kindClass}` }, r.action),
    r.dux_agent_id ? el("span", { class: "tag" }, r.dux_agent_id) : null,
    r.provider ? el("span", { class: "tag" }, `${r.provider}/${r.model || "?"}`) : null,
    !r.local_mode ? el("span", { class: "tag cloud" }, "cloud") : null,
    r.velum_reviewed ? el("span", { class: `tag ${r.velum_redacted ? "warn" : "ok"}` }, r.velum_redacted ? "velum: redacted" : "velum") : null,
    el("span", { class: "muted small", style: "margin-left:auto;" }, fmtTime(r.timestamp)));
  const card = el("details", { class: "receipt" },
    summary,
    el("div", { style: "margin-top:.4rem;" }, r.result_summary),
    el("pre", {}, JSON.stringify(r, null, 2)));
  return card;
}

// ── Settings ─────────────────────────────────────────────────────────────
async function renderSettings(root) {
  const [providerR, statusR] = await Promise.allSettled([api("/toba/provider"), api("/status")]);
  const p = providerR.status === "fulfilled" ? providerR.value.provider : {};
  const s = statusR.status === "fulfilled" ? statusR.value : {};
  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Settings"));
  root.appendChild(el("p", { class: "muted" }, "Service-wide provider and network exposure. API keys are write-only."));

  const stats = el("div", { class: "grid cols3" });
  for (const [k, v] of Object.entries({
    "Host":              s.host,
    "Port":              s.port,
    "Network exposure":  s.network_exposure,
    "Bridge enabled":    s.bridge_enabled,
    "OpenRouter configured": s.openrouter_configured,
    "OpenRouter source":     s.openrouter_source,
  })) stats.appendChild(mkRow(k, v == null ? "—" : String(v)));
  root.appendChild(stats);

  // Provider form
  const form = el("form", { class: "card" },
    el("h3", {}, "Global provider / model"));
  const providerSel = el("select", { name: "provider" });
  for (const def of p.available_providers || []) {
    providerSel.appendChild(el("option", { value: def.id, selected: p.provider === def.id }, `${def.label}${def.local ? "" : " (cloud)"}`));
  }
  form.appendChild(el("div", { class: "form-grid" },
    el("label", {}, "Provider"),    providerSel,
    el("label", {}, "Model"),       el("input", { name: "model",    value: p.model || "" }),
    el("label", {}, "Base URL"),    el("input", { name: "base_url", value: p.base_url || "", placeholder: "(provider default)" }),
    el("label", {}, "API key"),     el("input", { name: "api_key",  type: "password", placeholder: p.api_key_set ? "•••••• (stored — leave blank to keep)" : "(none stored)" }),
    el("label", {}, "Local-only"),  el("select", { name: "local_only" },
      el("option", { value: "false", selected: !p.local_only_mode }, "no"),
      el("option", { value: "true",  selected: !!p.local_only_mode }, "yes"))));
  form.appendChild(el("div", { class: "btn-row", style: "margin-top:.7rem;" },
    el("button", { class: "btn-primary", type: "submit" }, "Apply (runtime; not persisted)")));
  form.appendChild(el("p", { class: "muted small" }, "These changes apply in-process. For persistence, edit ", el("code", {}, "/mnt/ai/toba/.env"), " and restart the service."));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const raw = Object.fromEntries(fd.entries());
    const patch = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === "" || v == null) continue;
      if (k === "local_only") patch[k] = (v === "true");
      else patch[k] = v;
    }
    if (!patch.api_key) delete patch.api_key;
    try { await api("/toba/provider", { method: "PATCH", body: patch }); toast("Provider updated", "ok"); refreshStatus(); navigate("#settings"); }
    catch (err) { toast(err.message, "err"); }
  });
  root.appendChild(form);

  const clearAction = (label, path, method = "DELETE") => el("button", { class: "btn-ghost", onclick: async () => {
    if (!confirm(`${label}? This cannot be undone from the UI.`)) return;
    try { await api(path, { method }); toast(`${label} complete`, "warn"); refreshStatus(); }
    catch (err) { toast(err.message, "err"); }
  } }, label);

  root.appendChild(el("div", { class: "card" },
    el("h3", {}, "Data management"),
    el("p", { class: "muted small" }, "Use these controls before release or demos. The factory reset script backs up the DB first and never deletes .env."),
    el("div", { class: "btn-row" },
      clearAction("Clear profile", "/toba/profile/clear", "POST"),
      clearAction("Clear resumes", "/toba/resumes"),
      clearAction("Clear applications", "/toba/applications"),
      clearAction("Clear campaigns", "/toba/campaigns"),
      clearAction("Clear receipts", "/toba/receipts"),
      clearAction("Clear automation queue", "/toba/automation")),
    el("p", { class: "small muted" }, "Factory reset / release reset:"),
    el("pre", {}, "cd /mnt/ai/toba && scripts/toba-reset.sh --personal-data-only --dry-run\ncd /mnt/ai/toba && scripts/toba-reset.sh --personal-data-only"),
    el("p", { class: "small muted" }, "Release privacy audit:"),
    el("pre", {}, "cd /mnt/ai/toba && scripts/audit-release-privacy.sh")));

  // Helpful CLI hints
  root.appendChild(el("div", { class: "card" },
    el("h3", {}, "Operational"),
    el("p", { class: "small muted" }, "Restart after env changes:"),
    el("pre", {}, "sudo systemctl restart toba.service"),
    el("p", { class: "small muted" }, "Verify standalone posture:"),
    el("pre", {}, "/mnt/ai/toba/scripts/verify-standalone.sh"),
    el("p", { class: "small muted" }, "Reconfigure providers / Tailscale:"),
    el("pre", {}, "cd /mnt/ai/toba && pnpm run toba:setup")));
}
