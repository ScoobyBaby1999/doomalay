// ModelSelect — pick a model for the active chat. Fetches the catalog from
// /api/models dynamically. Shows: search input, provider-grouped list with
// color dots, recommended tags for popular models, model count per provider.

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useModelsStore } from '../store/models';
import { useSessionsStore } from '../store/sessions';
import { useEngineStore } from '../store/engines';

// Models tagged as "Recommended" — chosen for capability + value.
// Matched by case-insensitive substring on the model id.
const RECOMMENDED_MODELS = [
  { match: 'claude-sonnet', label: 'Claude Sonnet' },
  { match: 'gpt-4o', label: 'GPT-4o' },
  { match: 'gemini-2.5', label: 'Gemini 2.5' },
  { match: 'deepseek-v3', label: 'DeepSeek V3' },
  { match: 'llama-3.3', label: 'Llama 3.3' },
  { match: 'glm-4', label: 'GLM-4' },
];

export function ModelSelect({ onClose }: { onClose: () => void }) {
  const { models, syncStatus, providers } = useModelsStore();
  const activeId = useSessionsStore((s) => s.activeSessionId);
  const session = useSessionsStore((s) => (s.activeSessionId ? s.sessions.get(s.activeSessionId)?.session : null));
  const setSession = useSessionsStore((s) => s.setSession);
  const client = useEngineStore((s) => s.client);
  const [query, setQuery] = useState('');

  // Group models by provider, filtered by search query.
  const grouped = useMemo(() => {
    const q = query.toLowerCase();
    const filtered = models.filter((m) =>
      !q || m.id.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q) || m.label.toLowerCase().includes(q),
    );
    const map = new Map<string, typeof models>();
    for (const m of filtered) {
      if (!map.has(m.provider)) map.set(m.provider, []);
      map.get(m.provider)!.push(m);
    }
    // Sort providers: those with keys first, then alphabetical.
    return Array.from(map.entries()).sort((a, b) => {
      const aHasKey = syncStatus.find((s) => s.provider === a[0])?.has_key ?? false;
      const bHasKey = syncStatus.find((s) => s.provider === b[0])?.has_key ?? false;
      if (aHasKey !== bHasKey) return aHasKey ? -1 : 1;
      return a[0].localeCompare(b[0]);
    });
  }, [models, query, syncStatus]);

  // Recommended models that match the search query.
  const recommended = useMemo(() => {
    const q = query.toLowerCase();
    return RECOMMENDED_MODELS.filter((r) => !q || r.label.toLowerCase().includes(q) || r.match.includes(q));
  }, [query]);

  async function pick(modelId: string, providerName: string) {
    if (!activeId || !client) return;
    setSession(activeId, { Model: modelId, Provider: providerName });
    try {
      await client.updateSession(activeId, { model: modelId, provider: providerName });
    } catch (e) {
      console.error('persist model:', e);
    }
    onClose();
  }

  // Find a model by recommended match string.
  function findModelByMatch(match: string) {
    return models.find((m) => m.id.toLowerCase().includes(match));
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
              Current: <span className="font-mono text-text">{session.Model || 'none'}</span>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {/* Recommended models (only when no search query) */}
          {!query && recommended.length > 0 && (
            <div className="mb-3 border-b border-border pb-3">
              <div className="px-2 py-1 text-xs font-semibold uppercase text-muted">Recommended</div>
              {recommended.map((r) => {
                const m = findModelByMatch(r.match);
                if (!m) return null;
                return (
                  <button
                    key={r.match}
                    onClick={() => pick(m.id, m.provider)}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-text hover:bg-surface-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-accent/20 px-2 py-0.5 text-xs text-accent">★</span>
                      <span className="font-medium text-sm">{r.label}</span>
                      <span className="text-xs text-muted">{m.provider}</span>
                    </div>
                    {session?.Model === m.id && <span className="text-accent">✓</span>}
                  </button>
                );
              })}
            </div>
          )}

          {grouped.length === 0 && (
            <div className="p-8 text-center text-muted">
              {models.length === 0
                ? 'No models loaded. Add a provider key first (⚙ → Add API key).'
                : 'No models match your search.'}
            </div>
          )}

          {/* Provider-grouped model list */}
          {grouped.map(([providerName, providerModels]) => {
            const status = syncStatus.find((s) => s.provider === providerName);
            const providerCfg = providers[providerName];
            const color = providerCfg?.color || '#666';
            const hasKey = status?.has_key ?? false;
            return (
              <div key={providerName} className="mb-3">
                <div className="flex items-center gap-2 px-2 py-1">
                  <div
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span className="text-xs font-semibold uppercase text-muted">
                    {providerCfg?.label || providerName}
                  </span>
                  <span className="text-xs text-muted">
                    {providerModels.length}
                  </span>
                  {!hasKey && (
                    <span className="text-xs text-danger">no key</span>
                  )}
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
