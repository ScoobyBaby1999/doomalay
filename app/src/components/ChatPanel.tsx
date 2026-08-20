// ChatPanel — the main chat view. Shows: header (title, model badge,
// context ring, cost gauge), message stream, input box. Phase 1: simple
// list, no canvas. Phase 2 will wrap this in the sliding panel.

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useSessionsStore, useActiveSession } from '../store/sessions';
import { useChat } from '../hooks/useChat';
import { useEngineStore } from '../store/engines';
import { useModelsStore } from '../store/models';
import { fmtTokens } from '../lib/utils';
import { Message } from './Message';
import { ChatInput } from './ChatInput';
import { ModelSelect } from './ModelSelect';

export function ChatPanel({ onOpenProviders }: { onOpenProviders: () => void }) {
  const active = useActiveSession();
  const activeId = useSessionsStore((s) => s.activeSessionId);
  const { send, stop } = useChat(activeId);
  const client = useEngineStore((s) => s.client);
  const capabilities = useEngineStore((s) => s.capabilities);
  const keys = useModelsStore((s) => s.keys);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active?.messages.length]);

  if (!active || !activeId) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <div className="text-center">
          <div className="mb-2 text-4xl">●</div>
          <p>Select or create a chat to begin</p>
        </div>
      </div>
    );
  }

  const hasModel = !!active.session.Model;
  const brainAlive = capabilities?.brainAlive ?? false;
  const hasAnyKey = Object.values(keys).some((k) => k.has_key);
  const contextPct = active.session.MaxContext > 0
    ? Math.min(100, (active.cumulativeUsage.total_tokens / active.session.MaxContext) * 100)
    : 0;

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-3">
        <div className="flex items-center gap-3">
          <div
            className="h-8 w-8 rounded-full"
            style={{ backgroundColor: `hsl(${hashHue(activeId)}, 70%, 60%)` }}
          />
          <div>
            <div className="font-semibold text-text">{active.session.Title}</div>
            <button
              onClick={() => setShowModelSelect(true)}
              className="flex items-center gap-1 text-xs text-muted hover:text-text"
            >
              <span className="font-mono">{active.session.Model || 'no model'}</span>
              <span>▾</span>
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Context ring */}
          {active.lastUsage && (
            <div className="flex items-center gap-1 text-xs text-muted">
              <svg width="16" height="16" viewBox="0 0 16 16">
                <circle cx="8" cy="8" r="6" fill="none" stroke="#2a2a32" strokeWidth="2" />
                <circle
                  cx="8" cy="8" r="6" fill="none"
                  stroke={contextPct > 80 ? '#f87171' : contextPct > 50 ? '#fbbf24' : '#34d399'}
                  strokeWidth="2"
                  strokeDasharray={`${(contextPct / 100) * 37.7} 37.7`}
                  transform="rotate(-90 8 8)"
                />
              </svg>
              <span className="tabular-nums">{fmtTokens(active.cumulativeUsage.total_tokens)}</span>
            </div>
          )}
          {!brainAlive && (
            <span className="rounded-full bg-warning/20 px-2 py-0.5 text-xs text-warning">brain offline</span>
          )}
          <button
            onClick={onOpenProviders}
            className="rounded-lg border border-border px-2 py-1 text-xs text-muted hover:text-text"
          >
            ⚙
          </button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-3xl space-y-3">
          {active.messages.length === 0 && (
            <div className="mt-20 text-center text-muted">
              {!hasAnyKey ? (
                <>
                  <p className="mb-2">No API keys set yet.</p>
                  <p className="mb-4 text-sm">Add a provider key to start chatting with cloud LLMs.</p>
                  <button
                    onClick={onOpenProviders}
                    className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
                  >
                    Add API key
                  </button>
                </>
              ) : !hasModel ? (
                <>
                  <p>Say hi to {active.session.Title}…</p>
                  <button
                    onClick={() => setShowModelSelect(true)}
                    className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
                  >
                    Select a model
                  </button>
                </>
              ) : (
                <p>Say hi to {active.session.Title}…</p>
              )}
            </div>
          )}
          <AnimatePresence initial={false}>
            {active.messages.map((msg) => (
              <motion.div
                key={msg.id}
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              >
                <Message msg={msg} />
              </motion.div>
            ))}
          </AnimatePresence>
          {active.error && (
            <div className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
              {active.error}
            </div>
          )}
        </div>
      </div>

      {/* Input */}
      {/* Input — enabled whenever we have a client + model, regardless of brain status.
          The engine's streamFromDirectProxy path works without the Python brain
          (calls cloud LLMs directly from Go), so brainAlive is NOT a hard gate.
          The "brain offline" badge in the header is informational, not a blocker. */}
      <ChatInput
        onSend={send}
        onStop={stop}
        isBusy={active.isBusy}
        disabled={!client || !hasModel}
      />

      {/* Model select overlay */}
      <AnimatePresence>
        {showModelSelect && <ModelSelect onClose={() => setShowModelSelect(false)} />}
      </AnimatePresence>
    </div>
  );
}

// Tiny helper to avoid importing from utils (which would re-trigger renders).
function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
