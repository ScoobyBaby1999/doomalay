// Onboarding — first-launch screen. Three paths:
//   1. "Try Demo" → connects to the HF Demo Engine
//   2. "Connect My Device" → enter localhost URL (engine running locally)
//   3. "Enter Engine URL" → manual (for cloud/remote engines)

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useEngineStore } from '../store/engines';
import { useModelsStore } from '../store/models';

const HF_DEMO_URL = ''  // User configures their own HF Space URL;

export function Onboarding() {
  const addEngine = useEngineStore((s) => s.addEngine);
  const refreshModels = useModelsStore((s) => s.refresh);
  const [url, setUrl] = useState('http://localhost:8080');
  const [name, setName] = useState('My Device');
  const [token, setToken] = useState('');
  const [mode, setMode] = useState<'choose' | 'manual'>('choose');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(engineUrl: string, engineName: string, engineToken: string, type: 'local' | 'hf-demo' | 'cloud') {
    setConnecting(true);
    setError(null);
    try {
      const base = engineUrl.replace(/\/$/, '');
      // Health check.
      const res = await fetch(`${base}/api/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.status !== 'ok') throw new Error('engine not healthy');

      addEngine({
        id: `${engineName}-${Date.now()}`,
        name: engineName,
        url: base,
        token: engineToken,
        type,
        status: 'online',
        lastSeen: Date.now(),
        capabilities: { canChat: true, canBuild: false, canShell: false, hasGPU: false, hasKVM: false, type, version: data.version || '0.1.0', brainAlive: data.brain },
      });
      // Trigger model catalog fetch.
      setTimeout(() => refreshModels(), 200);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-bg p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        className="w-full max-w-md rounded-3xl border border-border bg-surface p-8 shadow-2xl"
      >
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 h-16 w-16 rounded-full bg-accent/20 p-3">
            <div className="h-full w-full rounded-full bg-accent" />
          </div>
          <h1 className="text-2xl font-bold text-text">Doomalay</h1>
          <p className="mt-1 text-sm text-muted">Your sovereign AI workspace</p>
        </div>

        {mode === 'choose' && (
          <div className="space-y-3">
            <button
              onClick={() => connect(HF_DEMO_URL, 'HF Demo', '', 'hf-demo')}
              disabled={connecting}
              className="w-full rounded-xl bg-accent p-4 text-left text-white transition hover:bg-accent-hover disabled:opacity-50"
            >
              <div className="font-semibold">🤗 Try Demo</div>
              <div className="text-sm opacity-80">Zero install. Uses HF Space (free, may sleep).</div>
            </button>
            <button
              onClick={() => connect('http://localhost:8080', 'This Device', '', 'local')}
              disabled={connecting}
              className="w-full rounded-xl border border-border bg-surface-2 p-4 text-left text-text transition hover:border-accent disabled:opacity-50"
            >
              <div className="font-semibold">💻 Connect My Device</div>
              <div className="text-sm text-muted">Engine running on localhost:8080</div>
            </button>
            <button
              onClick={() => setMode('manual')}
              className="w-full rounded-xl border border-border bg-surface-2 p-4 text-left text-text transition hover:border-accent"
            >
              <div className="font-semibold">☁️ Enter Engine URL</div>
              <div className="text-sm text-muted">Connect to a remote engine</div>
            </button>
          </div>
        )}

        {mode === 'manual' && (
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm text-muted">Engine URL</label>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="http://192.168.1.50:8080"
                className="w-full rounded-xl border border-border bg-surface-2 px-4 py-3 text-text outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted">Name (optional)</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-xl border border-border bg-surface-2 px-4 py-3 text-text outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted">Token (optional)</label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="bearer token"
                className="w-full rounded-xl border border-border bg-surface-2 px-4 py-3 text-text outline-none focus:border-accent"
              />
            </div>
            <button
              onClick={() => connect(url, name || 'Remote Engine', token, 'cloud')}
              disabled={connecting}
              className="w-full rounded-xl bg-accent p-3 font-semibold text-white transition hover:bg-accent-hover disabled:opacity-50"
            >
              {connecting ? 'Connecting…' : 'Connect'}
            </button>
            <button onClick={() => setMode('choose')} className="w-full text-sm text-muted hover:text-text">
              ← Back
            </button>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
            {error}
          </div>
        )}
      </motion.div>
    </div>
  );
}
