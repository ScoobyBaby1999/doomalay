// Provider + model catalog store. Dynamic fetch from /api/models — no static
// lists. The PWA calls refresh() on mount and after key changes.

import { create } from 'zustand';
import type { ModelsResponse, ProviderConfig, ModelInfo, SyncStatus, ProviderKeyInfo } from '../types';
import { useEngineStore } from './engines';

interface ModelsStore {
  providers: Record<string, ProviderConfig>;
  models: ModelInfo[];
  syncStatus: SyncStatus[];
  keys: Record<string, ProviderKeyInfo>;
  totalModels: number;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  lastFetchedAt: number | null;

  refresh: (force?: boolean) => Promise<void>;
  refreshKeys: () => Promise<void>;
  setKey: (envVar: string, provider: string, key: string, extra?: string) => Promise<void>;
  deleteKey: (envVar: string) => Promise<void>;
}

export const useModelsStore = create<ModelsStore>((set, get) => ({
  providers: {},
  models: [],
  syncStatus: [],
  keys: {},
  totalModels: 0,
  loading: false,
  refreshing: false,
  error: null,
  lastFetchedAt: null,

  async refresh(force = false) {
    const client = useEngineStore.getState().client;
    if (!client) return;
    const already = get().lastFetchedAt && !force;
    set({ loading: !already, refreshing: force, error: null });
    try {
      const data: ModelsResponse = await client.models(force);
      set({
        providers: data.providers || {},
        models: data.models || [],
        syncStatus: data.syncStatus || [],
        totalModels: data.totalModels || 0,
        error: data.error || null,
        loading: false,
        refreshing: false,
        lastFetchedAt: Date.now(),
      });
      // Also refresh keys (they affect sync status).
      await get().refreshKeys();
    } catch (e: any) {
      set({ loading: false, refreshing: false, error: e.message });
    }
  },

  async refreshKeys() {
    const client = useEngineStore.getState().client;
    if (!client) return;
    try {
      const keys = await client.listKeys();
      set({ keys });
    } catch (e) {
      // Silent — keys are best-effort.
    }
  },

  async setKey(envVar, provider, key, extra) {
    const client = useEngineStore.getState().client;
    if (!client) throw new Error('no engine connected');
    await client.setKey(envVar, provider, key, extra);
    await get().refreshKeys();
    // Force-refresh models so the sync status updates.
    await get().refresh(true);
  },

  async deleteKey(envVar) {
    const client = useEngineStore.getState().client;
    if (!client) throw new Error('no engine connected');
    await client.deleteKey(envVar);
    await get().refreshKeys();
    await get().refresh(true);
  },
}));
