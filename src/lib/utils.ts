// The name list for chat sessions. From the user.
// Each new chat gets a random unused name from this list.

export const CHAT_NAMES = [
  'Crippy', 'Scooby', 'Boon', 'Doobie', 'Sky', 'Faqous',
  'Lip', 'Trippy', 'Fourth Grade', 'Docks', 'Baby', 'Kenny',
] as const;

/** Pick a random unused name. Falls back to "<Name> 2" etc. if all taken. */
export function pickName(taken: Set<string>): string {
  const available = CHAT_NAMES.filter((n) => !taken.has(n));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  // All taken — append a number to a random base.
  const base = CHAT_NAMES[Math.floor(Math.random() * CHAT_NAMES.length)];
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Hash a string to a hue (0-360) for stable per-session icon colors. */
export function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

/** Format a token count compactly (e.g. 12345 → "12.3k"). */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Format a USD cost compactly (e.g. 0.0023 → "$0.0023"). */
export function fmtCost(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Convert ChatEvent[] → ChatMessage[] (merge assistant_delta chunks). */
export function eventsToMessages(events: { type: string; text?: string; name?: string; summary?: string; tool_use_id?: string; is_error?: boolean; state?: string; error?: string; ts: number; i: number }[]): import('../types').ChatMessage[] {
  const msgs: import('../types').ChatMessage[] = [];
  for (const ev of events) {
    switch (ev.type) {
      case 'user':
        msgs.push({
          id: `u-${ev.i}`,
          role: 'user',
          content: ev.text || '',
          timestamp: ev.ts,
        });
        break;
      case 'thinking': {
        // Replace the last streaming thinking bubble, or push a new one.
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'thinking' && last.isStreaming) {
          last.content = ev.text || '';
        } else {
          msgs.push({
            id: `t-${ev.i}`,
            role: 'thinking',
            content: ev.text || '',
            isStreaming: true,
            timestamp: ev.ts,
          });
        }
        break;
      }
      case 'assistant_delta': {
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'assistant' && last.isStreaming) {
          last.content += ev.text || '';
        } else {
          msgs.push({
            id: `a-${ev.i}`,
            role: 'assistant',
            content: ev.text || '',
            isStreaming: true,
            timestamp: ev.ts,
          });
        }
        break;
      }
      case 'tool_use':
        msgs.push({
          id: `tu-${ev.i}`,
          role: 'tool',
          content: '',
          toolName: ev.name,
          toolSummary: ev.summary,
          toolUseId: ev.tool_use_id,
          timestamp: ev.ts,
        });
        break;
      case 'tool_result': {
        // Pair with the matching tool_use by tool_use_id.
        const useIdx = msgs.findIndex((m) => m.toolUseId === ev.tool_use_id && m.role === 'tool');
        if (useIdx >= 0) {
          msgs[useIdx].content = ev.text || '';
          msgs[useIdx].isError = ev.is_error;
        } else {
          msgs.push({
            id: `tr-${ev.i}`,
            role: 'tool',
            content: ev.text || '',
            toolUseId: ev.tool_use_id,
            isError: ev.is_error,
            timestamp: ev.ts,
          });
        }
        break;
      }
      case 'status':
        // Finalize streaming bubbles.
        if (ev.state === 'idle' || ev.state === 'error') {
          for (const m of msgs) {
            if (m.isStreaming) m.isStreaming = false;
          }
        }
        break;
      case 'error':
        msgs.push({
          id: `e-${ev.i}`,
          role: 'system',
          content: ev.text || ev.error || 'Unknown error',
          isError: true,
          timestamp: ev.ts,
        });
        break;
    }
  }
  return msgs;
}
