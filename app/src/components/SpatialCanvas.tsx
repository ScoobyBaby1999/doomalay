// SpatialCanvas — the React wrapper for the PixiJS CanvasApp.
// Mounts the canvas, bridges to the Zustand store, handles the two-button
// empty state + double-tap-to-spawn.

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CanvasApp } from '../canvas/CanvasApp';
import { useSessionsStore } from '../store/sessions';
import { useEngineStore } from '../store/engines';
import { pickName } from '../canvas/names';
import { ChatPanel } from './ChatPanel';
import { RoutingOverlay } from './RoutingOverlay';

export function SpatialCanvas({ onOpenProviders, onOpenEngines }: { onOpenProviders: () => void; onOpenEngines: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<CanvasApp | null>(null);
  const [showRouting, setShowRouting] = useState(false);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const sessions = useSessionsStore((s) => s.sessions);
  const createSession = useSessionsStore((s) => s.createSession);
  const setActive = useSessionsStore((s) => s.setActive);
  const client = useEngineStore((s) => s.client);

  // Init the canvas app.
  useEffect(() => {
    if (!canvasRef.current) return;
    const app = new CanvasApp({
      onIconTap: (id) => {
        setActiveChatId(id);
        setActive(id);
      },
      onIconDoubleTap: (_id) => {
        // TODO: open settings for this chat
      },
      onEmptyDoubleTap: (x, y) => {
        spawnChat(x, y);
      },
      onIconDragEnd: (_id, _x, _y) => {
        // TODO: persist position
      },
    });
    appRef.current = app;
    app.init(canvasRef.current).catch(console.error);
    return () => {
      app.destroy();
      appRef.current = null;
    };
  }, []);

  // Sync sessions → canvas icons.
  useEffect(() => {
    if (!appRef.current) return;
    // Add icons for sessions not yet on the canvas.
    for (const [id, st] of sessions) {
      if (!appRef.current.icons.has(id)) {
        // Place new icons near the center (with some random spread).
        const x = (Math.random() - 0.5) * 400;
        const y = (Math.random() - 0.5) * 300;
        appRef.current.addIcon(st.session, x, y);
      }
    }
    // Remove icons for deleted sessions.
    for (const id of appRef.current.icons.keys()) {
      if (!sessions.has(id)) {
        appRef.current.removeIcon(id);
      }
    }
  }, [sessions]);

  async function spawnChat(x: number = 0, y: number = 0) {
    if (!client) return;
    const taken = new Set(Array.from(sessions.values()).map((s) => s.session.Title));
    const name = pickName(taken);
    try {
      const s = await client.createSession({ Title: name });
      createSession(s);
      // The useEffect above will add the icon.
    } catch (e) {
      console.error('spawn chat:', e);
    }
  }

  const hasChats = sessions.size > 0;

  return (
    <div className="relative h-full w-full overflow-hidden bg-bg">
      {/* The PixiJS canvas */}
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {/* Two-button empty state (when no chats) */}
      <AnimatePresence>
        {!hasChats && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <div className="pointer-events-auto flex gap-4">
              <button
                onClick={() => setShowRouting(true)}
                className="rounded-2xl border border-border bg-surface/80 p-6 backdrop-blur-md transition hover:border-accent"
              >
                <div className="text-3xl mb-2">🖥️</div>
                <div className="font-semibold text-text">Add Sandbox</div>
                <div className="text-sm text-muted">Route to a device</div>
              </button>
              <button
                onClick={() => setShowRouting(true)}
                className="rounded-2xl border border-border bg-surface/80 p-6 backdrop-blur-md transition hover:border-accent"
              >
                <div className="text-3xl mb-2">📁</div>
                <div className="font-semibold text-text">Add Workspace</div>
                <div className="text-sm text-muted">Connect a repo</div>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Hint text */}
      {!hasChats && (
        <div className="pointer-events-none absolute bottom-20 left-1/2 -translate-x-1/2 text-sm text-muted">
          Double-tap anywhere to spawn a chat
        </div>
      )}

      {/* Top toolbar */}
      <div className="absolute left-2 top-2 z-20 flex gap-2 safe-top">
        <button
          onClick={() => setShowRouting(true)}
          className="rounded-lg border border-border bg-surface/80 p-2 text-text backdrop-blur-md hover:border-accent"
        >
          ☰
        </button>
        <button
          onClick={() => spawnChat()}
          className="rounded-lg bg-accent p-2 text-white backdrop-blur-md hover:bg-accent-hover"
        >
          + New
        </button>
      </div>
      <div className="absolute right-2 top-2 z-20 safe-top">
        <button
          onClick={onOpenProviders}
          className="rounded-lg border border-border bg-surface/80 p-2 text-text backdrop-blur-md hover:border-accent"
        >
          ⚙
        </button>
      </div>

      {/* Routing overlay */}
      <AnimatePresence>
        {showRouting && <RoutingOverlay onClose={() => setShowRouting(false)} />}
      </AnimatePresence>

      {/* Chat panel (slides in when a chat is active) */}
      <AnimatePresence>
        {activeChatId && (
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 400, damping: 35 }}
            className="absolute inset-y-0 right-0 z-30 w-full max-w-2xl bg-bg shadow-2xl"
          >
            <ChatPanel onOpenProviders={onOpenProviders} onOpenEngines={onOpenEngines} />
            <button
              onClick={() => setActiveChatId(null)}
              className="absolute left-2 top-2 z-40 rounded-lg border border-border bg-surface p-2 text-text hover:border-accent"
            >
              ›
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
