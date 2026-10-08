#!/usr/bin/env node
// v1151-choice-test.js — v1.15.1 THE CHOICE pins (node-side).
//
// The autopickers are dead: no hardcoded model lists anywhere, and every
// path that used to silently pick a model now opens the model screen in
// TEACH MODE (Ready filter + the short banner) — the user picks. This rig
// pins the behavior where it is node-testable (smartConnect, the model
// picker's cloud card) and the source contracts where the DOM is too heavy
// for a fake (modelbrowser teach mode, the gatelock pointer line).
'use strict';

var path = require('path');
var fs = require('fs');
var WEB = path.join(__dirname, '..', 'engine', 'internal', 'server', 'web');

var sandboxLS = {};
global.localStorage = {
  getItem: function (k) { return sandboxLS.hasOwnProperty(k) ? sandboxLS[k] : null; },
  setItem: function (k, v) { sandboxLS[k] = String(v); },
  removeItem: function (k) { delete sandboxLS[k]; }
};

var pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ok - ' + label); }
  else { fail++; console.log('  FAIL - ' + label + (extra ? '  → ' + String(extra).slice(0, 200) : '')); }
}
function src(file) { return fs.readFileSync(path.join(WEB, file), 'utf8'); }

// ── 1. SOURCE PINS: the hardcoded autopickers are gone ────────────────
console.log('v1.15.1 THE CHOICE pins:');
(function () {
  var p = src('providers.js');
  ok(!/var KNOWN_GOOD/.test(p), 'providers.js: KNOWN_GOOD table deleted');
  ok(!/var FALLBACK_MODELS/.test(p), 'providers.js: FALLBACK_MODELS deleted');
  ok(!/function pickAutoModel/.test(p), 'providers.js: pickAutoModel deleted');
  ok(!/pickAutoModel\(/.test(p.replace(/\/\/[^\n]*/g, '')), 'providers.js: no live pickAutoModel calls (comments aside)');
  ok(!/reminder\b/.test(p.replace(/\/\/[^\n]*/g, '')), 'providers.js: the dead v0.17 reminder mode is gone');

  var mb = src('modelbrowser.js');
  ok(mb.indexOf('Pick your model</b> — this is the model screen') >= 0, 'modelbrowser.js: the teach banner text exists');
  ok(mb.indexOf('👾 model pill') >= 0, 'modelbrowser.js: the banner points at the 👾 model pill');
  ok(mb.indexOf("avail = 'available'") >= 0, 'modelbrowser.js: teach mode presets the Ready filter');
  ok(/teach && teach\.provider/.test(mb), 'modelbrowser.js: the teach provider sorts first + expands');
  ok(mb.indexOf('opts.teach') >= 0, 'modelbrowser.js: open() accepts opts.teach');

  var cf = src('chatframework.js');
  ok(cf.indexOf('tap to pick · the model screen') >= 0, 'chatframework.js: the gatelock model box carries the short pointer');

  var mp = src('modelpicker.js');
  ok(mp.indexOf('THE CHOICE') >= 0 && mp.indexOf('smartConnect(onPick)') >= 0, 'modelpicker.js: the cloud card routes through the detector (callback passed through — the pick is the user\'s)');
})();

// ── 2. smartConnect BEHAVIOR: ≥1 key → teach mode, never a pick ───────
(function () {
  var opened = [];
  var overlayOpen = false;
  global.window = {
    addEventListener: function () {},
    ConnectOverlay: {
      isOpen: function () { return overlayOpen; },
      open: function () { overlayOpen = true; },
      close: function () { overlayOpen = false; }
    },
    ModelBrowser: {
      open: function (onPick, opts) { opened.push(opts || {}); }
    }
  };
  global.document = { addEventListener: function () {}, createElement: function () { return { style: {} }; } };
  global.location = { protocol: 'http:', host: 't' };
  global.fetch = function (url) {
    if (url === '/api/keys') {
      return Promise.resolve({ json: function () { return {
        NVIDIA_API_KEY: { has_key: true, provider: 'nvidia' }
      }; } });
    }
    return Promise.resolve({ json: function () { return {}; } });
  };

  require(path.join(WEB, 'providers.js'));
  var PS = global.window.ProvidersScreen;

  var picked = [];
  PS.smartConnect(function (provider, modelId) { picked.push([provider, modelId]); }).then(function (res) {
    ok(res.connected === 1 && res.provider === 'nvidia', 'smartConnect: detects the connected provider');
    ok(opened.length === 1 && opened[0].teach && opened[0].teach.provider === 'nvidia', 'smartConnect: opens the model screen in teach mode for that provider');
    ok(picked.length === 0, 'smartConnect: NEVER auto-picks a model');

    // ── 3. smartConnect with 0 keys → the caller opens the setup GUI ──
    global.fetch = function (url) {
      return Promise.resolve({ json: function () { return {}; } });
    };
    opened.length = 0;
    PS.smartConnect(function () { picked.push(['x', 'y']); }).then(function (res2) {
      ok(res2.connected === 0 && res2.provider === null, 'smartConnect: 0 keys → {connected: 0}');
      ok(opened.length === 0 && picked.length === 0, 'smartConnect: 0 keys → no browser, no pick (caller shows setup)');

      // ── 4. the priority order: privatemodeai beats a generic key ──
      global.fetch = function (url) {
        if (url === '/api/keys') {
          return Promise.resolve({ json: function () { return {
            MISTRAL_API_KEY: { has_key: true, provider: 'mistral' },
            PRIVATEMODEAI_API_KEY: { has_key: true, provider: 'privatemodeai' }
          }; } });
        }
        return Promise.resolve({ json: function () { return {}; } });
      };
      PS.smartConnect(function () {}).then(function (res3) {
        ok(res3.provider === 'privatemodeai', 'smartConnect: PRIORITY provider order holds (it picks the PROVIDER, never a model)');
        var t = opened[opened.length - 1];
        ok(t && t.teach && t.teach.provider === 'privatemodeai', 'smartConnect: teach mode targets the priority provider');

        done();
      });
    });
  }).catch(function (e) { fail++; console.log('  FAIL - smartConnect threw: ' + e.message); done(); });

  function done() {
    console.log(pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
})();
