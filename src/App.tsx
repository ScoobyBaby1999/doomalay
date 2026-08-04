// App — the root shell. Routes between Onboarding (no engine) and the
// SpatialCanvas (the game-like chat workspace).

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useEngineStore } from './store/engines';
import { useSessionsStore } from './store/sessions';
import { useModelsStore } from './store/models';
import { useChat } from './hooks/useChat';
import { Onboarding } from './screens/Onboarding';
import { SpatialCanvas } from './components/SpatialCanvas';
import { Providers } from './components/Providers';

export default function App() {
  const { engines, activeEngineId, client, initFromStorage, refreshCapabilities } = useEngineStore();
  const { sessions, activeSessionId, createSession, setActive, loadSessionEvents } = useSessionsStore();
  const refreshModels = useModelsStore((s) => s.refresh);
  const [showProviders, setShowProviders] = useState(false);

  // Init: load engines from localStorage on mount.
  useEffect(() => {
    initFromStorage();
  }, []);

  // When engine changes, refresh capabilities + models + load sessions.
  useEffect(() => {
    if (activeEngineId && client) {
      refreshCapabilities();
      refreshModels();
      client.listSessions().then((remote) => {
        for (const s of remote) {
          if (!sessions.has(s.ID)) {
            createSession(s);
          }
        }
      }).catch(console.error);
    }
  }, [activeEngineId]);

  useChat(activeSessionId); // manages the WS for the active session

  // No engine → onboarding.
  if (!activeEngineId || !client) {
    return <Onboarding />;
  }

  return (
    <div className="h-full safe-top safe-bottom">
      <SpatialCanvas onOpenProviders={() => setShowProviders(true)} />

      {/* Providers overlay */}
      <AnimatePresence>
        {showProviders && (
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 400, damping: 35 }}
            className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-bg shadow-2xl"
          >
            <Providers onClose={() => setShowProviders(false)} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
