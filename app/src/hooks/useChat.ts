// useChat — the WebSocket chat hook. One per active session.
//
// Flow:
//  1. open(sessionId) — connects WS /api/chat?session_id=<id>
//  2. The engine replays existing events (since=0) on connect (idempotent —
//     the store dedups by seq).
//  3. send(text) — sends {"type":"send","message":text} over the WS.
//     The engine acquires the per-session _turn_lock, calls the brain,
//     streams events back, persists each one to chat_events, forwards to us.
//  4. stop() — sends {"type":"stop"} (the engine's ctx cancellation aborts
//     the brain's LLM call).
//  5. close() — disconnects the WS.
//
// V0 fix: the store's isBusy is set false when a status:idle|error event
// arrives. If the WS drops without a terminal status, a 60s watchdog clears
// isBusy (prevents the stuck-busy bug from the old chatbot).

import { useCallback, useEffect, useRef } from 'react';
import { useEngineStore } from '../store/engines';
import { useSessionsStore } from '../store/sessions';
import type { ChatEvent } from '../types';

export function useChat(sessionId: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = useCallback(() => {
    if (!sessionId) return;
    const client = useEngineStore.getState().client;
    if (!client) return;

    // Close any existing WS for this session.
    const existing = useSessionsStore.getState().sessions.get(sessionId)?._ws;
    if (existing) existing.close();

    const ws = client.chatWS(sessionId);
    useSessionsStore.getState().setWS(sessionId, ws);

    ws.onmessage = (e) => {
      try {
        const ev: ChatEvent = JSON.parse(e.data);
        // Dedup: if we already have this event (by seq), skip.
        // (The engine replays since=0 on reconnect; idempotent handler.)
        const st = useSessionsStore.getState().sessions.get(sessionId);
        if (st && st.events.some((x) => x.seq === ev.seq)) {
          return;
        }
        useSessionsStore.getState().appendEvent(sessionId, ev);
        useSessionsStore.getState().updateFromEvent(sessionId, ev);

        // Reset the watchdog on every event.
        resetWatchdog();
      } catch (err) {
        console.error('ws parse:', err);
      }
    };

    ws.onerror = (e) => {
      console.error('ws error:', e);
      useSessionsStore.getState().setError(sessionId, 'WebSocket error');
    };

    ws.onclose = () => {
      useSessionsStore.getState().setBusy(sessionId, false);
    };
  }, [sessionId]);

  const resetWatchdog = useCallback(() => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    // 60s with no event → assume dead → clear isBusy (the V0 stuck-busy fix).
    watchdogRef.current = setTimeout(() => {
      useSessionsStore.getState().setBusy(sessionId ?? '', false);
      useSessionsStore.getState().setError(sessionId ?? '', 'Stream timed out (60s no data)');
    }, 60_000);
  }, [sessionId]);

  const send = useCallback(
    (text: string) => {
      if (!sessionId) return;
      const ws = useSessionsStore.getState().sessions.get(sessionId)?._ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // Reconnect first.
        open();
        setTimeout(() => {
          const w = useSessionsStore.getState().sessions.get(sessionId)?._ws;
          if (w && w.readyState === WebSocket.OPEN) {
            w.send(JSON.stringify({ type: 'send', message: text }));
            useSessionsStore.getState().setBusy(sessionId, true);
            resetWatchdog();
          }
        }, 500);
        return;
      }
      ws.send(JSON.stringify({ type: 'send', message: text }));
      useSessionsStore.getState().setBusy(sessionId, true);
      resetWatchdog();
    },
    [sessionId, open, resetWatchdog],
  );

  const stop = useCallback(() => {
    if (!sessionId) return;
    const ws = useSessionsStore.getState().sessions.get(sessionId)?._ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
    }
    useSessionsStore.getState().setBusy(sessionId, false);
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
  }, [sessionId]);

  const close = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
  }, []);

  // Auto-open on mount, auto-close on unmount.
  useEffect(() => {
    if (sessionId) open();
    return close;
  }, [sessionId, open, close]);

  return { send, stop, close, open };
}
