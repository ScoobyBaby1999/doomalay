// EnginesScreen — manage the list of connected engines.
// Users can add multiple engines (local APK, HF Space, remote PC, Termux),
// switch between them, and see their health status.
//
// Pattern: card list with status dots (Carbon Design System inspired).
// Active engine is highlighted. Tap to switch. Trash icon to remove.

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useEngineStore } from '../store/engines';
import type { Engine } from '../types';

const STATUS_COLORS: Record<string, string> = {
  online: '#34d399',
  offline: '#f87171',
  waking: '#fbbf24',
};

const TYPE_LABELS: Record<string, string> = {
  local: 'Local',
  'hf-demo': 'HF Space',
  cloud: 'Remote',
  lan: 'LAN',
};

export function EnginesScreen({ onClose }: { onClose?: () => void }) {
  const { engines, activeEngineId, addEngine, removeEngine, setActive, pingHealth } = useEngineStore();
  const [showAdd, setShowAdd] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);

  // Ping all engines on mount.
  useEffect(() => {
    engines.forEach(async (e) => {
      setChecking(e.id);
      await pingHealth(e.id);
      setChecking(null);
    });
  }, []);

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border p-4">
        <div>
          <h2 className="text-lg font-bold text-text">Engines</h2>
          <p className="text-sm text-muted">
            {engines.length} configured · {engines.filter((e) => e.status === 'online').length} online
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowAdd(true)}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover"
          >
            + Add
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:text-text"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Engine list */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-2xl space-y-3">
          {engines.length === 0 && (
            <div className="text-center text-muted">
              No engines configured. Add one to get started.
            </div>
          )}
          <AnimatePresence>
            {engines.map((e) => (
              <EngineCard
                key={e.id}
                engine={e}
                isActive={e.id === activeEngineId}
                checking={checking === e.id}
                onSelect={() => setActive(e.id)}
                onRemove={() => {
                  if (confirm(`Remove "${e.name}"?`)) removeEngine(e.id);
                }}
              />
            ))}
          </AnimatePresence>
        </div>
      </div>

      {/* Add engine form */}
      <AnimatePresence>
        {showAdd && (
          <AddEngineForm
            onClose={() => setShowAdd(false)}
            onAdd={async (engine) => {
              const ok = await addEngine(engine);
              if (ok) setShowAdd(false);
              return ok;
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function EngineCard({
  engine,
  isActive,
  checking,
  onSelect,
  onRemove,
}: {
  engine: Engine;
  isActive: boolean;
  checking: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const dotColor = checking ? '#fbbf24' : STATUS_COLORS[engine.status] || '#666';
  const lastSeen = engine.lastSeen
    ? new Date(engine.lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'never';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      onClick={onSelect}
      className={`cursor-pointer rounded-2xl border p-4 transition ${
        isActive
          ? 'border-accent bg-accent/10'
          : 'border-border bg-surface hover:border-accent/50'
      }`}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <div
            className="mt-1 h-3 w-3 shrink-0 rounded-full"
            style={{ backgroundColor: dotColor }}
          />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-text">{engine.name}</span>
              {isActive && (
                <span className="rounded-full bg-accent/20 px-2 py-0.5 text-xs text-accent">
                  Active
                </span>
              )}
              <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">
                {TYPE_LABELS[engine.type] || engine.type}
              </span>
            </div>
            <div className="mt-1 text-sm text-muted">{engine.url}</div>
            <div className="mt-0.5 text-xs text-muted">
              {engine.status === 'online'
                ? `Online · v${engine.capabilities?.version || '?'}`
                : engine.status === 'offline'
                  ? `Offline · last seen ${lastSeen}`
                  : 'Waking up…'}
              {engine.capabilities?.brainAlive && (
                <span className="ml-2 text-success">brain online</span>
              )}
            </div>
          </div>
        </div>
        <button
          onClick={(ev) => {
            ev.stopPropagation();
            onRemove();
          }}
          className="rounded-lg p-1.5 text-muted hover:bg-danger/10 hover:text-danger"
        >
          ✕
        </button>
      </div>
    </motion.div>
  );
}

function AddEngineForm({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (engine: Engine) => Promise<boolean>;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [type, setType] = useState<Engine['type']>('cloud');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const presets: { label: string; type: Engine['type']; url: string; name: string }[] = [
    { label: 'Local (this device)', type: 'local', url: 'http://127.0.0.1:8080', name: 'This Device' },
    { label: 'HF Space', type: 'hf-demo', url: '', name: 'HF Space' },
    { label: 'Remote / LAN', type: 'cloud', url: '', name: 'Remote Engine' },
  ];

  async function handleAdd() {
    if (!url) {
      setError('URL is required');
      return;
    }
    setConnecting(true);
    setError(null);
    const engine: Engine = {
      id: `${type}-${Date.now()}`,
      name: name || `${type} engine`,
      url: url.replace(/\/$/, ''),
      token,
      type,
      status: 'offline',
      lastSeen: 0,
      capabilities: {
        canChat: true,
        canBuild: false,
        canShell: false,
        hasGPU: false,
        hasKVM: false,
        type,
        version: '0.1.0',
        brainAlive: false,
      },
    };
    const ok = await onAdd(engine);
    if (!ok) {
      setError('Could not reach engine at that URL. Added anyway — check the URL and try again.');
    }
    setConnecting(false);
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 20 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-2xl"
      >
        <h3 className="mb-4 text-lg font-bold text-text">Add Engine</h3>

        {/* Preset buttons */}
        <div className="mb-4 flex gap-2">
          {presets.map((p) => (
            <button
              key={p.label}
              onClick={() => {
                setType(p.type);
                setUrl(p.url);
                setName(p.name);
              }}
              className={`flex-1 rounded-lg border px-3 py-2 text-xs ${
                type === p.type
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border text-muted hover:text-text'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-sm text-muted">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Engine"
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted">URL</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://192.168.1.50:8080 or https://user-space.hf.space"
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted">Token (optional)</label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="bearer token for remote engines"
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
            />
          </div>
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 p-2 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <button
            onClick={handleAdd}
            disabled={connecting || !url}
            className="flex-1 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {connecting ? 'Connecting…' : 'Add & Connect'}
          </button>
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm text-muted hover:text-text"
          >
            Cancel
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
