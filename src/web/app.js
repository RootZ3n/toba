/*  Cursus Career Command Center — frontend
 *  ----------------------------------------
 *  Vanilla JS SPA. Hash-routed. Talks to the local Cursus API.
 *  Auth: bearer token in localStorage["cursus_auth_token"], attached when set.
 *  No external libs. Edit live; no build step.
 */

"use strict";

// ── State ────────────────────────────────────────────────────────────────
const TOKEN_KEY = "cursus_auth_token";
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

// ── Token / auth ─────────────────────────────────────────────────────────
const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
const setToken = (t) => { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); };

async function api(path, opts = {}) {
  const headers = { "accept": "application/json", ...(opts.headers || {}) };
  const tok = getToken();
  if (tok) headers["authorization"] = `Bearer ${tok}`;
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

// ── Auth modal ───────────────────────────────────────────────────────────
function showAuthModal({ msg } = {}) {
  $("#authErr").hidden = !msg;
  $("#authErr").textContent = msg || "";
  $("#authInput").value = "";
  $("#authModal").classList.remove("hidden");
  setTimeout(() => $("#authInput").focus(), 50);
}
function hideAuthModal() { $("#authModal").classList.add("hidden"); }

$("#authBtn").addEventListener("click", () => showAuthModal());
$("#authSave").addEventListener("click", async () => {
  const tok = $("#authInput").value.trim();
  if (!tok) return;
  setToken(tok);
  hideAuthModal();
  await refreshStatus();
  navigate(location.hash || "#dashboard");
  toast("Token saved", "ok");
});
$("#authClear").addEventListener("click", () => {
  setToken("");
  hideAuthModal();
  toast("Token cleared", "warn");
  refreshStatus();
});
$("#authCancel").addEventListener("click", hideAuthModal);

// ── Status chip refresh ──────────────────────────────────────────────────
async function refreshStatus() {
  try {
    serverStatus = await api("/status");
    paintChips();
  } catch (err) {
    if (err.status === 401) {
      // /status should be public — if it isn't, the user is hitting an old build.
      serverStatus = null;
      paintChips({ authRequired: true });
    } else {
      toast(`Status error: ${err.message}`, "err");
    }
  }
}
function paintChips(extra = {}) {
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
  const authNeed = extra.authRequired || s.auth_required;
  setChip("status.auth",     authNeed ? (getToken() ? "token ✓" : "token req'd") : "open",
                              authNeed ? (getToken() ? "ok" : "warn") : "");
  setChip("status.version",  s.host ? `${s.host}:${s.port} · v${s.dux_agents ? "" : ""}schema${s._sv || ""}` : "cursus");
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
    api("/cursus/dashboard").catch(() => null),
    api("/cursus/receipts?limit=8").catch(() => null),
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
    mkStat("Auth required",  s.auth_required ? "yes" : "no"),
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
    try { agentsCache = await api("/cursus/dux/agents"); } catch (err) { agentsCache = { agents: [] }; }
  }
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

  shell.append(controls, log, form);
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
    const url = agentId ? `/cursus/dux/agents/${agentId}/chat` : "/cursus/dux/chat";
    const placeholder = el("div", { class: "chat-msg assistant" },
      el("div", { class: "who" }, agentId || "dux"),
      el("span", { class: "muted" }, "Thinking…"));
    log.appendChild(placeholder);
    log.scrollTop = log.scrollHeight;

    try {
      const body = { message: msg, velum: $("#velumOn").checked };
      const res = await api(url, { method: "POST", body });
      placeholder.innerHTML = "";
      placeholder.appendChild(el("div", { class: "who" }, res.agent?.id || agentId || "dux"));
      placeholder.appendChild(document.createTextNode(res.reply || ""));
      const metaBits = [];
      if (res.provider) metaBits.push(`${res.provider.provider}/${res.provider.model}${res.provider.local ? " · local" : " · cloud"}`);
      if (res.provider?.fallback_used) metaBits.push("fallback");
      if (res.velum?.reviewed) metaBits.push(`velum: ${res.velum.redacted ? `redacted [${(res.velum.fields_redacted||[]).join(",")}]` : "ok"}`);
      if (res.usage) metaBits.push(`tokens in=${res.usage.input_tokens ?? "?"} out=${res.usage.output_tokens ?? "?"}`);
      if (res.finish_reason) metaBits.push(res.finish_reason);
      placeholder.appendChild(el("div", { class: "meta" }, metaBits.join(" · ")));
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
    api("/cursus/profile"),
    api("/cursus/profile/v2").catch(() => null),
    api("/cursus/onboarding").catch(() => null),
    api("/cursus/resumes").catch(() => null),
  ]);
  const p = profile.status === "fulfilled" ? profile.value?.profile : {};
  const ob = onboarding.status === "fulfilled" ? onboarding.value?.onboarding || {} : {};
  const rs = resumes.status === "fulfilled" ? resumes.value?.resumes || [] : [];

  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Profile · Resume"));
  root.appendChild(el("p", { class: "muted" }, "Your career profile, onboarding state, and resume uploads. Velum redacts PII on every upload."));

  // Profile card
  const profForm = el("form", { class: "card" },
    el("h3", {}, "Profile"),
    el("div", { class: "form-grid" },
      el("label", {}, "Name"),       el("input", { name: "name",     value: p?.name || "" }),
      el("label", {}, "Title"),      el("input", { name: "title",    value: p?.title || "" }),
      el("label", {}, "Location"),   el("input", { name: "location", value: p?.location || "" }),
      el("label", {}, "Summary"),    el("textarea", { name: "summary" }, p?.summary || ""),
    ),
    el("div", { class: "btn-row", style: "margin-top:.8rem;" },
      el("button", { class: "btn-primary", type: "submit" }, "Save profile")));
  profForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(profForm);
    const patch = Object.fromEntries(fd.entries());
    try {
      await api("/cursus/profile", { method: "PATCH", body: patch });
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
    el("p", { class: "muted small" }, "Paste resume text below. Velum redacts SSN, email, phone, address, and credit-card patterns before storage."),
    el("textarea", { name: "text", placeholder: "Paste resume text… (min 20 chars)" }),
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
    const body = Object.fromEntries(fd.entries());
    if (!body.text || body.text.length < 20) { toast("Resume text too short (need ≥20 chars)", "warn"); return; }
    try {
      const res = await api("/cursus/resumes/upload", { method: "POST", body });
      resultBox.innerHTML = "";
      const v = res.velum || {};
      resultBox.appendChild(el("div", { class: "banner ok" },
        `Saved as resume #${res.resume?.id?.slice(0,8) || "?"}. Velum reviewed (${v.redacted ? `redacted: ${(v.fields_redacted||[]).join(", ") || "—"}` : "no redaction needed"}).`));
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
    for (const r of rs.slice(0, 10)) {
      listCard.appendChild(el("div", { class: "list-row" },
        el("div", {}, r.tailored_for || el("span", { class: "muted" }, "(no role)")),
        el("div", { class: "meta" },
          el("span", { class: "tag" }, `#${(r.id || "").slice(0, 8)}`),
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
    api("/cursus/dux/agents"),
    api("/cursus/provider"),
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
      const res = await api(`/cursus/dux/agents/${a.id}`, { method: "PATCH", body: patch });
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
async function renderCampaigns(root) {
  const camps = (await api("/cursus/campaigns")).campaigns || [];
  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Campaigns"));
  root.appendChild(el("p", { class: "muted" }, "One active campaign at a time. Close it to start a new one."));

  const active = camps.find(c => c.active);
  if (active) {
    const card = el("div", { class: "card" },
      el("h3", {}, "Active campaign"),
      el("div", { class: "grid cols3" },
        mkRow("Name", active.name),
        mkRow("Target role", active.target_role),
        mkRow("Phase", active.phase),
        mkRow("Started", fmtTime(active.created_at))),
      el("div", { class: "btn-row", style: "margin-top:.8rem;" },
        el("button", { class: "btn-warn", onclick: async () => {
          if (!confirm(`Close campaign "${active.name}"?`)) return;
          try { await api(`/cursus/campaigns/${active.id}/close`, { method: "POST" }); toast("Campaign closed", "ok"); navigate("#campaigns"); }
          catch (err) { toast(err.message, "err"); }
        } }, "Close campaign"),
        el("a", { class: "btn-ghost", href: `#apps?campaign_id=${active.id}` }, "View applications")),
    );
    // Analytics
    try {
      const a = (await api(`/cursus/analytics/campaign/${active.id}`)).analytics;
      const insights = el("div", {});
      if (a?.insights?.length) {
        const ul = el("ul", { style: "margin:0; padding-left:1.1rem;" });
        for (const i of a.insights) ul.appendChild(el("li", {}, typeof i === "string" ? i : (i.message || JSON.stringify(i))));
        insights.appendChild(ul);
      } else insights.appendChild(el("div", { class: "empty" }, "No insights yet — log some applications."));
      card.appendChild(el("div", { class: "card", style: "margin-top:1rem;" },
        el("h3", {}, "Analytics"),
        el("div", { class: "grid cols4" },
          mkRow("Apps", a?.total_applications ?? 0),
          mkRow("Responses", a?.responses ?? 0),
          mkRow("Interviews", a?.interviews ?? 0),
          mkRow("Response rate", a?.response_rate != null ? `${Math.round(a.response_rate * 100)}%` : "—"),
        ),
        insights));
    } catch { /* analytics endpoint failure is non-fatal */ }
    root.appendChild(card);
  } else {
    // Start a new one
    const form = el("form", { class: "card" },
      el("h3", {}, "Start a campaign"),
      el("div", { class: "form-grid" },
        el("label", {}, "Name"),         el("input", { name: "name", required: true }),
        el("label", {}, "Target role"),  el("input", { name: "target_role", required: true, placeholder: "e.g. Senior Site Reliability Engineer" })),
      el("div", { class: "btn-row", style: "margin-top:.6rem;" },
        el("button", { class: "btn-primary", type: "submit" }, "Create")));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try { await api("/cursus/campaigns", { method: "POST", body: Object.fromEntries(fd.entries()) }); toast("Campaign created", "ok"); navigate("#campaigns"); }
      catch (err) { toast(err.message, "err"); }
    });
    root.appendChild(form);
  }

  // History
  const history = el("div", { class: "card" }, el("h3", {}, "All campaigns"));
  if (camps.length === 0) history.appendChild(el("div", { class: "empty" }, "No campaigns yet."));
  else {
    const tbl = el("table", {}, el("thead", {}, el("tr", {},
      el("th", {}, "Name"), el("th", {}, "Target"), el("th", {}, "Phase"), el("th", {}, "Active"), el("th", {}, "Created"))));
    const tb = el("tbody", {});
    for (const c of camps) tb.appendChild(el("tr", {},
      el("td", {}, c.name),
      el("td", {}, c.target_role),
      el("td", {}, c.phase),
      el("td", {}, el("span", { class: `tag ${c.active ? "ok" : ""}` }, c.active ? "yes" : "—")),
      el("td", { class: "muted" }, fmtTime(c.created_at))));
    tbl.appendChild(tb);
    history.appendChild(tbl);
  }
  root.appendChild(history);
}

// ── Job Scout ────────────────────────────────────────────────────────────
async function renderJobScout(root) {
  const ctx = await api("/cursus/job-scout/context").catch(() => null);
  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Job Scout"));
  root.appendChild(el("p", { class: "muted" },
    "Cursus does not crawl boards itself. Use the context below to drive an external search tool, then ingest results here."));

  // Context preview
  const c = ctx?.context || {};
  const ctxCard = el("div", { class: "card" }, el("h3", {}, "Search context"),
    el("div", { class: "grid cols3" },
      mkRow("Campaign", c.campaign_name || "—"),
      mkRow("Primary target", c.primary_target_role || "—"),
      mkRow("All targets", (c.all_target_roles || []).join(", ") || "—"),
      mkRow("Location", c.location || "—"),
      mkRow("Remote preference", c.remote_preference || "—"),
      mkRow("Salary", c.salary_range ? `${c.salary_range.min ?? "?"} – ${c.salary_range.max ?? "?"}` : "—"),
      mkRow("Certifications", c.certifications || "—"),
      mkRow("Live search?",  ctx?.live_search_implemented ? "yes" : "no (manual/external)"),
      mkRow("Mode", ctx?.ingestion_mode || "—"),
    ));
  root.appendChild(ctxCard);

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
      const res = await api("/cursus/job-scout/ingest", { method: "POST", body: { jobs: [job] } });
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
  const url = cid ? `/cursus/applications?campaign_id=${encodeURIComponent(cid)}` : "/cursus/applications";
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
        try { await api(`/cursus/applications/${a.id}`, { method: "PATCH", body: { status: statusSel.value } }); toast("Updated", "ok"); }
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
          try { await api(`/cursus/applications/${a.id}/follow-up`, { method: "POST" }); toast("Follow-up recorded", "ok"); navigate("#apps"); }
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
  const tasks = (await api("/cursus/automation").catch(() => ({ tasks: [], mode: "?" })));
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
    try { await api(`/cursus/automation/${id}/${what}`, { method: "POST" }); toast(`${what}d`, "ok"); navigate("#queue"); }
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
    const recs = (await api(`/cursus/receipts${q}`)).receipts || [];
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
  const [providerR, statusR] = await Promise.allSettled([api("/cursus/provider"), api("/status")]);
  const p = providerR.status === "fulfilled" ? providerR.value.provider : {};
  const s = statusR.status === "fulfilled" ? statusR.value : {};
  root.innerHTML = "";
  root.appendChild(el("h2", {}, "Settings"));
  root.appendChild(el("p", { class: "muted" }, "Service-wide provider, network exposure, and auth posture. API keys are write-only."));

  const stats = el("div", { class: "grid cols3" });
  for (const [k, v] of Object.entries({
    "Host":              s.host,
    "Port":              s.port,
    "Network exposure":  s.network_exposure,
    "Auth required":     s.auth_required,
    "Token configured":  s.auth_token_configured,
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
  form.appendChild(el("p", { class: "muted small" }, "These changes apply in-process. For persistence, edit ", el("code", {}, "/mnt/ai/cursus/.env"), " and restart the service."));
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
    try { await api("/cursus/provider", { method: "PATCH", body: patch }); toast("Provider updated", "ok"); refreshStatus(); navigate("#settings"); }
    catch (err) { toast(err.message, "err"); }
  });
  root.appendChild(form);

  // Auth controls
  const auth = el("div", { class: "card" },
    el("h3", {}, "Browser auth token"),
    el("p", { class: "muted small" }, getToken() ? "A token is stored in localStorage." : "No token stored. Set one if this Cursus requires auth."),
    el("div", { class: "btn-row" },
      el("button", { class: "btn-primary", onclick: () => showAuthModal() }, "Set token"),
      el("button", { class: "btn-ghost",   onclick: () => { setToken(""); refreshStatus(); toast("Token cleared", "warn"); navigate("#settings"); } }, "Clear token")));
  root.appendChild(auth);

  // Helpful CLI hints
  root.appendChild(el("div", { class: "card" },
    el("h3", {}, "Operational"),
    el("p", { class: "small muted" }, "Restart after env changes:"),
    el("pre", {}, "sudo systemctl restart cursus.service"),
    el("p", { class: "small muted" }, "Verify standalone posture:"),
    el("pre", {}, "/mnt/ai/cursus/scripts/verify-standalone.sh"),
    el("p", { class: "small muted" }, "Reconfigure providers / Tailscale:"),
    el("pre", {}, "cd /mnt/ai/cursus && pnpm run cursus:setup")));
}
