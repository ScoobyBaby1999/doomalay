// Engine registry — the list of connected engines (the Go runtime instances).
// The PWA talks to one engine at a time (the "active" engine). Users can add
// multiple engines (local Android APK, HF Space, remote PC, Termux) and switch
// between them. The active engine + the full engine list are persisted to
// localStorage so the PWA remembers the user's choice across sessions.

import { create } from 'zustand';
import type { Engine, EngineCapabilities } from '../types';
import { makeClient, type EngineClient } from '../lib/api';
import { fetchWithRetry } from '../lib/retry';

interface EngineState {
  engines: Engine[];
  activeEngineId: string | null;
  client: EngineClient | null;
  capabilities: EngineCapabilities | null;

  // Actions.
  addEngine: (e: Engine) => Promise<boolean>;
  removeEngine: (id: string) => void;
  setActive: (id: string) => void;
  refreshCapabilities: () => Promise<void>;
  pingHealth: (id: string) => Promise<{ online: boolean; brainAlive?: boolean; version?: string; error?: string }>;
  autoDetectLocal: () => Promise<Engine | null>;
  initFromStorage: () => void;
}

const STORAGE_KEY = 'doomalay.engines';
const ACTIVE_KEY = 'doomalay.activeEngineId';

function loadFromStorage(): Engine[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function loadActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function saveToStorage(engines: Engine[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(engines));
}

function saveActiveId(id: string | null) {
  if (id) localStorage.setItem(ACTIVE_KEY, id);
  else localStorage.removeItem(ACTIVE_KEY);
}

export const useEngineStore = create<EngineState>((set, get) => ({
  engines: [],
  activeEngineId: null,
  client: null,
  capabilities: null,

  async addEngine(e) {
    // Save to list first.
    const engines = [...get().engines.filter((x) => x.id !== e.id), e];
    saveToStorage(engines);
    // Health-check the engine before activating it.
    const health = await get().pingHealth(e.id);
    const updated: Engine = {
      ...e,
      status: health.online ? 'online' : 'offline',
      lastSeen: health.online ? Date.now() : e.lastSeen,
      capabilities: {
        ...e.capabilities,
        brainAlive: health.brainAlive ?? e.capabilities.brainAlive,
        version: health.version ?? e.capabilities.version,
      },
    };
    const finalEngines = [...get().engines.filter((x) => x.id !== e.id), updated];
    saveToStorage(finalEngines);
    // Auto-activate if it's the first engine or if it's online.
    const shouldActivate = !get().activeEngineId || health.online;
    if (shouldActivate) {
      saveActiveId(updated.id);
      set({
        engines: finalEngines,
        activeEngineId: updated.id,
        client: makeClient(updated.url, updated.token),
        capabilities: updated.capabilities,
      });
    } else {
      set({ engines: finalEngines });
    }
    return health.online;
  },

  removeEngine(id) {
    const engines = get().engines.filter((x) => x.id !== id);
    saveToStorage(engines);
    if (get().activeEngineId === id) {
      const next = engines[0];
      saveActiveId(next?.id || null);
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
    saveActiveId(id);
    set({ activeEngineId: id, client: makeClient(e.url, e.token), capabilities: null });
    get().refreshCapabilities();
  },

  async refreshCapabilities() {
    const client = get().client;
    if (!client) return;
    try {
      const caps = await client.capabilities();
      set({ capabilities: caps });
      // Also update the engine's status in the list.
      const id = get().activeEngineId;
      if (id) {
        const engines = get().engines.map((e) =>
          e.id === id ? { ...e, status: 'online' as const, lastSeen: Date.now(), capabilities: caps } : e
        );
        saveToStorage(engines);
        set({ engines });
      }
    } catch (e) {
      console.error('capabilities:', e);
      // Mark active engine as offline if capabilities fail.
      const id = get().activeEngineId;
      if (id) {
        const engines = get().engines.map((en) =>
          en.id === id ? { ...en, status: 'offline' as const } : en
        );
        saveToStorage(engines);
        set({ engines });
      }
    }
  },

  async pingHealth(id) {
    const e = get().engines.find((x) => x.id === id);
    if (!e) return { online: false, error: 'engine not found' };
    // Local engines get a short timeout (3s) — they should respond instantly.
    // Remote engines (HF Space, cloud) get retry logic to handle cold starts.
    const isLocal = e.type === 'local' || e.url.includes('127.0.0.1') || e.url.includes('localhost');
    try {
      if (isLocal) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`${e.url}/api/health`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) return { online: false, error: `HTTP ${res.status}` };
        const data = await res.json();
        return { online: data.status === 'ok', brainAlive: data.brain, version: data.version };
      } else {
        // Remote: retry with backoff to handle HF Space cold starts (up to 60s).
        const res = await fetchWithRetry(
          `${e.url}/api/health`,
          {},
          {
            maxAttempts: 8,
            baseDelayMs: 2000,
            maxDelayMs: 15000,
            timeoutMs: 10000,
          },
        );
        if (!res.ok) return { online: false, error: `HTTP ${res.status}` };
        const data = await res.json();
        return { online: data.status === 'ok', brainAlive: data.brain, version: data.version };
      }
    } catch (err: any) {
      return { online: false, error: err.message };
    }
  },

  async autoDetectLocal() {
    // Try to detect a local engine on 127.0.0.1:8080 (the APK's default).
    // Used during onboarding to skip manual URL entry when the engine is
    // already running (which it is on the Android APK).
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      const res = await fetch('http://127.0.0.1:8080/api/health', { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const data = await res.json();
      if (data.status !== 'ok') return null;
      const engine: Engine = {
        id: `local-${Date.now()}`,
        name: 'This Device',
        url: 'http://127.0.0.1:8080',
        token: '',
        type: 'local',
        status: 'online',
        lastSeen: Date.now(),
        capabilities: {
          canChat: true,
          canBuild: false,
          canShell: false,
          hasGPU: false,
          hasKVM: false,
          type: data.mode || 'local',
          version: data.version || '0.1.0',
          brainAlive: data.brain,
        },
      };
      return engine;
    } catch {
      return null;
    }
  },

  initFromStorage() {
    const engines = loadFromStorage();
    const activeId = loadActiveId();
    if (engines.length === 0) return;
    const active = engines.find((e) => e.id === activeId) || engines[0];
    saveActiveId(active.id);
    set({
      engines,
      activeEngineId: active.id,
      client: makeClient(active.url, active.token),
    });
    get().refreshCapabilities();
  },
}));
