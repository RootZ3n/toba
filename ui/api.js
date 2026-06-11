// ══════════════════════════════════════════════════════════════════════
// TOBA · API CLIENT — talks to the local Toba service (port 18815)
// Same-origin by default (override with window.TOBA_API_BASE). Every call
// resolves to a uniform envelope and NEVER throws on HTTP/network errors:
//   { ok:boolean, data:any, error:string|null, status:number }
// Callers branch on `.ok`; on failure `.error` is a human-readable string.
// ══════════════════════════════════════════════════════════════════════
(function () {
  // '' = same origin. Trailing slash trimmed so BASE + '/path' is clean.
  const BASE = String(window.TOBA_API_BASE || '').replace(/\/+$/, '');

  async function request(method, path, body) {
    const opts = { method, headers: { accept: 'application/json' } };
    if (body !== undefined && body !== null) {
      opts.headers['content-type'] = 'application/json';
      opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    try {
      const res = await fetch(BASE + path, opts);
      const ct = res.headers.get('content-type') || '';
      const payload = ct.includes('application/json')
        ? await res.json().catch(() => ({}))
        : await res.text();
      if (!res.ok) {
        const error = (payload && payload.error)
          || (typeof payload === 'string' && payload) || `HTTP ${res.status}`;
        return { ok: false, data: payload, error, status: res.status };
      }
      return { ok: true, data: payload, error: null, status: res.status };
    } catch (err) {
      // Network failure, server down, CORS — surfaced as ok:false, status:0.
      return { ok: false, data: null, error: String((err && err.message) || err), status: 0 };
    }
  }

  const get = (p) => request('GET', p);
  const post = (p, b) => request('POST', p, b);
  const patch = (p, b) => request('PATCH', p, b);
  const del = (p) => request('DELETE', p);
  const q = (v) => encodeURIComponent(String(v));

  // ── Typed endpoint helpers (thin wrappers over the verbs above) ────────
  const TobaAPI = {
    BASE, request, get, post, patch, del,

    // System / health
    health: () => get('/health'),
    status: () => get('/status'),
    provider: () => get('/toba/provider'),

    // Career data (reads)
    dashboard: () => get('/toba/dashboard'),
    profile: () => get('/toba/profile'),
    profileV2: () => get('/toba/profile/v2'),
    skills: () => get('/toba/skills'),
    experience: () => get('/toba/experience'),
    receipts: (limit = 12, action) =>
      get('/toba/receipts?limit=' + q(limit) + (action ? '&action=' + q(action) : '')),

    // Campaigns
    campaigns: () => get('/toba/campaigns'),
    campaign: (id) => get('/toba/campaigns/' + q(id)),
    createCampaign: (name, target_role) => post('/toba/campaigns', { name, target_role }),
    updateCampaign: (id, changes) => patch('/toba/campaigns/' + q(id), changes),
    closeCampaign: (id) => post('/toba/campaigns/' + q(id) + '/close'),

    // Applications
    applications: (campaignId) =>
      get('/toba/applications' + (campaignId ? '?campaign_id=' + q(campaignId) : '')),
    createApplication: (app) => post('/toba/applications', app),
    updateApplication: (id, changes) => patch('/toba/applications/' + q(id), changes),

    // Peh — the guide's voice on the backend
    pehChat: (message, opts) => post('/toba/peh/chat', Object.assign({ message }, opts || {})),
    pehSessions: () => get('/toba/peh/sessions'),
  };

  window.TobaAPI = TobaAPI;
})();
