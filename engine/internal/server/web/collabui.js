// collabui.js — v1.69.3 THE HANDSHAKE (PLAN-V169 §v1.69.3): the two
// Overlay screens of the handshake — both ride window.ConnectOverlay's
// pushPage (the house's Overlay screen — the rounded box that overlays
// above everything), both theme-law only (every color a var; zero
// literals).
//
//	THE SHARE SHEET (the OWNER): mint the 6-digit code, watch the pending
//	claim, THE ALLOW/DENY TAP, the member roster with revoke. Entered
//	from the canvas long-press menu ("share this canvas").
//
//	THE JOIN SHEET (the JOINER — any device pointed at the host engine's
//	URL, e.g. through the tunnel): the code + a device name → the poll
//	("waiting for the owner's approval…") → approved: the credential is
//	stored + the shared canvas goes LIVE. The guest's session never
//	whole-state PUTs (ops only — the doc is the room's truth).
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var T = {
    row: 'display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:var(--surface-2);color:var(--text-1);border:1px solid var(--border);border-radius:10px;padding:11px 13px;font-size:var(--ui-small-fs);cursor:pointer;touch-action:manipulation',
    btn: 'display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--accent);color:var(--accent-contrast,var(--text-1));border:none;border-radius:10px;padding:11px 16px;font-size:var(--ui-small-fs);font-weight:600;cursor:pointer;touch-action:manipulation',
    btnGhost: 'display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--surface-2);color:var(--text-1);border:1px solid var(--border);border-radius:10px;padding:11px 16px;font-size:var(--ui-small-fs);font-weight:600;cursor:pointer;touch-action:manipulation',
    title: 'font-size:var(--ui-large-fs);font-weight:700;color:var(--text-1)',
    sub: 'color:var(--text-3);font-size:var(--ui-tiny-fs)',
    code: 'font-size:34px;font-weight:800;letter-spacing:10px;color:var(--accent);font-family:var(--font-mono,monospace)',
    input: 'width:100%;background:var(--surface-2);color:var(--text-1);border:1px solid var(--border);border-radius:10px;padding:11px 13px;font-size:var(--ui-small-fs);outline:none;box-sizing:border-box',
    pill: 'display:inline-flex;align-items:center;gap:6px;background:var(--surface-2);border:1px solid var(--border);color:var(--text-2);border-radius:999px;padding:4px 10px;font-size:var(--ui-tiny-fs)'
  };

  async function jfetch(method, path, body) {
    var init = { method: method };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
    var r = await fetch(path, init);
    var d = null;
    try { d = await r.json(); } catch (e) {}
    return { status: r.status, body: d || {} };
  }

  // ══ THE SHARE SHEET (the owner) ═══════════════════════════════════

  var shareTimer = 0;

  function shareHTML(state) {
    var html = '<div style="padding:18px 16px;display:flex;flex-direction:column;gap:12px">';
    html += '<div style="display:flex;flex-direction:column;gap:2px">' +
      '<div style="' + T.title + '">share this canvas</div>' +
      '<div style="' + T.sub + '">a device joins with the code — you approve the handshake</div></div>';
    if (state.invite && !state.invite.denied_at) {
      var left = Math.max(0, Math.round(state.invite.expires_at - Date.now() / 1000));
      html += '<div style="display:flex;flex-direction:column;align-items:center;gap:4px;padding:14px 0 6px">' +
        '<div style="' + T.code + '">' + esc(state.invite.code) + '</div>' +
        '<div style="' + T.sub + '">expires in ' + left + 's</div></div>';
      if (state.invite.claimed_name && !state.invite.approved_at) {
        html += '<div style="display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:var(--surface-1)">' +
          '<div style="font-size:var(--ui-small-fs);color:var(--text-1)"><b>' + esc(state.invite.claimed_name) + '</b> wants to join</div>' +
          '<div style="display:flex;gap:8px">' +
          '<button data-cs-act="allow" style="flex:1;' + T.btn + '">✓ allow</button>' +
          '<button data-cs-act="deny" style="flex:1;' + T.btnGhost + '">deny</button>' +
          '</div></div>';
      } else if (state.invite.claimed_name && state.invite.approved_at) {
        html += '<div style="' + T.pill + '">✓ ' + esc(state.invite.claimed_name) + ' joined</div>';
      } else {
        html += '<div style="' + T.sub + '">no one has claimed the code yet…</div>';
      }
    } else {
      html += '<button data-cs-act="mint" style="' + T.btn + '">⤒ create invite code</button>';
    }
    if (state.members && state.members.length) {
      html += '<div style="display:flex;flex-direction:column;gap:6px;margin-top:4px">' +
        '<div style="' + T.sub + '">devices with access</div>';
      state.members.forEach(function (m) {
        html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2)">' +
          '<div style="font-size:var(--ui-small-fs);color:var(--text-1)">' + esc(m.name || m.id) +
          '<span style="color:var(--text-3);font-size:var(--ui-tiny-fs)"> · ' + esc(m.role || 'editor') + '</span></div>' +
          '<button data-cs-act="revoke" data-cs-dev="' + esc(m.id) + '" style="' + T.btnGhost + ';padding:6px 10px;font-size:var(--ui-tiny-fs)">revoke</button>' +
          '</div>';
      });
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function shareOpen(canvasId) {
    var id = canvasId || (window.Worlds && window.Worlds.activeId ? window.Worlds.activeId() : null);
    if (!id || !window.ConnectOverlay) return;
    var state = { invite: null, members: [] };
    var render = function () {
      window.ConnectOverlay.pushPage(shareHTML(state), {
        onSwap: function () {
          var root = window.ConnectOverlay.getContentEl();
          if (!root) return;
          root.querySelectorAll('[data-cs-act]').forEach(function (b) {
            b.addEventListener('click', async function () {
              var act = b.getAttribute('data-cs-act');
              if (act === 'mint') {
                var r = await jfetch('POST', '/api/collab/' + encodeURIComponent(id) + '/invite', {});
                if (r.status === 200) { state.invite = r.body; render(); }
              } else if (act === 'allow') {
                var ra = await jfetch('POST', '/api/collab/' + encodeURIComponent(id) + '/invite/approve', {});
                if (ra.status === 200) { await shareRefresh(); }
              } else if (act === 'deny') {
                await jfetch('POST', '/api/collab/' + encodeURIComponent(id) + '/invite/deny', {});
                await shareRefresh();
              } else if (act === 'revoke') {
                var dev = b.getAttribute('data-cs-dev');
                await jfetch('POST', '/api/collab/' + encodeURIComponent(id) + '/members/' + encodeURIComponent(dev) + '/revoke', {});
                await shareRefresh();
              }
            });
          });
        }
      });
    };
    var shareRefresh = async function () {
      var inv = await jfetch('GET', '/api/collab/' + encodeURIComponent(id) + '/invite');
      state.invite = inv.status === 200 ? inv.body.invite : null;
      var mem = await jfetch('GET', '/api/collab/' + encodeURIComponent(id) + '/members');
      state.members = (mem.status === 200 && mem.body.members) || [];
      render();
    };
    shareRefresh();
    // the sheet polls while open (the claim + the roster stay live)
    shareTimer = setInterval(async function () {
      if (!window.ConnectOverlay || !window.ConnectOverlay.isOpen()) {
        clearInterval(shareTimer); shareTimer = 0; return;
      }
      await shareRefresh();
    }, 4000);
  }

  // ══ THE JOIN SHEET (the joiner) ═══════════════════════════════════

  function joinHTML(st) {
    var html = '<div style="padding:18px 16px;display:flex;flex-direction:column;gap:12px">';
    html += '<div style="display:flex;flex-direction:column;gap:2px">' +
      '<div style="' + T.title + '">join a shared canvas</div>' +
      '<div style="' + T.sub + '">enter the code the canvas owner shows you</div></div>';
    if (st.phase === 'form') {
      html += '<input id="cj-code" inputmode="numeric" maxlength="6" placeholder="6-digit code" style="' + T.input + ';letter-spacing:8px;text-align:center;font-size:18px;font-family:var(--font-mono,monospace)">' +
        '<input id="cj-name" placeholder="this device\'s name" style="' + T.input + '">' +
        '<button data-cj-act="go" style="' + T.btn + '">pair with this canvas</button>';
    } else if (st.phase === 'polling') {
      html += '<div style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px 0">' +
        '<div style="' + T.code + '">' + esc(st.code) + '</div>' +
        '<div style="' + T.sub + '">waiting for the owner\u2019s approval…</div>' +
        '<div style="width:22px;height:22px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:cjspin 0.9s linear infinite"></div>' +
        '</div><style>@keyframes cjspin{to{transform:rotate(360deg)}}</style>';
    } else if (st.phase === 'approved') {
      html += '<div style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 0">' +
        '<div style="font-size:26px;color:var(--ok,var(--accent))">✓</div>' +
        '<div style="font-size:var(--ui-small-fs);color:var(--text-1)">' + esc(st.deviceName || 'this device') + ' is connected</div>' +
        '<div style="' + T.sub + '">the shared canvas is live — every edit syncs</div>' +
        '</div><button data-cj-act="enter" style="' + T.btn + '">open the canvas</button>';
    } else if (st.phase === 'denied') {
      html += '<div style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 0">' +
        '<div style="font-size:26px;color:var(--warn,var(--text-1))">✕</div>' +
        '<div style="font-size:var(--ui-small-fs);color:var(--text-1)">the owner denied this request</div></div>';
    } else if (st.phase === 'error') {
      html += '<div style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 0">' +
        '<div style="font-size:var(--ui-small-fs);color:var(--text-1)">' + esc(st.error) + '</div></div>' +
        '<button data-cj-act="again" style="' + T.btnGhost + '">try again</button>';
    }
    html += '</div>';
    return html;
  }

  var joinState = null;
  var joinTimer = 0;

  function joinRender() {
    window.ConnectOverlay.pushPage(joinHTML(joinState), {
      onSwap: function () {
        var root = window.ConnectOverlay.getContentEl();
        if (!root) return;
        var go = root.querySelector('[data-cj-act="go"]');
        if (go) {
          go.addEventListener('click', async function () {
            var codeEl = root.querySelector('#cj-code');
            var nameEl = root.querySelector('#cj-name');
            var code = (codeEl && codeEl.value || '').replace(/\D/g, '');
            var name = (nameEl && nameEl.value || '').trim() || 'Device';
            if (code.length !== 6) { joinState = { phase: 'error', error: 'the code is 6 digits' }; joinRender(); return; }
            // the pair names the canvas this device is already viewing
            // (the host engine's OWN registry named it); the code proves
            // the owner's intent.
            var canvas = joinState.canvas || (window.Worlds && window.Worlds.activeId ? window.Worlds.activeId() : null);
            if (!canvas) { joinState = { phase: 'error', error: 'no canvas to join' }; joinRender(); return; }
            var r = await jfetch('POST', '/api/collab/pair', { canvas: canvas, code: code, name: name });
            if (r.status !== 200) {
              joinState = { phase: 'error', error: r.status === 404 ? 'no matching invite' : r.status === 429 ? 'too many attempts — wait a minute' : 'pairing failed (' + r.status + ')' };
              joinRender(); return;
            }
            joinState = { phase: 'polling', canvas: canvas, code: code, deviceCode: r.body.device_code, deviceName: name };
            joinRender();
            joinPoll();
          });
        }
        var enter = root.querySelector('[data-cj-act="enter"]');
        if (enter) {
          enter.addEventListener('click', function () {
            try { window.dispatchEvent(new CustomEvent('doomalay:collab-join-approved', { detail: joinState })); } catch (e) {}
            if (window.ConnectOverlay && window.ConnectOverlay.backOne) window.ConnectOverlay.backOne();
          });
        }
        var again = root.querySelector('[data-cj-act="again"]');
        if (again) {
          again.addEventListener('click', function () {
            joinState = { phase: 'form', canvas: joinState.canvas };
            joinRender();
          });
        }
      }
    });
  }

  function joinPoll() {
    if (joinTimer) clearInterval(joinTimer);
    joinTimer = setInterval(async function () {
      if (!joinState || joinState.phase !== 'polling') { clearInterval(joinTimer); joinTimer = 0; return; }
      var r = await jfetch('GET', '/api/collab/pair?device_code=' + encodeURIComponent(joinState.deviceCode));
      if (r.status !== 200) return; // a transient poll failure keeps waiting
      var st = r.body.status;
      if (st === 'approved') {
        clearInterval(joinTimer); joinTimer = 0;
        // THE CREDENTIAL lands: stored per HOST ORIGIN (a device may know
        // many hosts), then the canvas session activates with it.
        try {
          var key = 'doomalay.collab.token';
          localStorage.setItem(key, r.body.token || '');
          localStorage.setItem('doomalay.collab.device', r.body.device_id || '');
        } catch (e) {}
        joinState.token = r.body.token;
        joinState.device = r.body.device_id;
        joinState.phase = 'approved';
        joinRender();
      } else if (st === 'denied') {
        clearInterval(joinTimer); joinTimer = 0;
        joinState.phase = 'denied';
        joinRender();
      } else if (st === 'expired' || st === 'unknown') {
        clearInterval(joinTimer); joinTimer = 0;
        joinState.phase = 'error';
        joinState.error = 'the invite expired';
        joinRender();
      }
    }, 5000);
  }

  function joinOpen(canvasId) {
    if (!window.ConnectOverlay) return;
    joinState = { phase: 'form', canvas: canvasId || null };
    joinRender();
  }

  // the shared credential surfaces (the app's activate path reads them)
  function storedToken() {
    try { return localStorage.getItem('doomalay.collab.token') || ''; } catch (e) { return ''; }
  }
  function clearStoredToken() {
    try { localStorage.removeItem('doomalay.collab.token'); } catch (e) {}
  }

  window.DoomCollabUI = {
    share: shareOpen,
    join: joinOpen,
    storedToken: storedToken,
    clearStoredToken: clearStoredToken
  };
})();
