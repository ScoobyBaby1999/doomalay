// Per-session chat store. THE V0 FIX: a Map<sessionId, ChatSessionState>
// instead of the old flat global slice. Each chat has its own messages,
// model, provider, toggles, isBusy, etc. — fully isolated.

import { create } from 'zustand';
import type { ChatEvent, ChatSession, ChatMessage, Usage } from '../types';
import { eventsToMessages } from '../lib/utils';
import { useEngineStore } from './engines';

interface ChatSessionState {
  // Persisted session metadata (from the engine's chat_sessions table).
  session: ChatSession;
  // Events from the engine (the source of truth — replayed on open).
  events: ChatEvent[];
  // Rendered messages (derived from events).
  messages: ChatMessage[];
  // Live metadata (updated by status events).
  isBusy: boolean;
  isStreaming: boolean;
  lastUsage: Usage | null;
  cumulativeUsage: Usage;
  sessionCost: number;
  error: string | null;
  // The WebSocket for an active turn.
  _ws: WebSocket | null;
  // Whether events have been loaded from the engine.
  _loaded: boolean;
}

interface SessionsStore {
  // THE per-session Map — the V0 fix.
  sessions: Map<string, ChatSessionState>;
  activeSessionId: string | null;

  // Actions.
  createSession: (s: ChatSession) => void;
  loadSessionEvents: (id: string, events: ChatEvent[]) => void;
  appendEvent: (id: string, ev: ChatEvent) => void;
  setActive: (id: string | null) => void;
  removeSession: (id: string) => void;
  setSession: (id: string, patch: Partial<ChatSession>) => void;
  setWS: (id: string, ws: WebSocket | null) => void;
  setBusy: (id: string, busy: boolean) => void;
  setError: (id: string, err: string | null) => void;
  updateFromEvent: (id: string, ev: ChatEvent) => void;
}

function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

function makeState(session: ChatSession): ChatSessionState {
  return {
    session,
    events: [],
    messages: [],
    isBusy: false,
    isStreaming: false,
    lastUsage: null,
    cumulativeUsage: emptyUsage(),
    sessionCost: 0,
    error: null,
    _ws: null,
    _loaded: false,
  };
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  sessions: new Map(),
  activeSessionId: null,

  createSession(s) {
    const sessions = new Map(get().sessions);
    sessions.set(s.ID, makeState(s));
    set({ sessions, activeSessionId: s.ID });
  },

  loadSessionEvents(id, events) {
    const sessions = new Map(get().sessions);
    const st = sessions.get(id);
    if (!st) return;
    st.events = events;
    st.messages = eventsToMessages(events);
    st._loaded = true;
    set({ sessions });
  },

  appendEvent(id, ev) {
    const sessions = new Map(get().sessions);
    const st = sessions.get(id);
    if (!st) return;
    st.events = [...st.events, ev];
    st.messages = eventsToMessages(st.events);
    set({ sessions });
  },

  setActive(id) {
    set({ activeSessionId: id });
  },

  removeSession(id) {
    const sessions = new Map(get().sessions);
    const st = sessions.get(id);
    if (st?._ws) st._ws.close();
    sessions.delete(id);
    const active = get().activeSessionId === id ? null : get().activeSessionId;
    set({ sessions, activeSessionId: active });
  },

  setSession(id, patch) {
    const sessions = new Map(get().sessions);
    const st = sessions.get(id);
    if (!st) return;
    st.session = { ...st.session, ...patch };
    set({ sessions });
  },

  setWS(id, ws) {
    const sessions = new Map(get().sessions);
    const st = sessions.get(id);
    if (!st) return;
    if (st._ws && st._ws !== ws) st._ws.close();
    st._ws = ws;
    set({ sessions });
  },

  setBusy(id, busy) {
    const sessions = new Map(get().sessions);
    const st = sessions.get(id);
    if (!st) return;
    st.isBusy = busy;
    st.isStreaming = busy;
    if (!busy && st._ws) {
      // Don't close the WS here — the WS stays open for the next turn.
      // Just null the busy flag.
    }
    set({ sessions });
  },

  setError(id, err) {
    const sessions = new Map(get().sessions);
    const st = sessions.get(id);
    if (!st) return;
    st.error = err;
    if (err) st.isBusy = false;
    set({ sessions });
  },

  updateFromEvent(id, ev) {
    const sessions = new Map(get().sessions);
    const st = sessions.get(id);
    if (!st) return;
    // Update live metadata from status events.
    if (ev.type === 'status') {
      if (ev.usage) {
        st.lastUsage = ev.usage;
        // Cumulative: add this turn's usage to the running total.
        st.cumulativeUsage = {
          input_tokens: st.cumulativeUsage.input_tokens + (ev.usage.input_tokens || 0),
          output_tokens: st.cumulativeUsage.output_tokens + (ev.usage.output_tokens || 0),
          total_tokens: st.cumulativeUsage.total_tokens + (ev.usage.total_tokens || 0),
        };
      }
      if (ev.state === 'idle' || ev.state === 'error') {
        st.isBusy = false;
        st.isStreaming = false;
      }
    }
    set({ sessions });
  },
}));

// Convenience selector: get the active session's state (or null).
export function useActiveSession(): ChatSessionState | null {
  return useSessionsStore((s) => {
    const id = s.activeSessionId;
    if (!id) return null;
    return s.sessions.get(id) || null;
  });
}
