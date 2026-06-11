// ══════════════════════════════════════════════════════════════════════
// TOBA · PEH — the guide. In this life Peh is a stone age man: primal,
// grounded, the beginning of every journey. He is MALE (he/him) and speaks
// in the first person — plain-spoken, warm, a little weathered. This module
// owns Peh's VOICE: his persona, his per-scene lines, and a HUD speech
// bubble he speaks through (separate from the in-scene engine bubble).
// ══════════════════════════════════════════════════════════════════════
(function () {
  const persona = {
    name: 'Peh',
    pastLife: 'the stone age man',
    gender: 'male',
    pronouns: 'he/him',
    voice: 'plain-spoken, grounded, encouraging — a tracker who has walked every path before.',
  };

  // Per-scene opening lines, keyed by SCENE_REGISTRY ids. Peh speaks as "I".
  const SCENE_LINES = {
    'cave-entrance': [
      "Welcome back to the entrance, friend. Every career starts with one step — where do we head?",
      "The fire's lit and the paths are open. Tell me where you want to go and I'll walk it with you.",
    ],
    'cave-paintings': [
      "Quiet in here. This is where I draw the plan on the stone before the hunt — let's map your vision.",
      "The old stories live on these walls. Show me where you've been and I'll help you see where you're going.",
    ],
    'hunting-grounds': [
      "The hunting grounds. Out here every expedition sharpens your instincts — let's chart the course.",
      "Track, train, test yourself. I've hunted these paths before; I'll show you the trails.",
    ],
    'campfire-circle': [
      "Pull up to the fire. Every bond you forge here warms the whole journey — who do we reach?",
      "This is where the tribe gathers. Connections made by firelight last a lifetime.",
    ],
    'gathering-place': [
      "Time to gather. Every skill you collect carries you further down the trail — what do we build?",
      "Forage, craft, refine. I'll help you turn what the land gives into something you can use.",
    ],
    'fire-pit': [
      "The fire pit. Raw becomes cooked, rough becomes ready — let's process what you've gathered.",
      "Heat changes everything, friend. Bring me the raw experience and we'll forge it into something that holds.",
    ],
    'stone-table': [
      "The stone table. Every mark carved here is a milestone earned, not given — what do we set in stone?",
      "Council gathers here. Decisions get made, milestones get carved. Let's mark the journey.",
    ],
  };

  // A small deterministic picker so Peh doesn't repeat the same line back to back.
  let _tick = 0;
  function line(sceneId) {
    const pool = SCENE_LINES[sceneId];
    if (!pool || !pool.length) return "Wherever you're headed, friend — I'm right beside you.";
    return pool[(_tick++) % pool.length];
  }

  // ── The HUD speech bubble Peh talks through ────────────────────────────
  let bubble = null;
  let hideTimer = null;
  function ensureBubble() {
    if (bubble) return bubble;
    bubble = document.createElement('div');
    bubble.id = 'peh-say';
    bubble.className = 'peh-say';
    bubble.setAttribute('role', 'status');
    bubble.innerHTML =
      '<span class="peh-say-mark" aria-hidden="true">🔥</span>' +
      '<div class="peh-say-body"><b class="peh-say-name">Peh</b>' +
      '<p class="peh-say-text"></p></div>' +
      '<button class="peh-say-x" type="button" aria-label="Dismiss Peh">×</button>';
    bubble.querySelector('.peh-say-x').addEventListener('click', dismiss);
    document.body.appendChild(bubble);
    return bubble;
  }
  function say(text, opts) {
    if (!text) return;
    const o = opts || {};
    const b = ensureBubble();
    b.querySelector('.peh-say-text').textContent = String(text);
    b.classList.add('show');
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    const hold = o.hold == null ? 7000 : o.hold;
    if (hold > 0) hideTimer = setTimeout(dismiss, hold);
  }
  function dismiss() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (bubble) bubble.classList.remove('show');
  }
  // Peh greets the current scene (used by app.js on scene change / boot).
  function greet(sceneId, opts) { say(line(sceneId), opts); }

  window.Peh = { persona, line, say, greet, dismiss };
})();
