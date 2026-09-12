// chat.js — swipe-down chat panel + WebSocket quick chat. Vanilla, no deps.
//
// Exposes: window.DoomalayChat
//
// ── PANEL GESTURE (the "big hotbox") ───────────────────────────────────
// The panel is dragged down from a generous invisible hotbox that spans the
// top 35% of the screen (plus the visible top bar). The user does NOT need
// to start the swipe at the very top edge (where Android's notification
// shade competes for the gesture). Starting anywhere in the top third and
// dragging DOWN brings the panel with the finger:
//
//   pointerdown (hotbox) → track
//   pointermove, dy > 12px downward → engage: panel follows finger
//     - if the gesture turns horizontal instead, we hand it to the app's
//       canvas pan (DoomalayApp.beginPan / movePan / endPan) so panning
//       still works from the upper third of the screen.
//   pointerup → snap open (dragged > 35% or fast flick) or snap closed
//
// While OPEN: swipe UP on the panel header closes it; ✕ closes; dim
// backdrop closes.
//
// ── CHAT ───────────────────────────────────────────────────────────────
// WS /api/chat?session_id=… — the engine replays history on connect, then
// streams events. We render: user, assistant_delta, thinking, tool_use,
// tool_result, title, status, error. One WS per open; reconnect on send if
// needed (mirrors the old PWA's useChat hook, incl. the 60s watchdog that
// clears a stuck busy state).

(function () {
  'use strict';

  // ── DOM refs ─────────────────────────────────────────────────
  const panelEl = document.getElementById('chatPanel');
  const hotboxEl = document.getElementById('panelHotbox');
  const topbarEl = document.getElementById('topbar');
  const panelDimEl = document.getElementById('panelDim');
  const panelTitleEl = document.getElementById('panelTitle');
  const panelSubEl = document.getElementById('panelSub');
  const panelCloseEl = document.getElementById('panelClose');
  const panelHandleEl = document.getElementById('panelHandle');
  const messagesEl = document.getElementById('messages');
  const chatInputEl = document.getElementById('chatInput');
  const sendBtnEl = document.getElementById('sendBtn');
  const stopBtnEl = document.getElementById('stopBtn');

  let PANEL_HEIGHT = Math.round(window.innerHeight * 0.72);
  // How far down (px) the panel must be dragged before it snaps open.
  let OPEN_THRESHOLD = PANEL_HEIGHT * 0.35;
  // Hotbox height: top 35% of the screen — the "big hotbox" the user asked
  // for. Swiping down from anywhere in the top third opens the panel.
  let HOTBOX_HEIGHT = Math.round(window.innerHeight * 0.35);

  function recomputeSizes() {
    const wasOpen = isOpen;
    PANEL_HEIGHT = Math.round(window.innerHeight * 0.72);
    OPEN_THRESHOLD = PANEL_HEIGHT * 0.35;
    HOTBOX_HEIGHT = Math.round(window.innerHeight * 0.35);
    hotboxEl.style.height = HOTBOX_HEIGHT + 'px';
    if (!wasOpen) setPanelY(-PANEL_HEIGHT, false);
  }
  window.addEventListener('resize', recomputeSizes);

  let isOpen = false;
  let session = null;      // {id, title, model, provider}
  let ws = null;
  let busy = false;
  let watchdog = null;
  let seenSeqs = new Set();
  let assistantBufEl = null;   // current streaming assistant bubble

  // ── Panel positioning ────────────────────────────────────────
  function panelY() {
    const t = panelEl.style.transform || '';
    const m = /translateY\((-?[\d.]+)px\)/.exec(t);
    return m ? parseFloat(m[1]) : -PANEL_HEIGHT;
  }

  function setPanelY(y, animate) {
    panelEl.classList.toggle('animated', !!animate);
    panelEl.style.transform = 'translateY(' + Math.round(y) + 'px)';
  }

  function snapOpen() {
    isOpen = true;
    setPanelY(0, true);
    panelDimEl.classList.add('show');
    panelEl.classList.add('open');
  }

  function snapClosed() {
    isOpen = false;
    setPanelY(-PANEL_HEIGHT, true);
    panelDimEl.classList.remove('show');
    panelEl.classList.remove('open');
    // Delay hiding the dim until the slide-up completes.
    setTimeout(function () {
      if (!isOpen) {
        panelDimEl.classList.remove('show');
      }
    }, 200);
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
  }

  // ── Hotbox gesture (panel drag vs canvas pan handoff) ────────
  const dr = { active: false, engaged: false, pan: false, sx: 0, sy: 0, lx: 0, ly: 0, lt: 0, vy: 0 };

  function hotboxDown(x, y) {
    dr.active = true;
    dr.engaged = false;
    dr.pan = false;
    dr.sx = dr.lx = x;
    dr.sy = dr.ly = y;
    dr.lt = performance.now();
    dr.vy = 0;
  }

  function hotboxMove(x, y) {
    if (!dr.active || dr.engaged) return;
    const dx = x - dr.sx, dy = y - dr.sy;
    // Engage panel drag on a downward pull ≥ 12px.
    if (dy > 12 && dy > Math.abs(dx) * 0.6) {
      dr.engaged = true;
      panelEl.classList.remove('hidden');
      // If the panel was already open, re-engage from its current spot.
      setPanelY(isOpen ? panelY() : -PANEL_HEIGHT + Math.min(dy, PANEL_HEIGHT), false);
      return;
    }
    // Horizontal/diagonal: hand off to the canvas pan (app keeps the state).
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12) {
      dr.pan = true;
      dr.engaged = true;
      if (window.DoomalayApp && window.DoomalayApp.beginPan) {
        window.DoomalayApp.beginPan(dr.sx, dr.sy);
      }
    }
  }

  function hotboxTrack(x, y) {
    // Continuation after engage (panel drag).
    if (dr.engaged && !dr.pan) {
      const dy = y - dr.sy;
      const target = -PANEL_HEIGHT + Math.max(0, Math.min(dy, PANEL_HEIGHT * 1.15));
      // Rubber-band past fully-open.
      let y2 = target;
      if (target > 0) y2 = target * 0.25;
      setPanelY(y2, false);
    } else if (dr.engaged && dr.pan) {
      if (window.DoomalayApp && window.DoomalayApp.movePan) {
        window.DoomalayApp.movePan(x, y);
      }
    }
    const now = performance.now();
    const dt = now - dr.lt;
    if (dt > 0) dr.vy = ((y - dr.ly) / dt);
    dr.lx = x; dr.ly = y; dr.lt = now;
  }

  function hotboxUp() {
    if (!dr.active) return;
    if (dr.engaged && !dr.pan) {
      const y = panelY();
      const draggedDown = PANEL_HEIGHT + y;   // how far the panel has come down
      if (draggedDown > OPEN_THRESHOLD || dr.vy > 0.5) snapOpen();
      else if (y < -PANEL_HEIGHT * 0.92) snapClosed();
      else if (!isOpen) snapClosed();
      else snapOpen();
    } else if (dr.pan) {
      if (window.DoomalayApp && window.DoomalayApp.endPan) window.DoomalayApp.endPan();
    }
    dr.active = false; dr.engaged = false; dr.pan = false;
  }

  // Wire the drag logic to BOTH the invisible hotbox AND the visible top
  // bar (a swipe down from the top bar itself should also pull the panel —
  // but taps on its buttons must keep working, so we skip pointerdowns
  // that originate on a button).
  function wireDragZone(zone) {
    zone.addEventListener('pointerdown', function (e) {
      if (zone === topbarEl && e.target.closest('button')) return;  // let chips click
      if (zone === topbarEl && e.target.closest('#panelClose')) return;
      hotboxDown(e.clientX, e.clientY);
      try { zone.setPointerCapture(e.pointerId); } catch (err) {}
    });
    zone.addEventListener('pointermove', function (e) {
      if (!dr.active) return;
      hotboxMove(e.clientX, e.clientY);
      hotboxTrack(e.clientX, e.clientY);
    });
    zone.addEventListener('pointerup', hotboxUp);
    zone.addEventListener('pointercancel', hotboxUp);
  }

  hotboxEl.style.height = HOTBOX_HEIGHT + 'px';
  wireDragZone(hotboxEl);
  wireDragZone(topbarEl);

  // Panel header: swipe up to close + tap ✕ to close.
  const hd = { active: false, sy: 0 };
  panelHandleEl.addEventListener('pointerdown', function (e) {
    hd.active = true;
    hd.sy = e.clientY;
    panelHandleEl.setPointerCapture(e.pointerId);
  });
  panelHandleEl.addEventListener('pointermove', function (e) {
    if (!hd.active) return;
    const dy = e.clientY - hd.sy;
    if (dy < 0) setPanelY(Math.max(-PANEL_HEIGHT, dy), false);
  });
  panelHandleEl.addEventListener('pointerup', function (e) {
    if (!hd.active) return;
    hd.active = false;
    const y = panelY();
    if (y < -PANEL_HEIGHT * 0.35) snapClosed();
    else snapOpen();
  });
  panelCloseEl.addEventListener('click', snapClosed);
  panelDimEl.addEventListener('click', snapClosed);

  // ── Messages ─────────────────────────────────────────────────
  function clearMessages() {
    messagesEl.innerHTML = '';
    assistantBufEl = null;
  }

  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addUserMsg(text) {
    const bubble = document.createElement('div');
    bubble.className = 'msg user';
    const inner = document.createElement('div');
    inner.className = 'msg-inner';
    inner.textContent = text;
    bubble.appendChild(inner);
    messagesEl.appendChild(bubble);
    scrollBottom();
  }

  function addMetaMsg(kind, text) {   // 'thinking' | 'error' | 'tool'
    const bubble = document.createElement('div');
    bubble.className = 'msg ' + kind;
    const inner = document.createElement('div');
    inner.className = 'msg-inner';
    inner.textContent = text;
    bubble.appendChild(inner);
    messagesEl.appendChild(bubble);
    scrollBottom();
    return bubble;
  }

  function appendAssistantDelta(text) {
    if (!assistantBufEl) {
      const bubble = document.createElement('div');
      bubble.className = 'msg assistant';
      const inner = document.createElement('div');
      inner.className = 'msg-inner';
      bubble.appendChild(inner);
      messagesEl.appendChild(bubble);
      assistantBufEl = bubble;
    }
    assistantBufEl.firstChild.textContent += text;
    scrollBottom();
  }

  function setBusy(b) {
    busy = b;
    sendBtnEl.classList.toggle('hidden', b);
    stopBtnEl.classList.toggle('hidden', !b);
    panelSubEl.classList.toggle('streaming', b);
    updateSub();
  }

  function updateSub() {
    if (!session) {
      panelSubEl.textContent = 'No model — pick one from the menu';
      return;
    }
    const model = session.model || '(unset)';
    const prov = session.provider ? ' · ' + session.provider : '';
    panelSubEl.textContent = busy ? model + ' — streaming…' : model + prov;
  }

  function resetWatchdog() {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(function () {
      setBusy(false);
      addMetaMsg('error', 'Stream timed out (60s no data)');
    }, 60_000);
  }

  function killWatchdog() {
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  }

  // ── WS event handling ────────────────────────────────────────
  function handleEvent(ev) {
    // Dedup by seq (engine replays history on connect).
    if (ev.seq != null) {
      if (seenSeqs.has(ev.seq)) return;
      seenSeqs.add(ev.seq);
    }
    switch (ev.type) {
      case 'user':
        addUserMsg(ev.text || '');
        break;
      case 'assistant_delta':
        appendAssistantDelta(ev.text || '');
        break;
      case 'thinking':
        addMetaMsg('thinking', ev.text || '');
        break;
      case 'tool_use':
        addMetaMsg('tool', '⚒ ' + (ev.name || 'tool') + ' ' + (ev.summary || ''));
        break;
      case 'tool_result':
        addMetaMsg('tool', '↩ ' + (ev.text || '').slice(0, 140));
        break;
      case 'title':
        session.title = ev.text || session.title;
        panelTitleEl.textContent = session.title;
        break;
      case 'error':
        addMetaMsg('error', '⚠ ' + (ev.message || ev.error || 'unknown error'));
        // An error event always terminates the turn — clear busy (the
        // status event that follows may arrive with its state wrapped
        // as a JSON string, handled below, but don't rely on it).
        setBusy(false);
        killWatchdog();
        break;
      case 'status': {
        // The engine sends status two ways: plain strings ('idle', 'busy')
        // or a JSON-stringified payload ('{"state":"error","usage":…}')
        // — normalize both.
        let state = ev.state;
        if (typeof state === 'string' && state.charAt(0) === '{') {
          try {
            const parsed = JSON.parse(state);
            if (parsed && parsed.state) {
              state = parsed.state;
              ev.usage = ev.usage || parsed.usage;
            }
          } catch (e) { /* keep raw string */ }
        }
        if (state === 'idle' || state === 'error') {
          assistantBufEl = null;
          setBusy(false);
          killWatchdog();
          if (ev.usage && ev.usage.total_tokens) {
            addMetaMsg('tool', '✓ ' + ev.usage.total_tokens + ' tokens');
          }
        } else if (state === 'busy' || state === 'streaming') {
          setBusy(true);
          resetWatchdog();
        }
        break;
      }
    }
  }

  function connectWS() {
    if (!session) return;
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    clearMessages();
    seenSeqs = new Set();
    ws = window.DoomalayAPI.chatWS(session.id, function (ev) {
      handleEvent(ev);
    }, function () {
      // WS closed — if we were mid-stream, unstick busy.
      setBusy(false);
      killWatchdog();
    }, function () {
      addMetaMsg('error', 'WebSocket error — is the engine running?');
    });
  }

  // ── Send / stop ──────────────────────────────────────────────
  function send() {
    const text = chatInputEl.value.trim();
    if (!text) return;
    if (!session) {
      window.DoomalayUI.toast('Create a chat first (long-press → New Chat)');
      return;
    }
    if (!session.model) {
      window.DoomalayUI.toast('Pick a model first (menu → Change model)');
      return;
    }

    const doSend = function () {
      ws.send(JSON.stringify({ type: 'send', message: text }));
      chatInputEl.value = '';
      chatInputEl.style.height = 'auto';
      setBusy(true);
      resetWatchdog();
    };

    if (!ws || ws.readyState !== 1) {
      connectWS();
      // Replay finishes quickly; wait for open before sending.
      setTimeout(function () {
        if (ws && ws.readyState === 1) doSend();
        else addMetaMsg('error', 'Could not connect to the engine (WS).');
      }, 400);
      return;
    }
    doSend();
  }

  function stop() {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'stop' }));
    }
    setBusy(false);
    killWatchdog();
  }

  sendBtnEl.addEventListener('click', send);
  stopBtnEl.addEventListener('click', stop);
  chatInputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  chatInputEl.addEventListener('input', function () {
    chatInputEl.style.height = 'auto';
    chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, 120) + 'px';
  });

  // ── Public API ───────────────────────────────────────────────
  window.DoomalayChat = {
    openForSession: function (sess) {
      // Called by app.js when the user taps a chatbot (or picks a model).
      session = sess;
      panelTitleEl.textContent = (sess && sess.title) || 'Chat';
      updateSub();
      panelEl.classList.remove('hidden');
      snapOpen();
      connectWS();
    },
    setSessionModel: function (model, provider) {
      if (!session) return;
      session.model = model;
      session.provider = provider;
      updateSub();
    },
    getSession: function () { return session; },
    isOpen: function () { return isOpen; },
    close: snapClosed
  };

  // Initial state: panel exists but is parked off-screen.
  panelEl.style.transform = 'translateY(' + (-PANEL_HEIGHT) + 'px)';
})();
