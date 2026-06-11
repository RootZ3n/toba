// ══════════════════════════════════════════════════════════════════════
// TOBA · HUD — the persistent chrome layered over the world engine.
// Three pieces, all fixed-position so the engine's #app re-renders never
// wipe them: a live STATUS dot (server + provider + campaign), a COMMAND
// bar (talk to Peh, run quick actions), and a JOURNAL (recent activity).
// Boots after the inline engine, mounts once, polls gently.
// ══════════════════════════════════════════════════════════════════════
(function () {
  const API = window.TobaAPI;
  const Peh = window.Peh;
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const STYLE = `
  #toba-hud{position:fixed;inset:0;pointer-events:none;z-index:9000;font-family:inherit}
  #toba-hud>*{pointer-events:auto}
  .toba-status{position:fixed;top:14px;right:16px;display:flex;align-items:center;gap:8px;
    background:var(--bg-card,rgba(30,22,12,.85));border:1px solid rgba(217,119,6,.35);
    border-radius:999px;padding:6px 12px;font-size:12px;color:#f3ecdc;backdrop-filter:blur(6px);cursor:pointer}
  .toba-dot{width:9px;height:9px;border-radius:50%;background:#888;box-shadow:0 0 0 0 rgba(0,0,0,0)}
  .toba-dot.ok{background:#3fb950;box-shadow:0 0 8px rgba(63,185,80,.7)}
  .toba-dot.warn{background:#d29922;box-shadow:0 0 8px rgba(210,153,34,.7)}
  .toba-dot.down{background:#f85149;box-shadow:0 0 8px rgba(248,81,73,.7)}
  .toba-status b{font-weight:600}.toba-status i{opacity:.7;font-style:normal}
  .toba-cmd{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);display:flex;gap:8px;
    width:min(620px,92vw);background:var(--bg-card,rgba(30,22,12,.9));border:1px solid rgba(217,119,6,.4);
    border-radius:14px;padding:8px;backdrop-filter:blur(8px);box-shadow:0 10px 40px rgba(0,0,0,.5)}
  .toba-cmd input{flex:1;background:transparent;border:0;outline:0;color:#f3ecdc;font-size:14px;padding:6px 10px}
  .toba-cmd input::placeholder{color:#b6a079}
  .toba-cmd button{background:var(--peh-accent,#d97706);color:#1a1208;border:0;border-radius:9px;
    padding:6px 14px;font-weight:700;cursor:pointer}
  .toba-cmd button:disabled{opacity:.5;cursor:default}
  .toba-jbtn{position:fixed;right:16px;bottom:18px;background:var(--bg-card,rgba(30,22,12,.9));
    border:1px solid rgba(217,119,6,.4);color:#f3ecdc;border-radius:12px;padding:9px 12px;cursor:pointer;font-size:13px}
  .toba-journal{position:fixed;top:0;right:0;height:100%;width:min(360px,90vw);
    background:var(--bg-1,#1a1208);border-left:1px solid rgba(217,119,6,.35);
    transform:translateX(100%);transition:transform .25s ease;padding:16px;overflow:auto;color:#f3ecdc}
  .toba-journal.open{transform:translateX(0)}
  .toba-journal h3{margin:.2rem 0 1rem;font-size:15px}
  .toba-jclose{position:absolute;top:12px;right:14px;background:none;border:0;color:#b6a079;font-size:20px;cursor:pointer}
  .toba-jitem{border-bottom:1px solid rgba(217,119,6,.15);padding:8px 0;font-size:12.5px}
  .toba-jitem b{display:block;text-transform:capitalize}.toba-jitem i{opacity:.65;font-style:normal}
  .peh-say{position:fixed;left:16px;bottom:78px;max-width:min(420px,88vw);display:flex;gap:10px;
    background:var(--bg-card,rgba(30,22,12,.95));border:1px solid rgba(217,119,6,.45);border-radius:14px;
    padding:12px 14px;color:#f3ecdc;opacity:0;transform:translateY(8px);transition:opacity .25s,transform .25s;
    pointer-events:none;z-index:9001;box-shadow:0 10px 40px rgba(0,0,0,.5)}
  .peh-say.show{opacity:1;transform:translateY(0);pointer-events:auto}
  .peh-say-mark{font-size:20px}.peh-say-name{display:block;color:var(--peh-accent,#d97706);font-size:12px}
  .peh-say-text{margin:.15rem 0 0;font-size:13.5px;line-height:1.45}
  .peh-say-x{position:absolute;top:6px;right:9px;background:none;border:0;color:#b6a079;cursor:pointer;font-size:16px}
  .toba-live{margin:10px 0}.toba-live-head{font-size:11px;letter-spacing:.06em;text-transform:uppercase;
    color:var(--peh-accent,#d97706);margin-bottom:6px}
  .toba-live-list{list-style:none;margin:0;padding:0}
  .toba-live-list li{padding:5px 0;border-bottom:1px solid rgba(217,119,6,.12);font-size:13px}
  .tl-main{display:block}.tl-sub{display:block;opacity:.65;font-size:11.5px}
  .toba-live-empty,.toba-live-loading{font-size:12.5px;opacity:.7}
  .toba-stats{margin:14px 0}.toba-stats-row{display:flex;gap:10px;flex-wrap:wrap}
  .toba-stat{flex:1;min-width:90px;background:rgba(217,119,6,.08);border:1px solid rgba(217,119,6,.2);
    border-radius:10px;padding:8px 10px;text-align:center}
  .toba-stat b{display:block;font-size:20px}.toba-stat i{font-style:normal;font-size:11px;opacity:.7}
  .toba-stat-note{margin-top:8px;font-size:12.5px;opacity:.85}`;

  function injectStyle() {
    const s = document.createElement('style');
    s.id = 'toba-hud-style';
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  const currentScene = () =>
    (document.querySelector('.peh-scene') || {}).dataset?.scene ||
    localStorage.getItem('pehverse-scene') || 'cave-entrance';

  // ── Status dot ─────────────────────────────────────────────────────────
  let statusEl;
  async function refreshStatus() {
    if (!statusEl) return;
    const [h, s] = await Promise.all([API.health(), API.status()]);
    const dot = statusEl.querySelector('.toba-dot');
    const txt = statusEl.querySelector('.toba-status-txt');
    if (!h.ok && !s.ok) {
      dot.className = 'toba-dot down';
      txt.innerHTML = '<b>Settlement offline</b>';
      return;
    }
    const st = s.data || {};
    const healthy = h.ok && (h.data.status || '').startsWith('healthy');
    dot.className = 'toba-dot ' + (healthy ? 'ok' : 'warn');
    const camp = st.active_campaign ? st.active_campaign.name : 'no campaign';
    txt.innerHTML = '<b>' + esc(st.provider || '—') + '/' + esc(st.model || '—') + '</b> · <i>' + esc(camp) + '</i>';
  }

  // ── Journal ────────────────────────────────────────────────────────────
  let journalEl;
  function toggleJournal(force) {
    const open = typeof force === 'boolean' ? force : !journalEl.classList.contains('open');
    journalEl.classList.toggle('open', open);
    if (open) loadJournal();
  }
  async function loadJournal() {
    const body = journalEl.querySelector('.toba-jbody');
    body.innerHTML = '<div class="toba-live-loading">Reading the journal…</div>';
    const r = await API.receipts(20);
    if (!r.ok) { body.innerHTML = '<div class="toba-live-empty">Journal unreachable.</div>'; return; }
    const rec = r.data.receipts || [];
    body.innerHTML = rec.length
      ? rec.map((x) => '<div class="toba-jitem"><b>' + esc((x.action || '').replace(/_/g, ' ')) +
          '</b><i>' + esc(x.result_summary || '') + '</i></div>').join('')
      : '<div class="toba-live-empty">Nothing carved yet.</div>';
  }

  // ── Command bar ────────────────────────────────────────────────────────
  async function runCommand(raw) {
    const text = raw.trim();
    if (!text) return;
    if (text[0] === '/') return slash(text.slice(1));
    Peh.say('Let me think on that…', { hold: 0 });
    const r = await API.pehChat(text);
    if (r.ok && r.data.reply) Peh.say(r.data.reply, { hold: 12000 });
    else Peh.say(r.error ? ('I couldn\'t reach my thoughts — ' + r.error) : 'No reply came back, friend.', { hold: 9000 });
  }
  async function slash(cmd) {
    const [verb, ...rest] = cmd.split(/\s+/);
    const arg = rest.join(' ');
    switch ((verb || '').toLowerCase()) {
      case 'help':
        return Peh.say('Try: /here (what\'s around), /status, /journal, /go <area>, /new <name> | <role>. Or just talk to me.', { hold: 12000 });
      case 'status':
        await refreshStatus();
        return Peh.say('Status refreshed — check the dot up top.', { hold: 6000 });
      case 'journal':
        return toggleJournal();
      case 'here': {
        Peh.say('Looking around…', { hold: 0 });
        const sum = await window.TobaScenes.summaryFor(currentScene());
        return Peh.say(sum || 'Quiet here for now.', { hold: 14000 });
      }
      case 'go':
        if (window.pehGoScene) { window.pehGoScene(arg.replace(/\s+/g, '-').toLowerCase()); return Peh.greet(currentScene()); }
        return Peh.say('I can\'t find that trail.', { hold: 6000 });
      case 'new': {
        const [name, role] = arg.split('|').map((s) => s.trim());
        if (!name || !role) return Peh.say('Name it like this: /new Backend hunt | Senior Engineer', { hold: 9000 });
        const r = await API.createCampaign(name, role);
        await refreshStatus();
        return Peh.say(r.ok ? ('New campaign lit: ' + name + '.') : ('Couldn\'t start it — ' + r.error), { hold: 9000 });
      }
      default:
        return Peh.say('I don\'t know that one. Try /help.', { hold: 7000 });
    }
  }

  // ── Mount ──────────────────────────────────────────────────────────────
  function mount() {
    if (document.getElementById('toba-hud')) return;
    injectStyle();
    const hud = document.createElement('div');
    hud.id = 'toba-hud';
    hud.innerHTML =
      '<div class="toba-status" title="Toba service status"><span class="toba-dot"></span>' +
        '<span class="toba-status-txt"><b>connecting…</b></span></div>' +
      '<div class="toba-cmd"><input type="text" placeholder="Talk to Peh, or /help" aria-label="Command bar">' +
        '<button type="button">Send</button></div>' +
      '<button class="toba-jbtn" type="button" title="Activity journal">📜 Journal</button>' +
      '<div class="toba-journal"><button class="toba-jclose" aria-label="Close journal">×</button>' +
        '<h3>Settlement Journal</h3><div class="toba-jbody"></div></div>';
    document.body.appendChild(hud);

    statusEl = hud.querySelector('.toba-status');
    journalEl = hud.querySelector('.toba-journal');
    const input = hud.querySelector('.toba-cmd input');
    const send = hud.querySelector('.toba-cmd button');
    const submit = () => { const v = input.value; input.value = ''; runCommand(v); };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    statusEl.addEventListener('click', refreshStatus);
    hud.querySelector('.toba-jbtn').addEventListener('click', () => toggleJournal());
    hud.querySelector('.toba-jclose').addEventListener('click', () => toggleJournal(false));

    refreshStatus();
    setInterval(refreshStatus, 20000);

    // Peh greets the scene, and greets again whenever the engine travels.
    let last = null;
    const watch = () => {
      const sc = currentScene();
      if (sc !== last) { last = sc; Peh.greet(sc); }
    };
    setTimeout(watch, 600);
    setInterval(watch, 1000);

    if (window.TobaScenes) window.TobaScenes.init();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
