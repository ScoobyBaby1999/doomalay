// app.js — main controller (v0.8.0 rewrite).
//
// Depends on: window.Physics, window.Chatbot, window.DoomalayAPI,
//             window.DoomalayUI, window.DoomalayChat (all loaded before
//             this file — see index.html script order).
//
// ── THE v0.8.0 INPUT MODEL (fixes the v0.7.0 touch race) ───────────────
// v0.7.0 put touch/mouse handlers on `document` and called preventDefault
// on everything "not inside the UI". On real touch devices that suppressed
// the synthetic click events menu buttons need → nothing was interactable.
//
// v0.8.0 scope:
//   • Canvas gestures (pan, long-press): pointerdown/move/up ON THE CANVAS
//     ELEMENT ONLY. UI never routes through this code.
//   • Chatbot drag/fling/tap: pointer events attached to each .chatbot
//     element itself. No document-level hit-testing.
//   • touch-action: none ONLY on #c, #panelHotbox, #panelHandle. Every
//     button/menu/sheet keeps touch-action: manipulation → taps always
//     produce clicks.
//   • The UI layer (menu/sheets) sits on its own backdrop; while it's up,
//     the canvas receives zero events. No races by construction.
//
// ── Features ───────────────────────────────────────────────────────────
//   • Long-press canvas → menu: New Chat / Change model / API keys /
//     Local models.
//   • New Chat → creates a chat session (POST /api/sessions) + spawns a
//     chatbot bound to it.
//   • Tap a chatbot → opens the swipe-down chat panel for its session.
//   • Model picker → PATCH the active session, chatbot re-colors to the
//     provider color, top bar chip updates.
//   • API keys sheet → POST /api/keys (engine vault).
//   • Persistence: bots + their session ids + canvas offset → localStorage.

(function () {
  'use strict';

  // ── Default config (fallback if /config/*.json fails) ────────
  const DEFAULT_NAMES = [
    "Scooby", "Doobie", "4rth Grade", "Crippy", "Lippy", "Trippy",
    "Baby", "Boonboon", "Dock", "Faqous", "Lip", "Sky", "Kenny"
  ];
  const DEFAULT_FAMILIES = {
    default:   { label: "Default",   color: "#4a4a5e", icons: [] }
  };

  const config = {
    names: DEFAULT_NAMES,
    families: DEFAULT_FAMILIES,
    defaultFamily: 'default'
  };
  window.DoomalayConfig = config;

  let providerCatalog = {};   // name → {label, color, env_var, ...} from /api/models

  // ── Canvas / grid (unchanged from v0.6.0/v0.7.0) ──────────────
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  let W = 0, H = 0;
  let offsetX = 0, offsetY = 0;
  let velX = 0, velY = 0;
  let animating = false;

  const GRID = 48;
  const BG = '#0a0a0b';
  const LINE_COLOR = '#131318';
  const DOT_COLOR = '#2e2e3a';
  const DOT_RADIUS = 1.4;
  const ORIGIN_COLOR = '#4a4a5e';
  const ORIGIN_RADIUS = 5;

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    update();
  }

  function renderGrid() {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    const startX = ((offsetX % GRID) + GRID) % GRID;
    const startY = ((offsetY % GRID) + GRID) % GRID;

    ctx.strokeStyle = LINE_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = startX; x < W; x += GRID) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, H);
    }
    for (let y = startY; y < H; y += GRID) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(W, Math.round(y) + 0.5);
    }
    ctx.stroke();

    ctx.fillStyle = DOT_COLOR;
    for (let x = startX; x < W; x += GRID) {
      for (let y = startY; y < H; y += GRID) {
        ctx.beginPath();
        ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const ox = -offsetX, oy = -offsetY;
    if (ox > -20 && ox < W + 20 && oy > -20 && oy < H + 20) {
      ctx.fillStyle = ORIGIN_COLOR;
      ctx.beginPath();
      ctx.arc(ox, oy, ORIGIN_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── World + chatbots ──────────────────────────────────────────
  const world = new Physics.World();
  const chatbotLayer = document.getElementById('chatbots');
  const namePicker = new Chatbot.NamePicker(config.names);

  function usedNames() {
    const s = new Set();
    world.entities.forEach(function (b) { s.add(b.name); });
    return s;
  }

  // Create a chatbot at world coords, bound to a session.
  function createChatbotAt(wx, wy, sess, presetName) {
    const name = presetName || namePicker.pick(usedNames());
    const family = (sess && sess.provider) || 'default';
    const bot = new Chatbot.Chatbot({
      name: name, family: family, iconIndex: -1, x: wx, y: wy
    });
    bot.sessionId = sess ? sess.id : null;
    bot.session = sess || null;
    chatbotLayer.appendChild(bot.el);
    world.add(bot);
    attachBotGestures(bot);
    update();
    scheduleSave();
    return bot;
  }

  // Remove a chatbot (its session stays in the engine's history).
  function removeChatbot(bot) {
    world.remove(bot.id);
    if (bot.el && bot.el.parentNode) bot.el.parentNode.removeChild(bot.el);
    if (activeBot === bot) activeBot = null;
    scheduleSave();
    update();
  }

  let activeBot = null;   // last-tapped bot (model changes apply here)

  // ── Chatbot gestures (attached per-bot; canvas untouched) ────
  // Drag → move. Fling → throw. Tap (<10px move, <400ms) → open chat.
  const LONG_PRESS_MS = 500;
  const MOVE_THRESHOLD = 10;

  function attachBotGestures(bot) {
    const st = { down: false, moved: false, sx: 0, sy: 0, lx: 0, ly: 0, lt: 0, t0: 0, vx: 0, vy: 0, id: null };

    bot.el.addEventListener('pointerdown', function (e) {
      if (st.down) return;
      st.down = true;
      st.moved = false;
      st.sx = st.lx = e.clientX;
      st.sy = st.ly = e.clientY;
      st.lt = st.t0 = performance.now();
      st.vx = st.vy = 0;
      st.id = e.pointerId;
      try { bot.el.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });

    bot.el.addEventListener('pointermove', function (e) {
      if (!st.down || e.pointerId !== st.id) return;
      const dx = e.clientX - st.lx;
      const dy = e.clientY - st.ly;
      const totalDx = e.clientX - st.sx;
      const totalDy = e.clientY - st.sy;

      if (!st.moved && totalDx * totalDx + totalDy * totalDy > MOVE_THRESHOLD * MOVE_THRESHOLD) {
        st.moved = true;
        bot.dragging = true;
        bot.el.classList.add('dragging');
        bot.vx = 0; bot.vy = 0;
      }
      if (st.moved) {
        bot.x += dx;
        bot.y += dy;
        const now = performance.now();
        const dt = now - st.lt;
        if (dt > 0) {
          st.vx = (dx / dt) * 16;
          st.vy = (dy / dt) * 16;
        }
        st.lt = now;
        update();
      }
      st.lx = e.clientX;
      st.ly = e.clientY;
      e.preventDefault();
    });

    function release(e) {
      if (!st.down || (e && e.pointerId != null && e.pointerId !== st.id)) return;
      st.down = false;
      if (st.moved) {
        // Fling if the last move was recent.
        if (performance.now() - st.lt < 100) {
          bot.vx = st.vx; bot.vy = st.vy;
        } else {
          bot.vx = 0; bot.vy = 0;
        }
        bot.dragging = false;
        bot.el.classList.remove('dragging');
        startAnimation();
        scheduleSave();
      } else if (performance.now() - st.t0 < 400) {
        // Tap → open the chat panel for this bot's session.
        activeBot = bot;
        openChatForBot(bot);
      }
      e.preventDefault();
    }

    bot.el.addEventListener('pointerup', release);
    bot.el.addEventListener('pointercancel', release);
  }

  // ── Canvas gestures (pan + long-press) ────────────────────────
  // Only the CANVAS element. touch-action:none is set on #c in CSS.
  let pan = { down: false, pending: false, lx: 0, ly: 0, lt: 0 };
  let longPressTimer = null;

  canvas.addEventListener('pointerdown', function (e) {
    pan.down = true;
    pan.pending = true;
    pan.lx = e.clientX;
    pan.ly = e.clientY;
    pan.lt = performance.now();
    velX = 0; velY = 0;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}

    // Long-press timer → menu.
    const sx = e.clientX, sy = e.clientY;
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = setTimeout(function () {
      longPressTimer = null;
      if (pan.pending) {
        pan.pending = false;
        showCanvasMenu(sx, sy);
      }
    }, LONG_PRESS_MS);
  });

  canvas.addEventListener('pointermove', function (e) {
    if (!pan.down) return;
    const dx = e.clientX - pan.lx;
    const dy = e.clientY - pan.ly;

    if (pan.pending) {
      if (dx * dx + dy * dy > MOVE_THRESHOLD * MOVE_THRESHOLD) {
        pan.pending = false;
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      } else {
        return;
      }
    }
    offsetX += dx;
    offsetY += dy;
    const now = performance.now();
    const dt = now - pan.lt;
    if (dt > 0) {
      velX = (dx / dt) * 16;
      velY = (dy / dt) * 16;
    }
    pan.lt = now;
    pan.lx = e.clientX;
    pan.ly = e.clientY;
    update();
  });

  function canvasUp(e) {
    if (!pan.down) return;
    pan.down = false;
    pan.pending = false;
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    if (performance.now() - pan.lt < 100) startAnimation();
    else { velX = 0; velY = 0; }
    scheduleSave();
  }
  canvas.addEventListener('pointerup', canvasUp);
  canvas.addEventListener('pointercancel', canvasUp);

  // Prevent the context menu on long-press / right-click on the canvas.
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // ── Hotbox → canvas pan handoff (used by chat.js when a swipe in the
  //    hotbox turns out to be a horizontal pan instead of a panel pull).
  let hbPan = { down: false, lx: 0, ly: 0, lt: 0 };
  window.DoomalayApp = {
    beginPan: function (x, y) {
      hbPan.down = true;
      hbPan.lx = x; hbPan.ly = y; hbPan.lt = performance.now();
      velX = 0; velY = 0;
    },
    movePan: function (x, y) {
      if (!hbPan.down) return;
      const dx = x - hbPan.lx, dy = y - hbPan.ly;
      offsetX += dx; offsetY += dy;
      const now = performance.now();
      const dt = now - hbPan.lt;
      if (dt > 0) { velX = (dx / dt) * 16; velY = (dy / dt) * 16; }
      hbPan.lt = now; hbPan.lx = x; hbPan.ly = y;
      update();
    },
    endPan: function () {
      if (!hbPan.down) return;
      hbPan.down = false;
      if (performance.now() - hbPan.lt < 100) startAnimation();
      else { velX = 0; velY = 0; }
      scheduleSave();
    }
  };

  // ── Long-press menu ───────────────────────────────────────────
  function showCanvasMenu(x, y) {
    window.DoomalayUI.showMenu(x, y, [
      { action: 'new-chat',   label: 'New Chat',      icon: '＋' },
      { action: 'model',      label: 'Change model',  icon: '⌘' },
      { action: 'keys',       label: 'API keys',      icon: '🔑' },
      { action: 'local',      label: 'Local models',  icon: '⬇' }
    ], function (action) {
      switch (action) {
        case 'new-chat':
          newChatAt(x, y);
          break;
        case 'model':
          window.DoomalayUI.openSheet('models', {
            title: 'Pick a model',
            onPick: pickModel
          });
          break;
        case 'keys':
          window.DoomalayUI.openSheet('keys', {});
          break;
        case 'local':
          window.DoomalayUI.openSheet('models', {
            title: 'Local models (demo)',
            onPick: pickModel
          });
          break;
      }
    });
  }

  // ── New Chat: session + chatbot ───────────────────────────────
  function newChatAt(x, y) {
    // Pick the name up front so the session title matches the bot name.
    const name = namePicker.pick(usedNames());
    window.DoomalayAPI.createSession({ title: name }).then(function (sess) {
      const bot = createChatbotAt(x + offsetX, y + offsetY, sess, name);
      bot.vx = (Math.random() - 0.5) * 6;
      bot.vy = (Math.random() - 0.5) * 6;
      startAnimation();
      activeBot = bot;
      window.DoomalayUI.toast('Chat "' + bot.name + '" created — pick a model next');
      // Pre-open the model picker the first time (no model selected yet).
      if (!sess.model) {
        window.DoomalayUI.openSheet('models', {
          title: 'Pick a model for ' + bot.name,
          onPick: function (mid, prov, label) { pickModel(mid, prov, label, bot); }
        });
      }
    }).catch(function (err) {
      window.DoomalayUI.toast('Could not create session: ' + (err && err.message || err));
    });
  }

  // ── Model pick → session PATCH + bot re-color ─────────────────
  function pickModel(modelId, provider, label, bot) {
    window.DoomalayUI.closeSheet();
    // Fallback chain: explicit bot → last-tapped bot → most recent bot.
    // If there are no chatbots at all, create one (center of the viewport)
    // so "pick a model first, chat later" works without a New Chat first.
    bot = bot || activeBot || world.entities[world.entities.length - 1];
    if (!bot) {
      const cx = window.innerWidth / 2 + offsetX;
      const cy = window.innerHeight / 2 + offsetY;
      const name = namePicker.pick(usedNames());
      window.DoomalayUI.toast('Setting up chat with ' + modelId + '…');
      window.DoomalayAPI.createSession({
        title: name, model: modelId, provider: provider
      }).then(function (sess) {
        const nb = createChatbotAt(cx, cy, sess, name);
        nb.vx = (Math.random() - 0.5) * 6;
        nb.vy = (Math.random() - 0.5) * 6;
        startAnimation();
        activeBot = nb;
        updateTopbar();
        window.DoomalayChat.setSessionModel(modelId, provider);
        window.DoomalayUI.toast('Model set: ' + modelId);
      }).catch(function (err) {
        window.DoomalayUI.toast('Create failed: ' + (err && err.message || err));
      });
      return;
    }
    const target = bot;
    window.DoomalayUI.toast('Setting ' + (target.name) + ' → ' + modelId + '…');

    const done = function (sess) {
      sess.model = modelId;
      sess.provider = provider;
      target.session = sess;
      target.sessionId = sess.id;
      // Re-color the bot to the provider color.
      target.setFamily(provider, -1);
      activeBot = target;
      scheduleSave();
      updateTopbar();
      window.DoomalayChat.setSessionModel(modelId, provider);
      window.DoomalayUI.toast('Model set: ' + modelId);
    };

    if (target.sessionId) {
      window.DoomalayAPI.updateSession(target.sessionId, {
        model: modelId, provider: provider
      }).then(function (sess) { done(sess); }).catch(function (err) {
        window.DoomalayUI.toast('Save failed: ' + (err && err.message || err));
      });
    } else {
      window.DoomalayAPI.createSession({
        model: modelId, provider: provider, title: target.name
      }).then(function (sess) { done(sess); }).catch(function (err) {
        window.DoomalayUI.toast('Create failed: ' + (err && err.message || err));
      });
    }
  }

  // ── Open chat panel for a bot ─────────────────────────────────
  function openChatForBot(bot) {
    if (!bot.sessionId) {
      // Bot without a session (from old persisted state) → create one.
      window.DoomalayAPI.createSession({ title: bot.name }).then(function (sess) {
        bot.session = sess;
        bot.sessionId = sess.id;
        scheduleSave();
        window.DoomalayChat.openForSession(sess);
      }).catch(function (err) {
        window.DoomalayUI.toast('No session for this chat: ' + (err && err.message || err));
      });
      return;
    }
    if (bot.session) {
      window.DoomalayChat.openForSession(bot.session);
    } else {
      window.DoomalayAPI.getSession(bot.sessionId).then(function (sess) {
        bot.session = sess;
        window.DoomalayChat.openForSession(sess);
      }).catch(function () {
        // Session deleted on the engine side → make a fresh one.
        window.DoomalayAPI.createSession({ title: bot.name }).then(function (sess) {
          bot.session = sess; bot.sessionId = sess.id;
          scheduleSave();
          window.DoomalayChat.openForSession(sess);
        });
      });
    }
  }

  // ── Top bar ───────────────────────────────────────────────────
  const modelChipEl = document.getElementById('modelChip');
  const modelChipLabelEl = document.getElementById('modelChipLabel');
  const keyChipEl = document.getElementById('keyChip');
  const statusDotEl = document.getElementById('statusDot');

  function updateTopbar() {
    const sess = activeBot && activeBot.session;
    modelChipLabelEl.textContent = sess && sess.model ? shortModel(sess.model) : 'Pick a model';
    modelChipEl.classList.toggle('set', !!(sess && sess.model));
  }

  function shortModel(id) {
    if (!id) return '';
    return id.length > 18 ? id.slice(0, 16) + '…' : id;
  }

  modelChipEl.addEventListener('click', function () {
    window.DoomalayUI.openSheet('models', {
      title: 'Pick a model',
      onPick: function (mid, prov, label) { pickModel(mid, prov, label); }
    });
  });
  keyChipEl.addEventListener('click', function () {
    window.DoomalayUI.openSheet('keys', {});
  });

  function refreshKeyChip() {
    window.DoomalayAPI.listKeys().then(function (keys) {
      const any = Object.keys(keys || {}).some(function (k) {
        return keys[k] && keys[k].has_key;
      });
      keyChipEl.classList.toggle('set', any);
      keyChipEl.textContent = any ? '🔑' : '🔒';
    }).catch(function () { /* engine not up */ });
  }
  // Key changes made in the keys sheet update the topbar chip.
  document.addEventListener('doomalay:keys-changed', refreshKeyChip);

  window.DoomalayAPI.health().then(function (h) {
    statusDotEl.classList.add('ok');
    statusDotEl.title = 'engine v' + h.version + (h.brain ? ' (brain on)' : ' (cloud direct)');
  }).catch(function () {
    statusDotEl.classList.add('bad');
  });

  // ── Physics + render loop (pattern from v0.7.0: update() renders once;
  //    startAnimation() runs a rAF loop that stops when nothing moves) ──
  function update() {
    renderGrid();
    world.entities.forEach(function (b) { b.render(offsetX, offsetY); });
  }

  function tick() {
    let moving = false;

    // Pan momentum.
    if (Math.abs(velX) >= 0.15 || Math.abs(velY) >= 0.15) {
      offsetX += velX;
      offsetY += velY;
      velX *= 0.93;
      velY *= 0.93;
      moving = true;
    } else if (velX !== 0 || velY !== 0) {
      velX = 0; velY = 0;
    }

    // Step chatbot physics.
    world.step();

    for (const e of world.entities) {
      if (!e.dragging && (Math.abs(e.vx) > 0.01 || Math.abs(e.vy) > 0.01)) {
        moving = true;
        break;
      }
    }

    renderGrid();
    world.entities.forEach(function (b) { b.render(offsetX, offsetY); });

    if (moving) {
      requestAnimationFrame(tick);
    } else {
      animating = false;
      scheduleSave();
    }
  }

  function startAnimation() {
    if (animating) return;
    animating = true;
    requestAnimationFrame(tick);
  }

  // ── Persistence ───────────────────────────────────────────────
  const STORAGE_KEY = 'doomalay.state.v2';
  let saveScheduled = false;

  function scheduleSave() {
    if (saveScheduled) return;
    saveScheduled = true;
    setTimeout(function () {
      saveScheduled = false;
      saveNow();
    }, 200);
  }

  function saveNow() {
    try {
      const state = {
        offset: { x: offsetX, y: offsetY },
        chatbots: world.entities.map(function (c) {
          return {
            id: c.id, name: c.name, family: c.family,
            sessionId: c.sessionId || null,
            x: c.x, y: c.y, vx: c.vx, vy: c.vy, radius: c.radius
          };
        }),
        savedAt: Date.now()
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* storage full / private mode */ }
  }

  function loadState() {
    let state = null;
    try { state = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) {}
    if (!state) return;
    if (state.offset) {
      offsetX = state.offset.x || 0;
      offsetY = state.offset.y || 0;
    }
    (state.chatbots || []).forEach(function (d) {
      const bot = new Chatbot.Chatbot({
        id: d.id, name: d.name, family: d.family || 'default',
        iconIndex: -1, x: d.x, y: d.y,
        vx: d.vx || 0, vy: d.vy || 0, radius: d.radius || 28
      });
      bot.sessionId = d.sessionId || null;
      bot.session = null;   // fetched lazily on first tap
      chatbotLayer.appendChild(bot.el);
      world.add(bot);
      attachBotGestures(bot);
    });
    update();
  }

  // ── Init ──────────────────────────────────────────────────────
  function loadConfig() {
    fetch('/config/names.json').then(function (r) { return r.json(); })
      .then(function (names) { config.names = names; })
      .catch(function () { /* keep defaults */ });
    fetch('/config/families.json').then(function (r) { return r.json(); })
      .then(function (fams) {
        Object.keys(fams).forEach(function (k) {
          config.families[k] = fams[k];
        });
        update();
      })
      .catch(function () { /* keep defaults */ });
  }

  function loadProviders() {
    // Merge the engine's provider catalog into families so chatbot colors
    // follow the provider brand colors (anthropic #D97706, groq #F55036…).
    window.DoomalayAPI.models().then(function (data) {
      providerCatalog = data.providers || {};
      Object.keys(providerCatalog).forEach(function (p) {
        const cfg = providerCatalog[p];
        if (!config.families[p]) {
          config.families[p] = {
            label: cfg.label || p, color: cfg.color || '#4a4a5e', icons: []
          };
        }
      });
      // Re-render existing bots with provider colors.
      world.entities.forEach(function (b) { b.setFamily(b.family, -1); });
      update();
    }).catch(function () { /* engine offline — defaults are fine */ });
  }

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () {
    setTimeout(resize, 100);
  });

  resize();
  loadConfig();
  loadProviders();
  loadState();
  refreshKeyChip();
  updateTopbar();
})();
