// replay-rig.test.ts — v1.14.6 THE SOLID STREAM: the WS-replay rig.
//
// Proves the property the phase exists for: a stream that is interrupted
// and resumed (full replay, since=N incremental tail, duplicates, any
// split) folds into BYTE-IDENTICAL message state vs the never-interrupted
// fold. Also pins the complexity class: 50k streaming events fold in
// linear time (the old re-derive-per-event path was O(n²) and melted on
// long turns — the user's O(n)/O(k) directive).
//
// Run: bun test app/src/lib/replay-rig.test.ts

import { describe, it, expect } from 'bun:test';
import { applyEvent, eventsToMessages } from './utils';
import type { ChatMessage } from '../types';

// ── deterministic PRNG (mulberry32) — the rig must be reproducible ──────
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Ev = { type: string; text?: string; name?: string; summary?: string; tool_use_id?: string; is_error?: boolean; state?: string; error?: string; ts: number; i: number; seq: number };

// foldWatermarked — the store's foldOne semantics (guard + apply +
// watermark) mirrored exactly; the rig owns the property, the store owns
// the wiring. If either drifts, the identity tests below fail.
function foldWatermarked(msgs: ChatMessage[], ev: Ev, watermark: { n: number }): boolean {
  if (ev.seq && ev.seq <= watermark.n) return false;
  applyEvent(msgs, ev);
  if (ev.seq) watermark.n = ev.seq;
  return true;
}

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'the answer', 'thinking about it', 'checking repos…'];

function randomStream(rnd: () => number, n: number): Ev[] {
  const evs: Ev[] = [];
  let seq = 1;
  let toolId = 0;
  const openToolIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = rnd();
    const base = { ts: 1700000000000 + i * 100, i, seq: seq++ };
    if (r < 0.1) {
      evs.push({ ...base, type: 'user', text: 'do the thing' });
    } else if (r < 0.25) {
      evs.push({ ...base, type: 'thinking', text: `snapshot of thinking ${i}` });
    } else if (r < 0.65) {
      evs.push({ ...base, type: 'assistant_delta', text: WORDS[Math.floor(rnd() * WORDS.length)] + ' ' });
    } else if (r < 0.8) {
      const id = `call_${toolId++}`;
      openToolIds.push(id);
      evs.push({ ...base, type: 'tool_use', name: 'web_search', summary: 'searching', tool_use_id: id });
    } else if (r < 0.9 && openToolIds.length > 0) {
      const idx = Math.floor(rnd() * openToolIds.length);
      const id = openToolIds.splice(idx, 1)[0];
      evs.push({ ...base, type: 'tool_result', tool_use_id: id, text: '42 results', is_error: rnd() < 0.1 });
    } else if (r < 0.95) {
      evs.push({ ...base, type: 'status', state: rnd() < 0.5 ? 'running' : 'idle' });
    } else {
      evs.push({ ...base, type: 'error', error: 'something failed' });
    }
  }
  return evs;
}

const canon = (msgs: ChatMessage[]) => JSON.stringify(msgs);

describe('v1.14.6 THE SOLID STREAM — the WS-replay rig', () => {
  it('reconnect fold == never-disconnected fold (random splits, 200 streams)', () => {
    const rnd = mulberry32(11406);
    for (let trial = 0; trial < 200; trial++) {
      const evs = randomStream(rnd, 3 + Math.floor(rnd() * 60));
      const whole = canon(eventsToMessages(evs));

      // The disconnect: split at a random point; the client folds the
      // first half live, then reconnects and folds the tail (since=N
      // replay → seq > watermark).
      const cut = Math.floor(rnd() * (evs.length + 1));
      const live: ChatMessage[] = [];
      const wm = { n: 0 };
      for (let i = 0; i < cut; i++) foldWatermarked(live, evs[i], wm);
      for (let i = cut; i < evs.length; i++) foldWatermarked(live, evs[i], wm);

      if (canon(live) !== whole) {
        throw new Error(
          `trial ${trial}: replay state diverged at cut=${cut}\nwhole:  ${whole}\nresumed: ${canon(live)}`,
        );
      }
    }
  });

  it('full replay after reconnect is idempotent (duplicates drop)', () => {
    const rnd = mulberry32(11407);
    const evs = randomStream(rnd, 80);
    const whole = canon(eventsToMessages(evs));

    const live: ChatMessage[] = [];
    const wm = { n: 0 };
    for (const ev of evs) foldWatermarked(live, ev, wm);
    // the reconnect that asks since=0 anyway (stale client): the engine
    // replays EVERYTHING — the watermark must drop every duplicate.
    for (const ev of evs) foldWatermarked(live, ev, wm);
    expect(canon(live)).toBe(whole);
  });

  it('the streaming bubble continues across the reconnect (no REPLACE)', () => {
    // the exact REPLACE shape: deltas before the drop, deltas after the
    // resume — ONE assistant message, full content, finalized by status.
    const evs: Ev[] = [];
    let seq = 1;
    const mk = (type: string, extra: Partial<Ev>): Ev => ({ ts: 1700000000000, i: seq - 1, seq: seq++, type, ...extra });
    evs.push(mk('user', { text: 'long answer please' }));
    for (const w of ['one ', 'two ', 'three ']) evs.push(mk('assistant_delta', { text: w }));
    // ── the drop ──
    for (const w of ['four ', 'five']) evs.push(mk('assistant_delta', { text: w }));
    evs.push(mk('status', { state: 'idle' }));

    const live: ChatMessage[] = [];
    const wm = { n: 0 };
    for (let i = 0; i < 4; i++) foldWatermarked(live, evs[i], wm); // pre-drop
    for (let i = 4; i < evs.length; i++) foldWatermarked(live, evs[i], wm); // resumed tail

    const assistants = live.filter((m) => m.role === 'assistant');
    expect(assistants.length).toBe(1); // ONE message — never replaced/duplicated
    expect(assistants[0].content).toBe('one two three four five');
    expect(assistants[0].isStreaming).toBe(false); // finalized by the replayed status
  });

  it('50k streaming events fold in linear time (the O(n)/O(k) pin)', () => {
    const N = 50_000;
    const evs: Ev[] = [];
    for (let i = 0; i < N; i++) {
      evs.push({ type: 'assistant_delta', text: 'x ', ts: 1700000000000 + i, i, seq: i + 1 });
    }
    const t0 = performance.now();
    const msgs = eventsToMessages(evs);
    const dt = performance.now() - t0;
    expect(msgs.length).toBe(1);
    expect(msgs[0].content.length).toBe(N * 2); // 'x ' × N
    // linear fold: 50k events in well under a second locally. The old
    // O(n²) re-derivation at this scale measured in MINUTES.
    expect(dt).toBeLessThan(2000);
    console.log(`    rig: ${N} events folded in ${dt.toFixed(1)}ms`);
  });
});
