// v0766-auditor.js — the leak auditor, injected via agent-browser.
// Classifies every element's background layer stack under sentinel
// gradients (border=#ff0055 · s1=#0044cc · s2=#00cc55):
//   A:border-in-X   the border sweep painting a layer NOT clipped to border-box
//   B:raised-on-s1  the raised (s2) field on a plain-surface (s1) based box
//   B2:raised-on-X  the raised field on some other non-s2 base
//   C:s1+s2-stack   both full windows stacking on one element
//   S:scrollbox     a scroll container carrying any field (the user's
//                   "scroll boxes regularly colored by surface" set)
(function () {
  var SENT = {
    border: /rgb\(255, 0, 85\)/,
    s1: /rgb\(0, 68, 204\)/,
    s2: /rgb\(0, 204, 85\)/
  };
  function splitLayers(s) {
    var out = [], depth = 0, cur = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  var probe = document.createElement('div');
  probe.style.display = 'none';
  document.documentElement.appendChild(probe);
  function solidRGB(varName) {
    probe.style.backgroundColor = 'var(' + varName + ')';
    var r = getComputedStyle(probe).backgroundColor;
    probe.style.backgroundColor = '';
    return r;
  }
  var s1solid = solidRGB('--surface-1').replace(/\s/g, '');
  var s2solid = solidRGB('--surface-2').replace(/\s/g, '');
  probe.remove();
  window.__audit = function (surfaceLabel) {
    var leaks = [], scrolls = [], seen = {};
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var cs = getComputedStyle(el);
      var img = cs.backgroundImage;
      var findings = [];
      var isScroll = /auto|scroll/.test(cs.overflowY + ' ' + cs.overflow);
      if (!img || img === 'none') {
        if (isScroll && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') {
          scrolls.push({sel: selOf(el), bg: cs.backgroundColor});
        }
        continue;
      }
      var layers = splitLayers(img);
      var clips = cs.backgroundClip.split(',').map(function (s) { return s.trim(); });
      var fam = layers.map(function (L) {
        if (SENT.border.test(L)) return 'border';
        if (SENT.s1.test(L)) return 's1';
        if (SENT.s2.test(L)) return 's2';
        return 'other';
      });
      for (var li = 0; li < layers.length; li++) {
        if (fam[li] === 'border' && (clips[li] || clips[0]) !== 'border-box') {
          findings.push('A:border-in-' + (clips[li] || clips[0]));
        }
      }
      var hasS2win = fam.indexOf('s2') !== -1;
      if (hasS2win) {
        var bgc = (cs.backgroundColor || '').replace(/\s/g, '');
        var baseIsS2 = (bgc === s2solid);
        // a TRANSLUCENT base (alpha < 1) is a deliberate veil under the
        // window (the projection model's fallback) — only an OPAQUE
        // foreign base is a bleed.
        var m = /^rgba\((\d+,\d+,\d+),(0(?:\.\d+)?|1)\)$/.exec(bgc);
        var translucent = !!(m && parseFloat(m[2]) < 1);
        if (!baseIsS2 && !translucent) {
          var hasS1win = fam.indexOf('s1') !== -1;
          var baseIsS1 = (bgc === s1solid) || ((bgc === 'rgba(0,0,0,0)' || bgc === '') && hasS1win);
          if (baseIsS1) findings.push('B:raised-on-s1-base');
          else if (bgc !== 'rgba(0,0,0,0)' && bgc !== '') findings.push('B2:raised-on-' + bgc.slice(0, 22));
        }
      }
      if (fam.indexOf('s1') !== -1 && fam.indexOf('s2') !== -1) findings.push('C:s1+s2-stack');
      if (isScroll && (fam.indexOf('s1') !== -1 || fam.indexOf('s2') !== -1 || fam.indexOf('border') !== -1)) {
        scrolls.push({sel: selOf(el), layers: fam.join('|'), clips: clips.join('|')});
      }
      if (findings.length) {
        var key = selOf(el) + '::' + findings.join(';') + '::' + fam.join('|');
        if (!seen[key]) { seen[key] = 1; leaks.push(key + ' x1'); }
        else {
          // bump the count in place
          for (var lk = 0; lk < leaks.length; lk++) {
            if (leaks[lk].indexOf(key) === 0) {
              var m = / x(\d+)$/.exec(leaks[lk]);
              var n = m ? (parseInt(m[1], 10) + 1) : 2;
              leaks[lk] = key + ' x' + n;
              break;
            }
          }
        }
      }
    }
    return JSON.stringify({
      surface: surfaceLabel,
      leakCount: leaks.length,
      leaks: leaks.slice(0, 50),
      scrollsWithFields: scrolls.slice(0, 25)
    });
  };
  function selOf(el) {
    var cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').toString();
    var s = el.tagName.toLowerCase() + (cls ? '.' + cls.trim().split(/\s+/).slice(0, 3).join('.') : '');
    if (el.id) s += '#' + el.id;
    return s.slice(0, 90);
  }
  return 'auditor armed (s1=' + s1solid + ' s2=' + s2solid + ')';
})()
