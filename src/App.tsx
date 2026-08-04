// App — the root shell. Routes between Onboarding (no engine configured)
// and the main ChatView (engine connected). Phase 1: simple single-chat
// layout with a sidebar. Phase 2 replaces this with the SpatialCanvas.

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useEngineStore } from './store/engines';
import { useSessionsStore } from './store/sessions';
import { useModelsStore } from './store/models';
import { useChat } from './hooks/useChat';
import { pickName } from './lib/utils';
import { Onboarding } from './screens/Onboarding';
import { ChatPanel } from './components/ChatPanel';
import { Providers } from './components/Providers';

export default function App() {
  const { engines, activeEngineId, client, initFromStorage, refreshCapabilities } = useEngineStore();
  const { sessions, activeSessionId, createSession, setActive, loadSessionEvents } = useSessionsStore();
  const refreshModels = useModelsStore((s) => s.refresh);
  const [showProviders, setShowProviders] = useState(false);
  const [showSidebar, setShowSidebar] = useState(() => {
    // Show sidebar by default on desktop (>= 768px), hidden on mobile.
    if (typeof window === 'undefined') return true;
    return window.innerWidth >= 768;
  });

  // Init: load engines from localStorage on mount.
  useEffect(() => {
    initFromStorage();
  }, []);

  // When engine changes, refresh capabilities + models.
  useEffect(() => {
    if (activeEngineId && client) {
      refreshCapabilities();
      refreshModels();
      // Load existing sessions from the engine.
      client.listSessions().then((remote) => {
        for (const s of remote) {
          if (!sessions.has(s.ID)) {
            createSession(s);
            // Load events for each session (lazy: only load for the active one).
          }
        }
      }).catch(console.error);
    }
  }, [activeEngineId]);

  const activeId = activeSessionId;
  useChat(activeId); // manages the WS for the active session

  // No engine → onboarding.
  if (!activeEngineId || !client) {
    return <Onboarding />;
  }

  function handleNewChat() {
    if (!client) return;
    const taken = new Set(Array.from(sessions.values()).map((s) => s.session.Title));
    const name = pickName(taken);
    client.createSession({ Title: name }).then((s) => {
      createSession(s);
      // Load its (empty) events.
      client.getEvents(s.ID).then((events) => loadSessionEvents(s.ID, events));
    }).catch(console.error);
  }

  async function handleSelectSession(id: string) {
    setActive(id);
    // Lazy-load events if not yet loaded.
    const st = sessions.get(id);
    if (st && !st._loaded && client) {
      const events = await client.getEvents(id);
      loadSessionEvents(id, events);
    }
  }

  const sessionList = Array.from(sessions.values()).sort(
    (a, b) => b.session.UpdatedAt - a.session.UpdatedAt,
  );

  return (
    <div className="flex h-full safe-top safe-bottom">
      {/* Sidebar — hidden on small screens unless toggled. Phase 2 replaces with canvas. */}
      <AnimatePresence>
      {showSidebar && (
        <motion.aside
          initial={{ x: -300 }}
          animate={{ x: 0 }}
          exit={{ x: -300 }}
          transition={{ type: 'spring', stiffness: 400, damping: 35 }}
          className="absolute inset-y-0 left-0 z-30 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface md:relative md:w-64"
        >
          <div className="border-b border-border p-3">
            <div className="mb-2 text-xs font-semibold uppercase text-muted">
              {engines.find((e) => e.id === activeEngineId)?.name || 'Engine'}
            </div>
            <button
              onClick={handleNewChat}
              className="w-full rounded-lg bg-accent p-2 text-sm font-semibold text-white hover:bg-accent-hover"
            >
              + New Chat
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {sessionList.length === 0 && (
              <div className="p-4 text-center text-sm text-muted">No chats yet</div>
            )}
            {sessionList.map(({ session }) => (
              <button
                key={session.ID}
                onClick={() => { handleSelectSession(session.ID); setShowSidebar(false); }}
                className={`mb-1 flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm transition ${
                  activeSessionId === session.ID
                    ? 'bg-surface-2 text-text'
                    : 'text-muted hover:bg-surface-2 hover:text-text'
                }`}
              >
                <div
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: `hsl(${hashHue(session.ID)}, 70%, 60%)` }}
                />
                <span className="truncate">{session.Title}</span>
              </button>
            ))}
          </div>
          <div className="border-t border-border p-2">
            <button
              onClick={() => { setShowProviders(true); setShowSidebar(false); }}
              className="w-full rounded-lg p-2 text-left text-sm text-muted hover:bg-surface-2 hover:text-text"
            >
              ⚙ Providers
            </button>
          </div>
        </motion.aside>
      )}
      </AnimatePresence>

      {/* Backdrop on mobile when sidebar is open */}
      <AnimatePresence>
        {showSidebar && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowSidebar(false)}
            className="absolute inset-0 z-20 bg-black/50 md:hidden"
          />
        )}
      </AnimatePresence>

      {/* Main */}
      <main className="relative flex-1">
        {/* Mobile top bar with sidebar toggle */}
        {!activeSessionId && (
          <div className="absolute left-2 top-2 z-20 md:hidden">
            <button
              onClick={() => setShowSidebar(!showSidebar)}
              className="rounded-lg border border-border bg-surface p-2 text-text"
            >
              ☰
            </button>
          </div>
        )}
        {activeSessionId && (
          <div className="absolute left-2 top-2 z-20 md:hidden">
            <button
              onClick={() => setShowSidebar(!showSidebar)}
              className="rounded-lg border border-border bg-surface p-2 text-text"
            >
              ☰
            </button>
          </div>
        )}
        <ChatPanel onOpenProviders={() => setShowProviders(true)} />
      </main>

      {/* Providers overlay */}
      <AnimatePresence>
        {showProviders && (
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 400, damping: 35 }}
            className="fixed inset-y-0 right-0 w-full max-w-md bg-bg shadow-2xl"
          >
            <Providers onClose={() => setShowProviders(false)} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
