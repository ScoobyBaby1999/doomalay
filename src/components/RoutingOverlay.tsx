// RoutingOverlay — the 4-icon sandbox picker (rounded popup).
// HF Docker / Cloud API / Personal Device / Cloud Devices.

import { motion } from 'framer-motion';
import { useEngineStore } from '../store/engines';

export function RoutingOverlay({ onClose }: { onClose: () => void }) {
  const addEngine = useEngineStore((s) => s.addEngine);
  const refreshModels = useModelsStoreRefresh();

  const options = [
    {
      icon: '🤗',
      label: 'HF Docker',
      desc: 'Free bubblewrap sandbox',
      color: '#ff9d00',
      action: () => connectHF(),
    },
    {
      icon: '☁️',
      label: 'Cloud API',
      desc: 'OpenRouter, NVIDIA, etc.',
      color: '#a78bfa',
      action: () => onClose(), // Just close — the user adds keys in Providers
    },
    {
      icon: '💻',
      label: 'Personal Device',
      desc: 'Your PC, Mac, or phone',
      color: '#34d399',
      action: () => connectLocal(),
    },
    {
      icon: '🖥️',
      label: 'Cloud Devices',
      desc: 'Oracle, Hetzner, E2B',
      color: '#60a5fa',
      action: () => onClose(),
    },
  ];

  function connectHF() {
    // TODO: HF OAuth flow
    addEngine({
      id: `hf-demo-${Date.now()}`,
      name: 'HF Demo',
      url: 'https://scoobybaby1999-doomalaysocreate.hf.space',
      token: '',
      type: 'hf-demo',
      status: 'online',
      lastSeen: Date.now(),
      capabilities: {
        canChat: true, canBuild: false, canShell: false,
        hasGPU: false, hasKVM: false, type: 'hf-demo',
        version: '0.1.0', brainAlive: true,
      },
    });
    setTimeout(() => refreshModels(), 200);
    onClose();
  }

  function connectLocal() {
    addEngine({
      id: `local-${Date.now()}`,
      name: 'This Device',
      url: window.location.origin,
      token: '',
      type: 'local',
      status: 'online',
      lastSeen: Date.now(),
      capabilities: {
        canChat: true, canBuild: false, canShell: false,
        hasGPU: false, hasKVM: false, type: 'local',
        version: '0.1.0', brainAlive: true,
      },
    });
    setTimeout(() => refreshModels(), 200);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        className="w-full max-w-md rounded-3xl border border-border bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-text">Route to Sandbox</h2>
          <button onClick={onClose} className="text-muted hover:text-text">✕</button>
        </div>
        <p className="mb-4 text-sm text-muted">Where should this chat run?</p>
        <div className="grid grid-cols-2 gap-3">
          {options.map((opt) => (
            <button
              key={opt.label}
              onClick={opt.action}
              className="rounded-2xl border border-border bg-surface-2 p-4 text-center transition hover:border-accent"
            >
              <div className="mb-2 text-3xl">{opt.icon}</div>
              <div className="font-semibold text-text">{opt.label}</div>
              <div className="text-xs text-muted">{opt.desc}</div>
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  );
}

// Tiny helper to avoid importing the whole models store (circular dep).
function useModelsStoreRefresh() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useModelsStore } = require('../store/models');
  return useModelsStore((s: any) => s.refresh);
}
