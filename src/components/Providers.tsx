// Providers — manage provider API keys. Ported + rebuilt from the old
// ProvidersScreen.tsx. Fetches the catalog dynamically from /api/models
// (no static lists). Each provider card shows: name, description, key input,
// active badge, signup link.

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useModelsStore } from '../store/models';

export function Providers({ onClose }: { onClose?: () => void }) {
  const { providers, keys, setKey, deleteKey, refreshing, refresh } = useModelsStore();
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [extraInput, setExtraInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerList = Object.entries(providers).sort((a, b) => {
    // Free tier first, then alphabetical.
    if (a[1].free_tier !== b[1].free_tier) return a[1].free_tier ? -1 : 1;
    return a[0].localeCompare(b[0]);
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
          <h2 className="text-lg font-bold text-text">Provider Keys</h2>
          <p className="text-sm text-muted">Add API keys to enable cloud LLM providers</p>
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
                      </div>
                      <p className="text-sm text-muted">{cfg.description}</p>
                      <a href={cfg.signup_url} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">
                        Get API key →
                      </a>
                    </div>
                  </div>
                  {isActive && !isEditing && (
                    <button
                      onClick={() => handleDelete(cfg.env_var)}
                      className="rounded-lg border border-border px-2 py-1 text-xs text-danger hover:bg-danger/10"
                    >
                      Remove
                    </button>
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
        {error && (
          <div className="mx-auto mt-4 max-w-2xl rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
