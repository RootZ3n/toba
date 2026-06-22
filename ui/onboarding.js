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

  // ── Guided tour ─────────────────────────────────────────────────────
  // Walks the default scene's hotspots, using pehSayGreeting() for each.
  var tourTimer = null;
  var tourRunning = false;

  function cancelTour() {
    if (tourTimer) { clearTimeout(tourTimer); tourTimer = null; }
    tourRunning = false;
  }

  function randomDelay() {
    return TOUR_DELAY_MIN + Math.random() * (TOUR_DELAY_MAX - TOUR_DELAY_MIN);
  }

  function getTourHotspots() {
    // Gather hotspots from the default scene (cave-entrance) plus all other scenes
    var scenes = [];
    try {
      var pid = (typeof pehActiveProductId === 'function') ? pehActiveProductId() : 'toba';
      scenes = (typeof pehScenes === 'function') ? pehScenes(pid) : [];
    } catch (e) {}
    if (!scenes.length) return [];

    // Start with cave-entrance hotspots (the hub), then one representative
    // hotspot from each other scene for a world overview.
    var ordered = [];
    var seen = {};
    for (var i = 0; i < scenes.length; i++) {
      var scene = scenes[i];
      if (!scene.hotspots) continue;
      // For the hub scene, include all hotspots
      var takeAll = (i === 0);
      for (var j = 0; j < scene.hotspots.length; j++) {
        var h = scene.hotspots[j];
        if (seen[h.id]) continue;
        // Skip "Back to Cave Entrance" travel hotspots in the tour
        if (h.label && h.label.indexOf('Back to') === 0) continue;
        seen[h.id] = true;
        ordered.push({ hotspot: h, scene: scene });
        if (!takeAll && j > 0) break; // only first non-back hotspot per non-hub scene
      }
    }
    return ordered;
  }

  function startTour() {
    hideOverlay();
    cancelTour();
    tourRunning = true;

    var stops = getTourHotspots();
    if (!stops.length) {
      // Fallback: just greet the current scene
      try { if (window.Peh) window.Peh.greet('cave-entrance'); } catch (e) {}
      markOnboarded();
      return;
    }

    var idx = 0;
    function next() {
      if (!tourRunning || idx >= stops.length) {
        tourRunning = false;
        markOnboarded();
        return;
      }
      var stop = stops[idx++];
      try {
        if (typeof pehSayGreeting === 'function') {
          pehSayGreeting(stop.hotspot, stop.scene);
        } else if (window.Peh) {
          window.Peh.say(stop.hotspot.greeting || 'Welcome!', { hold: TOUR_HOLD_MS });
        }
      } catch (e) {}

      // If the stop is on a different scene, travel there first
      if (stop.scene && typeof pehGoScene === 'function') {
        var current = null;
        try { current = (document.querySelector('.peh-scene') || {}).dataset.scene; } catch (e) {}
        if (current && current !== stop.scene.id) {
          pehGoScene(stop.scene.id);
        }
      }

      tourTimer = setTimeout(next, randomDelay());
    }

    // Brief pause before first stop
    tourTimer = setTimeout(next, 1200);
  }

  function skipTour() {
    cancelTour();
    markOnboarded();
    hideOverlay();
  }

  // ── Re-trigger (Help button) ────────────────────────────────────────
  function showHelp() {
    markOnboarded(); // clear any partial state
    cancelTour();
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
  window.PehOnboarding = { show: showHelp, isFirstLaunch: isFirstLaunch };
})();
