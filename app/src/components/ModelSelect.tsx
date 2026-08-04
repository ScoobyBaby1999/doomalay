// ModelSelect — pick a model for the active chat. Rebuilt from the old
// ModelSelectOverlay.tsx (77KB) — minimal Phase 1 version. Fetches the
// catalog from /api/models dynamically. Shows provider grouping + search.

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useModelsStore } from '../store/models';
import { useSessionsStore } from '../store/sessions';
import { useEngineStore } from '../store/engines';

export function ModelSelect({ onClose }: { onClose: () => void }) {
  const { models, syncStatus } = useModelsStore();
  const activeId = useSessionsStore((s) => s.activeSessionId);
  const session = useSessionsStore((s) => (s.activeSessionId ? s.sessions.get(s.activeSessionId)?.session : null));
  const setSession = useSessionsStore((s) => s.setSession);
  const client = useEngineStore((s) => s.client);
  const [query, setQuery] = useState('');

  // Group models by provider.
  const grouped = useMemo(() => {
    const filtered = models.filter((m) =>
      !query || m.id.toLowerCase().includes(query.toLowerCase()) || m.provider.toLowerCase().includes(query.toLowerCase()),
    );
    const map = new Map<string, typeof models>();
    for (const m of filtered) {
      if (!map.has(m.provider)) map.set(m.provider, []);
      map.get(m.provider)!.push(m);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [models, query]);

  async function pick(modelId: string, providerName: string) {
    if (!activeId || !client) return;
    // Optimistically update the local state.
    setSession(activeId, { Model: modelId, Provider: providerName });
    // Persist to the engine.
    try {
      await client.updateSession(activeId, { model: modelId, provider: providerName });
    } catch (e) {
      console.error('persist model:', e);
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        className="flex h-[600px] max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-bold text-text">Select Model</h2>
            <button onClick={onClose} className="text-muted hover:text-text">✕</button>
          </div>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models…"
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent"
            autoFocus
          />
          {session && (
            <div className="mt-2 text-xs text-muted">
              Current: <span className="text-text">{session.Model || 'none'}</span>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {grouped.length === 0 && (
            <div className="p-8 text-center text-muted">
              No models found. Add a provider key first (Settings → Providers).
            </div>
          )}
          {grouped.map(([providerName, providerModels]) => {
            const status = syncStatus.find((s) => s.provider === providerName);
            return (
              <div key={providerName} className="mb-3">
                <div className="px-2 py-1 text-xs font-semibold uppercase text-muted">
                  {providerName} ({providerModels.length})
                </div>
                {providerModels.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => pick(m.id, providerName)}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-text hover:bg-surface-2"
                  >
                    <span className="font-mono text-sm">{m.label}</span>
                    {session?.Model === m.id && <span className="text-accent">✓</span>}
                  </button>
                ))}
                {status?.error && (
                  <div className="px-3 py-1 text-xs text-danger">sync error: {status.error}</div>
                )}
              </div>
            );
          })}
        </div>
      </motion.div>
    </div>
  );
}
