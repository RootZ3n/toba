// ══════════════════════════════════════════════════════════════════════
// TOBA · FIRST-LAUNCH ONBOARDING OVERLAY
// Peh greets new visitors with a warm stone-age welcome, then guides
// them through each settlement location with contextual speech bubbles.
// Persists completion to localStorage('pehverse-onboarded').
// Re-triggerable via the Help button in the HUD.
// ══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var FLAG = 'pehverse-onboarded';
  var TOUR_DELAY_MIN = 1000;   // 1s min between tour stops
  var TOUR_DELAY_MAX = 8000;   // 8s max between tour stops
  var TOUR_HOLD_MS   = 6000;   // how long each greeting stays visible

  // ── First-launch detection ──────────────────────────────────────────
  function isFirstLaunch() {
    try { return !localStorage.getItem(FLAG); } catch (e) { return true; }
  }
  function markOnboarded() {
    try { localStorage.setItem(FLAG, '1'); } catch (e) {}
  }

  // ── Overlay root ────────────────────────────────────────────────────
  var overlay = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'peh-onboarding';
    overlay.className = 'peh-onboard-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Welcome to The Settlement');
    overlay.innerHTML =
      '<div class="peh-onboard-backdrop"></div>' +
      '<div class="peh-onboard-card">' +
        '<div class="peh-onboard-portrait">' +
          '<img src="assets/peh-toba.png" alt="Peh" class="peh-onboard-img" loading="eager">' +
        '</div>' +
        '<div class="peh-onboard-bubble">' +
          '<span class="peh-onboard-name">Pehlichi</span>' +
          '<p class="peh-onboard-text">Halito! My name is Pehlichi, but my friends call me Peh. I will be joining you on this new adventure. Would you like to get started?</p>' +
          '<div class="peh-onboard-actions">' +
            '<button class="peh-onboard-btn peh-onboard-start" type="button">Let\'s go</button>' +
            '<button class="peh-onboard-btn peh-onboard-skip" type="button">Skip tour</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.querySelector('.peh-onboard-start').addEventListener('click', startTour);
    overlay.querySelector('.peh-onboard-skip').addEventListener('click', skipTour);
    overlay.querySelector('.peh-onboard-backdrop').addEventListener('click', skipTour);

    // Esc to skip
    overlay._escHandler = function (e) {
      if (e.key === 'Escape') skipTour();
    };
    document.addEventListener('keydown', overlay._escHandler);

    return overlay;
  }

  function showOverlay() {
    var el = ensureOverlay();
    el.classList.add('visible');
    // Focus the start button for a11y
    setTimeout(function () {
      var btn = el.querySelector('.peh-onboard-start');
      if (btn) btn.focus();
    }, 100);
  }

  function hideOverlay() {
    if (!overlay) return;
    overlay.classList.remove('visible');
    document.removeEventListener('keydown', overlay._escHandler);
    setTimeout(function () {
      if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
      overlay = null;
    }, 400);
  }

  // ── Interactive setup quest (live state) ────────────────────────────
  // Replaces the old cosmetic scripted tour. Drives an interactive checklist
  // from the real backend (GET /toba/setup/quest). Each completed step lights
  // up the matching settlement location and carves a milestone receipt.
  var questEl = null;
  var lastDoneSet = {}; // step id -> done, to detect transitions

  // Each quest step id maps to a scene to travel to when the user clicks "Go".
  var STEP_SCENE = {
    configure_model: 'cave-entrance',
    profile_and_campaign: 'longhouse',
    upload_resume: 'tannery',
    find_jobs: 'watchtower',
  };

  function api() { return window.TobaAPI; }

  function ensureQuest() {
    if (questEl) return questEl;
    questEl = document.createElement('div');
    questEl.id = 'peh-quest';
    questEl.className = 'peh-quest-overlay';
    questEl.setAttribute('role', 'dialog');
    questEl.setAttribute('aria-modal', 'true');
    questEl.setAttribute('aria-label', 'Setup quest');
    questEl.innerHTML =
      '<div class="peh-quest-backdrop"></div>' +
      '<div class="peh-quest-card">' +
        '<header class="peh-quest-head">' +
          '<img src="assets/peh-toba.png" alt="Peh" class="peh-quest-img">' +
          '<div><h2 class="peh-quest-title">Your first quest</h2>' +
          '<p class="peh-quest-sub">Light up the settlement, one step at a time.</p></div>' +
          '<button class="peh-quest-close" type="button" aria-label="Close">×</button>' +
        '</header>' +
        '<div class="peh-quest-progress"><div class="peh-quest-bar"></div><span class="peh-quest-count"></span></div>' +
        '<ol class="peh-quest-steps"></ol>' +
        '<footer class="peh-quest-foot">' +
          '<button class="peh-quest-refresh" type="button">Refresh</button>' +
        '</footer>' +
      '</div>';
    document.body.appendChild(questEl);
    questEl.querySelector('.peh-quest-close').addEventListener('click', hideQuest);
    questEl.querySelector('.peh-quest-backdrop').addEventListener('click', hideQuest);
    questEl.querySelector('.peh-quest-refresh').addEventListener('click', loadQuest);
    return questEl;
  }

  function hideQuest() {
    if (!questEl) return;
    questEl.classList.remove('visible');
    setTimeout(function () {
      if (questEl && questEl.parentNode) questEl.parentNode.removeChild(questEl);
      questEl = null;
    }, 300);
  }

  function stepActionLabel(id) {
    switch (id) {
      case 'configure_model': return 'Open The Fire';
      case 'profile_and_campaign': return 'Open The Longhouse';
      case 'upload_resume': return 'Open The Tannery';
      case 'find_jobs': return 'Open The Watchtower';
      default: return 'Go';
    }
  }

  function goToStep(id) {
    var scene = STEP_SCENE[id];
    hideQuest();
    try { if (scene && typeof pehGoScene === 'function') pehGoScene(scene); } catch (e) {}
    // Special case: "find_jobs" can be triggered directly from the quest.
    if (id === 'find_jobs' && api()) {
      try {
        if (window.Peh) window.Peh.say('Let me scout the watchtower for fresh tracks…', { hold: 4000 });
        api().jobScoutRun().then(function (r) {
          if (r && r.ok && window.Peh) {
            var d = r.data || {};
            var msg = d.ran === false
              ? 'No lanes to scout yet — set a search lane first.'
              : ('Scouted ' + (d.lanes_scanned || 0) + ' lane(s): ' + (d.discovered || 0) + ' found, ' +
                 (d.staged || d.ingested || 0) + ' staged for your review.');
            window.Peh.say(msg, { hold: 6000 });
          }
        });
      } catch (e) {}
    }
  }

  function renderQuest(quest) {
    if (!questEl) return;
    var bar = questEl.querySelector('.peh-quest-bar');
    var count = questEl.querySelector('.peh-quest-count');
    var list = questEl.querySelector('.peh-quest-steps');
    var pct = quest.total ? Math.round((quest.completed / quest.total) * 100) : 0;
    if (bar) bar.style.width = pct + '%';
    if (count) count.textContent = quest.completed + ' / ' + quest.total;
    list.innerHTML = '';

    (quest.steps || []).forEach(function (step) {
      // Detect a fresh completion → carve a milestone receipt once.
      if (step.done && lastDoneSet[step.id] === false && api()) {
        try { api().setupMilestone(step.id, step.title); } catch (e) {}
      }
      lastDoneSet[step.id] = !!step.done;

      var li = document.createElement('li');
      li.className = 'peh-quest-step' + (step.done ? ' done' : '');
      var actions = step.done
        ? '<span class="peh-quest-badge">Lit ✓</span>'
        : '<button class="peh-quest-go" type="button">' + stepActionLabel(step.id) + '</button>';
      li.innerHTML =
        '<span class="peh-quest-mark">' + (step.done ? '✓' : '○') + '</span>' +
        '<div class="peh-quest-body">' +
          '<div class="peh-quest-steptitle">' + escapeHtml(step.title) + '</div>' +
          '<div class="peh-quest-loc">' + escapeHtml(step.location || '') + '</div>' +
          '<div class="peh-quest-desc">' + escapeHtml(step.description || '') + '</div>' +
        '</div>' +
        '<div class="peh-quest-act">' + actions + '</div>';
      var goBtn = li.querySelector('.peh-quest-go');
      if (goBtn) goBtn.addEventListener('click', function () { goToStep(step.id); });
      list.appendChild(li);
    });

    if (quest.all_done) {
      var done = document.createElement('li');
      done.className = 'peh-quest-step alldone';
      done.innerHTML = '<span class="peh-quest-mark">★</span><div class="peh-quest-body">' +
        '<div class="peh-quest-steptitle">The settlement is alive!</div>' +
        '<div class="peh-quest-desc">Every fire is lit. You are ready to run your search.</div></div>';
      list.appendChild(done);
      markOnboarded();
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function loadQuest() {
    ensureQuest().classList.add('visible');
    var list = questEl.querySelector('.peh-quest-steps');
    if (list && !list.children.length) list.innerHTML = '<li class="peh-quest-loading">Reading the settlement…</li>';
    if (!api()) {
      if (list) list.innerHTML = '<li class="peh-quest-loading">Toba API unavailable.</li>';
      return;
    }
    api().setupQuest().then(function (r) {
      if (r && r.ok && r.data && r.data.quest) renderQuest(r.data.quest);
      else if (list) list.innerHTML = '<li class="peh-quest-loading">Could not load the quest.</li>';
    });
  }

  // The welcome "Let's go" button now opens the live quest instead of a tour.
  function startTour() {
    hideOverlay();
    markOnboarded();
    loadQuest();
  }

  function skipTour() {
    markOnboarded();
    hideOverlay();
  }

  // ── Re-trigger (Help button) ────────────────────────────────────────
  function showHelp() {
    markOnboarded(); // clear any partial state
    showOverlay();
  }

  // ── Help button injector ────────────────────────────────────────────
  // Adds a small "?" button to the topbar (adjacent to mode toggle).
  function injectHelpButton() {
    if (document.getElementById('peh-help-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'peh-help-btn';
    btn.className = 'peh-help-btn';
    btn.type = 'button';
    btn.textContent = '?';
    btn.title = 'Help — Peh\'s welcome tour';
    btn.setAttribute('aria-label', 'Help — Peh\'s welcome tour');
    btn.addEventListener('click', showHelp);
    document.body.appendChild(btn);
  }

  // ── Boot ─────────────────────────────────────────────────────────────
  function boot() {
    injectHelpButton();
    if (isFirstLaunch()) {
      // Wait a tick for the engine to render so the backdrop covers everything
      setTimeout(showOverlay, 300);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Expose for external use
  window.PehOnboarding = { show: showHelp, quest: loadQuest, isFirstLaunch: isFirstLaunch };
})();
