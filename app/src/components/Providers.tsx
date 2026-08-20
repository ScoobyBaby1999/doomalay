// Providers — manage provider API keys.
// Two modes:
//   1. Quickstart (no keys set) — shows only top 3 providers with large inputs.
//      Progressive disclosure: "Show all providers" reveals the full catalog.
//   2. Full catalog (≥1 key set) — shows all providers, sorted free-tier first.
//
// Fetches the catalog dynamically from /api/models. Each provider card shows:
// name, description, key input, active badge, signup link.

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useModelsStore } from '../store/models';

// The 3 providers shown in quickstart mode. Chosen for: free tier availability,
// model quality, and broad recognition. OpenRouter first because it aggregates
// 300+ models and has a generous free tier.
const QUICKSTART_PROVIDERS = ['openrouter', 'anthropic', 'openai'];

export function Providers({ onClose }: { onClose?: () => void }) {
  const { providers, keys, keyValidation, setKey, deleteKey, validateKey, refreshing, refresh } = useModelsStore();
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [extraInput, setExtraInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const hasAnyKey = Object.values(keys).some((k) => k.has_key);
  // Quickstart mode: no keys set AND user hasn't clicked "show all".
  const quickstartMode = !hasAnyKey && !showAll;

  const providerList = Object.entries(providers).sort((a, b) => {
    // In quickstart mode, only show the top 3 in the defined order.
    if (quickstartMode) {
      const aIdx = QUICKSTART_PROVIDERS.indexOf(a[0]);
      const bIdx = QUICKSTART_PROVIDERS.indexOf(b[0]);
      if (aIdx === -1 && bIdx === -1) return 0;
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    }
    // Full catalog: free tier first, then alphabetical.
    if (a[1].free_tier !== b[1].free_tier) return a[1].free_tier ? -1 : 1;
    return a[0].localeCompare(b[0]);
  }).filter(([name]) => {
    if (quickstartMode) return QUICKSTART_PROVIDERS.includes(name);
    return true;
  });

  async function handleSave(envVar: string, providerName: string, hasExtra: boolean) {
    setSaving(true);
    setError(null);
    try {
      await setKey(envVar, providerName, keyInput, hasExtra ? extraInput : undefined);
      setKeyInput('');
      setExtraInput('');
      setEditingProvider(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(envVar: string) {
    if (!confirm('Remove this API key?')) return;
    try {
      await deleteKey(envVar);
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div>
          <h2 className="text-lg font-bold text-text">
            {quickstartMode ? 'Quickstart — Add a Key' : 'Provider Keys'}
          </h2>
          <p className="text-sm text-muted">
            {quickstartMode
              ? 'Pick one provider to start chatting. You can add more later.'
              : `${Object.values(keys).filter((k) => k.has_key).length} keys active`}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => refresh(true)}
            disabled={refreshing}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:text-text disabled:opacity-50"
          >
            {refreshing ? 'Syncing…' : '↻ Sync'}
          </button>
          {onClose && (
            <button onClick={onClose} className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:text-text">
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {providerList.length === 0 && (
          <div className="text-center text-muted">
            {refreshing ? 'Loading providers…' : 'No providers loaded. Is the engine running?'}
          </div>
        )}
        <div className="mx-auto max-w-2xl space-y-3">
          {providerList.map(([name, cfg]) => {
            const keyInfo = keys[cfg.env_var];
            const isActive = keyInfo?.has_key;
            const isEditing = editingProvider === name;
            const validation = keyValidation[cfg.env_var];
            return (
              <motion.div
                key={name}
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-2xl border border-border bg-surface p-4"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <div
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white"
                      style={{ backgroundColor: cfg.color }}
                    >
                      {cfg.label[0]}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-text">{cfg.label}</span>
                        {cfg.free_tier && (
                          <span className="rounded-full bg-success/20 px-2 py-0.5 text-xs text-success">Free</span>
                        )}
                        {isActive && (
                          <span className="rounded-full bg-accent/20 px-2 py-0.5 text-xs text-accent">Active</span>
                        )}
                        {/* Key validation indicator */}
                        {validation?.checking && (
                          <span className="text-xs text-muted">⟳ validating…</span>
                        )}
                        {validation && !validation.checking && validation.valid && (
                          <span className="text-xs text-success" title={`${validation.model_count} models available`}>
                            ✓ {validation.model_count} models
                          </span>
                        )}
                        {validation && !validation.checking && !validation.valid && (
                          <span className="text-xs text-danger" title={validation.error}>
                            ✕ invalid
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-muted">{cfg.description}</p>
                      <a href={cfg.signup_url} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">
                        Get API key →
                      </a>
                    </div>
                  </div>
                  {isActive && !isEditing && (
                    <div className="flex gap-1">
                      <button
                        onClick={() => validateKey(cfg.env_var)}
                        disabled={validation?.checking}
                        className="rounded-lg border border-border px-2 py-1 text-xs text-muted hover:text-text disabled:opacity-50"
                        title="Re-validate key"
                      >
                        {validation?.checking ? '⟳' : '✓?'}
                      </button>
                      <button
                        onClick={() => handleDelete(cfg.env_var)}
                        className="rounded-lg border border-border px-2 py-1 text-xs text-danger hover:bg-danger/10"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>

                {isEditing ? (
                  <div className="mt-3 space-y-2">
                    <input
                      type="password"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      placeholder={cfg.env_var}
                      className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent"
                    />
                    {cfg.extra_env_var && (
                      <input
                        type="text"
                        value={extraInput}
                        onChange={(e) => setExtraInput(e.target.value)}
                        placeholder={`${cfg.extra_env_var} (account ID)`}
                        className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent"
                      />
                    )}
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleSave(cfg.env_var, name, !!cfg.extra_env_var)}
                        disabled={saving || !keyInput}
                        className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
                      >
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={() => { setEditingProvider(null); setKeyInput(''); setExtraInput(''); }}
                        className="rounded-lg border border-border px-4 py-2 text-sm text-muted hover:text-text"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  !isActive && (
                    <button
                      onClick={() => { setEditingProvider(name); setKeyInput(''); setExtraInput(''); }}
                      className="mt-3 w-full rounded-lg border border-dashed border-border py-2 text-sm text-muted hover:border-accent hover:text-text"
                    >
                      + Add API key
                    </button>
                  )
                )}
              </motion.div>
            );
          })}
        </div>

        {/* Show all providers toggle (quickstart mode only) */}
        {quickstartMode && (
          <div className="mx-auto mt-4 max-w-2xl">
            <button
              onClick={() => setShowAll(true)}
              className="w-full rounded-lg border border-dashed border-border py-3 text-sm text-muted hover:border-accent hover:text-text"
            >
              Show all providers ({Object.keys(providers).length} total)
            </button>
          </div>
        )}

        {error && (
          <div className="mx-auto mt-4 max-w-2xl rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
