// v065-theme-audit.mjs — THE VISION AUDIT for the v0.65 theme suite.
//
// Reads the suite's manifest.json (screenshots + phases + invariants),
// batches the shots per phase, and asks the VLM a PHASE-AWARE question:
// "where should this gradient appear, does it, and is anything broken?"
// Every answer is validated as JSON; flagged issues land in audit.json.
//
// Usage:  NODE_PATH=/home/z/my-project/node_modules node scripts/v065-theme-audit.mjs \
//             /home/z/sweep-v065 [--batch N] [--only p06,p15]
import ZAI from 'z-ai-web-dev-sdk';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const OUT = args[0] || '/home/z/sweep-v065';
const onlyArg = (args.find(a => a.startsWith('--only=')) || '').split('=')[1] || '';
const ONLY = onlyArg ? onlyArg.split(',') : null;
const BATCH = parseInt((args.find(a => a.startsWith('--batch=')) || '--batch=4').split('=')[1], 10);

// ── per-phase visual expectations (what SHOULD the screenshots show) ──
const PHASE_EXPECT = {
  'p00': 'BASE theme (no overrides): a clean dark/light theme, coherent colors, no gradient overrides anywhere',
  'p01': 'CANVAS BACKGROUND override: the infinite grid canvas BEHIND the UI (visible on the home screen and at the edges/margins of overlay screens) carries a 6-color PURPLE->MAGENTA->RED->ORANGE MESH gradient with soft glowing spots; UI cards/bubbles stay their normal theme colors',
  'p02': 'OVERLAY BACKGROUND override: the background of overlay screens/modal cards (behind the rows/cards, in section headers, behind scrims) carries a 6-color DARK-BLUE->TEAL->MINT MESH gradient; the canvas behind the app may stay the base theme. NOTE: hub/bundle ITEM cards carry their own per-item gradient IDENTITY (orange/pink/green card headers) — that is correct, do NOT flag those',
  'p03': 'SURFACE override: panels, cards, chat bubbles, settings sections (the main surfaces) carry a 6-color DARK-PURPLE->PINK->RED->ORANGE->GOLD DIAGONAL gradient',
  'p04': 'SURFACE RAISED override: inputs, pills, chips, small buttons, raised cards carry a 6-color DARK-GREEN->TEAL->MINT COUNTER-DIAGONAL gradient',
  'p05': 'BORDER override: hairlines and outlines around cards/pills/sections carry a RAINBOW 6-color diagonal sweep (red/orange/yellow/green/blue/purple) — borders may look like thin multi-color lines',
  'p06': 'PRIMARY TEXT override (dark-first 6-color mesh): BODY TEXT carries the DARK first color (dark navy — subtle on a dark theme BY DESIGN), and PROMINENT TITLES (page headings, the bot name label, section titles, big "Settings" header) are clipped to a multi-color mesh text gradient. gradient_follows=true when the body text is dark OR titles show the multi-color clip; screens without prominent titles are not applicable (true)',
  'p07': 'ACCENT 1 override: the primary accent carries a 6-color RED->ORANGE->YELLOW->MINT->BLUE MESH gradient — most visible on the CHAT screen (the user bubble AND the sandbox/persona pills, which render accent-1\'s viewport projection as windows). Screens without accent consumers are not applicable (gradient_follows=true)',
  'p08': 'ACCENT 2 override: secondary accents carry a 6-color PURPLE->MAGENTA->ORANGE->YELLOW DIAGONAL gradient — subtle on screens without secondary-accent consumers (true when not applicable)',
  'p09': 'ACCENT 3 override: tertiary accents carry a 6-color CYAN->BLUE->PURPLE->MAGENTA->RED MESH gradient — subtle on screens without tertiary consumers (true when not applicable)',
  'p10': 'ACCENT 4 override: quaternary accents (script category tones in the library, provider pills) carry a 6-color LIME->GREEN->CYAN->BLUE COUNTER-DIAGONAL gradient — MOST screens have NO accent-4 consumers: only the library (script cards) reliably shows it; treat screens without consumers as not applicable (gradient_follows=true)',
  'p11': 'PRIMARY TEXT override (LIGHT-first mesh): BODY TEXT is near-WHITE (subtle on dark themes BY DESIGN), titles clipped to a light-blue mesh gradient; treat subtle-but-correct text colors as following (true). Screens without prominent titles: not applicable (true)',
  'p12': 'CHAT SCHEME preset: headings/subheads/links/code in the chat carry the named scheme colors',
  'p13': 'CHAT COLOR SLOT gradients: chat headings show a red/orange/yellow mesh text gradient, links a green/teal mesh, emphasis a cyan/purple mesh — visible in the CHAT screenshots; other screens not applicable (true)',
  'p14': 'GRID gradient: the canvas dots/lines carry multi-color gradients (visible on the home canvas)',
  'p15': 'THE COMBO: nearly EVERY surface (canvas, overlays, cards, inputs, borders, text, accents) carries its own vivid gradient — a maximal gradient test',
  'p16': 'REVERTED: back to the clean base theme, no gradient overrides remain',
  'p17': 'THE WINDOW PROOF (accent-1 hard split, RED-left / BLUE-right): every accent-1 object — the sandbox + persona pills, the user bubble, the lib pill — is a WINDOW into ONE viewport-fitted gradient. Objects near the LEFT edge must read RED-ish, objects near the RIGHT edge BLUE-ish (the same gradient seen from different screen positions; cross-element coherence is the point). A pill squeezing the WHOLE red-to-blue spectrum inside its own body is WRONG (a local copy). A WHITE or MILKY pill is WRONG (the stained-white regression). gradient_follows=true when the left/right split reads ACROSS different elements and no pill is white/milky',
  'p18': 'THE PILL VIEW (header dropdown expanded): the pill row shows sandbox/model/artifacts/persona/mind pills. Accent-1 pills (sandbox ⚡, persona 🎭) + the user bubble are windows into the RED-left/BLUE-right split; the accent-2 pills (model 🤖, artifacts 🌳) are windows into a purple/magenta/orange diagonal. Verify: pills render their own variable gradient (vivid, not white/milky, not transparent), pill labels readable, left accent-1 pills redder than right ones. gradient_follows=true when pills show these gradient windows',
  'p19': 'THE PAINTER PROOF (v0.67 transform-proof anchors): the chat panel carries a PERMANENT transform, which breaks background-attachment:fixed — the projection painter re-anchors every window by hand. The chat screen under the accent-1 hard RED-left/BLUE-right split: the model button (top-left header pill) must read SOLID RED (it sits in the red region of the viewport), the user bubble (right side) BLUE-ish, message text readable. A model button showing its own full red-to-blue transition INSIDE itself is WRONG (element-sized — the bug). gradient_follows=true when the split reads by SCREEN POSITION',
  'p20': 'THE EVERY-WINDOW PASS (v0.67 stragglers): sizing-tabs = the SIZING settings page where the ACTIVE tab pill is a purple/magenta/orange/yellow DIAGONAL window (accent-2) with readable light ink; chat-text = the chat where BODY TEXT letters show a 4-color orange/yellow/green/cyan diagonal mesh (the text-1 projection clipped through the glyphs — every .fmt, not just titles). gradient_follows=true when the tab shows the a2 window and/or the body text shows multi-colored letters',
  'p21': 'THE AMPLIFIER (v0.76 depth stack): home-before/home-after = the canvas (amplify 100, starfield live) before/after a left-ward pan. The lattice shifts FLAT (lines and dots by the SAME amount — no lag) while a THREE-LAYER star stack appears around it: dense tiny far stars (nearly pinned), medium mid stars, and a few LARGE soft-glow near orbs that sweep FASTER than the lattice (foreground dust). gradient_follows=true when both shots look like the same clean canvas (no layout break; the star stack — including the big near orbs — is EXPECTED and correct)'
};
const schemeName = {
  teal: 'teal (cyan headings, teal subheads, cyan links)', sunset: 'sunset (amber headings, orange links)',
  forest: 'forest (green headings, teal subheads, green links)', berry: 'berry (purple headings, violet subheads, purple links)',
  ocean: 'ocean (blue headings, light-blue subheads, blue links)', rose: 'rose (pink headings, rose links)',
  mono: 'mono (gray-scale headings)', solar: 'solar (amber headings, cyan subheads)',
  paper: 'paper (brown headings, teal links)', frost: 'frost (blue headings, teal/magenta accents)'
};

const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf-8'));
const records = manifest.records.filter(r => ONLY ? ONLY.some(p => r.phase.startsWith(p)) : true);
if (!records.length) { console.error('no screenshots matched'); process.exit(1); }

// group by phase, keep screen order stable
const byPhase = {};
for (const r of records) (byPhase[r.phase] = byPhase[r.phase] || []).push(r);
const phases = Object.keys(byPhase).sort();

function expectFor(phase) {
  if (phase.startsWith('p12-')) {
    const sch = phase.slice(4);
    return 'CHAT SCHEME "' + sch + '": chat headings/keywords, code, links in the chat carry the scheme colors ' + (schemeName[sch] || sch);
  }
  return PHASE_EXPECT[phase.replace(/-.*$/, '')] || PHASE_EXPECT[phase] || 'theme consistency';
}

const sysPrompt = (phase, names) => `You are a meticulous visual QA auditor for a mobile chatbot app (412x915 screenshots, a canvas of floating chatbot icons + panels/overlays). This batch tests: ${expectFor(phase)}.
The ${names.length} attached screenshots are named, in order: ${names.join(', ')}.
For EACH screenshot answer with STRICT JSON (one object per screenshot, in order):
{"file":"<name>","gradient_follows":<bool — the expected gradient/colors are actually visible where described>,"white_box":<bool — any element that became an OPAQUE WHITE or washed-out box that hides content or clearly breaks the theme>,"readability":<bool — all text readable against its background>,"layout_ok":<bool — no overlapping/broken/blank areas>,"notes":"<one short sentence: what you saw, or the problem>"}
Reply with ONLY the JSON array — no markdown fences, no prose.
Known-good patterns (do NOT flag): tight 13px gaps between chat bubbles; a single light-gray USER bubble with dark text; the canvas home screen showing bot icons with name labels; subtle text shadows; the app's own accent-colored buttons.`;

const zai = await ZAI.create();
const results = [];
let flagged = 0;

for (const phase of phases) {
  const rows = byPhase[phase];
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const names = chunk.map(r => r.file);
    const content = [{
      type: 'text',
      text: sysPrompt(phase, names)
    }, ...chunk.map(r => ({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,' + fs.readFileSync(path.join(OUT, r.file)).toString('base64') }
    }))];
    let parsed = null, attempt = 0;
    while (!parsed && attempt < 4) {
      attempt++;
      try {
        const resp = await zai.chat.completions.createVision({
          messages: [{ role: 'user', content }],
          thinking: { type: 'disabled' }
        });
        let txt = (resp.choices[0]?.message?.content || '').trim();
        txt = txt.replace(/^```(json)?/m, '').replace(/```$/m, '').trim();
        const m = txt.match(/\[[\s\S]*\]/);
        parsed = JSON.parse(m ? m[0] : txt);
      } catch (e) {
        const rate = /429|Too many/i.test(e.message || '');
        console.error(`  ! ${phase} batch ${i / BATCH} attempt ${attempt} failed: ${e.message}`);
        await new Promise(r => setTimeout(r, rate ? 20000 : 2500));
      }
    }
    if (!parsed) {
      results.push(...chunk.map(r => ({ file: r.file, phase, audit_error: 'VLM_FAILED' })));
      flagged += chunk.length;
      continue;
    }
    parsed.forEach((a, j) => {
      const rec = chunk[j] || {};
      const item = {
        file: a.file || rec.file, phase,
        gradient_follows: a.gradient_follows !== false,
        white_box: !!a.white_box,
        readability: a.readability !== false,
        layout_ok: a.layout_ok !== false,
        console_errs: rec.errs || 0,
        notes: a.notes || ''
      };
      const bad = !item.gradient_follows || item.white_box || !item.readability || !item.layout_ok || item.console_errs > 0;
      if (bad) flagged++;
      results.push(item);
      console.log(`  ${bad ? '✘' : '✓'} ${phase}/${(a.file || rec.file || '').replace(/\.png$/, '')}${bad ? ' — ' + a.notes : ''}`);
    });
    await new Promise(r => setTimeout(r, 1200));   // pacing between batches
  }
}

// merge with a previous audit when re-running a subset (--only): the
// fresh results replace their file entries, older ones survive.
let prevResults = null;
try {
  prevResults = JSON.parse(fs.readFileSync(path.join(OUT, 'audit.json'), 'utf-8')).results;
} catch (e) { /* no previous audit */ }
fs.writeFileSync(path.join(OUT, 'audit.json'), JSON.stringify({
  seed: manifest.seed, theme: manifest.theme, audited: results.length, flagged,
  results
}, null, 1));
if (prevResults && prevResults.length) {
  const byFile = new Map(prevResults.map(r => [r.file, r]));
  for (const r of results) byFile.set(r.file, r);
  const merged = [...byFile.values()];
  const mflag = merged.filter(r => r.audit_error || r.white_box || r.readability === false || r.layout_ok === false || r.gradient_follows === false).length;
  fs.writeFileSync(path.join(OUT, 'audit.json'), JSON.stringify({
    seed: manifest.seed, theme: manifest.theme, audited: merged.length, flagged: mflag, merged: true,
    results: merged
  }, null, 1));
  console.log(`MERGED: ${merged.length} total screenshots in audit.json`);
}
console.log(`\nAUDIT DONE: ${results.length} screenshots this run, ${flagged} flagged → ${path.join(OUT, 'audit.json')}`);
process.exit(flagged > 0 ? 2 : 0);
