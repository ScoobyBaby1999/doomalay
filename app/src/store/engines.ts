// Engine registry — the list of connected engines (the Go runtime instances).
// The PWA talks to one engine at a time (the "active" engine). In Phase 1,
// there's exactly one engine (localhost or the HF Demo). Phase 2 adds the
// 4-icon routing overlay which lets each chat pick a different engine.

import { create } from 'zustand';
import type { Engine, EngineCapabilities } from '../types';
import { makeClient, type EngineClient } from '../lib/api';

interface EngineState {
  engines: Engine[];
  activeEngineId: string | null;
  client: EngineClient | null;
  capabilities: EngineCapabilities | null;

  // Actions.
  addEngine: (e: Engine) => void;
  removeEngine: (id: string) => void;
  setActive: (id: string) => void;
  refreshCapabilities: () => Promise<void>;
  initFromStorage: () => void;
}

const STORAGE_KEY = 'doomalay.engines';

function loadFromStorage(): Engine[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveToStorage(engines: Engine[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(engines));
}

export const useEngineStore = create<EngineState>((set, get) => ({
  engines: [],
  activeEngineId: null,
  client: null,
  capabilities: null,

  addEngine(e) {
    const engines = [...get().engines.filter((x) => x.id !== e.id), e];
    saveToStorage(engines);
    const activeId = get().activeEngineId || e.id;
    const active = engines.find((x) => x.id === activeId) || engines[0];
    set({
      engines,
      activeEngineId: active?.id || null,
      client: active ? makeClient(active.url, active.token) : null,
    });
  },

  removeEngine(id) {
    const engines = get().engines.filter((x) => x.id !== id);
    saveToStorage(engines);
    if (get().activeEngineId === id) {
      const next = engines[0];
      set({
        engines,
        activeEngineId: next?.id || null,
        client: next ? makeClient(next.url, next.token) : null,
        capabilities: null,
      });
    } else {
      set({ engines });
    }
  },

  setActive(id) {
    const e = get().engines.find((x) => x.id === id);
    if (!e) return;
    set({ activeEngineId: id, client: makeClient(e.url, e.token), capabilities: null });
    get().refreshCapabilities();
  },

  async refreshCapabilities() {
    const client = get().client;
    if (!client) return;
    try {
      const caps = await client.capabilities();
      set({ capabilities: caps });
    } catch (e) {
      console.error('capabilities:', e);
    }
  },

  initFromStorage() {
    const engines = loadFromStorage();
    if (engines.length === 0) return;
    const active = engines.find((e) => e.id === get().activeEngineId) || engines[0];
    set({
      engines,
      activeEngineId: active.id,
      client: makeClient(active.url, active.token),
    });
    get().refreshCapabilities();
  },
}));
