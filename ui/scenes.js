// ══════════════════════════════════════════════════════════════════════
// TOBA · SCENE DATA — binds each settlement location to live backend data.
// The inline world engine renders placeholder workspace bodies; this module
// watches for them and injects real career data (profile, campaigns,
// applications, skills, milestones) fetched through TobaAPI. It is
// non-invasive: it never touches the engine's render pipeline, it only
// enriches the DOM the engine produces.
// ══════════════════════════════════════════════════════════════════════
(function () {
  const API = window.TobaAPI;
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function list(items, empty) {
    if (!items || !items.length) return '<div class="toba-live-empty">' + esc(empty) + '</div>';
    return '<ul class="toba-live-list">' + items.map((i) =>
      '<li><span class="tl-main">' + esc(i.main) + '</span>' +
      (i.sub ? '<span class="tl-sub">' + esc(i.sub) + '</span>' : '') + '</li>').join('') + '</ul>';
  }
  function head(label) { return '<div class="toba-live-head">' + esc(label) + '</div>'; }

  // ── Loaders — each resolves to an HTML string (never rejects) ──────────
  async function loadPaths() {
    const r = await API.campaigns();
    if (!r.ok) return head('Career paths') + '<div class="toba-live-empty">Records unreachable.</div>';
    const camps = (r.data.campaigns || []);
    return head('Campaigns · ' + camps.length) + list(camps.map((c) => ({
      main: (c.active ? '● ' : '○ ') + c.name,
      sub: 'targeting ' + (c.target_role || '—') + ' · ' + (c.phase || 'research'),
    })), 'No campaigns yet — start one from the command bar with “new campaign”.');
  }
  async function loadSkills() {
    const r = await API.skills();
    if (!r.ok) return head('Skills') + '<div class="toba-live-empty">Records unreachable.</div>';
    const skills = (r.data.skills || []);
    return head('Skills gathered · ' + skills.length) + list(skills.slice(0, 12).map((s) => ({
      main: s.name || s.skill || String(s),
      sub: s.level || s.category || '',
    })), 'No skills logged yet — every one you gather carries you further.');
  }
  async function loadNetwork() {
    const r = await API.applications();
    if (!r.ok) return head('Connections') + '<div class="toba-live-empty">Records unreachable.</div>';
    const apps = (r.data.applications || []);
    const companies = [...new Set(apps.map((a) => a.company).filter(Boolean))];
    return head('Companies in reach · ' + companies.length) + list(companies.slice(0, 12).map((c) => ({
      main: c, sub: apps.filter((a) => a.company === c).length + ' application(s)',
    })), 'No connections yet — the campfire is warm whenever you are.');
  }
  async function loadMilestones() {
    const r = await API.receipts(10);
    if (!r.ok) return head('Milestones') + '<div class="toba-live-empty">Records unreachable.</div>';
    const rec = (r.data.receipts || []);
    return head('Carved into the stone · ' + rec.length) + list(rec.map((x) => ({
      main: (x.action || 'event').replace(/_/g, ' '),
      sub: x.result_summary || '',
    })), 'No milestones carved yet — they are earned, not given.');
  }
  async function loadPlanning() {
    const [p, v2] = await Promise.all([API.profile(), API.profileV2()]);
    const prof = (p.ok && p.data.profile) || {};
    const roles = (v2.ok && v2.data.profile && v2.data.profile.target_roles) || prof.target_roles;
    let parsed = [];
    try { parsed = Array.isArray(roles) ? roles : JSON.parse(roles || '[]'); } catch { parsed = []; }
    return head('Vision on the wall') + list([
      { main: prof.name || 'Name not set', sub: prof.title || 'title not set' },
      { main: 'Target roles', sub: parsed.join(', ') || 'not set' },
      { main: 'Location', sub: prof.location || 'not set' },
    ], 'Draw your plan on the stone — set a profile to begin.');
  }
  async function loadProcessing() {
    const r = await API.applications();
    if (!r.ok) return head('In the fire') + '<div class="toba-live-empty">Records unreachable.</div>';
    const apps = (r.data.applications || []).filter((a) =>
      a.status && a.status !== 'closed' && a.status !== 'rejected');
    return head('Cooking now · ' + apps.length) + list(apps.slice(0, 12).map((a) => ({
      main: a.company + ' — ' + a.role, sub: 'status: ' + (a.status || 'new'),
    })), 'Nothing in the fire yet — bring raw experience to refine.');
  }
  async function loadOverview() {
    const r = await API.dashboard();
    if (!r.ok) return '<div class="toba-live-empty">Settlement records unreachable.</div>';
    const d = r.data.dashboard || {};
    const s = d.stats || {};
    const cells = [
      ['Applications', s.applications_sent ?? d.totalApplications ?? 0],
      ['Responses', s.responses ?? 0],
      ['Interviews', s.interviews ?? 0],
      ['Pending outreach', d.pendingOutreach ?? 0],
    ];
    return '<div class="toba-stats-row">' + cells.map(([k, v]) =>
      '<div class="toba-stat"><b>' + esc(v) + '</b><i>' + esc(k) + '</i></div>').join('') +
      '</div>' + (d.activeCampaign
        ? '<div class="toba-stat-note">Active campaign: <b>' + esc(d.activeCampaign.name) +
          '</b> · ' + esc(d.activeCampaign.target_role || '') + '</div>'
        : '<div class="toba-stat-note">No active campaign — ask Peh to help define a target role.</div>');
  }

  // Workspace panel title → loader. (Engine sets def.title in .peh-panel-title.)
  const BY_TITLE = {
    'Career Paths': loadPaths,
    'Skill Building': loadSkills,
    'Connections': loadNetwork,
    'Milestones': loadMilestones,
    'Career Planning': loadPlanning,
    'Fire Processing': loadProcessing,
  };
  // Scene id → loader, for textual summaries spoken by Peh / the command bar.
  const BY_SCENE = {
    'cave-entrance': loadOverview, 'hunting-grounds': loadPaths,
    'gathering-place': loadSkills, 'campfire-circle': loadNetwork,
    'stone-table': loadMilestones, 'cave-paintings': loadPlanning,
    'fire-pit': loadProcessing,
  };

  // ── DOM enrichment ─────────────────────────────────────────────────────
  function enrichPlaceholder(ph) {
    const panel = ph.closest('.peh-panel, .peh-tile');
    const title = panel && panel.querySelector('.peh-panel-title');
    const loader = title && BY_TITLE[title.textContent.trim()];
    if (!loader) return;
    ph.setAttribute('data-toba-live', 'loading');
    const holder = document.createElement('div');
    holder.className = 'toba-live';
    holder.innerHTML = '<div class="toba-live-loading">Peh is reading the stones…</div>';
    const tag = ph.querySelector('.peh-ph-tag');
    if (tag) ph.insertBefore(holder, tag); else ph.appendChild(holder);
    loader().then((html) => { holder.innerHTML = html; ph.setAttribute('data-toba-live', 'ready'); });
  }
  function enrichOverview(con) {
    con.setAttribute('data-toba-live', 'loading');
    const strip = document.createElement('div');
    strip.className = 'toba-stats';
    strip.innerHTML = '<div class="toba-live-loading">Peh is reading the stones…</div>';
    const hero = con.querySelector('.settle-hero');
    if (hero) hero.insertAdjacentElement('afterend', strip); else con.prepend(strip);
    loadOverview().then((html) => { strip.innerHTML = html; con.setAttribute('data-toba-live', 'ready'); });
  }
  function scan(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('.peh-ph:not([data-toba-live])').forEach(enrichPlaceholder);
    scope.querySelectorAll('.settle-console:not([data-toba-live])').forEach(enrichOverview);
  }

  let observer = null;
  function init() {
    const app = document.getElementById('app');
    if (!app || observer) return;
    scan(document);
    let pending = false;
    observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; scan(document); });
    });
    observer.observe(app, { childList: true, subtree: true });
  }

  // Textual summary for the active scene — Peh speaks this on request.
  async function summaryFor(sceneId) {
    const loader = BY_SCENE[sceneId] || loadOverview;
    const html = await loader();
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  window.TobaScenes = { init, scan, summaryFor, loadOverview };
})();
