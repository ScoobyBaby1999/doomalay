// app.js — main controller.
//
// Uses the modular components:
//   • Physics.Entity, World (physics.js)
//   • GridIcon base + registry (gridicon.js) — any icon on the grid
//   • ChatIcon (chatbot.js) — extends GridIcon, registers 'chat' type
//   • Panel (panel.js) — content-agnostic slide-up panel
//   • Settings (settings.js) — modular settings with pages
//   • Appearance (appearance.js) — first settings page
//
// Responsibilities:
//   • Render the infinite grid (colors from Settings, live-editable)
//   • Maintain the World of GridIcon entities (chats, and future: polls, monitors)
//   • Long-press → "New Chat" menu → create a ChatIcon at the press point
//   • Tap an icon → flash → 500ms later → Panel slides up with icon's content
//   • Tap the settings gear → Panel opens with Settings (Appearance page)
//   • Pan (inverted), pinch-zoom, momentum — all preserved from v0.7.1
//   • Persist icons + view state to localStorage

(function () {
  'use strict';

  // ── Config (loaded from /config/*.json, falls back to defaults) ──
  const DEFAULT_NAMES = [
    "Scooby", "Doobie", "4rth Grade", "Crippy", "Lippy", "Trippy",
    "Baby", "Boonboon", "Dock", "Faqous", "Lip", "Sky", "Kenny"
  ];
  const DEFAULT_FAMILIES = {
    default:   { label: "Default",   color: "#4a4a5e", icons: [] }, // canvas-drawn data hex — theme re-tints at draw time
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
  window.DoomalayConfig = config;

  let currentFamily = 'default';

  // ── Canvas / grid state ────────────────────────────────────────
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  let W = 0, H = 0;
  let offsetX = 0, offsetY = 0;
  let scale = 1;
  const MIN_SCALE = 0.5;
  const MAX_SCALE = 3.0;
  let velX = 0, velY = 0;
  let animating = false;

  const PAN_FRICTION = 0.88;
  const MAX_PAN_VELOCITY = 18;

  const GRID_BASE = 48;    // base grid spacing in px (at scale 1, gridSize 1)
  const DOT_RADIUS = 1.4;
  const ORIGIN_RADIUS = 5;

  // Grid colors + size now come from Settings (live-editable via
  // Appearance page). These are the fallbacks if Settings hasn't loaded.
  function theme() { return window.Settings.getState(); }
  // Effective grid spacing = base * gridSize setting (1x to 5x).
  function gridSpacing() {
    const t = theme();
    const gs = (t && typeof t.gridSize === 'number') ? t.gridSize : 1;
    return GRID_BASE * gs;
  }

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

  function worldToScreen(wx, wy) {
    return { x: (wx - offsetX) * scale, y: (wy - offsetY) * scale };
  }
  function screenToWorld(sx, sy) {
    return { x: sx / scale + offsetX, y: sy / scale + offsetY };
  }

  function renderGrid() {
    // v0.24: grid colors resolve through the THEME (user picks win over
    // the theme's grid palette; pre-v0.24 default values = never
    // customized → follow the theme).
    const t = (window.DoomTheme && window.DoomTheme.effectiveGrid)
      ? window.DoomTheme.effectiveGrid(window.Settings.getState())
      : window.Settings.getState();
    // v0.25: canvas fillStyle REJECTS invalid values silently (the grid bug:
    // a stale color stayed on screen when the value wasn't a real hex).
    // Validate every grid color before it reaches the canvas.
    const HEX_RE = /^#[0-9a-fA-F]{6}$/;
    ctx.fillStyle = (HEX_RE.test(t.bg || '')) ? t.bg : '#0a0a0b';
    ctx.fillRect(0, 0, W, H);

    const scaledGrid = gridSpacing() * scale;
    const startX = ((-offsetX * scale) % scaledGrid + scaledGrid) % scaledGrid;
    const startY = ((-offsetY * scale) % scaledGrid + scaledGrid) % scaledGrid;

    ctx.strokeStyle = (HEX_RE.test(t.lineColor || '')) ? t.lineColor : '#131318';
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

    ctx.fillStyle = (HEX_RE.test(t.dotColor || '')) ? t.dotColor : '#2e2e3a';
    const dotR = Math.max(0.6, DOT_RADIUS * Math.min(scale, 1.3));
    for (let x = startX; x < W; x += scaledGrid) {
      for (let y = startY; y < H; y += scaledGrid) {
        ctx.beginPath();
        ctx.arc(x, y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const o = worldToScreen(0, 0);
    if (o.x > -20 && o.x < W + 20 && o.y > -20 && o.y < H + 20) {
      ctx.fillStyle = (HEX_RE.test(t.originColor || '')) ? t.originColor : '#4a4a5e';
      ctx.beginPath();
      ctx.arc(o.x, o.y, ORIGIN_RADIUS * Math.min(scale, 1.5), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function renderOffScreenArrows() {
    const margin = 50;
    for (const bot of world.entities) {
      const s = worldToScreen(bot.x, bot.y);
      if (s.x >= 0 && s.x <= W && s.y >= 0 && s.y <= H) continue;

      const ax = Math.max(margin, Math.min(W - margin, s.x));
      const ay = Math.max(margin, Math.min(H - margin, s.y));
      const angle = Math.atan2(s.y - ay, s.x - ax);

      const fam = (config.families[bot.family] || config.families.default || {});
      // v0.24: the default family follows the theme — canvas fill needs a
      // REAL hex, so resolve the CSS var at draw time.
      let color = fam.color || '#4a4a5e';
      if (bot.family === 'default' || !fam.color) {
        color = getComputedStyle(document.documentElement)
          .getPropertyValue('--border-strong').trim() || color;
      }

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

  // ── World + icons ──────────────────────────────────────────────
  const world = new Physics.World();
  const iconLayer = document.getElementById('chatbots');
  const namePicker = new ChatIcon.NamePicker(config.names);
  const iconPickers = {};

  function getIconPicker(family) {
    if (!iconPickers[family]) {
      const fam = (config.families[family] || { icons: [] });
      iconPickers[family] = new ChatIcon.IconPicker(family, fam.icons || []);
    }
    return iconPickers[family];
  }

  function usedNames() {
    return new Set(world.entities.map(c => c.name));
  }
  function usedIconIndices(family) {
    return new Set(
      world.entities
        .filter(c => c.family === family)
        .map(c => c.iconIndex)
        .filter(i => i >= 0)
    );
  }

  function createIconAt(worldX, worldY) {
    const family = currentFamily;
    const name = namePicker.pick(usedNames());
    const iconIndex = getIconPicker(family).pick(usedIconIndices(family));
    // v0.17 FIX: nextId resets to 1 on every reload — a new chat created
    // after a restart got "chat_1" which COLLIDED with the first restored
    // icon → the new chat reused the OLD chat's state (same conversation,
    // "identical to the old one") and third chats dead-ended. Generate an
    // id guaranteed unused across the restored world.
    const used = new Set(world.entities.map(e => e.id));
    let n = 1;
    while (used.has('chat_' + n)) n++;
    const icon = new ChatIcon.ChatIcon({ id: 'chat_' + n, name, family, iconIndex, x: worldX, y: worldY });
    world.add(icon);
    iconLayer.appendChild(icon.el);
    icon.render(offsetX, offsetY, scale);
    scheduleSave();
    return icon;
  }

  function setFamily(family) {
    if (!config.families[family]) return;
    currentFamily = family;
    delete iconPickers[family];
    for (const bot of world.entities) {
      const iconIndex = getIconPicker(family).pick(usedIconIndices(family));
      bot.setFamily(family, iconIndex);
    }
    scheduleSave();
  }

  window.doomalay = {
    setFamily,
    getFamily: () => currentFamily,
    getConfig: () => config,
    scheduleSave,
    // v0.41: global-search jump — open a chat by engine session id
    // (materializing an icon if the grid has none) + optional jump to a
    // specific engine event (scrollIntoView + find-hit pulse).
    openChatBySession,
    resetView: function () {
      offsetX = 0; offsetY = 0; scale = 1; velX = 0; velY = 0;
      update(); scheduleSave();
    },
    // Handle Android back press. Returns true if we closed something (overlay
    // or panel), false if nothing was open. Called by MainActivity.onBackPressed
    // so the back gesture closes overlays/panels instead of exiting the app.
    handleBack: function () {
      // Close connect overlay first (highest priority)
      if (window.ConnectOverlay && window.ConnectOverlay.isOpen()) {
        window.ConnectOverlay.close();
        return true;
      }
      // v0.18: the artifacts drawer/editor + the long-press action sheet
      // are appended to document.body (not inside the chat panel) — the
      // back gesture MUST know about them or a stuck overlay traps the
      // user in the app ("had to close the app completely").
      var artOverlay = document.getElementById('artifacts-overlay');
      if (artOverlay && artOverlay.style.display !== 'none' && artOverlay.style.display !== '') {
        // v0.18: dirty-aware — an editor with unsaved changes shows the
        // in-DOM discard banner instead of losing edits ('blocked').
        var r = (window.Artifacts && window.Artifacts.backClose)
          ? window.Artifacts.backClose() : 'closed';
        if (r !== false) return true;
      }
      // v0.27: THE PANEL VIEW STACK — personas, usage, export, mind all
      // render as views on the master panel. Back pops one view; when the
      // stack is empty it closes the panel itself (panel.back()).
      var actionSheet = document.getElementById('msg-action-sheet');
      if (actionSheet && window.MsgActions && window.MsgActions.isOpen && window.MsgActions.isOpen()) {
        window.MsgActions.dismiss();
        return true;
      }
      // Close the chat panel (a view pops first, the root closes after)
      if (panel && panel.isOpen()) {
        if (panel.back && panel.back()) return true;
        panel.close();
        return true;
      }
      // Close the long-press menu
      if (menuEl && !menuEl.classList.contains('hidden')) {
        hideMenu();
        return true;
      }
      return false;
    }
  };

  // ── Animation loop ────────────────────────────────────────────
  function update() {
    world.step();
    renderGrid();
    for (const icon of world.entities) icon.render(offsetX, offsetY, scale);
    renderOffScreenArrows();
  }

  function tick() {
    let moving = false;
    if (Math.abs(velX) >= 0.15 || Math.abs(velY) >= 0.15) {
      offsetX += velX; offsetY += velY;
      velX *= PAN_FRICTION; velY *= PAN_FRICTION;
      moving = true;
    } else if (velX !== 0 || velY !== 0) {
      velX = 0; velY = 0;
    }
    world.step();
    for (const e of world.entities) {
      if (!e.dragging && (Math.abs(e.vx) > 0.01 || Math.abs(e.vy) > 0.01)) {
        moving = true; break;
      }
    }
    renderGrid();
    for (const icon of world.entities) icon.render(offsetX, offsetY, scale);
    renderOffScreenArrows();
    if (moving) { scheduleSave(); requestAnimationFrame(tick); }
    else { animating = false; scheduleSave(); }
  }

  function startAnimation() {
    if (animating) return;
    animating = true;
    requestAnimationFrame(tick);
  }

  // ── Panel (content-agnostic) ──────────────────────────────────
  const panel = new window.Panel({
    panelEl:  document.getElementById('chat-panel'),
    scrimEl:  document.getElementById('chat-scrim'),
    handleEl: document.getElementById('panel-handle'),
    headerEl: document.querySelector('#chat-panel .panel-header'),
    avatarEl: document.getElementById('panel-avatar'),
    nameEl:   document.getElementById('panel-name'),
    subEl:    document.getElementById('panel-sub'),
    bodyEl:   document.getElementById('panel-body')
  });

  // ── v0.19: manual chat rename ─────────────────────────────────
  // The user's spec: "don't have the chat rename from the default random
  // name from the list unless the user manually changes the chat name
  // themselves." The auto-title (first message → icon label) is GONE;
  // tapping the chat's name in the panel header is now THE way to rename.
  // Inline input (Android-safe — no window.prompt), commits on Enter/blur,
  // cancels on Escape, and persists to the icon + the engine session
  // (with manually_renamed so nothing ever overwrites it again).
  const panelNameEl = document.getElementById('panel-name');
  if (panelNameEl) {
    panelNameEl.addEventListener('click', function () {
      var icon = panel.currentContext;
      if (!icon || icon.type !== 'chat') return;
      // v0.27: a stacked view owns the header (its title lives here) —
      // never start a rename while views are open.
      if (panel.viewDepth && panel.viewDepth()) return;
      // v0.19: a header DRAG that ended on the name still fires this click —
      // ignore it (the drag just moved the panel).
      if (panel.gestures && panel.gestures.justDragged && panel.gestures.justDragged()) return;
      if (panelNameEl.querySelector('input')) return; // already editing
      var old = icon.name || '';
      panelNameEl.textContent = '';
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.value = old;
      inp.maxLength = 48;
      inp.style.cssText = 'width:100%;font-size:15px;font-weight:600;color:var(--text-1);background:transparent;border:none;border-bottom:1px solid var(--ok);outline:none;font-family:inherit;padding:0;box-sizing:border-box';
      panelNameEl.appendChild(inp);
      inp.focus();
      try { inp.select(); } catch (e) {}
      var settled = false;
      var done = function (commit) {
        if (settled) return;
        settled = true;
        var v = String(inp.value || '').trim();
        panelNameEl.textContent = (commit && v) ? v : old;
        if (commit && v && v !== old) {
          if (typeof icon.setName === 'function') icon.setName(v);
          if (typeof icon.save === 'function') icon.save();
          var st = window.ChatPanel && window.ChatPanel.getState(icon.id);
          if (st && st.sessionId) {
            fetch('/api/sessions/' + st.sessionId, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: v, override_manual: true, manually_renamed: true })
            }).catch(function () {});
          }
        }
      };
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        else if (e.key === 'Escape') { settled = true; panelNameEl.textContent = old; inp.blur(); }
      });
      inp.addEventListener('blur', function () { done(true); });
    });
  }

  // ── Long-press dropdown menu ───────────────────────────────────
  const menuEl = document.getElementById('menu');

  function showMenu(x, y) {
    menuEl.classList.remove('hidden');
    const menuW = menuEl.offsetWidth || 160;
    const menuH = menuEl.offsetHeight || 50;
    const cx = Math.max(menuW / 2 + 8, Math.min(W - menuW / 2 - 8, x));
    const cy = Math.max(menuH / 2 + 8, Math.min(H - menuH / 2 - 8, y));
    menuEl.style.left = cx + 'px';
    menuEl.style.top = cy + 'px';
  }
  function hideMenu() { menuEl.classList.add('hidden'); }

  menuEl.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'new-chat') {
      const r = menuEl.getBoundingClientRect();
      const wp = screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
      const icon = createIconAt(wp.x, wp.y);
      icon.vx = (Math.random() - 0.5) * 6;
      icon.vy = (Math.random() - 0.5) * 6;
      startAnimation();
    }
    hideMenu();
  });

  // ── Input state machine ───────────────────────────────────────
  const LONG_PRESS_MS = 500;
  const MOVE_THRESHOLD = 10;

  let inputState = 'IDLE';
  let startScreenX = 0, startScreenY = 0;
  let lastScreenX = 0, lastScreenY = 0;
  let lastTime = 0;
  let longPressTimer = null;
  let draggedIcon = null;
  let dragVel = { vx: 0, vy: 0, t: 0 };

  function findIconAt(screenX, screenY) {
    const bots = world.entities;
    for (let i = bots.length - 1; i >= 0; i--) {
      const bot = bots[i];
      const sx = (bot.x - offsetX) * scale;
      const sy = (bot.y - offsetY) * scale;
      const dx = screenX - sx;
      const dy = screenY - sy;
      // Hit-test radius: the icon's visual radius * scale, plus a
      // generous slack (20px) so icons are easy to tap even when zoomed
      // out. Also enforce a minimum hit radius of 28px so tiny icons
      // at low zoom are still tappable — finger-friendly.
      const visualR = bot.radius * scale;
      const r = Math.max(28, visualR + 20);
      if (dx * dx + dy * dy <= r * r) return bot;
    }
    return null;
  }

  function inputStart(screenX, screenY) {
    if (!menuEl.classList.contains('hidden')) {
      const r = menuEl.getBoundingClientRect();
      if (screenX >= r.left && screenX <= r.right &&
          screenY >= r.top && screenY <= r.bottom) return;
      hideMenu();
      return;
    }
    inputState = 'PENDING';
    startScreenX = lastScreenX = screenX;
    startScreenY = lastScreenY = screenY;
    lastTime = performance.now();
    velX = 0; velY = 0;
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
      if (dx * dx + dy * dy < MOVE_THRESHOLD * MOVE_THRESHOLD) return;
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      draggedIcon = findIconAt(startScreenX, startScreenY);
      if (draggedIcon) {
        inputState = 'ICON_DRAG';
        draggedIcon.dragging = true;
        draggedIcon.el.classList.add('dragging');
        draggedIcon.vx = 0; draggedIcon.vy = 0;
      } else {
        inputState = 'PANNING';
      }
    }

    const now = performance.now();
    const dx = screenX - lastScreenX;
    const dy = screenY - lastScreenY;

    if (inputState === 'PANNING') {
      // INVERTED: content follows the finger.
      const ddx = -dx, ddy = -dy;
      offsetX += ddx; offsetY += ddy;
      const dt = now - lastTime;
      if (dt > 0) {
        velX = Math.max(-MAX_PAN_VELOCITY, Math.min(MAX_PAN_VELOCITY, (ddx / dt) * 16));
        velY = Math.max(-MAX_PAN_VELOCITY, Math.min(MAX_PAN_VELOCITY, (ddy / dt) * 16));
      }
      update();
    } else if (inputState === 'ICON_DRAG' && draggedIcon) {
      draggedIcon.x += dx / scale;
      draggedIcon.y += dy / scale;
      const dt = now - lastTime;
      if (dt > 0) {
        dragVel.vx = (dx / dt) * 16;
        dragVel.vy = (dy / dt) * 16;
        // Cap fling velocity so even a hard flick doesn't send the icon
        // flying off-screen. With the airy friction (0.92 in physics.js),
        // a max-velocity fling (18px/frame) travels ~225px — satisfying
        // slide distance, not lost in the void.
        const MAX_FLING = 18;
        dragVel.vx = Math.max(-MAX_FLING, Math.min(MAX_FLING, dragVel.vx));
        dragVel.vy = Math.max(-MAX_FLING, Math.min(MAX_FLING, dragVel.vy));
        dragVel.t = now;
      }
      update();
    }
    lastScreenX = screenX; lastScreenY = screenY; lastTime = now;
  }

  function inputEnd() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }

    if (inputState === 'PENDING') {
      // Tap with no movement + no long-press.
      const icon = findIconAt(startScreenX, startScreenY);
      if (icon) {
        icon.flash();
        // Reduced delay: was 500ms (felt too long). 150ms gives a quick
        // flash-then-panel feel without the lag.
        setTimeout(function () {
          // v0.14: reset per-open header state — the far-left model button
          // is hidden until ChatPanel shows it (chat icons with a model).
          var modelBtn = document.getElementById('panel-model-btn');
          if (modelBtn) { modelBtn.style.display = 'none'; modelBtn.onclick = null; }
          // v0.34: the ★ quick-switch reset is gone with the button itself.
          // v0.14: the chat UI is full-bleed (its own padding); other panel
          // types keep the default 20px from the stylesheet.
          panel.bodyEl.style.padding = icon.type === 'chat' ? '0' : '';
          panel.open({
            title: icon.getPanelTitle(),
            subtitle: icon.getPanelSubtitle(),
            avatarHTML: icon.getAvatarHTML(),
            bodyHTML: icon.getPanelBodyHTML(),
            context: icon
          });
          // If the icon is a ChatIcon, render the interactive chat panel
          // into the panel body (replaces the static placeholder HTML).
          if (icon.type === 'chat' && window.ChatPanel) {
            window.ChatPanel.render(panel.bodyEl, icon, panel);
          }
        }, 150);
      }
      inputState = 'IDLE';
      return;
    }

    if (inputState === 'PANNING') {
      inputState = 'IDLE';
      if (performance.now() - lastTime < 100) startAnimation();
      else velX = 0, velY = 0;
      scheduleSave();
    } else if (inputState === 'ICON_DRAG' && draggedIcon) {
      if (performance.now() - dragVel.t < 100) {
        draggedIcon.vx = dragVel.vx; draggedIcon.vy = dragVel.vy;
      } else { draggedIcon.vx = 0; draggedIcon.vy = 0; }
      draggedIcon.dragging = false;
      draggedIcon.el.classList.remove('dragging');
      draggedIcon = null;
      inputState = 'IDLE';
      startAnimation();
      scheduleSave();
    } else { inputState = 'IDLE'; }
  }

  // ── Zoom ──────────────────────────────────────────────────────
  function zoomAt(factor, cx, cy) {
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
    if (newScale === scale) return;
    const f = 1 / scale - 1 / newScale;
    offsetX = offsetX + cx * f;
    offsetY = offsetY + cy * f;
    scale = newScale;
    update();
  }

  // ── Pinch state ───────────────────────────────────────────────
  let pinching = false;
  let pinchStartDist = 0, pinchStartScale = 1;
  let pinchStartOffsetX = 0, pinchStartOffsetY = 0;
  let pinchCenter = { x: 0, y: 0 };

  function touchDist(t1, t2) {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ── Event listeners ───────────────────────────────────────────
  const settingsBtnEl = document.getElementById('settings-btn');
  // v0.31.2: the canvas dock — the › arrow + its strip, left of the gear.
  const dockToggleEl = document.getElementById('dock-toggle');
  const dockStripEl = document.getElementById('dock-strip');

  function isInsideUI(target) {
    if (!target) return false;
    // ConnectOverlay covers the full screen (inset:0) while open — any
    // touch during that state is a UI touch. v0.10.1 MISSING THIS CHECK
    // WAS THE "nothing is interactable, not even the X" BUG: touches in
    // the overlay fell through to the document handlers, whose
    // preventDefault() suppressed the synthetic click events the
    // overlay's buttons need. (Mouse clicks fire regardless of
    // preventDefault on touchstart — which is why desktop dogfooding
    // never caught it.)
    if (window.ConnectOverlay && window.ConnectOverlay.isOpen()) return true;
    // v0.17: the artifacts drawer/editor overlay + the long-press action
    // sheet are appended to document.body (NOT inside the chat panel) —
    // without these checks their buttons were dead on touch for the
    // exact same reason.
    var artOverlay = document.getElementById('artifacts-overlay');
    if (artOverlay && artOverlay.contains(target)) return true;
    var actionSheet = document.getElementById('msg-action-sheet');
    if (actionSheet && actionSheet.contains(target)) return true;
    // v0.34: the crop overlay (uikit.js CropUI) + the fullscreen media zoom
    // (formatter.js MediaZoom) both append themselves to document.body —
    // WITHOUT these checks their touches fell through to the canvas pan
    // handlers (the grid moved behind the cropper!) and the document-level
    // preventDefault() killed the zoom slider's native touch drag — the
    // exact #sheet-root class of bug, phone-only (mouse clicks fire
    // regardless of touchstart preventDefault, so Playwright never saw it).
    if (target.closest && target.closest('.crop-ui')) return true;
    var mediaZoom = document.getElementById('media-zoom');
    if (mediaZoom && mediaZoom.contains(target)) return true;
    // (v0.26's #sheet-root was NEVER in this list — that omission is why
    // the sheet's buttons were dead on Android while desktop dogfooding
    // and Playwright both passed. It is deleted now; the master panel and
    // the connect overlay are the only two panel types left.)
    // v0.31.2: the canvas dock joins its gear sibling — without these
    // checks the strip's buttons die the same death on Android.
    if (dockStripEl && dockStripEl.contains(target)) return true;
    if (dockToggleEl && dockToggleEl.contains(target)) return true;
    return menuEl.contains(target) ||
           settingsBtnEl.contains(target) ||
           panel.panelEl.contains(target) ||
           panel.scrimEl.contains(target);
  }

  // Touch
  document.addEventListener('touchstart', function (e) {
    if (isInsideUI(e.target)) return;
    if (e.touches.length === 2) {
      e.preventDefault();
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      inputState = 'IDLE'; velX = 0; velY = 0;
      if (draggedIcon) {
        draggedIcon.dragging = false;
        draggedIcon.el.classList.remove('dragging');
        draggedIcon = null;
      }
      pinching = true;
      pinchStartDist = touchDist(e.touches[0], e.touches[1]);
      pinchStartScale = scale;
      pinchStartOffsetX = offsetX; pinchStartOffsetY = offsetY;
      pinchCenter = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2
      };
    } else if (e.touches.length === 1 && !pinching) {
      e.preventDefault();
      inputStart(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: false });

  document.addEventListener('touchmove', function (e) {
    if (isInsideUI(e.target)) return;
    if (e.touches.length === 2 && pinching) {
      e.preventDefault();
      const d = touchDist(e.touches[0], e.touches[1]);
      const factor = d / pinchStartDist;
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, pinchStartScale * factor));
      const worldX = pinchCenter.x / pinchStartScale + pinchStartOffsetX;
      const worldY = pinchCenter.y / pinchStartScale + pinchStartOffsetY;
      offsetX = worldX - pinchCenter.x / newScale;
      offsetY = worldY - pinchCenter.y / newScale;
      scale = newScale;
      update();
    } else if (e.touches.length === 1 && !pinching) {
      e.preventDefault();
      inputMove(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: false });

  document.addEventListener('touchend', function (e) {
    if (isInsideUI(e.target)) return;
    if (e.touches.length === 0) {
      if (pinching) pinching = false;
      e.preventDefault(); inputEnd();
    } else if (e.touches.length === 1 && pinching) {
      pinching = false; inputState = 'IDLE'; velX = 0; velY = 0;
    }
  }, { passive: false });

  document.addEventListener('touchcancel', function () {
    if (pinching) pinching = false;
    if (inputState !== 'IDLE') inputEnd();
  });

  // Mouse
  document.addEventListener('mousedown', function (e) {
    if (isInsideUI(e.target)) return;
    e.preventDefault(); inputStart(e.clientX, e.clientY);
  });
  window.addEventListener('mousemove', function (e) { inputMove(e.clientX, e.clientY); });
  window.addEventListener('mouseup', function () { inputEnd(); });

  // Wheel zoom
  document.addEventListener('wheel', function (e) {
    if (isInsideUI(e.target)) return;
    e.preventDefault();
    zoomAt(e.deltaY < 0 ? 1.1 : 0.9, e.clientX, e.clientY);
  }, { passive: false });

  document.addEventListener('contextmenu', function (e) {
    if (isInsideUI(e.target)) return;
    e.preventDefault();
  });

  // Settings gear → spin animation + open settings panel.
  settingsBtnEl.addEventListener('click', function () {
    // Trigger the spin animation: add .spinning, remove after 0.4s.
    // The CSS rotates the SVG 180° while .spinning is active; removing
    // it snaps back, giving a quick spin-and-return effect.
    settingsBtnEl.classList.add('spinning');
    setTimeout(function () { settingsBtnEl.classList.remove('spinning'); }, 400);
    window.Settings.openInPanel(panel);
  });

  // Listen for custom action events (e.g. "reset-view" from Appearance page).
  window.addEventListener('doomalay:action', function (e) {
    if (!e.detail) return;
    if (e.detail.action === 'reset-view') {
      window.doomalay.resetView();
    }
  });

  // ── v0.41: openChatPanelFor — shared by the canvas-dock views (the
  // hub) and window.doomalay.openChatBySession (global search jumps).
  // Opens a chat panel exactly the way a chatbot tap does — so a
  // canvas-side view has the master panel to ride on.
  function openChatPanelFor(icon) {
    // v0.14: reset per-open header state — the far-left model button
    // is hidden until ChatPanel shows it (chat icons with a model).
    var modelBtn = document.getElementById('panel-model-btn');
    if (modelBtn) { modelBtn.style.display = 'none'; modelBtn.onclick = null; }
    // v0.14: the chat UI is full-bleed (its own padding).
    panel.bodyEl.style.padding = icon.type === 'chat' ? '0' : '';
    panel.open({
      title: icon.getPanelTitle(),
      subtitle: icon.getPanelSubtitle(),
      avatarHTML: icon.getAvatarHTML(),
      bodyHTML: icon.getPanelBodyHTML(),
      context: icon
    });
    if (icon.type === 'chat' && window.ChatPanel) {
      window.ChatPanel.render(panel.bodyEl, icon, panel);
    }
  }

  // findIconBySession — the grid IS the chat list; icons carry their
  // engine session id (v0.15).
  function findIconBySession(sid) {
    if (!sid) return null;
    for (const e of world.entities) {
      if (e.type === 'chat' && e.sessionId === sid) return e;
    }
    return null;
  }

  // openChatBySession(sid, { ei }) — v0.41 GLOBAL SEARCH JUMP.
  // Finds (or recreates) the chat icon for an engine session, opens its
  // panel, and optionally scrolls to + flashes a specific engine event
  // (the WhatsApp/Telegram "tap result → jump to message" pattern).
  // A NULL sid opens the first chat icon — the hub/search "host panel"
  // fallback when the dock fires from the bare canvas. Returns a
  // Promise<boolean>: did a panel open?
  function openChatBySession(sid, opts) {
    opts = opts || {};
    var done = function (icon) {
      openChatPanelFor(icon);
      if (opts.ei !== undefined && opts.ei !== null) {
        jumpToEvent(opts.ei);
      }
    };
    var icon = sid ? findIconBySession(sid) : null;
    if (!sid) {
      // host-panel mode: any chat icon will do (the view that called
      // us rides the panel stack; the chat underneath is a backdrop).
      for (var i = 0; i < world.entities.length; i++) {
        if (world.entities[i].type === 'chat') { icon = world.entities[i]; break; }
      }
      if (!icon) return Promise.resolve(false);
      done(icon);
      return Promise.resolve(true);
    }
    if (icon) { done(icon); return Promise.resolve(true); }
    // No icon on the canvas (session created outside the grid, or the
    // icon was never made): fetch the session and materialize an icon
    // for it near the viewport center.
    return fetch('/api/sessions/' + encodeURIComponent(sid))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s) return false;
        var wx = (W / 2 / scale) + offsetX + (Math.random() * 60 - 30);
        var wy = (H / 2 / scale) + offsetY + (Math.random() * 60 - 30);
        var ic = createIconAt(wx, wy);
        try {
          if (s.Title) ic.setName(s.Title);
          if (s.Model) ic.model = s.Model;
          if (s.Provider) ic.provider = s.Provider;
          if (s.Sandbox) ic.sandbox = s.Sandbox;
        } catch (e) {}
        ic.sessionId = sid;
        if (typeof ic.save === 'function') ic.save(); else scheduleSave();
        done(ic);
        return true;
      })
      .catch(function () { return false; });
  }

  // jumpToEvent — after a panel opens, the transcript loads async (WS
  // replay). Poll for the row carrying the engine event id, then scroll
  // it to the center and pulse it with the find-hit highlight.
  function jumpToEvent(ei) {
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      var row = panel.bodyEl && panel.bodyEl.querySelector('[data-ei="' + ei + '"]');
      if (row) {
        clearInterval(t);
        try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {
          row.scrollIntoView(true);
        }
        row.classList.add('find-hit');
        setTimeout(function () { row.classList.remove('find-hit'); }, 2600);
        try { if (navigator.vibrate) navigator.vibrate(10); } catch (e) {}
      } else if (tries > 60) { // ~6s: transcript never materialized
        clearInterval(t);
      }
    }, 100);
  }

  // ── v0.31.2: THE CANVAS DOCK ──────────────────────────────────
  // A › arrow sits left of the settings gear. Tapping it flips to ‹ and
  // expands a vertical strip holding the two relocated entries: the
  // cloud provider screen (was Settings → Cloud) and the hub library
  // (was the chat util row's ◈ pill). The collapsed/expanded state
  // persists (doomalay.dock.v1) and is re-applied on every boot.
  const DOCK_KEY = 'doomalay.dock.v1';

  function dockApply(expanded) {
    if (dockToggleEl) {
      dockToggleEl.textContent = expanded ? '‹' : '›';
      dockToggleEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      dockToggleEl.setAttribute('aria-label', expanded ? 'Collapse dock' : 'Expand dock');
    }
    if (dockStripEl) dockStripEl.classList.toggle('hidden', !expanded);
  }
  function dockIsExpanded() {
    return !!(dockStripEl && !dockStripEl.classList.contains('hidden'));
  }

  if (dockToggleEl && dockStripEl) {
    let savedDock = null;
    try { savedDock = JSON.parse(localStorage.getItem(DOCK_KEY)); } catch (e) {}
    dockApply(!!(savedDock && savedDock.expanded));   // default: collapsed

    dockToggleEl.addEventListener('click', function () {
      dockApply(!dockIsExpanded());
      try {
        localStorage.setItem(DOCK_KEY, JSON.stringify({ expanded: dockIsExpanded() }));
      } catch (e) {}
    });

    // Cloud glyph → the provider screen, relocated from Settings → Cloud.
    // Same panel, same wiring (the overlay works from anywhere).
    const dockCloudBtn = dockStripEl.querySelector('#dock-cloud');
    if (dockCloudBtn) dockCloudBtn.addEventListener('click', function () {
      if (window.ProvidersScreen) window.ProvidersScreen.open(null, {});
    });

    // v0.41: Search glyph → GLOBAL CHAT SEARCH (globalsearch.js). Same
    // ride-the-panel pattern as the hub: the view lives on the master
    // panel's stack whether a chat is open or not.
    const dockSearchBtn = dockStripEl.querySelector('#dock-search');
    if (dockSearchBtn) dockSearchBtn.addEventListener('click', function () {
      if (window.GlobalSearch) window.GlobalSearch.open();
    });

    // v0.42: Chats glyph → THE ALL-CHATS INDEX (chatsview.js). Every
    // conversation most-recently-active-first with previews — the same
    // ride-the-panel pattern as search + the hub.
    const dockChatsBtn = dockStripEl.querySelector('#dock-chats');
    if (dockChatsBtn) dockChatsBtn.addEventListener('click', function () {
      if (window.ChatsView) window.ChatsView.open();
    });

    // Library glyph → the hub library, relocated from the chat util
    // row's ◈ pill — the SAME open path the pill had: the hub view
    // rides the master panel's view stack (panel.js pushView + the
    // slide-up animation).
    const dockLibraryBtn = dockStripEl.querySelector('#dock-library');
    if (dockLibraryBtn) dockLibraryBtn.addEventListener('click', function () {
      if (!window.Hub) return;
      // A chat panel is already up → the pill's exact path applies.
      var cur = window.ChatPanel && window.ChatPanel.current();
      if (cur && cur.panel && cur.panel.isOpen()) { window.Hub.open(); return; }
      // From the bare canvas (the dock sits under an open panel's scrim,
      // so this is the only other case) — open the current chat's panel
      // first, then push the hub view on top of it.
      var icon = (cur && cur.icon) || null;
      if (!icon) {
        for (const e of world.entities) { if (e.type === 'chat') { icon = e; break; } }
      }
      if (!icon) { window.Hub.open(); return; }  // toasts "open a chat first"
      openChatPanelFor(icon);
      window.Hub.open();
    });
  }

  // Re-render on settings change (live color updates).
  window.Settings.onChange(function () {
    update();
    // Also sync the names list to the NamePicker so new chatbots use edited names.
    const names = window.Settings.getState().names;
    if (Array.isArray(names) && names.length > 0) {
      namePicker.names = [...names];
    }
  });

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 100); });

  // ── Persistence ──────────────────────────────────────────────
  const STORAGE_KEY = 'doomalay.state.v2';
  let saveScheduled = false;

  function scheduleSave() {
    if (saveScheduled) return;
    saveScheduled = true;
    setTimeout(function () { saveScheduled = false; saveNow(); }, 200);
  }
  function saveNow() {
    const state = {
      offset: { x: offsetX, y: offsetY },
      scale: scale,
      currentFamily: currentFamily,
      icons: world.entities.map(function (c) { return c.serialize(); }),
      savedAt: Date.now()
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { console.warn('doomalay: save failed', e); }
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  // ── Init ──────────────────────────────────────────────────────
  async function init() {
    // Load config from the server (best-effort — fall back to defaults).
    try {
      const [namesRes, famRes] = await Promise.all([
        fetch('config/names.json'),
        fetch('config/families.json')
      ]);
      if (namesRes.ok) {
        const d = await namesRes.json();
        if (Array.isArray(d.names) && d.names.length > 0) config.names = d.names;
      }
      if (famRes.ok) {
        const d = await famRes.json();
        if (d.families && typeof d.families === 'object') {
          config.families = Object.assign({}, DEFAULT_FAMILIES, d.families);
        }
        if (typeof d.defaultFamily === 'string') config.defaultFamily = d.defaultFamily;
      }
    } catch (e) {
      console.warn('doomalay: config fetch failed, using defaults', e);
    }

    currentFamily = config.defaultFamily;

    // Settings names override config names if the user has edited them.
    const settingsNames = window.Settings.getState().names;
    if (Array.isArray(settingsNames) && settingsNames.length > 0) {
      config.names = [...settingsNames];
    }
    namePicker.names = [...config.names];

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
      // Migrate: old storage key (v1) stored chatbots; new key (v2) stores icons.
      // Try both 'icons' (new) and 'chatbots' (old v0.7.0/v0.8.0).
      const savedIcons = saved.icons || saved.chatbots;
      if (Array.isArray(savedIcons)) {
        // v0.20 HEAL: installs saved before the unique-id fix can carry
        // DUPLICATE ids (the nextId reset bug) — two chats sharing one id
        // cross-wired their panel states. Rename later duplicates BEFORE
        // construction so every restored chat gets its own state entry.
        // The renamed chat keeps its sessionId, so its history stays
        // attached — only the internal id changes.
        // v0.38 SESSION-ISOLATION HEAL: the same era of saves can also
        // carry TWO icons bound to the SAME engine sessionId — both then
        // replay each other's full history on every WS connect and write
        // into one event log (the data-level chat leak). The FIRST icon
        // keeps the session; later duplicates are unbound and create a
        // fresh engine session on their next open.
        const seenIds = new Set();
        const seenSessions = new Set();
        for (const c of savedIcons) {
          // v0.35 WHITE-SCREEN GUARD: one corrupt entry (a string, null, or
          // a malformed object from a crashed write) used to throw here in
          // strict mode → init() aborted → __doomalayReady never set → the
          // app booted to a dead blank screen, permanently. Skip poison
          // entries; the rest of the chats still load.
          if (!c || typeof c !== 'object') continue;
          try {
            if (!c.id) c.id = 'chat_' + Math.random().toString(36).slice(2, 10);
            while (seenIds.has(c.id)) {
              c.id = c.id + '_' + Math.random().toString(36).slice(2, 6);
            }
            seenIds.add(c.id);
            if (c.sessionId) {
              if (seenSessions.has(c.sessionId)) c.sessionId = ''; // own sandbox on next open
              else seenSessions.add(c.sessionId);
            }
          } catch (e) { continue; }
        }
        for (const c of savedIcons) {
          try {
            if (!c || typeof c !== 'object') continue;
            if (!c.type) c.type = 'chat';  // migration from v0.7.0
            const icon = window.GridIcon.create(c);
            if (icon) {
              world.add(icon);
              iconLayer.appendChild(icon.el);
            }
          } catch (e) {
            console.warn('doomalay: skipped a corrupt saved chat entry', e);
          }
        }
      }
    }

    resize();

    // v0.15: recovery.js's boot watchdog — flip the flag once the canvas +
    // icons are live. (A stalled boot shows the recovery screen instead of
    // a dead white screen.)
    window.__doomalayReady = true;
  }

  init();
})();
