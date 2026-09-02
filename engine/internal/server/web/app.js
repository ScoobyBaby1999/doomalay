// app.js — main controller.
//
// Depends on: window.Physics, window.Chatbot (loaded before this file).
//
// Responsibilities:
//   • Load user-editable config from /config/names.json + /config/families.json
//     (falls back to hardcoded defaults if fetch fails).
//   • Render the infinite grid canvas (existing v0.6.0 behavior).
//   • Maintain the World of chatbot entities (in world-space, so they
//     pan with the grid).
//   • Long-press detection on the canvas → show dropdown menu.
//   • "New Chat" action → create a chatbot at the long-press location
//     with a random name + a random icon from the active family.
//   • Drag / fling chatbots (with physics — friction, elastic collisions).
//   • Drag the canvas background to pan (existing v0.6.0 behavior).
//   • Persist everything (canvas offset + all chatbots) to localStorage,
//     throttled to one save per 200ms.
//   • Debug family-switcher (top-right) — TEMPORARY, removed when the
//     real model picker lands.

(function () {
  'use strict';

  // ── Default config (overwritten by fetch on init) ─────────────
  // These are baked into the binary as a fallback in case /config/*.json
  // 404s or fails to parse. The user edits the JSON files, not these.
  const DEFAULT_NAMES = [
    "Scooby", "Doobie", "4rth Grade", "Crippy", "Lippy", "Trippy",
    "Baby", "Boonboon", "Dock", "Faqous", "Lip", "Sky", "Kenny"
  ];
  const DEFAULT_FAMILIES = {
    default:   { label: "Default",   color: "#4a4a5e", icons: [] },
    anthropic: { label: "Anthropic", color: "#d97757", icons: [] },
    openai:    { label: "OpenAI",    color: "#10a37f", icons: [] },
    google:    { label: "Google",    color: "#4285f4", icons: [] },
    deepseek:  { label: "DeepSeek",  color: "#4f46e5", icons: [] },
    qwen:      { label: "Qwen",      color: "#6c4cf1", icons: [] },
    glm:       { label: "GLM",       color: "#3b82f6", icons: [] },
    meta:      { label: "Meta",      color: "#0866ff", icons: [] },
    mistral:   { label: "Mistral",   color: "#fa520f", icons: [] }
  };

  const config = {
    names: DEFAULT_NAMES,
    families: DEFAULT_FAMILIES,
    defaultFamily: 'default'
  };
  // Exposed globally so chatbot.js can look up family colors + icon sets
  // when rendering icons.
  window.DoomalayConfig = config;

  // The "active model family". Defaults to "default" (no model picked yet).
  // When the user picks a model (future feature), it'll call
  // window.doomalay.setFamily('anthropic') etc. For now, the debug
  // family-switcher (top-right) calls the same API.
  let currentFamily = 'default';

  // ── Canvas / grid (carried over from v0.6.0) ──────────────────
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  let W = 0, H = 0;

  // World-space coord of the screen's top-left corner. Panning
  // changes these. World point (wx, wy) appears on screen at
  // (wx - offsetX, wy - offsetY).
  let offsetX = 0, offsetY = 0;
  let scale = 1;              // zoom level (1 = default)
  const MIN_SCALE = 0.5;      // zoomed out 2x
  const MAX_SCALE = 3.0;      // zoomed in 3x
  let velX = 0, velY = 0;   // pan momentum (px / 16ms frame)
  let animating = false;

  // Pan momentum tuning — heavier feel. Was 0.93 (traveled ~285px on a
  // fast flick). 0.88 + velocity cap = ~150px, feels weighty.
  const PAN_FRICTION = 0.88;
  const MAX_PAN_VELOCITY = 18;

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

  // World → screen coordinate conversion (with zoom).
  function worldToScreen(wx, wy) {
    return { x: (wx - offsetX) * scale, y: (wy - offsetY) * scale };
  }
  function screenToWorld(sx, sy) {
    return { x: sx / scale + offsetX, y: sy / scale + offsetY };
  }

  function renderGrid() {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    const scaledGrid = GRID * scale;
    // First visible grid line in screen space. Uses -offsetX so the grid
    // lines align with the world origin (world 0 is always on a line).
    const startX = ((-offsetX * scale) % scaledGrid + scaledGrid) % scaledGrid;
    const startY = ((-offsetY * scale) % scaledGrid + scaledGrid) % scaledGrid;

    ctx.strokeStyle = LINE_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = startX; x < W; x += scaledGrid) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, H);
    }
    for (let y = startY; y < H; y += scaledGrid) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(W, Math.round(y) + 0.5);
    }
    ctx.stroke();

    // Dots at intersections — shrink slightly at low zoom but stay visible.
    ctx.fillStyle = DOT_COLOR;
    const dotR = Math.max(0.6, DOT_RADIUS * Math.min(scale, 1.3));
    for (let x = startX; x < W; x += scaledGrid) {
      for (let y = startY; y < H; y += scaledGrid) {
        ctx.beginPath();
        ctx.arc(x, y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Origin marker (world 0,0)
    const o = worldToScreen(0, 0);
    if (o.x > -20 && o.x < W + 20 && o.y > -20 && o.y < H + 20) {
      ctx.fillStyle = ORIGIN_COLOR;
      ctx.beginPath();
      ctx.arc(o.x, o.y, ORIGIN_RADIUS * Math.min(scale, 1.5), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Off-screen chatbot arrows ────────────────────────────────
  // When a chatbot's screen position is off-screen, draw a directional
  // arrow at the nearest screen edge pointing toward it. Colored by
  // the chatbot's family color so the user knows which bot it is.
  function renderOffScreenArrows() {
    const margin = 50;
    for (const bot of world.entities) {
      const s = worldToScreen(bot.x, bot.y);
      const onScreen = s.x >= 0 && s.x <= W && s.y >= 0 && s.y <= H;
      if (onScreen) continue;

      // Clamp arrow position to screen edge with margin.
      const ax = Math.max(margin, Math.min(W - margin, s.x));
      const ay = Math.max(margin, Math.min(H - margin, s.y));
      // Direction from arrow toward the chatbot (screen space).
      const dx = s.x - ax;
      const dy = s.y - ay;
      const angle = Math.atan2(dy, dx);

      const fam = (config.families[bot.family] || config.families.default || {});
      const color = fam.color || '#4a4a5e';

      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(angle);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(14, 0);
      ctx.lineTo(-8, -9);
      ctx.lineTo(-4, 0);
      ctx.lineTo(-8, 9);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  // ── World + chatbots ──────────────────────────────────────────
  const world = new Physics.World();
  const chatbotLayer = document.getElementById('chatbots');
  const namePicker = new Chatbot.NamePicker(config.names);
  const iconPickers = {};  // family → IconPicker (lazy-created)

  function getIconPicker(family) {
    if (!iconPickers[family]) {
      const fam = (config.families[family] || { icons: [] });
      iconPickers[family] = new Chatbot.IconPicker(family, fam.icons || []);
    }
    return iconPickers[family];
  }

  // Names currently in use by any chatbot on the canvas.
  function usedNames() {
    return new Set(world.entities.map(c => c.name));
  }

  // Icon indices currently in use by chatbots of the given family.
  function usedIconIndices(family) {
    return new Set(
      world.entities
        .filter(c => c.family === family)
        .map(c => c.iconIndex)
        .filter(i => i >= 0)  // exclude placeholders
    );
  }

  function createChatbotAt(worldX, worldY) {
    const family = currentFamily;
    const name = namePicker.pick(usedNames());
    const iconIndex = getIconPicker(family).pick(usedIconIndices(family));
    const bot = new Chatbot.Chatbot({
      name, family, iconIndex,
      x: worldX, y: worldY
    });
    world.add(bot);
    chatbotLayer.appendChild(bot.el);
    bot.render(offsetX, offsetY);
    scheduleSave();
    return bot;
  }

  // When the active model family changes, every chatbot re-picks an
  // icon from the new family's set. The no-repeat rule is enforced
  // per-family (see IconPicker).
  function setFamily(family) {
    if (!config.families[family]) return;
    currentFamily = family;
    // Reset the icon picker for the new family so the no-repeat cycle
    // starts fresh. (This is per-family, so other families' pickers
    // stay in their current state.)
    delete iconPickers[family];
    for (const bot of world.entities) {
      const iconIndex = getIconPicker(family).pick(usedIconIndices(family));
      bot.setFamily(family, iconIndex);
    }
    scheduleSave();
  }

  // Public API (used by the model picker when it lands).
  window.doomalay = {
    setFamily,
    getFamily: () => currentFamily,
    getConfig: () => config
  };

  // ── Animation loop ───────────────────────────────────────────
  // One rAF loop drives pan momentum, chatbot physics, and off-screen
  // arrows. Stops when nothing is moving (saves battery).
  function update() {
    world.step();
    renderGrid();
    for (const bot of world.entities) bot.render(offsetX, offsetY, scale);
    renderOffScreenArrows();
  }

  function tick() {
    let moving = false;

    // Pan momentum — heavier friction (0.88 vs old 0.93).
    if (Math.abs(velX) >= 0.15 || Math.abs(velY) >= 0.15) {
      offsetX += velX;
      offsetY += velY;
      velX *= PAN_FRICTION;
      velY *= PAN_FRICTION;
      moving = true;
    } else if (velX !== 0 || velY !== 0) {
      velX = 0; velY = 0;
    }

    // Step chatbot physics
    world.step();

    // Check if any chatbot is still moving
    for (const e of world.entities) {
      if (!e.dragging && (Math.abs(e.vx) > 0.01 || Math.abs(e.vy) > 0.01)) {
        moving = true;
        break;
      }
    }

    renderGrid();
    for (const bot of world.entities) bot.render(offsetX, offsetY, scale);
    renderOffScreenArrows();

    if (moving) {
      scheduleSave();
      requestAnimationFrame(tick);
    } else {
      animating = false;
      scheduleSave();  // final save after motion settles
    }
  }

  function startAnimation() {
    if (animating) return;
    animating = true;
    requestAnimationFrame(tick);
  }

  // ── Long-press dropdown menu ──────────────────────────────────
  const menuEl = document.getElementById('menu');

  function showMenu(x, y) {
    // Make menu visible so we can measure it, then clamp to viewport.
    menuEl.classList.remove('hidden');
    const menuW = menuEl.offsetWidth || 160;
    const menuH = menuEl.offsetHeight || 50;
    // Center the menu on (x, y) — CSS uses transform: translate(-50%, -50%).
    const cx = Math.max(menuW / 2 + 8, Math.min(W - menuW / 2 - 8, x));
    const cy = Math.max(menuH / 2 + 8, Math.min(H - menuH / 2 - 8, y));
    menuEl.style.left = cx + 'px';
    menuEl.style.top = cy + 'px';
  }

  function hideMenu() {
    menuEl.classList.add('hidden');
  }

  menuEl.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'new-chat') {
      // Place the new chatbot at the menu's center, in world space.
      const r = menuEl.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const wp = screenToWorld(cx, cy);
      const bot = createChatbotAt(wp.x, wp.y);
      // Tiny random nudge so multiple new chats don't perfectly stack.
      bot.vx = (Math.random() - 0.5) * 6;
      bot.vy = (Math.random() - 0.5) * 6;
      startAnimation();
    }
    hideMenu();
  });

  // ── Input state machine ───────────────────────────────────────
  // The same handlers cover canvas pan, chatbot drag, and long-press.
  // State transitions:
  //
  //   IDLE ──(input start)──→ PENDING
  //   PENDING ──(move > 10px)──→ PANNING  or  CHATBOT_DRAG
  //                              (depending on whether the start point
  //                               was over a chatbot)
  //   PENDING ──(500ms timer)──→ MENU_OPEN  (show long-press menu)
  //   PENDING ──(release)──→ IDLE  (tap — no action for now)
  //   PANNING / CHATBOT_DRAG ──(release)──→ IDLE  (+ momentum / fling)
  //   MENU_OPEN ──(release / outside tap)──→ IDLE  (menu hides)
  //
  // Edge case: if a touch starts while the menu is open, we close the
  // menu and ignore that touch (no drag starts).
  const LONG_PRESS_MS = 500;
  const MOVE_THRESHOLD = 10;  // px from start before it counts as a drag

  let inputState = 'IDLE';
  let startScreenX = 0, startScreenY = 0;
  let lastScreenX = 0, lastScreenY = 0;
  let lastTime = 0;
  let longPressTimer = null;
  let draggedBot = null;
  let dragVel = { vx: 0, vy: 0, t: 0 };  // tracked velocity for fling

  // Hit-test: is the screen point over a chatbot icon?
  // Accounts for zoom — the icon's visual radius scales with `scale`.
  function findChatbotAt(screenX, screenY) {
    // Iterate from topmost (last in DOM) to bottom.
    const bots = world.entities;
    for (let i = bots.length - 1; i >= 0; i--) {
      const bot = bots[i];
      const sx = (bot.x - offsetX) * scale;
      const sy = (bot.y - offsetY) * scale;
      const dx = screenX - sx;
      const dy = screenY - sy;
      // Use radius * scale + a small slack for easier grabbing on touch.
      const r = bot.radius * scale + 4;
      if (dx * dx + dy * dy <= r * r) return bot;
    }
    return null;
  }

  function inputStart(screenX, screenY) {
    // If the menu is already open, a tap outside it just closes the menu.
    if (!menuEl.classList.contains('hidden')) {
      const r = menuEl.getBoundingClientRect();
      if (screenX >= r.left && screenX <= r.right &&
          screenY >= r.top && screenY <= r.bottom) {
        return;  // inside menu — let the menu's click handler deal with it
      }
      hideMenu();
      return;  // don't start a drag from this tap
    }

    inputState = 'PENDING';
    startScreenX = lastScreenX = screenX;
    startScreenY = lastScreenY = screenY;
    lastTime = performance.now();

    // Stop any in-progress pan momentum.
    velX = 0; velY = 0;

    // Start the long-press timer. Cancelled on move > threshold or release.
    longPressTimer = setTimeout(function () {
      longPressTimer = null;
      if (inputState === 'PENDING') {
        inputState = 'MENU_OPEN';
        showMenu(startScreenX, startScreenY);
      }
    }, LONG_PRESS_MS);
  }

  function inputMove(screenX, screenY) {
    if (inputState === 'IDLE' || inputState === 'MENU_OPEN') return;

    if (inputState === 'PENDING') {
      const dx = screenX - startScreenX;
      const dy = screenY - startScreenY;
      if (dx * dx + dy * dy < MOVE_THRESHOLD * MOVE_THRESHOLD) {
        return;  // still within threshold — stay pending
      }
      // Exceeded threshold — commit to either canvas pan or chatbot drag.
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      draggedBot = findChatbotAt(startScreenX, startScreenY);
      if (draggedBot) {
        inputState = 'CHATBOT_DRAG';
        draggedBot.dragging = true;
        draggedBot.el.classList.add('dragging');
        draggedBot.vx = 0; draggedBot.vy = 0;
      } else {
        inputState = 'PANNING';
      }
    }

    const now = performance.now();
    const dx = screenX - lastScreenX;
    const dy = screenY - lastScreenY;

    if (inputState === 'PANNING') {
      // INVERTED scroll: content follows the finger. Drag right → grid
      // moves right (not left). dx = lastX - currentX, so dragging right
      // (currentX > lastX) gives negative dx, decreasing offsetX, shifting
      // world content right on screen.
      const ddx = -dx;
      const ddy = -dy;
      offsetX += ddx;
      offsetY += ddy;
      const dt = now - lastTime;
      if (dt > 0) {
        velX = (ddx / dt) * 16;   // px per 16ms frame
        velY = (ddy / dt) * 16;
        // Cap velocity for a heavier feel.
        velX = Math.max(-MAX_PAN_VELOCITY, Math.min(MAX_PAN_VELOCITY, velX));
        velY = Math.max(-MAX_PAN_VELOCITY, Math.min(MAX_PAN_VELOCITY, velY));
      }
      update();
    } else if (inputState === 'CHATBOT_DRAG' && draggedBot) {
      // Move the chatbot in world space. Account for zoom: a dx-pixel
      // screen move = dx/scale world-space move.
      draggedBot.x += dx / scale;
      draggedBot.y += dy / scale;
      const dt = now - lastTime;
      if (dt > 0) {
        dragVel.vx = (dx / dt) * 16;
        dragVel.vy = (dy / dt) * 16;
        dragVel.t = now;
      }
      update();  // step physics so other chatbots get pushed out of the way
    }

    lastScreenX = screenX;
    lastScreenY = screenY;
    lastTime = now;
  }

  function inputEnd() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }

    if (inputState === 'PENDING') {
      // Tap with no movement and no long-press. If the tap was on a
      // chatbot, trigger the tap-flash + open the chat panel. Otherwise,
      // it's a tap on empty canvas — no action (for now).
      const bot = findChatbotAt(startScreenX, startScreenY);
      if (bot) {
        flashChatbot(bot);
        // Half-second delay between the flash starting and the panel
        // sliding up, so the user sees the icon react before the panel
        // covers it.
        setTimeout(function () { openChatPanel(bot); }, 500);
      }
      inputState = 'IDLE';
      return;
    }

    if (inputState === 'PANNING') {
      inputState = 'IDLE';
      // Apply pan momentum if the last move was recent (<100ms).
      if (performance.now() - lastTime < 100) {
        startAnimation();
      } else {
        velX = 0; velY = 0;
      }
      scheduleSave();
    } else if (inputState === 'CHATBOT_DRAG' && draggedBot) {
      // Fling: apply the tracked velocity (if recent).
      if (performance.now() - dragVel.t < 100) {
        draggedBot.vx = dragVel.vx;
        draggedBot.vy = dragVel.vy;
      } else {
        draggedBot.vx = 0; draggedBot.vy = 0;
      }
      draggedBot.dragging = false;
      draggedBot.el.classList.remove('dragging');
      draggedBot = null;
      inputState = 'IDLE';
      startAnimation();  // physics ticks until everything stops
      scheduleSave();
    } else {
      inputState = 'IDLE';
    }
  }

  // ── Zoom ───────────────────────────────────────────────────────
  // Zoom by `factor` centered at screen point (cx, cy), keeping the world
  // point under (cx, cy) fixed on screen. Clamped to [MIN_SCALE, MAX_SCALE].
  function zoomAt(factor, cx, cy) {
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
    if (newScale === scale) return;
    // World point under (cx, cy): worldX = cx/scale + offsetX
    // After zoom: cx = (worldX - newOffsetX) * newScale
    // → newOffsetX = worldX - cx/newScale = offsetX + cx/scale - cx/newScale
    const f = 1 / scale - 1 / newScale;
    offsetX = offsetX + cx * f;
    offsetY = offsetY + cy * f;
    scale = newScale;
    update();
  }

  // ── Pinch state (2-finger touch) ──────────────────────────────
  let pinching = false;
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let pinchStartOffsetX = 0, pinchStartOffsetY = 0;
  let pinchCenter = { x: 0, y: 0 };

  function touchDist(t1, t2) {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ── Event listeners (on document/window so we catch events on
  //    chatbot divs too — they're inside #chatbots which has
  //    pointer-events:none, but events bubble through the DOM tree) ──
  //
  // We explicitly skip events whose target is inside the menu or the
  // settings button, so those UI elements work normally.

  function isInsideUI(target) {
    if (!target) return false;
    return menuEl.contains(target) ||
           settingsBtnEl.contains(target) ||
           panelEl.contains(target) ||
           scrimEl.contains(target);
  }

  // Touch — handle 1-finger (pan/drag) and 2-finger (pinch) separately.
  document.addEventListener('touchstart', function (e) {
    if (isInsideUI(e.target)) return;
    if (e.touches.length === 2) {
      // Start pinch — cancel any in-progress drag/pan.
      e.preventDefault();
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      inputState = 'IDLE';
      velX = 0; velY = 0;
      if (draggedBot) {
        draggedBot.dragging = false;
        draggedBot.el.classList.remove('dragging');
        draggedBot = null;
      }
      pinching = true;
      pinchStartDist = touchDist(e.touches[0], e.touches[1]);
      pinchStartScale = scale;
      pinchStartOffsetX = offsetX;
      pinchStartOffsetY = offsetY;
      pinchCenter = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2
      };
    } else if (e.touches.length === 1 && !pinching) {
      e.preventDefault();
      const t = e.touches[0];
      inputStart(t.clientX, t.clientY);
    }
  }, { passive: false });

  document.addEventListener('touchmove', function (e) {
    if (isInsideUI(e.target)) return;
    if (e.touches.length === 2 && pinching) {
      e.preventDefault();
      const d = touchDist(e.touches[0], e.touches[1]);
      const factor = d / pinchStartDist;
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, pinchStartScale * factor));
      // Keep the world point under the pinch center fixed.
      const worldX = pinchCenter.x / pinchStartScale + pinchStartOffsetX;
      const worldY = pinchCenter.y / pinchStartScale + pinchStartOffsetY;
      offsetX = worldX - pinchCenter.x / newScale;
      offsetY = worldY - pinchCenter.y / newScale;
      scale = newScale;
      update();
    } else if (e.touches.length === 1 && !pinching) {
      e.preventDefault();
      const t = e.touches[0];
      inputMove(t.clientX, t.clientY);
    }
  }, { passive: false });

  document.addEventListener('touchend', function (e) {
    if (isInsideUI(e.target)) return;
    if (e.touches.length === 0) {
      if (pinching) { pinching = false; }
      e.preventDefault();
      inputEnd();
    } else if (e.touches.length === 1 && pinching) {
      // Dropped from 2 fingers to 1 — end pinch, don't start a drag
      // (avoids a jump when lifting one finger).
      pinching = false;
      inputState = 'IDLE';
      velX = 0; velY = 0;
    }
  }, { passive: false });

  document.addEventListener('touchcancel', function () {
    if (pinching) { pinching = false; }
    if (inputState !== 'IDLE') inputEnd();
  });

  // Mouse (desktop testing)
  document.addEventListener('mousedown', function (e) {
    if (isInsideUI(e.target)) return;
    e.preventDefault();
    inputStart(e.clientX, e.clientY);
  });

  window.addEventListener('mousemove', function (e) {
    inputMove(e.clientX, e.clientY);
  });

  window.addEventListener('mouseup', function () {
    inputEnd();
  });

  // Wheel zoom (desktop) — zoom toward cursor.
  document.addEventListener('wheel', function (e) {
    if (isInsideUI(e.target)) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    zoomAt(factor, e.clientX, e.clientY);
  }, { passive: false });

  // Prevent the browser's context menu on long-press / right-click.
  document.addEventListener('contextmenu', function (e) {
    if (isInsideUI(e.target)) return;
    e.preventDefault();
  });

  // Resize
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () {
    setTimeout(resize, 100);
  });

  // ── Settings button (replaces the old debug family-switcher) ──
  // Currently resets the view (zoom 1x, pan to origin). Will open a real
  // settings panel once there are settings to configure.
  const settingsBtnEl = document.getElementById('settings-btn');
  settingsBtnEl.addEventListener('click', function () {
    offsetX = 0;
    offsetY = 0;
    scale = 1;
    velX = 0; velY = 0;
    update();
    scheduleSave();
  });

  // ── Persistence ──────────────────────────────────────────────
  // Save canvas offset + all chatbots to localStorage, throttled.
  // Loaded on init so the user's last layout is restored.
  const STORAGE_KEY = 'doomalay.state.v1';
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
    const state = {
      offset: { x: offsetX, y: offsetY },
      scale: scale,
      currentFamily: currentFamily,
      chatbots: world.entities.map(function (c) { return c.serialize(); }),
      savedAt: Date.now()
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('doomalay: save failed', e);
    }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  // ── Chat panel (slide-up from bottom) ─────────────────────────
  // Opened by tapping a chatbot icon. Each panel is associated with
  // the specific chatbot (its own convo + settings + storage — for now
  // just metadata, chat interface comes later). Closes by dragging the
  // handle down or tapping the scrim.

  const panelEl = document.getElementById('chat-panel');
  const scrimEl = document.getElementById('chat-scrim');
  const handleEl = document.getElementById('panel-handle');
  const avatarEl = document.getElementById('panel-avatar');
  const nameEl = document.getElementById('panel-name');
  const subEl = document.getElementById('panel-sub');
  const bodyEl = document.getElementById('panel-body');
  let panelBot = null;   // the chatbot the panel is currently showing

  // Tap-flash: add the 'tapped' class for 400ms to trigger the CSS pulse.
  function flashChatbot(bot) {
    bot.el.classList.add('tapped');
    setTimeout(function () { bot.el.classList.remove('tapped'); }, 400);
  }

  // Open the panel for a specific chatbot. Populates the header with the
  // chatbot's metadata (name, family, id) and shows the panel + scrim.
  function openChatPanel(bot) {
    panelBot = bot;

    // Header: avatar + name + family/id.
    const fam = (config.families[bot.family] || config.families.default || {});
    avatarEl.innerHTML = '';
    avatarEl.style.background = fam.color || '#4a4a5e';
    if (bot.iconIndex >= 0 && fam.icons && bot.iconIndex < fam.icons.length) {
      const img = document.createElement('img');
      img.src = fam.icons[bot.iconIndex];
      img.alt = bot.name;
      avatarEl.appendChild(img);
    } else {
      avatarEl.textContent = (bot.name || '?').charAt(0).toUpperCase();
    }
    nameEl.textContent = bot.name || 'Chat';
    const famLabel = fam.label || bot.family;
    subEl.textContent = famLabel + ' · ' + bot.id;

    // Body: placeholder for now (chat interface comes later).
    bodyEl.innerHTML =
      '<div class="placeholder">' +
      'Chat interface goes here.<br>' +
      'Each chat has its own conversation, settings, and storage.<br><br>' +
      '<span style="color:#3a3a45;font-size:12px">Bot ID: ' + bot.id + '</span>' +
      '</div>';

    // Trigger the slide-up + scrim fade.
    // requestAnimationFrame ensures the browser has rendered the panel
    // in its hidden state before we add .open, so the CSS transition fires.
    requestAnimationFrame(function () {
      scrimEl.classList.add('open');
      panelEl.classList.add('open');
    });
  }

  function closeChatPanel() {
    scrimEl.classList.remove('open');
    panelEl.classList.remove('open');
    panelBot = null;
  }

  // Tap scrim to close.
  scrimEl.addEventListener('click', closeChatPanel);

  // Drag the handle down to close. Track touch/mouse on the handle only
  // (so dragging the body scrolls the content instead).
  let panelDragStartY = 0;
  let panelDragOffset = 0;
  let panelDragging = false;

  function panelDragStart(clientY) {
    panelDragging = true;
    panelDragStartY = clientY;
    panelDragOffset = 0;
    // Disable the CSS transition while dragging so it follows the finger.
    panelEl.style.transition = 'none';
  }

  function panelDragMove(clientY) {
    if (!panelDragging) return;
    panelDragOffset = clientY - panelDragStartY;
    // Only allow dragging DOWN (positive offset). Dragging up does nothing.
    if (panelDragOffset < 0) panelDragOffset = 0;
    panelEl.style.transform = 'translateY(' + panelDragOffset + 'px)';
  }

  function panelDragEnd() {
    if (!panelDragging) return;
    panelDragging = false;
    // Re-enable the CSS transition.
    panelEl.style.transition = '';
    // If dragged more than ~120px (or 25% of panel height), close.
    // Otherwise snap back to open.
    const panelH = panelEl.offsetHeight;
    const closeThreshold = Math.min(120, panelH * 0.25);
    if (panelDragOffset > closeThreshold) {
      closeChatPanel();
    }
    // Reset the transform (closeChatPanel or the .open class handles it).
    panelEl.style.transform = '';
  }

  // Touch on handle.
  handleEl.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    e.stopPropagation();  // don't let it bubble to the canvas pan handler
    panelDragStart(e.touches[0].clientY);
  }, { passive: false });
  handleEl.addEventListener('touchmove', function (e) {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    panelDragMove(e.touches[0].clientY);
  }, { passive: false });
  handleEl.addEventListener('touchend', function (e) {
    e.stopPropagation();
    panelDragEnd();
  });

  // Mouse on handle (desktop testing).
  handleEl.addEventListener('mousedown', function (e) {
    e.preventDefault();
    e.stopPropagation();
    panelDragStart(e.clientY);
  });
  window.addEventListener('mousemove', function (e) {
    if (panelDragging) panelDragMove(e.clientY);
  });
  window.addEventListener('mouseup', function () {
    if (panelDragging) panelDragEnd();
  });

  // ── Init ─────────────────────────────────────────────────────
  async function init() {
    // Load config from the server (best-effort — fall back to defaults).
    try {
      const [namesRes, famRes] = await Promise.all([
        fetch('config/names.json'),
        fetch('config/families.json')
      ]);
      if (namesRes.ok) {
        const d = await namesRes.json();
        if (Array.isArray(d.names) && d.names.length > 0) {
          config.names = d.names;
          namePicker.names = [...d.names];  // refresh picker
        }
      }
      if (famRes.ok) {
        const d = await famRes.json();
        if (d.families && typeof d.families === 'object') {
          // Merge: keep any default family not in the file, so the
          // user can ship a partial families.json.
          config.families = Object.assign({}, DEFAULT_FAMILIES, d.families);
        }
        if (typeof d.defaultFamily === 'string') {
          config.defaultFamily = d.defaultFamily;
        }
      }
    } catch (e) {
      console.warn('doomalay: config fetch failed, using defaults', e);
    }

    currentFamily = config.defaultFamily;

    // Restore saved state.
    const saved = loadState();
    if (saved) {
      offsetX = (saved.offset && saved.offset.x) || 0;
      offsetY = (saved.offset && saved.offset.y) || 0;
      if (typeof saved.scale === 'number') {
        scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, saved.scale));
      }
      if (saved.currentFamily && config.families[saved.currentFamily]) {
        currentFamily = saved.currentFamily;
      }
      if (Array.isArray(saved.chatbots)) {
        for (const c of saved.chatbots) {
          try {
            const bot = Chatbot.Chatbot.deserialize(c);
            world.add(bot);
            chatbotLayer.appendChild(bot.el);
          } catch (e) {
            console.warn('doomalay: failed to restore chatbot', c, e);
          }
        }
      }
    }

    resize();
  }

  init();
})();
